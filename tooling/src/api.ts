/**
 * Calls to the signed-in user's account on proschi.app with the tokens of
 * `proschi login` (credentials.ts): a bearer token, refreshed shortly before
 * it expires or after a 401, the new pair stored before it is used. Used by
 * `proschi imports sync` (cloud: sources), `proschi versions` and `whoami`.
 * Tokens and response bodies are never printed.
 */
import { CredentialStore, type Session } from './credentials';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 30_000;
/** Most bytes of a response read: a diagram with its imports is at most 64 KiB, as JSON a little more. */
const MAX_RESPONSE_BYTES = 4_000_000;
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 60_000;

/** Not signed in, or the sign-in ended: the message says to run proschi login. */
export class NotSignedInError extends Error {
  override name = 'NotSignedInError';
}

/** An error answer of the API, with its status and `error` code. */
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Reads a JSON body of at most MAX_RESPONSE_BYTES. */
export async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = reader ? await reader.read() : { done: true as const, value: undefined };
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader?.cancel();
      throw new Error('The answer is too large');
    }
    chunks.push(chunk.value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The answer (HTTP ${response.status}) is not JSON`);
  }
}

/** A request to the site: no redirects (a bearer token never follows one), within a timeout. */
export async function send(fetchImpl: Fetch, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`Cannot reach ${new URL(url).origin}: ${(e as Error).message}`);
  }
}

const messageOf = (body: unknown): { code?: string; message?: string } => {
  if (!body || typeof body !== 'object') return {};
  const { error, message, error_description } = body as Record<string, unknown>;
  return {
    code: typeof error === 'string' ? error : undefined,
    message: typeof message === 'string' ? message.slice(0, 300) : typeof error_description === 'string' ? error_description.slice(0, 300) : undefined,
  };
};

/** The tokens of a `/auth/token` answer, checked. */
export function sessionFrom(body: unknown, now = Date.now()): Session {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.access_token !== 'string' || !b.access_token || typeof b.refresh_token !== 'string' || !b.refresh_token) {
    throw new Error('The sign-in answer has no tokens');
  }
  const expiresIn = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : 3600;
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt: now + expiresIn * 1000 };
}

/** POSTs JSON to `/auth/token` and returns the new tokens. */
export async function requestTokens(fetchImpl: Fetch, base: string, body: Record<string, string>): Promise<Session> {
  const response = await send(fetchImpl, `${base}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await readJson(response).catch(() => undefined);
  if (!response.ok) {
    const { code, message } = messageOf(json);
    throw new ApiError(`Sign-in failed (HTTP ${response.status}${code ? `, ${code}` : ''})${message ? `: ${message}` : ''}`, response.status, code);
  }
  return sessionFrom(json);
}

export interface ApiClientOptions {
  base: string;
  store?: CredentialStore;
  fetch?: Fetch;
  now?: () => number;
}

export class ApiClient {
  readonly base: string;
  private readonly store: CredentialStore;
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;

  constructor({ base, store = new CredentialStore(), fetch: fetchImpl = fetch, now = Date.now }: ApiClientOptions) {
    this.base = base;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  private notSignedIn(): NotSignedInError {
    return new NotSignedInError(`Not signed in to ${this.base}; run proschi login`);
  }

  /** Whether tokens are stored for the site (they may still have expired). */
  signedIn(): boolean {
    return this.store.get(this.base) !== undefined;
  }

  /**
   * New tokens for the stored refresh token `used`, unless another process
   * already refreshed it (then its tokens). An invalid refresh token ends
   * the sign-in.
   */
  private async refresh(used: Session): Promise<Session> {
    return this.store.locked(async () => {
      const current = this.store.get(this.base);
      if (!current) throw this.notSignedIn();
      if (current.refreshToken !== used.refreshToken) return current;
      let next: Session;
      try {
        next = await requestTokens(this.fetchImpl, this.base, { grant_type: 'refresh_token', refresh_token: current.refreshToken });
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'invalid_grant' || e.status === 401)) {
          this.store.delete(this.base);
          throw new NotSignedInError(`The sign-in to ${this.base} has ended; run proschi login`);
        }
        throw e;
      }
      this.store.set(this.base, next);
      return next;
    });
  }

  /** GETs a JSON path of the API as the signed-in user; an ApiError for an error answer. */
  async get(path: string): Promise<unknown> {
    let session = this.store.get(this.base);
    if (!session) throw this.notSignedIn();
    if (session.expiresAt - EXPIRY_MARGIN_MS <= this.now()) session = await this.refresh(session);
    for (let attempt = 0; ; attempt++) {
      const response = await send(this.fetchImpl, `${this.base}${path}`, {
        headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' },
      });
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        session = await this.refresh(session);
        continue;
      }
      if (response.status === 401) throw new NotSignedInError(`${this.base} refused the sign-in; run proschi login`);
      const json = await readJson(response).catch((e: Error) => {
        if (response.ok) throw e;
        return undefined;
      });
      if (!response.ok) {
        const { code, message } = messageOf(json);
        throw new ApiError(message ?? `HTTP ${response.status}`, response.status, code);
      }
      return json;
    }
  }
}
