/**
 * `proschi login`, `logout` and `whoami`: signing in to proschi.app like a
 * native app (RFC 8252, backend/README.md "Command line sign-in"). The CLI
 * listens on 127.0.0.1 at a port the OS picks, opens the browser at the
 * site's sign-in with a PKCE S256 challenge and a random state, takes one
 * callback, and exchanges its code for tokens, which credentials.ts stores
 * readable by the user only. Tokens are never printed.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ApiClient, requestTokens, send, type Fetch } from './api';
import { CredentialStore, DEFAULT_SITE, normalizeBase } from './credentials';

export const LOGIN_USAGE = `  proschi login [--provider github|google] [--base <url>]
  proschi logout [--base <url>]
  proschi whoami [--base <url>]`;

export const LOGIN_HELP = `login   Signs in to your Proschi account in the browser (the link is printed
        too, for a machine without one) and stores the tokens in your user's
        config folder (readable by you only). cloud: imports and proschi
        versions need it. --base sets the site (default ${DEFAULT_SITE}).
logout  Ends the sign-in and deletes its tokens.
whoami  Prints the account you are signed in as.`;

const PROVIDERS = ['github', 'google'] as const;
type Provider = (typeof PROVIDERS)[number];
const LOGIN_TIMEOUT_MS = 5 * 60_000;

const base64url = (bytes: Buffer) => bytes.toString('base64url');

/** Opens a URL in the system browser: the platform's opener with the URL as its one argument, never a shell. */
export function openBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = execFile(command, args as string[], { timeout: 10_000, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
    child.on('error', reject);
  });
}

const page = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#0f172a}` +
  `main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem}@media(prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}}</style>` +
  `</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface LoginOptions {
  base?: string;
  provider?: Provider;
  store?: CredentialStore;
  fetch?: Fetch;
  /** Opens the sign-in page; tests pass a fake browser. */
  open?: (url: string) => Promise<void>;
  print?: (s: string) => void;
  timeoutMs?: number;
}

/** Runs the browser sign-in and stores the tokens; rejects with an Error that says what went wrong. */
export async function login({
  base = DEFAULT_SITE,
  provider = 'github',
  store = new CredentialStore(),
  fetch: fetchImpl = fetch,
  open = openBrowser,
  print = () => undefined,
  timeoutMs = LOGIN_TIMEOUT_MS,
}: LoginOptions = {}): Promise<void> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(24));

  let settle!: { resolve: (code: string) => void; reject: (e: Error) => void };
  const callback = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  let done = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, title: string, text: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(page(title, text));
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (done || req.method !== 'GET' || url.pathname !== '/callback') return reply(404, 'Not found', 'Nothing here.');
    done = true;
    const got = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (!sameText(got, state)) {
      reply(400, 'Sign-in failed', 'This sign-in did not come from the proschi login that is waiting. Run proschi login again.');
      settle.reject(new Error('The sign-in answer does not match this login (state mismatch); run proschi login again'));
    } else if (error || !code) {
      reply(400, 'Sign-in failed', error === 'access_denied' ? 'The sign-in was cancelled. You can close this tab.' : 'The sign-in did not finish. You can close this tab and try again.');
      settle.reject(new Error(error === 'access_denied' ? 'The sign-in was cancelled' : `The sign-in failed${error ? ` (${error.replace(/[^\w-]/g, '').slice(0, 40)})` : ''}`));
    } else {
      reply(200, 'Signed in to Proschi', 'You can close this tab and return to the terminal.');
      settle.resolve(code);
    }
  });
  // Callbacks only; never keep the process alive for idle browser connections.
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => settle.reject(new Error(`No sign-in within ${Math.round(timeoutMs / 60_000) || 1} minute(s); run proschi login again`)), timeoutMs);
  try {
    const start = new URL(`${base}/auth/${provider}/start`);
    start.search = new URLSearchParams({ client: 'proschi-cli', redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state }).toString();
    print(`Opening your browser to sign in to ${base}. If it does not open, visit:\n\n  ${start.href}\n`);
    open(start.href).catch(() => print('Could not open a browser; open the link above.'));
    const code = await callback;
    const session = await requestTokens(fetchImpl, base, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
    store.set(base, session);
  } finally {
    clearTimeout(timer);
    server.closeAllConnections?.();
    server.close();
  }
}

/** Ends the sign-in at the site and deletes its tokens; whether there was one. A failed revoke still deletes them. */
export async function logout({ base = DEFAULT_SITE, store = new CredentialStore(), fetch: fetchImpl = fetch }: Pick<LoginOptions, 'base' | 'store' | 'fetch'> = {}): Promise<{
  signedIn: boolean;
  revoked: boolean;
}> {
  const session = store.get(base);
  if (!session) return { signedIn: false, revoked: false };
  let revoked = false;
  try {
    const response = await send(fetchImpl, `${base}/auth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: session.refreshToken }),
    });
    await response.body?.cancel();
    revoked = response.ok;
  } catch {
    // Offline: the tokens are deleted anyway and expire on their own.
  }
  store.delete(base);
  return { signedIn: true, revoked };
}

export interface CommandDeps {
  store?: CredentialStore;
  fetch?: Fetch;
  open?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

export async function runAuth(command: 'login' | 'logout' | 'whoami', args: string[], out: (s: string) => void, err: (s: string) => void, deps: CommandDeps = {}): Promise<number> {
  let base = DEFAULT_SITE;
  let provider: Provider = 'github';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--base') {
      try {
        base = normalizeBase(args[++i] ?? '');
      } catch (e) {
        err((e as Error).message);
        return 2;
      }
    } else if (arg === '--provider' && command === 'login') {
      const value = args[++i];
      if (!PROVIDERS.includes(value as Provider)) {
        err(`Unknown provider '${value ?? ''}'; use ${PROVIDERS.join(' or ')}`);
        return 2;
      }
      provider = value as Provider;
    } else {
      err(`Unknown option ${arg}\n\nUsage:\n${LOGIN_USAGE}`);
      return 2;
    }
  }
  try {
    if (command === 'login') {
      await login({ base, provider, ...deps, print: err });
      out(`Signed in to ${base}`);
      return 0;
    }
    if (command === 'logout') {
      const { signedIn, revoked } = await logout({ base, ...deps });
      if (!signedIn) out(`Not signed in to ${base}`);
      else out(revoked ? `Signed out of ${base}` : `Deleted the stored sign-in for ${base} (the site could not be reached to end it; it expires on its own)`);
      return 0;
    }
    const me = (await new ApiClient({ base, store: deps.store, fetch: deps.fetch }).get('/api/me')) as { user?: { displayName?: unknown } } | undefined;
    const name = typeof me?.user?.displayName === 'string' ? me.user.displayName : 'an account without a name';
    out(`Signed in to ${base} as ${name}`);
    return 0;
  } catch (e) {
    err(`error: ${(e as Error).message}`);
    return 1;
  }
}
