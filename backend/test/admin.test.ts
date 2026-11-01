import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_COOKIE, ADMIN_IDLE } from '../src/adminAuth';
import { hourlyCron } from '../src/cron';
import type { Env } from '../src/env';
import { resetEventThrottle, routeOf } from '../src/events';
import worker from '../src/index';
import { call, dailyRun, ORIGIN, resetDatabase, signedInUser } from './helpers';
import { createPasskey, type Passkey } from './webauthn';

const SETUP_TOKEN = 'test-admin-setup-token-0123456789';

/** A request with the admin cookie (`admin`, a session token). */
function adminCall(path: string, admin: string | undefined, init: Parameters<typeof call>[1] = {}) {
  const headers = new Headers(init.headers);
  if (admin) headers.append('Cookie', `${ADMIN_COOKIE}=${admin}`);
  return call(path, { ...init, headers });
}

function adminToken(response: Response): string | undefined {
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith(`${ADMIN_COOKIE}=`));
  return cookie?.split(';')[0].split('=')[1] || undefined;
}

/** Sets the admin up with a new passkey; returns it and the session token. */
async function setUp(): Promise<{ passkey: Passkey; admin: string }> {
  const passkey = await createPasskey();
  const options = (await (await call('/api/admin/setup/options', { method: 'POST', body: { setupToken: SETUP_TOKEN } })).json()) as { challenge: string; rp: { id: string } };
  const response = await call('/api/admin/setup', { method: 'POST', body: { setupToken: SETUP_TOKEN, name: 'Laptop', response: await passkey.register(options, ORIGIN) } });
  expect(response.status).toBe(200);
  return { passkey, admin: adminToken(response)! };
}

async function signIn(passkey: Passkey, overrides?: { id?: string; counter?: number }): Promise<Response> {
  const options = (await (await call('/api/admin/login/options', { method: 'POST' })).json()) as { challenge: string; rpId: string };
  return call('/api/admin/login', { method: 'POST', body: { response: await passkey.authenticate(options, ORIGIN, overrides) } });
}

async function events(kind: string): Promise<{ level: string; message: string; detail: string | null }[]> {
  return (await env.DB.prepare('SELECT level, message, detail FROM app_events WHERE kind = ? ORDER BY id').bind(kind).all<{ level: string; message: string; detail: string | null }>()).results;
}

async function callWith(overrides: Partial<Env>, path: string): Promise<Response> {
  const exec = createExecutionContext();
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`) as Request<unknown, IncomingRequestCfProperties>, { ...env, ...overrides } as Env, exec);
  await waitOnExecutionContext(exec);
  return response;
}

describe('admin setup and passkey sign-in', () => {
  beforeEach(resetDatabase);

  it('offers setup only while there is no passkey and the setup token is configured', async () => {
    expect(await (await call('/api/admin/status')).json()).toEqual({ passkeys: false, setupAvailable: true, signedIn: false });
    expect(await (await callWith({ ADMIN_SETUP_TOKEN: undefined }, '/api/admin/status')).json()).toEqual({ passkeys: false, setupAvailable: false, signedIn: false });
    expect(await (await callWith({ ADMIN_SETUP_TOKEN: 'short' }, '/api/admin/status')).json()).toMatchObject({ setupAvailable: false });
    const { admin } = await setUp();
    expect(await (await call('/api/admin/status')).json()).toEqual({ passkeys: true, setupAvailable: false, signedIn: false });
    expect(await (await adminCall('/api/admin/status', admin)).json()).toEqual({ passkeys: true, setupAvailable: false, signedIn: true });
  });

  it('refuses setup with a wrong or missing token, and records the attempt', async () => {
    for (const setupToken of ['wrong-token-wrong-token', undefined, SETUP_TOKEN.slice(0, -1)]) {
      const response = await call('/api/admin/setup/options', { method: 'POST', body: { setupToken } });
      expect(response.status).toBe(403);
    }
    expect(await events('admin_sign_in_failed')).toHaveLength(3);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_challenges').first<{ n: number }>())!.n).toBe(0);
  });

  it('registers the first passkey, signs in with a SameSite=Strict cookie, and closes setup', async () => {
    const passkey = await createPasskey();
    const optionsResponse = await call('/api/admin/setup/options', { method: 'POST', body: { setupToken: SETUP_TOKEN } });
    const options = (await optionsResponse.json()) as { challenge: string; rp: { id: string }; authenticatorSelection: unknown; attestation: string };
    expect(options.rp.id).toBe('proschi.test');
    expect(options.attestation).toBe('none');
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    const response = await call('/api/admin/setup', { method: 'POST', body: { setupToken: SETUP_TOKEN, name: 'Laptop', response: await passkey.register(options, ORIGIN) } });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith(`${ADMIN_COOKIE}=`))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    const stored = await env.DB.prepare('SELECT id, name, transports FROM admin_passkeys').all();
    expect(stored.results).toEqual([{ id: passkey.id, name: 'Laptop', transports: '["internal"]' }]);

    // Setup is closed now, even with the right token.
    expect((await call('/api/admin/setup/options', { method: 'POST', body: { setupToken: SETUP_TOKEN } })).status).toBe(403);
    const second = await createPasskey();
    expect((await call('/api/admin/setup', { method: 'POST', body: { setupToken: SETUP_TOKEN, response: await second.register(options, ORIGIN) } })).status).toBe(403);
    expect(await events('admin_setup')).toHaveLength(1);
  });

  it('uses each challenge once, and refuses another origin in the client data', async () => {
    const passkey = await createPasskey();
    const options = (await (await call('/api/admin/setup/options', { method: 'POST', body: { setupToken: SETUP_TOKEN } })).json()) as { challenge: string; rp: { id: string } };
    const elsewhere = await call('/api/admin/setup', { method: 'POST', body: { setupToken: SETUP_TOKEN, response: await passkey.register(options, 'https://evil.test') } });
    expect(elsewhere.status).toBe(400);
    // The failed attempt used the challenge up.
    const again = await call('/api/admin/setup', { method: 'POST', body: { setupToken: SETUP_TOKEN, response: await passkey.register(options, ORIGIN) } });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'The passkey request expired; try again' });
  });

  it('signs in with a registered passkey, and refuses forged, unknown and replayed answers', async () => {
    const { passkey } = await setUp();
    // Discoverable passkeys: the options name none, so asking for them reveals no credential id.
    const loginOptions = (await (await call('/api/admin/login/options', { method: 'POST' })).json()) as Record<string, unknown>;
    expect(loginOptions).toMatchObject({ rpId: 'proschi.test', userVerification: 'required' });
    expect(JSON.stringify(loginOptions)).not.toContain(passkey.id);
    const ok = await signIn(passkey);
    expect(ok.status).toBe(200);
    expect(adminToken(ok)).toBeTruthy();
    expect(await events('admin_sign_in')).toHaveLength(1);

    // Another key, sent as the registered passkey's id: the signature does not match.
    const other = await createPasskey();
    expect((await signIn(other, { id: passkey.id })).status).toBe(401);
    // A passkey the admin never registered.
    expect((await signIn(other)).status).toBe(401);
    // A replayed answer: its challenge is used up.
    const options = (await (await call('/api/admin/login/options', { method: 'POST' })).json()) as { challenge: string };
    const answer = await passkey.authenticate(options, ORIGIN);
    expect((await call('/api/admin/login', { method: 'POST', body: { response: answer } })).status).toBe(200);
    expect((await call('/api/admin/login', { method: 'POST', body: { response: answer } })).status).toBe(401);
    expect(await events('admin_sign_in_failed')).toHaveLength(3);
  });

  it('refuses a passkey whose signature counter went backwards (a cloned key)', async () => {
    const { passkey } = await setUp();
    expect((await signIn(passkey, { counter: 5 })).status).toBe(200);
    expect((await signIn(passkey, { counter: 3 })).status).toBe(401);
  });

  it('answers login options only once set up', async () => {
    expect((await call('/api/admin/login/options', { method: 'POST' })).status).toBe(409);
  });

  it('needs a session for every admin route, and this site’s Origin for changes', async () => {
    for (const path of ['/api/admin/overview', '/api/admin/health', '/api/admin/users', '/api/admin/shares', '/api/admin/events', '/api/admin/audit', '/api/admin/passkeys']) {
      expect((await call(path)).status, path).toBe(401);
    }
    const { id } = await signedInUser();
    // A user's own session is no admin session.
    const user = await signedInUser();
    expect((await call('/api/admin/users', { token: user.token })).status).toBe(401);
    const { admin } = await setUp();
    expect((await adminCall('/api/admin/users', admin)).status).toBe(200);
    expect((await adminCall(`/api/admin/users/${id}/block`, admin, { method: 'POST', body: {}, headers: { Origin: 'https://evil.test' } })).status).toBe(403);
    // Browsers send Origin on every fetch POST; an admin change without one is refused too.
    const headers = new Headers({ Cookie: `${ADMIN_COOKIE}=${admin}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': 'test-no-origin' });
    const exec = createExecutionContext();
    const noOrigin = await worker.fetch(new Request(`${ORIGIN}/api/admin/users/${id}/block`, { method: 'POST', headers, body: '{}' }) as Request<unknown, IncomingRequestCfProperties>, env as Env, exec);
    await waitOnExecutionContext(exec);
    expect(noOrigin.status).toBe(403);
  });

  it('ends a session after 30 idle minutes, and on logout', async () => {
    const { admin, passkey } = await setUp();
    await env.DB.prepare('UPDATE admin_sessions SET expires_at = ?').bind(Math.floor(Date.now() / 1000) - 1).run();
    expect((await adminCall('/api/admin/users', admin)).status).toBe(401);

    const fresh = adminToken(await signIn(passkey))!;
    const before = (await env.DB.prepare('SELECT expires_at FROM admin_sessions').first<{ expires_at: number }>())!.expires_at;
    expect(before - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(ADMIN_IDLE);
    const out = await adminCall('/api/admin/logout', fresh, { method: 'POST' });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie().join()).toContain(`${ADMIN_COOKIE}=; Path=/; Max-Age=0`);
    expect((await adminCall('/api/admin/users', fresh)).status).toBe(401);
  });

  it('adds and removes passkeys, but never the last one', async () => {
    const { admin, passkey } = await setUp();
    const second = await createPasskey();
    const options = (await (await adminCall('/api/admin/passkeys/options', admin, { method: 'POST' })).json()) as {
      challenge: string;
      rp: { id: string };
      excludeCredentials: { id: string }[];
    };
    expect(options.excludeCredentials.map((c) => c.id)).toEqual([passkey.id]);
    const added = await adminCall('/api/admin/passkeys', admin, { method: 'POST', body: { name: 'Phone', response: await second.register(options, ORIGIN) } });
    expect(added.status).toBe(201);
    const list = (await (await adminCall('/api/admin/passkeys', admin)).json()) as { passkeys: { id: string; name: string; current: boolean }[]; sessions: number };
    expect(list.passkeys.map((p) => [p.name, p.current])).toEqual([
      ['Laptop', true],
      ['Phone', false],
    ]);
    expect(list.sessions).toBe(1);
    // The second one signs in too.
    expect((await signIn(second)).status).toBe(200);

    expect((await adminCall(`/api/admin/passkeys/${second.id}`, admin, { method: 'DELETE' })).status).toBe(204);
    expect((await adminCall(`/api/admin/passkeys/${passkey.id}`, admin, { method: 'DELETE' })).status).toBe(409);
    expect((await adminCall('/api/admin/passkeys/nope', admin, { method: 'DELETE' })).status).toBe(404);
    expect((await signIn(second)).status).toBe(401);
    const audit = (await env.DB.prepare('SELECT action FROM admin_audit ORDER BY id').all<{ action: string }>()).results.map((r) => r.action);
    expect(audit).toEqual(['admin.setup', 'passkey.add', 'passkey.delete']);
  });

  it('signs every admin session out', async () => {
    const { admin, passkey } = await setUp();
    const other = adminToken(await signIn(passkey))!;
    expect((await adminCall('/api/admin/sessions/revoke-all', admin, { method: 'POST' })).status).toBe(204);
    expect((await adminCall('/api/admin/users', admin)).status).toBe(401);
    expect((await adminCall('/api/admin/users', other)).status).toBe(401);
  });
});

describe('admin: users', () => {
  beforeEach(resetDatabase);

  it('lists, searches and filters accounts', async () => {
    const { admin } = await setUp();
    const ada = await signedInUser('Ada Lovelace', true);
    const bob = await signedInUser('Bob_50%');
    await env.DB.prepare("INSERT INTO progress (user_id, problem_id, runs, first_run_at, updated_at, solved_at) VALUES (?, 'url-shortener', 3, 0, 0, 1)").bind(ada.id).run();
    type List = { total: number; users: { id: string; displayName: string; solved: number; providers: string[]; publicProfile: boolean }[] };
    const list = async (query: string) => (await (await adminCall(`/api/admin/users${query}`, admin)).json()) as List;

    expect((await list('')).total).toBe(2);
    expect((await list('?q=love')).users.map((u) => u.displayName)).toEqual(['Ada Lovelace']);
    // % and _ are literal.
    expect((await list('?q=50%25')).users.map((u) => u.displayName)).toEqual(['Bob_50%']);
    expect((await list('?q=a_')).total).toBe(0);
    // By account id, and by the provider's user id.
    expect((await list(`?q=${bob.id}`)).users.map((u) => u.id)).toEqual([bob.id]);
    expect((await list('?filter=public')).users.map((u) => u.id)).toEqual([ada.id]);
    expect((await list('?sort=solved')).users[0]).toMatchObject({ id: ada.id, solved: 1, providers: ['github'], publicProfile: true });
    // Seen today: signedInUser's sessions have not been used yet.
    expect((await list('?filter=active')).total).toBe(0);
    await call('/api/me', { token: ada.token });
    expect((await list('?filter=active')).users.map((u) => u.id)).toEqual([ada.id]);
    expect((await adminCall('/api/admin/users?filter=nope', admin)).status).toBe(400);
    expect((await adminCall('/api/admin/users?sort=nope', admin)).status).toBe(400);
  });

  it('shows one account in detail, with a masked email address', async () => {
    const { admin } = await setUp();
    const ada = await signedInUser('Ada');
    await env.DB.prepare(
      `INSERT INTO email_prefs (user_id, email, confirmed_at, time_zone, unsubscribe_token, created_at, updated_at) VALUES (?, 'ada@example.com', 1, 'UTC', 'u', 0, 0)`,
    )
      .bind(ada.id)
      .run();
    await env.DB.prepare("INSERT INTO shares (id, user_id, title, source, created_at) VALUES ('AbCdEf1234', ?, 'Shop', 'a', 5)").bind(ada.id).run();
    const detail = (await (await adminCall(`/api/admin/users/${ada.id}`, admin)).json()) as Record<string, unknown>;
    expect(detail).toMatchObject({
      user: { id: ada.id, displayName: 'Ada', blockedAt: null, plan: 'free' },
      identities: [{ provider: 'github', subject: ada.id }],
      sessions: [{ kind: 'web', count: 1 }],
      shares: [{ id: 'AbCdEf1234', title: 'Shop' }],
      email: { address: 'a***@example.com', confirmed: true, paused: false },
    });
    expect(JSON.stringify(detail)).not.toContain('ada@example.com');
    expect((await adminCall('/api/admin/users/00000000-0000-0000-0000-000000000000', admin)).status).toBe(404);
    expect((await adminCall('/api/admin/users/not-an-id', admin)).status).toBe(404);
  });

  it('blocks an account: signed out, refused, hidden; unblocking lets it back in', async () => {
    const { admin } = await setUp();
    const ada = await signedInUser('Ada', true);
    await env.DB.prepare("INSERT INTO shares (id, user_id, title, source, created_at) VALUES ('AbCdEf1234', ?, 'Shop', 'a', 5)").bind(ada.id).run();
    expect((await call('/api/shares/AbCdEf1234')).status).toBe(200);

    const block = await adminCall(`/api/admin/users/${ada.id}/block`, admin, { method: 'POST', body: { reason: 'spam links' } });
    expect(block.status).toBe(204);
    expect((await call('/api/me', { token: ada.token })).status).toBe(401);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(ada.id).first<{ n: number }>())!.n).toBe(0);
    expect((await call('/api/shares/AbCdEf1234')).status).toBe(404);
    expect((await call(`/api/users/${ada.id}/profile`)).status).toBe(404);
    expect((await adminCall(`/api/admin/users/${ada.id}/block`, admin, { method: 'POST', body: {} })).status).toBe(409);
    expect(await (await adminCall(`/api/admin/users/${ada.id}`, admin)).json()).toMatchObject({
      user: { blockedReason: 'spam links', publicProfile: false },
      audit: [{ action: 'user.block', detail: { reason: 'spam links' } }],
    });
    const blocked = (await (await adminCall('/api/admin/users?filter=blocked', admin)).json()) as { users: { id: string }[] };
    expect(blocked.users.map((u) => u.id)).toEqual([ada.id]);

    // A session made after blocking (as if it slipped through) is refused too.
    await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ('late', ?, 4000000000, 0)").bind(ada.id).run();

    expect((await adminCall(`/api/admin/users/${ada.id}/unblock`, admin, { method: 'POST' })).status).toBe(204);
    expect((await adminCall(`/api/admin/users/${ada.id}/unblock`, admin, { method: 'POST' })).status).toBe(409);
    expect((await call('/api/shares/AbCdEf1234')).status).toBe(200);
    // The profile stays private until the user turns it on again.
    expect((await call(`/api/users/${ada.id}/profile`)).status).toBe(404);
  });

  it('renames, signs out, removes the email address and deletes an account', async () => {
    const { admin } = await setUp();
    const ada = await signedInUser('Rude name', true);
    await env.DB.prepare(
      `INSERT INTO email_prefs (user_id, email, confirmed_at, time_zone, unsubscribe_token, created_at, updated_at) VALUES (?, 'ada@example.com', 1, 'UTC', 'u', 0, 0)`,
    )
      .bind(ada.id)
      .run();
    expect((await adminCall(`/api/admin/users/${ada.id}`, admin, { method: 'PATCH', body: { displayName: '  Ada  ', publicProfile: false } })).status).toBe(204);
    expect(await env.DB.prepare('SELECT display_name, public_profile FROM users WHERE id = ?').bind(ada.id).first()).toEqual({ display_name: 'Ada', public_profile: 0 });
    expect((await adminCall(`/api/admin/users/${ada.id}`, admin, { method: 'PATCH', body: { displayName: '   ' } })).status).toBe(400);
    expect((await adminCall(`/api/admin/users/${ada.id}`, admin, { method: 'PATCH', body: {} })).status).toBe(400);

    const out = await adminCall(`/api/admin/users/${ada.id}/sign-out`, admin, { method: 'POST' });
    expect(await out.json()).toEqual({ sessions: 1 });
    expect((await call('/api/me', { token: ada.token })).status).toBe(401);

    expect((await adminCall(`/api/admin/users/${ada.id}/email`, admin, { method: 'DELETE' })).status).toBe(204);
    expect((await adminCall(`/api/admin/users/${ada.id}/email`, admin, { method: 'DELETE' })).status).toBe(404);

    expect((await adminCall(`/api/admin/users/${ada.id}`, admin, { method: 'DELETE' })).status).toBe(204);
    expect(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(ada.id).first()).toBeNull();
    expect((await adminCall(`/api/admin/users/${ada.id}`, admin, { method: 'DELETE' })).status).toBe(404);
    const audit = (await env.DB.prepare("SELECT action, target, detail FROM admin_audit WHERE action LIKE 'user.%' ORDER BY id").all()).results;
    expect(audit).toEqual([
      { action: 'user.update', target: ada.id, detail: '{"displayName":true,"publicProfile":false}' },
      { action: 'user.sign_out', target: ada.id, detail: null },
      { action: 'user.email.delete', target: ada.id, detail: null },
      { action: 'user.delete', target: ada.id, detail: null },
    ]);
    // The audit log names the account by id only, never its name.
    expect(JSON.stringify(audit)).not.toContain('Ada');
  });
});

describe('admin: short links, overview, health, events', () => {
  beforeEach(() => {
    resetEventThrottle();
    return resetDatabase();
  });

  it('lists and deletes short links', async () => {
    const { admin } = await setUp();
    const ada = await signedInUser('Ada');
    await env.DB.batch([
      env.DB.prepare("INSERT INTO shares (id, user_id, title, source, created_at) VALUES ('AbCdEf1234', ?, 'Shop', 'abc', 5)").bind(ada.id),
      env.DB.prepare("INSERT INTO shares (id, user_id, title, source, created_at) VALUES ('ZyXwVu9876', ?, 'Chat', 'a', 6)").bind(ada.id),
    ]);
    const list = (await (await adminCall('/api/admin/shares', admin)).json()) as { total: number; shares: { id: string; url: string; bytes: number; owner: { id: string } }[] };
    expect(list.total).toBe(2);
    expect(list.shares[0]).toMatchObject({ id: 'ZyXwVu9876', url: `${ORIGIN}/s/ZyXwVu9876`, owner: { id: ada.id, displayName: 'Ada', blocked: false } });
    const found = (await (await adminCall('/api/admin/shares?q=sho', admin)).json()) as { shares: { id: string }[] };
    expect(found.shares.map((s) => s.id)).toEqual(['AbCdEf1234']);
    expect((await adminCall('/api/admin/shares/AbCdEf1234', admin, { method: 'DELETE' })).status).toBe(204);
    expect((await call('/api/shares/AbCdEf1234')).status).toBe(404);
    expect((await adminCall('/api/admin/shares/AbCdEf1234', admin, { method: 'DELETE' })).status).toBe(404);
  });

  it('sums up users, sign-ups, content and usage', async () => {
    const { admin } = await setUp();
    const t = Math.floor(Date.now() / 1000);
    const ada = await signedInUser('Ada', true);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET created_at = ?').bind(t),
      env.DB.prepare("INSERT INTO daily_counts (day, event, count) VALUES (?, 'editor_open', 7)").bind(new Date().toISOString().slice(0, 10)),
    ]);
    await call('/api/me', { token: ada.token });
    const overview = (await (await adminCall('/api/admin/overview', admin)).json()) as {
      users: Record<string, unknown>;
      signups: { day: string; count: number }[];
      usage: { days: { day: string; counts: Record<string, number> }[] };
    };
    expect(overview.users).toMatchObject({ total: 1, public: 1, blocked: 0, new: { day: 1, week: 1, month: 1 }, active: { day: 1, week: 1, month: 1 } });
    expect(overview.signups).toHaveLength(30);
    expect(overview.signups.at(-1)).toEqual({ day: new Date().toISOString().slice(0, 10), count: 1 });
    expect(overview.usage.days.at(-1)!.counts).toEqual({ editor_open: 7 });
  });

  it('records server errors and rate limits without ids, at most once a minute per route', async () => {
    expect(routeOf('/api/users/0b8f6d8e-7d5f-4a39-9a7e-1d2c3b4a5e6f/profile')).toBe('/api/users/:id/profile');
    expect(routeOf('/s/AbCdEf1234.png')).toBe('/s/:id');
    expect(routeOf('/api/problems/url-shortener/runs')).toBe('/api/problems/url-shortener/runs');
    // A 429: the import limiter allows 3 a minute per user.
    const { token } = await signedInUser();
    for (let i = 0; i < 5; i++) await call('/api/me/import', { method: 'POST', token, body: { items: [] } });
    const limited = await events('rate_limited');
    expect(limited).toHaveLength(1);
    expect(JSON.parse(limited[0].detail!)).toEqual({ method: 'POST', path: '/api/me/import' });
  });

  it('shows each cron job’s last run, configuration and table sizes on the health page', async () => {
    const { admin } = await setUp();
    await hourlyCron(env, dailyRun());
    const health = (await (await adminCall('/api/admin/health', admin)).json()) as {
      database: { ok: boolean; tables: Record<string, number> };
      cron: { runs: { job: string; level: string; detail: Record<string, number> }[] };
      config: Record<string, unknown>;
      worker: Record<string, unknown>;
    };
    expect(health.database.ok).toBe(true);
    expect(health.database.tables.users).toBe(0);
    expect(health.cron.runs.map((r) => r.job)).toEqual(['app_events', 'game_runs', 'reminders', 'sessions', 'tombstones', 'usage_counts']);
    expect(health.cron.runs.every((r) => r.level === 'info' && typeof r.detail.ms === 'number')).toBe(true);
    expect(health.config).toMatchObject({ sessionSecret: true, providers: ['github', 'google'], metricsToken: true, setupToken: true });
    expect(health.worker).toMatchObject({ environment: expect.any(String), simVersion: expect.any(Number) });
  });

  it('lists app events and the audit log, newest first, filtered', async () => {
    const { admin } = await setUp();
    const ada = await signedInUser();
    await adminCall(`/api/admin/users/${ada.id}/sign-out`, admin, { method: 'POST' });
    const list = (await (await adminCall('/api/admin/events?kind=admin_setup', admin)).json()) as { events: { kind: string }[]; kinds: { kind: string; n: number }[] };
    expect(list.events.map((e) => e.kind)).toEqual(['admin_setup']);
    expect(list.kinds).toEqual([{ kind: 'admin_setup', n: 1 }]);
    const audit = (await (await adminCall('/api/admin/audit', admin)).json()) as { entries: { action: string; passkey: string }[]; next: number | null };
    expect(audit.entries.map((e) => [e.action, e.passkey])).toEqual([
      ['user.sign_out', 'Laptop'],
      ['admin.setup', 'Laptop'],
    ]);
    expect(audit.next).toBeNull();
  });

  it('prunes old events and audit entries in the daily run', async () => {
    const old = Math.floor(Date.now() / 1000) - 401 * 86_400;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO app_events (at, level, kind, message) VALUES (?, 'info', 'cron', 'x')").bind(old),
      env.DB.prepare("INSERT INTO admin_audit (at, action) VALUES (?, 'user.block')").bind(old),
      env.DB.prepare("INSERT INTO admin_audit (at, action) VALUES (?, 'user.block')").bind(old + 2 * 86_400),
    ]);
    await hourlyCron(env, dailyRun());
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM app_events WHERE message = 'x'").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit').first<{ n: number }>())!.n).toBe(1);
  });
});
