import { appRedirect, CLI_CLIENT, isAppState, isChallenge, isRedirectUriFor, issueAppCode, type AppClient, type AppLogin } from './apptokens';
import type { Ctx } from './context';
import { decodeJson, encodeJson, randomToken, sha256, sign, unsign } from './crypto';
import { now, secretOk, type Env } from './env';
import { bearerToken, errorResponse, HttpError, rateLimit, readCookie, SESSION_COOKIE } from './http';
import { recordEvent } from './events';
import { errorText, log } from './log';
import { countServerEvent } from './metrics';
import { rejectName } from './moderation';

/**
 * Sign-in with GitHub or Google (OAuth 2 authorization code flow with PKCE).
 * The site and the API share an origin, so the session is an HttpOnly cookie
 * page scripts cannot read.
 *
 *   page → GET /auth/<provider>/start?return=<path on this site>
 *        → provider → GET /auth/<provider>/callback
 *        → <path>, with the session cookie set
 *
 * A signed, short-lived state cookie set by /start ties the callback to the
 * browser that started the sign-in, so a crafted callback link cannot sign a
 * visitor in to someone else's account.
 *
 * Signed in, /start?link=1 adds the provider's identity to the account
 * instead: the callback links it and starts no new session.
 *
 * A native app starts with /start?client=app&redirect_uri=<allow-listed
 * URI>&code_challenge=<S256> (the CLI with client=proschi-cli and a
 * loopback redirect_uri, apptokens.ts): the callback sets no cookie but sends the app
 * back to its URI with a one-time code for POST /auth/token (apptokens.ts).
 * Requests then carry `Authorization: Bearer <access token>`.
 */

export type ProviderId = 'github' | 'google';

interface Profile {
  subject: string;
  name: string;
}

interface Provider {
  clientId(env: Env): string | undefined;
  clientSecret(env: Env): string | undefined;
  authorizeUrl(clientId: string, redirectUri: string, state: string, challenge: string): string;
  profile(env: Env, code: string, redirectUri: string, verifier: string): Promise<Profile>;
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || body.error) throw new Error(`${url}: ${response.status} ${String(body.error ?? '')}`);
  return body;
}

const PROVIDERS: Record<ProviderId, Provider> = {
  github: {
    clientId: (env) => env.GITHUB_CLIENT_ID,
    clientSecret: (env) => env.GITHUB_CLIENT_SECRET,
    authorizeUrl: (clientId, redirectUri, state, challenge) =>
      // No scope: read-only access to the public profile.
      `https://github.com/login/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        allow_signup: 'true',
      })}`,
    async profile(env, code, redirectUri, verifier) {
      const token = await fetchJson('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.GITHUB_CLIENT_ID!,
          client_secret: env.GITHUB_CLIENT_SECRET!,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      });
      const user = await fetchJson('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${String(token.access_token)}`, Accept: 'application/vnd.github+json', 'User-Agent': 'proschi-api' },
      });
      if (typeof user.id !== 'number') throw new Error('GitHub returned no user id');
      return { subject: String(user.id), name: String(user.login ?? `user${user.id}`) };
    },
  },
  google: {
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    authorizeUrl: (clientId, redirectUri, state, challenge) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      })}`,
    async profile(env, code, redirectUri, verifier) {
      const token = await fetchJson('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID!,
          client_secret: env.GOOGLE_CLIENT_SECRET!,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }),
      });
      const user = await fetchJson('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${String(token.access_token)}` },
      });
      if (typeof user.sub !== 'string') throw new Error('Google returned no subject');
      return { subject: user.sub, name: String(user.given_name ?? user.name ?? 'Google user') };
    },
  },
};

export function isProvider(id: string): id is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

/** The providers with credentials; the page offers only these. None without a usable SESSION_SECRET. */
export function configuredProviders(env: Env): ProviderId[] {
  if (!secretOk(env)) return [];
  return (Object.keys(PROVIDERS) as ProviderId[]).filter((id) => PROVIDERS[id].clientId(env) && PROVIDERS[id].clientSecret(env));
}

const STATE_COOKIE = 'proschi_oauth';
export { SESSION_COOKIE };
const STATE_TTL = 600;
export const SESSION_TTL = 30 * 24 * 3600;
export const MAX_NAME = 40;

interface LoginState {
  provider: ProviderId;
  state: string;
  verifier: string;
  returnTo: string;
  expires: number;
  /** Linking: the signed-in user to add the identity to. */
  linkUserId?: string;
  /** A native app's sign-in: the callback answers its redirect URI with a one-time code instead of setting the cookie. */
  app?: AppLogin;
}

/** A path on this site to come back to; anything else (another origin, `//host`, a scheme) is refused. */
function isReturnPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') && !/[\u0000-\u001f]/.test(path);
}

function redirect(location: string, headers: [string, string][] = []): Response {
  const response = new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
  for (const [name, value] of headers) response.headers.append(name, value);
  return response;
}

function stateCookie(value: string, maxAge: number): string {
  return `${STATE_COOKIE}=${value}; Path=/auth/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function withParam(path: string, key: string, value: string): string {
  const url = new URL(path, 'https://site.invalid');
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Without a usable SESSION_SECRET sign-in fails closed: state cookies signed with an empty or short one could be forged. */
function unavailable(ctx: Ctx): Response {
  log('error', 'Sign-in is unavailable: SESSION_SECRET is missing or shorter than 32 characters', { requestId: ctx.requestId });
  return errorResponse(503, 'Sign-in is unavailable (server misconfigured)');
}

/**
 * The app part of /start?client=app: redirect_uri must be allow-listed
 * (APP_REDIRECT_URIS), code_challenge an S256 challenge; state is optional.
 * For client=proschi-cli, redirect_uri must be a loopback one
 * (isLoopbackRedirectUri) instead.
 */
function readAppLogin(env: Env, params: URLSearchParams, client: AppClient): AppLogin | string {
  const redirectUri = params.get('redirect_uri') ?? '';
  if (!isRedirectUriFor(env, client, redirectUri)) {
    return client === CLI_CLIENT ? 'redirect_uri must be http://127.0.0.1:<port>/callback or http://[::1]:<port>/callback' : 'redirect_uri is not an allowed app redirect URI';
  }
  const challenge = params.get('code_challenge') ?? '';
  if (params.get('code_challenge_method') !== 'S256' || !isChallenge(challenge)) return 'code_challenge must be an S256 PKCE challenge (code_challenge_method=S256)';
  const state = params.get('state');
  if (state !== null && !isAppState(state)) return 'state must be at most 256 printable ASCII characters';
  return { ...(client === CLI_CLIENT ? { client } : {}), redirectUri, challenge, ...(state !== null ? { state } : {}) };
}

/** GET /auth/<provider>/start?return=<path>[&link=1], or ?client=app|proschi-cli&redirect_uri=&code_challenge=&code_challenge_method=S256[&state=] */
export async function startLogin(request: Request, ctx: Ctx, provider: ProviderId): Promise<Response> {
  const { env } = ctx;
  if (!secretOk(env)) return unavailable(ctx);
  await rateLimit(env.AUTH_LIMITER, ctx.ip, 'Too many sign-in attempts; wait a minute');
  const clientId = PROVIDERS[provider].clientId(env);
  if (!clientId || !configuredProviders(env).includes(provider)) return errorResponse(404, `Sign-in with ${provider} is not configured`);
  const url = new URL(request.url);
  const client = url.searchParams.get('client');
  if (client !== null && client !== 'app' && client !== CLI_CLIENT) return errorResponse(400, `client must be app or ${CLI_CLIENT}`);
  const returnTo = client !== null ? '/' : (url.searchParams.get('return') ?? '/');
  if (!isReturnPath(returnTo)) return errorResponse(400, 'return must be a path on this site');
  const login: LoginState = { provider, state: randomToken(16), verifier: randomToken(32), returnTo, expires: now() + STATE_TTL };
  if (client !== null) {
    if (url.searchParams.has('link')) return errorResponse(400, 'An app cannot link a sign-in');
    const app = readAppLogin(env, url.searchParams, client);
    // Never redirected to: an address that is not allow-listed only gets this error.
    if (typeof app === 'string') return errorResponse(400, app);
    login.app = app;
  } else if (url.searchParams.get('link') === '1') login.linkUserId = (await requireUser(request, ctx)).id;
  const cookie = await sign(encodeJson(login), env.SESSION_SECRET);
  const redirectUri = `${url.origin}/auth/${provider}/callback`;
  return redirect(PROVIDERS[provider].authorizeUrl(clientId, redirectUri, login.state, await sha256(login.verifier)), [
    ['Set-Cookie', stateCookie(cookie, STATE_TTL)],
  ]);
}

async function readLoginState(request: Request, env: Env & { SESSION_SECRET: string }, provider: ProviderId): Promise<LoginState | undefined> {
  const cookie = readCookie(request, STATE_COOKIE);
  const value = cookie && (await unsign(cookie, env.SESSION_SECRET));
  const login = value ? (decodeJson(value) as LoginState | undefined) : undefined;
  if (!login || login.provider !== provider || !(login.expires > now()) || !isReturnPath(login.returnTo)) return undefined;
  // Checked again: the allow-list may have changed since /start.
  if (login.app && !isRedirectUriFor(env, login.app.client ?? 'app', login.app.redirectUri)) return undefined;
  return login;
}

/** GET /auth/<provider>/callback */
export async function finishLogin(request: Request, ctx: Ctx, provider: ProviderId): Promise<Response> {
  const { env } = ctx;
  if (!secretOk(env)) return unavailable(ctx);
  await rateLimit(env.AUTH_LIMITER, ctx.ip, 'Too many sign-in attempts; wait a minute');
  const url = new URL(request.url);
  const login = await readLoginState(request, env, provider);
  if (!login || url.searchParams.get('state') !== login.state) {
    return new Response('Sign-in expired or was started in another browser. Go back to the page and sign in again.', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Set-Cookie': stateCookie('', 0) },
    });
  }
  const clearState: [string, string] = ['Set-Cookie', stateCookie('', 0)];
  const { app } = login;
  /** Back to the page, or to the app's redirect URI (OAuth error codes), with the error. */
  const failed = (reason: 'cancelled' | 'failed') =>
    app
      ? redirect(appRedirect(app.redirectUri, { error: reason === 'cancelled' ? 'access_denied' : 'server_error', state: app.state }), [clearState])
      : redirect(withParam(login.returnTo, 'login_error', reason), [clearState]);
  const code = url.searchParams.get('code');
  if (!code) return failed(url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed');

  let profile: Profile;
  try {
    profile = await PROVIDERS[provider].profile(env, code, `${url.origin}/auth/${provider}/callback`, login.verifier);
  } catch (e) {
    log('warn', `Sign-in with ${provider} failed`, { requestId: ctx.requestId, error: errorText(e) });
    await recordEvent(env, 'warn', 'sign_in_failed', `Sign-in with ${provider} failed`, { provider, requestId: ctx.requestId, error: errorText(e).split('\n')[0] });
    return failed('failed');
  }

  if (app) {
    // No cookie: the app exchanges this code, with its PKCE verifier, at POST /auth/token.
    const userId = await upsertUser(env, provider, profile);
    if (await refuseBlocked(ctx, userId, provider)) return redirect(appRedirect(app.redirectUri, { error: 'access_denied', state: app.state }), [clearState]);
    ctx.userId = userId;
    const appCode = await issueAppCode(env, userId, app);
    await countServerEvent(ctx, 'sign_in');
    return redirect(appRedirect(app.redirectUri, { code: appCode, state: app.state }), [clearState]);
  }

  if (login.linkUserId) {
    // Only while still signed in as the user who started linking.
    const user = await authenticate(request, ctx);
    if (user?.id !== login.linkUserId) return redirect(withParam(login.returnTo, 'login_error', 'failed'), [clearState]);
    const linked = await linkIdentity(env, user.id, provider, profile.subject);
    if (linked === 'in_use') return redirect(withParam(login.returnTo, 'login_error', 'identity_in_use'), [clearState]);
    if (linked === 'provider_taken') return redirect(withParam(login.returnTo, 'login_error', 'provider_linked'), [clearState]);
    return redirect(withParam(login.returnTo, 'linked', provider), [clearState]);
  }

  const userId = await upsertUser(env, provider, profile);
  if (await refuseBlocked(ctx, userId, provider)) return redirect(withParam(login.returnTo, 'login_error', 'blocked'), [clearState]);
  const token = randomToken();
  const t = now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at, kind) VALUES (?, ?, ?, ?, 'web')")
    .bind(await sha256(token), userId, t + SESSION_TTL, t)
    .run();
  await countServerEvent(ctx, 'sign_in');
  return redirect(login.returnTo, [clearState, ['Set-Cookie', sessionCookie(token, SESSION_TTL)]]);
}

/** Whether the account is blocked by the admin (src/admin.ts); records the refused sign-in, without the account's id. */
async function refuseBlocked(ctx: Ctx, userId: string, provider: ProviderId): Promise<boolean> {
  const row = await ctx.env.DB.prepare('SELECT blocked_at FROM users WHERE id = ?').bind(userId).first<{ blocked_at: number | null }>();
  if (!row || row.blocked_at === null) return false;
  await recordEvent(ctx.env, 'info', 'blocked_sign_in', `A blocked account tried to sign in with ${provider}`, { provider, requestId: ctx.requestId });
  return true;
}

/**
 * Adds a provider identity to a user. 'in_use': it already signs in to
 * another account; 'provider_taken': the user has another identity with the
 * provider (one each, identities_user_provider).
 */
async function linkIdentity(env: Env, userId: string, provider: ProviderId, subject: string): Promise<'linked' | 'already' | 'in_use' | 'provider_taken'> {
  const { meta } = await env.DB.prepare('INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
    .bind(provider, subject, userId)
    .run();
  if (meta.changes > 0) return 'linked';
  const owner = await env.DB.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').bind(provider, subject).first<{ user_id: string }>();
  if (!owner) return 'provider_taken';
  return owner.user_id === userId ? 'already' : 'in_use';
}

async function upsertUser(env: Env, provider: ProviderId, profile: Profile): Promise<string> {
  const existing = await env.DB.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?')
    .bind(provider, profile.subject)
    .first<{ user_id: string }>();
  if (existing) return existing.user_id;
  const id = crypto.randomUUID();
  const cleaned = cleanName(profile.name);
  const name = cleaned && !rejectName(cleaned) ? cleaned : 'Proschi user';
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, display_name, public_profile, created_at) VALUES (?, ?, 0, ?)').bind(id, name, now()),
    env.DB.prepare('INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)').bind(provider, profile.subject, id),
  ]);
  return id;
}

/** Control, zero-width and bidirectional formatting characters. */
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]', 'g');

/** A display name: trimmed, single spaces, no control characters, at most MAX_NAME characters; undefined when empty. */
export function cleanName(name: string): string | undefined {
  const cleaned = [...name.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()]
    .slice(0, MAX_NAME)
    .join('')
    .trim();
  return cleaned || undefined;
}

export interface User {
  id: string;
  displayName: string;
  publicProfile: boolean;
  /** Cards a day the user aims for (GOAL_CHOICES in frontend/src/learn/streak.ts); a solve also meets it. */
  dailyGoal: number;
  /** The account's plan, for its limits (src/plans.ts). */
  plan: string;
}

interface UserRow {
  id: string;
  display_name: string;
  public_profile: number;
  daily_goal: number;
  plan: string;
  last_seen_day: string | null;
  expires_at: number;
}

const toUser = (row: UserRow): User => ({ id: row.id, displayName: row.display_name, publicProfile: row.public_profile === 1, dailyGoal: row.daily_goal, plan: row.plan });

/**
 * Notes today (UTC) as the account's last seen day, at most once a day and
 * after the answer (the admin's active-user counts, src/admin.ts).
 */
function markSeen(ctx: Ctx, row: UserRow): void {
  const today = new Date(now() * 1000).toISOString().slice(0, 10);
  if (row.last_seen_day === today) return;
  ctx.exec.waitUntil(
    ctx.env.DB.prepare('UPDATE users SET last_seen_day = ?1 WHERE id = ?2 AND (last_seen_day IS NULL OR last_seen_day < ?1)')
      .bind(today, row.id)
      .run()
      .then(
        () => undefined,
        (e: unknown) => log('warn', 'Noting the last seen day failed', { requestId: ctx.requestId, error: errorText(e) }),
      ),
  );
}

/**
 * The signed-in user, or undefined without valid credentials. A blocked
 * account's sessions do not count (blocking deletes them too). A request
 * with `Authorization: Bearer` is an app's: only its access token counts,
 * never the cookie. Otherwise the session cookie: sessions slide, one used in
 * the second half of its 30 days gets 30 more, and the response carries the
 * renewed cookie.
 */
export async function authenticate(request: Request, ctx: Ctx): Promise<User | undefined> {
  const bearer = bearerToken(request);
  if (bearer !== undefined) {
    if (!bearer) return undefined;
    // Access tokens only: a refresh token or a cookie's token is refused here.
    const row = await ctx.env.DB.prepare(
      `SELECT u.id, u.display_name, u.public_profile, u.daily_goal, u.plan, u.last_seen_day, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.kind = 'app_access' AND s.expires_at > ? AND u.blocked_at IS NULL`,
    )
      .bind(await sha256(bearer), now())
      .first<UserRow>();
    if (!row) return undefined;
    ctx.userId = row.id;
    markSeen(ctx, row);
    return toUser(row);
  }
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return undefined;
  const hash = await sha256(token);
  const t = now();
  const row = await ctx.env.DB.prepare(
    `SELECT u.id, u.display_name, u.public_profile, u.daily_goal, u.plan, u.last_seen_day, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.kind = 'web' AND s.expires_at > ? AND u.blocked_at IS NULL`,
  )
    .bind(hash, t)
    .first<UserRow>();
  if (!row) return undefined;
  ctx.userId = row.id;
  markSeen(ctx, row);
  if (row.expires_at - t < SESSION_TTL / 2) {
    // Conditional, so of concurrent requests only the first renews it.
    const { meta } = await ctx.env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND kind = 'web' AND expires_at = ?")
      .bind(t + SESSION_TTL, hash, row.expires_at)
      .run();
    if (meta.changes > 0) ctx.setCookies.push(sessionCookie(token, SESSION_TTL));
  }
  return toUser(row);
}

export async function requireUser(request: Request, ctx: Ctx): Promise<User> {
  const user = await authenticate(request, ctx);
  if (!user) {
    // RFC 6750: tells an app its access token is no good (expired or revoked), so it refreshes.
    const headers: Record<string, string> = bearerToken(request) !== undefined ? { 'WWW-Authenticate': 'Bearer error="invalid_token"' } : {};
    throw new HttpError(401, 'Sign in first', headers);
  }
  return user;
}

/** POST /auth/logout: ends the cookie's session and clears the cookie (an app uses POST /auth/revoke). */
export async function logout(request: Request, ctx: Ctx): Promise<Response> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await ctx.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ? AND kind = 'web'").bind(await sha256(token)).run();
  return new Response(null, { status: 204, headers: { 'Set-Cookie': sessionCookie('', 0) } });
}

/** POST /api/me/sessions/revoke-all: signs the user out everywhere, this browser included, apps' tokens and pending codes too. */
export async function revokeAllSessions(request: Request, ctx: Ctx): Promise<Response> {
  const user = await requireUser(request, ctx);
  await rateLimit(ctx.env.PROFILE_LIMITER, user.id, 'Too many account changes; wait a minute');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    ctx.env.DB.prepare('DELETE FROM app_auth_codes WHERE user_id = ?').bind(user.id),
  ]);
  // Instead of a renewal authenticate may have queued.
  ctx.setCookies = [sessionCookie('', 0)];
  return new Response(null, { status: 204 });
}

/** DELETE /api/me/identities/<provider>: unlinks a sign-in, unless it is the account's only one. */
export async function unlinkIdentity(request: Request, ctx: Ctx, provider: string): Promise<Response> {
  const user = await requireUser(request, ctx);
  await rateLimit(ctx.env.PROFILE_LIMITER, user.id, 'Too many account changes; wait a minute');
  // One statement, so two concurrent unlinks cannot remove both identities.
  const { meta } = await ctx.env.DB.prepare(
    'DELETE FROM identities WHERE user_id = ?1 AND provider = ?2 AND (SELECT COUNT(*) FROM identities WHERE user_id = ?1) > 1',
  )
    .bind(user.id, provider)
    .run();
  if (meta.changes > 0) return new Response(null, { status: 204 });
  const linked = await ctx.env.DB.prepare('SELECT 1 FROM identities WHERE user_id = ? AND provider = ?').bind(user.id, provider).first();
  if (!linked) throw new HttpError(404, `No ${provider} sign-in is linked`);
  throw new HttpError(409, "Can't remove your only sign-in");
}
