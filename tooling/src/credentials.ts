/**
 * The tokens of `proschi login`, per user: `credentials.json` in
 * `$XDG_CONFIG_HOME/proschi` (else `~/.config/proschi`; `%APPDATA%\proschi`
 * on Windows), readable by the user only (0600 in a 0700 folder), keyed by
 * the site's base URL. Written atomically (a temp file renamed over it), and
 * refreshes are serialised across processes with a lock file next to it,
 * since a refresh token works once (backend/README.md, "Command line sign-in").
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_SITE = 'https://proschi.app';

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** When the access token expires, Unix milliseconds. */
  expiresAt: number;
}

interface CredentialsFile {
  version: 1;
  /** By base URL (an origin, e.g. https://proschi.app). */
  sessions: Record<string, Session>;
}

/** Where the credentials file is for this environment. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'proschi', 'credentials.json');
  const config = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/') ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(config, 'proschi', 'credentials.json');
}

/**
 * The site a command talks to: an https origin, or http on localhost or
 * 127.0.0.1 for development. Throws an Error that says what is allowed.
 */
export function normalizeBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`'${value}' is not a URL; use e.g. ${DEFAULT_SITE}`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`'${value}' is not https; only https:// sites (or http://localhost and http://127.0.0.1 for development) are allowed`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`'${value}' must be the site's address only, like ${DEFAULT_SITE}`);
  }
  return url.origin;
}

const isSession = (v: unknown): v is Session =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as Session).accessToken === 'string' &&
  typeof (v as Session).refreshToken === 'string' &&
  typeof (v as Session).expiresAt === 'number';

export class CredentialStore {
  constructor(readonly file: string = credentialsPath()) {}

  private read(): CredentialsFile {
    if (!existsSync(this.file)) return { version: 1, sessions: {} };
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error(`${this.file} is not valid JSON; delete it and run proschi login`);
    }
    const sessions: Record<string, Session> = {};
    const stored = (json as { sessions?: unknown } | null)?.sessions;
    if (stored && typeof stored === 'object') for (const [base, s] of Object.entries(stored)) if (isSession(s)) sessions[base] = s;
    return { version: 1, sessions };
  }

  /** Writes the file with mode 0600 through a temp file in the same folder, so a reader never sees half a file. */
  private write(data: CredentialsFile): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(data, null, 2) + '\n');
    } finally {
      closeSync(fd);
    }
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  get(base: string): Session | undefined {
    return this.read().sessions[base];
  }

  set(base: string, session: Session): void {
    const data = this.read();
    data.sessions[base] = session;
    this.write(data);
  }

  delete(base: string): void {
    const data = this.read();
    if (!(base in data.sessions)) return;
    delete data.sessions[base];
    this.write(data);
  }

  /**
   * Runs `fn` holding the lock file next to the credentials, so two
   * processes never refresh with the same token. A lock older than
   * `staleMs` (a crashed process) is taken over.
   */
  async locked<T>(fn: () => Promise<T>, { timeoutMs = 15_000, staleMs = 30_000 } = {}): Promise<T> {
    const lock = `${this.file}.lock`;
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    const start = Date.now();
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx', 0o600));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          if (Date.now() - statSync(lock).mtimeMs > staleMs) rmSync(lock, { force: true });
        } catch {
          // Removed by its owner meanwhile.
        }
        if (Date.now() - start > timeoutMs) throw new Error(`Another proschi process holds ${lock}; try again, or delete it if none runs`);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }
}
