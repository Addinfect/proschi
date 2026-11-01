import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TTL, REFRESH_TTL } from '../src/apptokens';
import { SESSION_COOKIE } from '../src/auth';
import { randomToken, sha256, timingSafeEqual } from '../src/crypto';
import type { Env } from '../src/env';
import worker from '../src/index';
import { call, dailyRun, ORIGIN, resetDatabase, signedInUser, WINDOW_TIMEOUT, withinOneWindow } from './helpers';

const APP_URI = 'proschi://auth';
const nowSeconds = () => Math.floor(Date.now() / 1000);
const count = async (sql: string, ...params: unknown[]) => (await env.DB.prepare(sql).bind(...params).first<{ n: number }>())!.n;

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/** Answers GitHub's token and profile endpoints. */
function mockGitHub(profile: Record<string, unknown> = { id: 42, login: 'octocat' }) {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = new URLSearchParams(String(init?.body));
      if (body.get('code') !== 'good-code' || !body.get('code_verifier')) return Response.json({ error: 'bad_verification_code' });
      return Response.json({ access_token: 'gh-token' });
    }
    if (url === 'https://api.github.com/user') return Response.json(profile);
    return real(input, init);
  });
}

/** The Worker with other bindings. */
async function callWith(overrides: Partial<Env>, path: string): Promise<Response> {
  const exec = createExecutionContext();
  const request = new Request(`${ORIGIN}${path}`, { redirect: 'manual' }) as Request<unknown, IncomingRequestCfProperties>;
  const response = await worker.fetch(request, { ...env, ...overrides } as Env, exec);
  await waitOnExecutionContext(exec);
  return response;
}

/** A PKCE verifier and its S256 challenge. */
async function pkce() {
  const verifier = randomToken(32);
  return { verifier, challenge: await sha256(verifier) };
}

const startPath = (params: Record<string, string>, provider = 'github') => `/auth/${provider}/start?${new URLSearchParams(params)}`;

/** The app's sign-in up to the redirect back to it: returns that redirect and the one-time code in it. */
async function appSignIn(challenge: string, extra: Record<string, string> = {}) {
  const start = await call(startPath({ client: 'app', redirect_uri: APP_URI, code_challenge: challenge, code_challenge_method: 'S256', ...extra }), {
    redirect: 'manual',
  });
  expect(start.status).toBe(302);
  const cookie = (start.headers.getSetCookie().find((c) => c.startsWith('proschi_oauth=')) ?? '').split(';')[0];
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
  const back = await call(`/auth/github/callback?${new URLSearchParams({ code: 'good-code', state })}`, { redirect: 'manual', headers: { Cookie: cookie } });
  const location = back.headers.get('Location') ?? '';
  return { start, back, location, code: new URL(location, 'https://invalid.example').searchParams.get('code') ?? '' };
}

const tokenRequest = (body: Record<string, string>, headers: Record<string, string> = {}) => call('/auth/token', { method: 'POST', body, headers });

async function exchange(code: string, verifier: string): Promise<Response> {
  return tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier });
}

/** The whole app sign-in: tokens. */
async function appTokens(): Promise<Tokens> {
  const { verifier, challenge } = await pkce();
  const { code } = await appSignIn(challenge);
  const response = await exchange(code, verifier);
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens;
}

const refresh = (refreshToken: string) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
const me = (bearer: string) => call('/api/me', { bearer });

describe('app sign-in', () => {
  beforeEach(resetDatabase);
  afterEach(() => vi.restoreAllMocks());

  it('runs the PKCE flow: code to the redirect URI, tokens for code and verifier, bearer access to the API', async () => {
    mockGitHub();
    const { verifier, challenge } = await pkce();
    const { start, back, location, code } = await appSignIn(challenge, { state: 'app-state-1' });
    // The provider sees the server's own PKCE challenge, never the app's.
    expect(new URL(start.headers.get('Location')!).searchParams.get('code_challenge')).not.toBe(challenge);

    expect(back.status).toBe(302);
    expect(back.headers.get('Cache-Control')).toBe('no-store');
    expect(location).toMatch(/^proschi:\/\/auth\?code=[\w-]{43}&state=app-state-1$/);
    // No cookie for the browser: only the clearing of the state cookie.
    expect(back.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    // Stored only as a hash.
    expect(await count('SELECT COUNT(*) AS n FROM app_auth_codes WHERE code_hash = ?', await sha256(code))).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM app_auth_codes WHERE code_hash = ?', code)).toBe(0);

    const response = await exchange(code, verifier);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const tokens = (await response.json()) as Tokens;
    expect(tokens).toEqual({ access_token: expect.stringMatching(/^[\w-]{43}$/), refresh_token: expect.stringMatching(/^[\w-]{43}$/), expires_in: ACCESS_TTL, token_type: 'Bearer' });
    expect(await count('SELECT COUNT(*) AS n FROM app_auth_codes')).toBe(0);

    const rows = await env.DB.prepare('SELECT token_hash, kind, expires_at, family_id FROM sessions ORDER BY kind').all<Record<string, string | number>>();
    expect(rows.results.map((r) => r.kind)).toEqual(['app_access', 'app_refresh']);
    expect(rows.results.map((r) => r.token_hash)).toEqual([await sha256(tokens.access_token), await sha256(tokens.refresh_token)]);
    expect(rows.results[0].family_id).toBe(rows.results[1].family_id);
    expect(Number(rows.results[0].expires_at)).toBeLessThanOrEqual(nowSeconds() + ACCESS_TTL);
    expect(Number(rows.results[1].expires_at)).toBeGreaterThan(nowSeconds() + REFRESH_TTL - 60);

    const profile = await me(tokens.access_token);
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({ user: { displayName: 'octocat', providers: ['github'] } });
    expect(profile.headers.getSetCookie()).toEqual([]);
    const cards = await call('/api/cards/state?day=2026-10-05', { bearer: tokens.access_token });
    expect(cards.status).toBe(200);
    expect(await cards.json()).toMatchObject({ states: {} });
    // A change, sent as an app sends it (no Origin).
    const patched = await call('/api/me', { method: 'PATCH', bearer: tokens.access_token, body: { displayName: 'From the app' } });
    expect(patched.status).toBe(200);
  });

  it('accepts a form-encoded token request, as OAuth client libraries send it', async () => {
    mockGitHub();
    const { verifier, challenge } = await pkce();
    const { code } = await appSignIn(challenge);
    const response = await (exports as unknown as { default: Fetcher }).default.fetch(
      new Request(`${ORIGIN}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': 'form-test' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: APP_URI }).toString(),
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as Tokens).token_type).toBe('Bearer');
  });

  it('sends the app its error when the user cancels', async () => {
    const { challenge } = await pkce();
    const start = await call(startPath({ client: 'app', redirect_uri: APP_URI, code_challenge: challenge, code_challenge_method: 'S256', state: 's' }), {
      redirect: 'manual',
    });
    const cookie = (start.headers.getSetCookie().find((c) => c.startsWith('proschi_oauth=')) ?? '').split(';')[0];
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
    const back = await call(`/auth/github/callback?${new URLSearchParams({ error: 'access_denied', state })}`, { redirect: 'manual', headers: { Cookie: cookie } });
    expect(back.headers.get('Location')).toBe('proschi://auth?error=access_denied&state=s');
  });

  it('only sends the app back to an allow-listed redirect URI, and never redirects anywhere else', async () => {
    const { challenge } = await pkce();
    const app = (redirectUri: string) =>
      call(startPath({ client: 'app', redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256' }), { redirect: 'manual' });
    for (const bad of ['https://evil.example/', 'proschi://auth/x', 'proschi://authx', 'proschi://auth?code=x', 'PROSCHI://auth', '', 'javascript:alert(1)']) {
      const response = await app(bad);
      expect(response.status, bad).toBe(400);
      expect(response.headers.get('Location'), bad).toBeNull();
    }
    // A listed URI with a query of its own keeps it.
    expect((await app('https://app.proschi.test/callback?x=1')).status).toBe(302);
    // Without the parameter.
    expect((await call(startPath({ client: 'app', code_challenge: challenge, code_challenge_method: 'S256' }), { redirect: 'manual' })).status).toBe(400);
    // Nothing is allowed while APP_REDIRECT_URIS is empty or holds unsafe schemes.
    const path = startPath({ client: 'app', redirect_uri: APP_URI, code_challenge: challenge, code_challenge_method: 'S256' });
    expect((await callWith({ APP_REDIRECT_URIS: '' }, path)).status).toBe(400);
    expect((await callWith({ APP_REDIRECT_URIS: undefined }, path)).status).toBe(400);
    const js = startPath({ client: 'app', redirect_uri: 'javascript:alert(1)', code_challenge: challenge, code_challenge_method: 'S256' });
    expect((await callWith({ APP_REDIRECT_URIS: 'javascript:alert(1)' }, js)).status).toBe(400);
  });

  it('needs an S256 challenge, and refuses linking or an unknown client', async () => {
    const { challenge } = await pkce();
    const base = { client: 'app', redirect_uri: APP_URI };
    for (const params of <Record<string, string>[]>[
      base,
      { ...base, code_challenge: challenge },
      { ...base, code_challenge: challenge, code_challenge_method: 'plain' },
      { ...base, code_challenge: 'short', code_challenge_method: 'S256' },
      { ...base, code_challenge: challenge, code_challenge_method: 'S256', state: 'x'.repeat(257) },
      { ...base, code_challenge: challenge, code_challenge_method: 'S256', link: '1' },
      { client: 'desktop', return: '/' },
    ]) {
      expect((await call(startPath(params), { redirect: 'manual' })).status, JSON.stringify(params)).toBe(400);
    }
  });

  it('refuses a wrong verifier, and the code is gone after that one try', async () => {
    mockGitHub();
    const { verifier, challenge } = await pkce();
    const { code } = await appSignIn(challenge);
    const wrong = await exchange(code, (await pkce()).verifier);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await exchange(code, verifier)).status).toBe(400);
    // A malformed verifier is refused before the code is looked at.
    const second = await appSignIn((await pkce()).challenge);
    expect(await (await exchange(second.code, 'too-short')).json()).toMatchObject({ error: 'invalid_request' });
  });

  it('refuses an expired code', async () => {
    mockGitHub();
    const { verifier, challenge } = await pkce();
    const { code } = await appSignIn(challenge);
    await env.DB.prepare('UPDATE app_auth_codes SET expires_at = ?').bind(nowSeconds() - 1).run();
    const response = await exchange(code, verifier);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await count('SELECT COUNT(*) AS n FROM sessions')).toBe(0);
  });

  it('accepts a code once', async () => {
    mockGitHub();
    const { verifier, challenge } = await pkce();
    const { code } = await appSignIn(challenge);
    expect((await exchange(code, verifier)).status).toBe(200);
    const again = await exchange(code, verifier);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a code sent with another redirect URI, and unknown grant types', async () => {
    mockGitHub();
    const { verifier, challenge } = await pkce();
    const { code } = await appSignIn(challenge);
    expect((await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'proschi://other' })).status).toBe(400);
    expect(await (await tokenRequest({ grant_type: 'password', username: 'a', password: 'b' })).json()).toMatchObject({ error: 'unsupported_grant_type' });
    expect(await (await tokenRequest({ grant_type: 'authorization_code' })).json()).toMatchObject({ error: 'invalid_request' });
  });

  it('rate-limits token requests per IP', async () => {
    await withinOneWindow();
    const headers = { 'CF-Connecting-IP': 'token-limit' };
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await tokenRequest({ grant_type: 'refresh_token', refresh_token: 'nope' }, headers)).status);
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses[20]).toBe(429);
  }, WINDOW_TIMEOUT);
});

describe('app tokens', () => {
  beforeEach(resetDatabase);
  afterEach(() => vi.restoreAllMocks());

  it('rotate on refresh; reusing an old refresh token revokes the whole sign-in, and only it', async () => {
    mockGitHub();
    const first = await appTokens();
    const other = await appTokens();

    const response = await refresh(first.refresh_token);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const second = (await response.json()) as Tokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    // The rotation ends the earlier access token.
    expect((await me(first.access_token)).status).toBe(401);
    expect((await me(second.access_token)).status).toBe(200);

    const third = (await (await refresh(second.refresh_token)).json()) as Tokens;
    expect((await me(third.access_token)).status).toBe(200);

    // The first refresh token again: someone holds a copy.
    const reused = await refresh(first.refresh_token);
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await me(third.access_token)).status).toBe(401);
    expect((await refresh(third.refresh_token)).status).toBe(400);
    // Another sign-in of the same user is untouched.
    expect((await me(other.access_token)).status).toBe(200);
    expect((await refresh(other.refresh_token)).status).toBe(200);
  });

  it('refuses an expired refresh token, and expired access tokens with WWW-Authenticate', async () => {
    mockGitHub();
    const tokens = await appTokens();
    await env.DB.prepare('UPDATE sessions SET expires_at = ?').bind(nowSeconds() - 1).run();
    const response = await me(tokens.access_token);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"');
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
  });

  it('are not interchangeable with each other or with the cookie', async () => {
    mockGitHub();
    const tokens = await appTokens();
    const web = await signedInUser();
    expect((await me(tokens.refresh_token)).status).toBe(401);
    expect((await call('/api/me', { token: tokens.access_token })).status).toBe(401);
    expect((await call('/api/me', { token: tokens.refresh_token })).status).toBe(401);
    expect((await me(web.token)).status).toBe(401);
    expect((await refresh(tokens.access_token)).status).toBe(400);
    expect((await refresh(web.token)).status).toBe(400);
    // With a bearer header only the token counts, never a cookie sent along.
    expect((await call('/api/me', { bearer: 'not-a-token', token: web.token })).status).toBe(401);
    expect((await call('/api/me', { headers: { Authorization: 'Bearer' }, token: web.token })).status).toBe(401);
    // Another scheme is not a bearer token: the cookie decides.
    expect((await call('/api/me', { headers: { Authorization: 'Basic eDp5' }, token: web.token })).status).toBe(200);
    expect((await me(tokens.access_token)).status).toBe(200);
  });

  it('POST /auth/revoke ends the sign-in, given either token, and answers the same for unknown ones', async () => {
    mockGitHub();
    const a = await appTokens();
    const b = await appTokens();
    expect((await call('/auth/revoke', { method: 'POST', body: { token: a.refresh_token } })).status).toBe(200);
    expect((await me(a.access_token)).status).toBe(401);
    expect((await refresh(a.refresh_token)).status).toBe(400);
    expect((await call('/auth/revoke', { method: 'POST', body: { token: b.access_token } })).status).toBe(200);
    expect((await me(b.access_token)).status).toBe(401);
    expect((await refresh(b.refresh_token)).status).toBe(400);
    expect((await call('/auth/revoke', { method: 'POST', body: { token: 'unknown' } })).status).toBe(200);
    expect((await call('/auth/revoke', { method: 'POST', body: {} })).status).toBe(400);
    // A cookie's token is not an app's: revoke leaves it alone.
    const web = await signedInUser();
    expect((await call('/auth/revoke', { method: 'POST', body: { token: web.token } })).status).toBe(200);
    expect((await call('/api/me', { token: web.token })).status).toBe(200);
  });

  it('signing out everywhere ends apps’ tokens, pending codes and cookies, from either side', async () => {
    mockGitHub();
    const tokens = await appTokens();
    const userId = (await env.DB.prepare('SELECT user_id AS n FROM sessions LIMIT 1').first<{ n: string }>())!.n;
    // A browser session of the same user, and a code not yet exchanged.
    const cookie = `web-${crypto.randomUUID()}`;
    await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, 0)').bind(await sha256(cookie), userId, 4_000_000_000).run();
    await appSignIn((await pkce()).challenge);
    expect(await count('SELECT COUNT(*) AS n FROM app_auth_codes')).toBe(1);

    const response = await call('/api/me/sessions/revoke-all', { method: 'POST', bearer: tokens.access_token });
    expect(response.status).toBe(204);
    expect((await me(tokens.access_token)).status).toBe(401);
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
    expect((await call('/api/me', { token: cookie })).status).toBe(401);
    expect(await count('SELECT COUNT(*) AS n FROM app_auth_codes')).toBe(0);

    // From the site.
    const again = await appTokens();
    const web = `web-${crypto.randomUUID()}`;
    await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, 0)').bind(await sha256(web), userId, 4_000_000_000).run();
    expect((await call('/api/me/sessions/revoke-all', { method: 'POST', token: web })).status).toBe(204);
    expect((await me(again.access_token)).status).toBe(401);
    expect((await refresh(again.refresh_token)).status).toBe(400);
  });

  it('deleting the account ends them', async () => {
    mockGitHub();
    const tokens = await appTokens();
    await appSignIn((await pkce()).challenge);
    expect((await call('/api/me', { method: 'DELETE', bearer: tokens.access_token })).status).toBe(204);
    expect(await count('SELECT COUNT(*) AS n FROM sessions')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM app_auth_codes')).toBe(0);
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
  });

  it('appear in the export with their kind, without hashes', async () => {
    mockGitHub();
    const tokens = await appTokens();
    await refresh(tokens.refresh_token);
    const response = await call('/api/me/export', { bearer: (await appTokens()).access_token });
    const text = await response.text();
    const sessions = (JSON.parse(text) as { sessions: { kind: string; rotatedAt?: number | null }[] }).sessions;
    expect(sessions.map((s) => s.kind).sort()).toEqual(['app_access', 'app_access', 'app_refresh', 'app_refresh', 'app_refresh']);
    expect(sessions.filter((s) => s.kind === 'app_refresh').map((s) => s.rotatedAt === null)).toContain(false);
    expect(text).not.toContain(tokens.refresh_token);
    expect(text).not.toContain(await sha256(tokens.refresh_token));
  });

  it('the daily cron deletes expired codes and tokens', async () => {
    mockGitHub();
    await appTokens();
    await appSignIn((await pkce()).challenge);
    await env.DB.batch([
      env.DB.prepare('UPDATE sessions SET expires_at = ?').bind(nowSeconds() - 1),
      env.DB.prepare('UPDATE app_auth_codes SET expires_at = ?').bind(nowSeconds() - 1),
    ]);
    await worker.scheduled(createScheduledController({ cron: '17 * * * *', scheduledTime: dailyRun() }), env);
    expect(await count('SELECT COUNT(*) AS n FROM sessions')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM app_auth_codes')).toBe(0);
  });
});

describe('same-origin check with bearer tokens', () => {
  beforeEach(resetDatabase);
  afterEach(() => vi.restoreAllMocks());

  const evil = { Origin: 'https://evil.example' };

  it('lets a bearer-only request through whatever its Origin, but never one carrying the session cookie', async () => {
    mockGitHub();
    const tokens = await appTokens();
    const web = await signedInUser();
    // An app's request is no browser's: its token is no ambient credential.
    expect((await call('/api/me', { method: 'PATCH', bearer: tokens.access_token, headers: evil, body: { displayName: 'App' } })).status).toBe(200);
    // A cross-site POST with only the cookie is still refused.
    expect((await call('/api/me', { method: 'PATCH', token: web.token, headers: evil, body: { displayName: 'Evil' } })).status).toBe(403);
    expect((await call('/api/me/sessions/revoke-all', { method: 'POST', token: web.token, headers: evil })).status).toBe(403);
    // A bearer header does not excuse a cookie sent along with it.
    expect((await call('/api/me', { method: 'PATCH', bearer: tokens.access_token, token: web.token, headers: evil, body: {} })).status).toBe(403);
    expect((await call('/api/me', { token: web.token })).status).toBe(200);
    expect(await (await call('/api/me', { token: web.token })).json()).toMatchObject({ user: { displayName: expect.not.stringMatching('Evil') } });
  });

  it('leaves cookie sign-in as it was: a web session, a cookie, no tokens', async () => {
    mockGitHub();
    const start = await call(startPath({ return: '/practice/' }), { redirect: 'manual' });
    const cookie = (start.headers.getSetCookie().find((c) => c.startsWith('proschi_oauth=')) ?? '').split(';')[0];
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
    const back = await call(`/auth/github/callback?${new URLSearchParams({ code: 'good-code', state })}`, { redirect: 'manual', headers: { Cookie: cookie } });
    expect(back.headers.get('Location')).toBe('/practice/');
    const session = back.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(session).toMatch(/; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
    expect(await env.DB.prepare('SELECT kind, family_id FROM sessions').all()).toMatchObject({ results: [{ kind: 'web', family_id: null }] });
    expect(await count('SELECT COUNT(*) AS n FROM app_auth_codes')).toBe(0);
  });
});

describe('timingSafeEqual', () => {
  it('compares strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
    expect(timingSafeEqual('', 'a')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('CLI sign-in (proschi-cli, loopback redirect)', () => {
  beforeEach(resetDatabase);
  afterEach(() => vi.restoreAllMocks());

  const cliStart = (redirectUri: string, challenge: string, extra: Record<string, string> = {}) =>
    call(startPath({ client: 'proschi-cli', redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', ...extra }), { redirect: 'manual' });

  /** The CLI's sign-in up to the redirect back to its loopback server: the one-time code. */
  async function cliCode(uri: string, challenge: string, state?: string): Promise<{ location: string; code: string; back: Response }> {
    const start = await cliStart(uri, challenge, state ? { state } : {});
    expect(start.status, uri).toBe(302);
    const cookie = (start.headers.getSetCookie().find((c) => c.startsWith('proschi_oauth=')) ?? '').split(';')[0];
    const providerState = new URL(start.headers.get('Location')!).searchParams.get('state')!;
    const back = await call(`/auth/github/callback?${new URLSearchParams({ code: 'good-code', state: providerState })}`, { redirect: 'manual', headers: { Cookie: cookie } });
    const location = back.headers.get('Location') ?? '';
    return { location, back, code: new URL(location, 'https://invalid.example').searchParams.get('code') ?? '' };
  }

  it('accepts 127.0.0.1 and [::1] on any port', async () => {
    mockGitHub();
    for (const uri of ['http://127.0.0.1:53682/callback', 'http://[::1]:1/callback', 'http://127.0.0.1:65535/callback']) {
      const { verifier, challenge } = await pkce();
      const { location, back, code } = await cliCode(uri, challenge, 'cli-state');
      expect(location).toMatch(new RegExp(`^${uri.replace(/[.[\]]/g, '\\$&')}\\?code=[\\w-]{43}&state=cli-state$`));
      expect(back.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
      // The redirect_uri, when sent, must be the one the code was issued for (and the code is then used up).
      expect((await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:1234/callback' })).status).toBe(400);
    }
  });

  it('runs the whole flow: tokens, the API, refresh and revoke', async () => {
    mockGitHub();
    const { verifier, challenge } = await pkce();
    const uri = 'http://127.0.0.1:49152/callback';
    const { code } = await cliCode(uri, challenge);
    const response = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: uri });
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as Tokens;
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: ACCESS_TTL });
    expect((await me(tokens.access_token)).status).toBe(200);
    const refreshed = (await (await refresh(tokens.refresh_token)).json()) as Tokens;
    expect((await me(tokens.access_token)).status).toBe(401);
    expect((await me(refreshed.access_token)).status).toBe(200);
    expect((await call('/auth/revoke', { method: 'POST', body: { token: refreshed.refresh_token } })).status).toBe(200);
    expect((await me(refreshed.access_token)).status).toBe(401);
  });

  it('refuses every other redirect URI, without redirecting', async () => {
    const { challenge } = await pkce();
    for (const uri of [
      'http://evil.com/callback',
      'http://evil.com:8080/callback',
      'http://127.0.0.1.evil.com:8080/callback',
      'http://127.0.0.1.evil.com/callback',
      'http://127.0.0.1:8080.evil.com/callback',
      'http://127.0.0.1@evil.com:8080/callback',
      'http://user@127.0.0.1:8080/callback',
      'http://localhost:8080/callback',
      'https://127.0.0.1:8080/callback',
      'http://127.0.0.1/callback',
      'http://127.0.0.1:/callback',
      'http://127.0.0.1:0/callback',
      'http://127.0.0.1:08080/callback',
      'http://127.0.0.1:65536/callback',
      'http://127.0.0.1:8080/callback/',
      'http://127.0.0.1:8080/callback?x=1',
      'http://127.0.0.1:8080/callback#x',
      'http://127.0.0.1:8080/other',
      'http://127.0.0.1:8080/Callback',
      'http://127.0.0.2:8080/callback',
      'http://[::2]:8080/callback',
      'http://[0:0:0:0:0:0:0:1]:8080/callback',
      'http://0x7f.0.0.1:8080/callback',
      ' http://127.0.0.1:8080/callback',
      'proschi://auth',
      '',
    ]) {
      const response = await cliStart(uri, challenge);
      expect(response.status, uri).toBe(400);
      expect(response.headers.get('Location'), uri).toBeNull();
    }
  });

  it('requires PKCE S256 and refuses linking', async () => {
    const uri = 'http://127.0.0.1:8080/callback';
    const { challenge } = await pkce();
    expect((await cliStart(uri, challenge, { code_challenge_method: 'plain' })).status).toBe(400);
    expect((await cliStart(uri, 'short')).status).toBe(400);
    expect((await call(startPath({ client: 'proschi-cli', redirect_uri: uri }), { redirect: 'manual' })).status).toBe(400);
    expect((await cliStart(uri, challenge, { link: '1' })).status).toBe(400);
    expect((await cliStart(uri, challenge)).status).toBe(302);
  });

  it('keeps loopback URIs to the CLI, and the allow-list to apps', async () => {
    const { challenge } = await pkce();
    const loopback = 'http://127.0.0.1:8080/callback';
    expect((await call(startPath({ client: 'app', redirect_uri: loopback, code_challenge: challenge, code_challenge_method: 'S256' }), { redirect: 'manual' })).status).toBe(400);
    expect((await cliStart(APP_URI, challenge)).status).toBe(400);
    expect((await call(startPath({ client: 'other-cli', redirect_uri: loopback, code_challenge: challenge, code_challenge_method: 'S256' }), { redirect: 'manual' })).status).toBe(400);
  });
});
