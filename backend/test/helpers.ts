import { env, exports } from 'cloudflare:workers';
import { SESSION_COOKIE } from '../src/auth';
import { sha256 } from '../src/crypto';
import { clearStatsCache } from '../src/stats';

export const ORIGIN = 'https://proschi.test';

/**
 * A request to the Worker, as a page on the site sends it; `token` is the
 * session cookie. Each comes from a new IP unless `CF-Connecting-IP` is
 * given, so the per-IP rate limits only add up where a test wants them to.
 * With `bearer` it is a native app's instead: `Authorization: Bearer`, and no
 * Origin unless given.
 */
export function call(path: string, init: Omit<RequestInit, 'body'> & { token?: string; bearer?: string; body?: unknown } = {}): Promise<Response> {
  const { token, bearer, body, ...rest } = init;
  const headers = new Headers(rest.headers);
  const method = (rest.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !headers.has('Origin') && bearer === undefined) headers.set('Origin', ORIGIN);
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', `test-${crypto.randomUUID()}`);
  if (token) headers.append('Cookie', `${SESSION_COOKIE}=${token}`);
  if (bearer !== undefined) headers.set('Authorization', `Bearer ${bearer}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

/**
 * The local rate limiters count in fixed windows aligned to the wall clock
 * (miniflare's RateLimiterObject: epoch = floor(now / period)), so a burst
 * that straddles a minute boundary starts counting again halfway. Tests that
 * expect a 429 call this first: it waits for the next minute when fewer than
 * `needMs` are left in this one.
 */
export async function withinOneWindow(needMs = 5000, periodMs = 60_000): Promise<void> {
  const left = periodMs - (Date.now() % periodMs);
  if (left < needMs) await new Promise((resolve) => setTimeout(resolve, left + 50));
}

/** Timeout for a test that calls withinOneWindow. */
export const WINDOW_TIMEOUT = 20_000;

let users = 0;

/** A user with a session, created straight in the database; returns its id and session token. */
export async function signedInUser(name = `user${++users}`, publicProfile = false): Promise<{ id: string; token: string }> {
  const id = crypto.randomUUID();
  const token = `token-${id}`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, display_name, public_profile, created_at) VALUES (?, ?, ?, 0)').bind(id, name, publicProfile ? 1 : 0),
    env.DB.prepare('INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)').bind('github', id, id),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, 0)').bind(await sha256(token), id, 4_000_000_000),
  ]);
  return { id, token };
}

export async function resetDatabase(): Promise<void> {
  await env.DB.batch(['admin_sessions', 'admin_challenges', 'admin_passkeys', 'admin_audit', 'app_events', 'lesson_reads', 'email_prefs', 'document_versions', 'documents', 'shares', 'daily_counts', 'game_runs', 'game_meta', 'challenge_attempts', 'achievements', 'card_reviews', 'card_state', 'app_auth_codes', 'sessions', 'progress', 'identities', 'users'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await clearStatsCache();
}

/** Today's 03:17 UTC, in milliseconds: the hourly cron's run that also does the daily jobs (src/cron.ts). */
export const dailyRun = (): number => Date.parse(`${new Date().toISOString().slice(0, 10)}T03:17:00Z`);
