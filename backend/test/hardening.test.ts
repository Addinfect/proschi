import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { SIM_VERSION } from '../../frontend/src/sim/version';
import { SESSION_COOKIE, SESSION_TTL } from '../src/auth';
import { sha256 } from '../src/crypto';
import type { Env } from '../src/env';
import worker from '../src/index';
import { normalizeForCheck, rejectName, wordsForCheck } from '../src/moderation';
import { findProblem, problemIds } from '../src/verify';
import { call, dailyRun, ORIGIN, resetDatabase, signedInUser, WINDOW_TIMEOUT, withinOneWindow } from './helpers';

const ID = 'url-shortener';
const problem = findProblem(ID)!;
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The Worker called directly, as Cloudflare would. */
const incoming = (path: string, init: RequestInit = {}) => new Request(`${ORIGIN}${path}`, init) as Request<unknown, IncomingRequestCfProperties>;

/** The Worker with other bindings, e.g. without SESSION_SECRET. */
async function callWith(overrides: Partial<Env>, path: string, init: RequestInit = {}): Promise<Response> {
  const exec = createExecutionContext();
  const response = await worker.fetch(incoming(path, init), { ...env, ...overrides } as Env, exec);
  await waitOnExecutionContext(exec);
  return response;
}

async function addSession(userId: string, expiresAt: number): Promise<string> {
  const token = `token-${crypto.randomUUID()}`;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, expiresAt, nowSeconds())
    .run();
  return token;
}

const count = async (sql: string, ...params: unknown[]) => (await env.DB.prepare(sql).bind(...params).first<{ n: number }>())!.n;

describe('responses', () => {
  beforeEach(resetDatabase);

  it('carry security headers and a request id, echoing a well-formed one', async () => {
    for (const path of ['/api/health', '/api/nothing', '/api/me', '/auth/github/start?return=/']) {
      const response = await call(path, { redirect: 'manual' });
      expect(response.headers.get('X-Content-Type-Options'), path).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options'), path).toBe('DENY');
      expect(response.headers.get('Referrer-Policy'), path).toBe('no-referrer');
      expect(response.headers.get('Content-Security-Policy'), path).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(response.headers.get('Strict-Transport-Security'), path).toBe('max-age=63072000; includeSubDomains');
      expect(response.headers.get('Cross-Origin-Resource-Policy'), path).toBe('same-origin');
      expect(response.headers.get('X-Request-Id'), path).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect((await call('/api/health', { headers: { 'X-Request-Id': 'edge-42_a' } })).headers.get('X-Request-Id')).toBe('edge-42_a');
    expect((await call('/api/health', { headers: { 'X-Request-Id': 'not ok!' } })).headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET /api/health checks D1', async () => {
    const response = await call('/api/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, env: 'production', simVersion: SIM_VERSION });
    const broken = {
      prepare() {
        throw new Error('D1 is down');
      },
    } as unknown as D1Database;
    expect((await callWith({ DB: broken }, '/api/health')).status).toBe(503);
  });

  it('refuses a body over 128 KiB, and accepts a same-site change without an Origin header', async () => {
    const { token } = await signedInUser();
    expect((await call('/api/me', { method: 'PATCH', token, body: { displayName: 'x'.repeat(130 * 1024) } })).status).toBe(413);
    // Same-origin fetches and older browsers may leave Origin out; the SameSite cookie still protects them.
    const noOrigin = await callWith({}, '/api/me', {
      method: 'PATCH',
      headers: { Cookie: `${SESSION_COOKIE}=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicProfile: true }),
    });
    expect(noOrigin.status).toBe(200);
  });

  it('answers 404 for stats of an unknown problem', async () => {
    expect((await call('/api/stats/no-such-problem')).status).toBe(404);
  });
});

describe('sign-in without a usable SESSION_SECRET', () => {
  it('offers no provider and refuses to start or finish a sign-in', async () => {
    for (const secret of [undefined, 'short']) {
      expect(await (await callWith({ SESSION_SECRET: secret }, '/auth/providers')).json()).toEqual({ providers: [] });
      const start = await callWith({ SESSION_SECRET: secret }, '/auth/github/start?return=/', { redirect: 'manual' });
      expect(start.status).toBe(503);
      expect(await start.json()).toEqual({ error: 'Sign-in is unavailable (server misconfigured)' });
      expect((await callWith({ SESSION_SECRET: secret }, '/auth/github/callback?code=x&state=y', { redirect: 'manual' })).status).toBe(503);
    }
  });

  it('limits sign-in attempts per IP', async () => {
    const headers = { 'CF-Connecting-IP': `test-${crypto.randomUUID()}` };
    await withinOneWindow();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await call('/auth/github/start?return=/', { headers, redirect: 'manual' })).status);
    expect(statuses.slice(0, 20).every((s) => s === 302)).toBe(true);
    expect(statuses[20]).toBe(429);
  }, WINDOW_TIMEOUT);
});

describe('sessions', () => {
  beforeEach(resetDatabase);

  it('refuses an expired session', async () => {
    const { id } = await signedInUser();
    const token = await addSession(id, nowSeconds() - 1);
    expect((await call('/api/me', { token })).status).toBe(401);
  });

  it('renews a session used in the second half of its life, and only then', async () => {
    const { id, token: fresh } = await signedInUser();
    expect((await call('/api/me', { token: fresh })).headers.getSetCookie()).toEqual([]);

    const token = await addSession(id, nowSeconds() + SESSION_TTL / 2 - 60);
    const response = await call('/api/me', { token });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([`${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; Secure; SameSite=Lax`]);
    const expires = await count('SELECT expires_at AS n FROM sessions WHERE token_hash = ?', await sha256(token));
    expect(expires).toBeGreaterThanOrEqual(nowSeconds() + SESSION_TTL - 5);
  });

  it('signs out everywhere', async () => {
    const { id, token } = await signedInUser();
    const other = await addSession(id, nowSeconds() + 3600);
    const someoneElse = await signedInUser();
    const response = await call('/api/me/sessions/revoke-all', { method: 'POST', token });
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(new RegExp(`^${SESSION_COOKIE}=; .*Max-Age=0`))]);
    expect((await call('/api/me', { token })).status).toBe(401);
    expect((await call('/api/me', { token: other })).status).toBe(401);
    expect((await call('/api/me', { token: someoneElse.token })).status).toBe(200);
  });

  it('the daily cron deletes expired sessions', async () => {
    const { id } = await signedInUser();
    await addSession(id, nowSeconds() - 10);
    await addSession(id, nowSeconds() - 1);
    await worker.scheduled(createScheduledController({ cron: '17 * * * *', scheduledTime: dailyRun() }), env);
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', id)).toBe(1);
  });
});

describe('display names', () => {
  beforeEach(resetDatabase);

  it('fold look-alikes before checking', () => {
    expect(normalizeForCheck('Pr0schi  Admin')).toBe('proschiadmin');
    expect(normalizeForCheck('ＡＤＭ１Ｎ')).toBe('admin');
    expect(rejectName('Mod')).toBeTruthy();
    expect(rejectName('Ada Lovelace')).toBeUndefined();
  });

  it('match staff words as whole words only, the site name anywhere', () => {
    expect(wordsForCheck('4dm1n_42 Bob')).toEqual(['admin', 'dmn', 'a', 'bob', 'bob']);
    for (const name of ['Pr0schi Admin', 'admin 42', 'Admin42', 'The 4dm1n', 'chief-moderator', 'ProschiFan']) {
      expect(rejectName(name), name).toMatch(/staff/);
    }
    for (const name of ['Badminton', 'Modest Mouse', 'Administrative Ada', 'System Design Fan', 'Root Beer']) {
      expect(rejectName(name), name).toBeUndefined();
    }
  });

  it('PATCH /api/me validates them', async () => {
    const { token } = await signedInUser('Ada');
    const patch = async (body: unknown) => {
      const response = await call('/api/me', { method: 'PATCH', token, body });
      return { status: response.status, body: (await response.json()) as { error?: string } };
    };
    expect((await patch({ displayName: '' })).status).toBe(400);
    expect((await patch({ displayName: 42 })).status).toBe(400);
    expect((await patch({ publicProfile: 'yes' })).status).toBe(400);
    expect(await patch({ displayName: 'Pr0schi Admin' })).toEqual({ status: 400, body: { error: expect.stringMatching(/staff/) } });
    expect(await patch({ displayName: 'support' })).toEqual({ status: 400, body: { error: expect.stringMatching(/reserved/) } });
    expect(await patch({ displayName: 'F.u.c.k' })).toEqual({ status: 400, body: { error: expect.stringMatching(/not allowed/) } });
    expect((await patch({ displayName: 'Grace' })).status).toBe(200);
  });
});

describe('progress import', () => {
  beforeEach(resetDatabase);

  const importItems = (token: string, items: unknown) => call('/api/me/import', { method: 'POST', token, body: { items } });

  it('imports the browser’s progress in one request, verifying solves and skipping unknown problems', async () => {
    const { token } = await signedInUser();
    const response = await importItems(token, [
      { problemId: ID, source: problem.solution, solved: true },
      { problemId: 'chat', source: 'mine', solved: true },
      { problemId: 'no-such-problem', source: 'x', solved: false },
    ]);
    expect(await response.json()).toEqual({ imported: 2, skipped: ['no-such-problem'] });
    const me = (await (await call('/api/me', { token })).json()) as { progress: Record<string, Record<string, unknown>> };
    expect(me.progress[ID]).toMatchObject({ status: 'solved', runs: 1, source: problem.solution });
    expect(me.progress[ID].runsToSolve).toBeUndefined();
    // The page claimed a solve the server does not confirm.
    expect(me.progress.chat).toMatchObject({ status: 'attempted', source: 'mine' });
  });

  it('validates the upload and limits it to 3 a minute', async () => {
    const { token } = await signedInUser();
    expect((await importItems(token, 'all')).status).toBe(400);
    expect((await importItems(token, [{ problemId: ID, source: 1, solved: false }])).status).toBe(400);
    const tooMany = Array.from({ length: problemIds().length + 1 }, () => ({ problemId: ID, source: '', solved: false }));
    expect((await importItems(token, tooMany)).status).toBe(413);
    expect((await importItems(token, [{ problemId: ID, source: 'x'.repeat(600 * 1024), solved: false }])).status).toBe(413);

    await withinOneWindow();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await importItems(token, [{ problemId: ID, source: 'x', solved: false }])).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await importItems(token, []);
    expect(limited.headers.get('Retry-After')).toBe('60');
  }, WINDOW_TIMEOUT);
});

describe('data export', () => {
  beforeEach(resetDatabase);

  it('downloads everything stored about the user, without session token hashes', async () => {
    const { id, token } = await signedInUser('Ada');
    await addSession(id, nowSeconds() + 3600);
    await call(`/api/problems/${ID}/runs`, { method: 'POST', token, body: { source: problem.solution, solved: true } });
    const response = await call('/api/me/export', { token });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="proschi-data.json"');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      exportedAt: expect.any(Number),
      user: { id, displayName: 'Ada', publicProfile: false, dailyGoal: 10, createdAt: 0, lastSeenDay: new Date().toISOString().slice(0, 10), plan: 'free' },
      identities: [{ provider: 'github', subject: id }],
      sessions: [
        { kind: 'web', createdAt: 0, expiresAt: 4_000_000_000 },
        { kind: 'web', createdAt: expect.any(Number), expiresAt: expect.any(Number) },
      ],
      progress: [
        {
          problemId: ID,
          runs: 1,
          source: problem.solution,
          firstRunAt: expect.any(Number),
          updatedAt: expect.any(Number),
          solvedAt: expect.any(Number),
          solvedDay: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          runsToSolve: 1,
          bestCostUsd: expect.any(Number),
          bestP99Ms: expect.any(Number),
          bestCostAt: expect.any(Number),
          bestP99At: expect.any(Number),
          simVersion: SIM_VERSION,
          problemVersion: 1,
        },
      ],
      cardReviews: [],
      cardStates: [],
      achievements: [],
      challengeAttempts: [],
      game: { meta: null, runs: [] },
      lessonReads: [],
      shares: [],
      documents: [],
      documentVersions: [],
      emailReminders: null,
    });
    expect(text).not.toContain(await sha256(token));
    expect(text).not.toContain(token);
  });
});

describe('versions', () => {
  beforeEach(resetDatabase);

  const run = (token: string, body: Record<string, unknown>, id = ID) => call(`/api/problems/${id}/runs`, { method: 'POST', token, body });

  it('stats and the leaderboard count only progress on the current simulation and problem versions', async () => {
    const current = await signedInUser('Current', true);
    const oldSim = await signedInUser('OldSim', true);
    const oldProblem = await signedInUser('OldProblem', true);
    for (const u of [current, oldSim, oldProblem]) await run(u.token, { source: problem.solution, solved: true });
    await env.DB.prepare('UPDATE progress SET sim_version = ? WHERE user_id = ?').bind(SIM_VERSION - 1, oldSim.id).run();
    await env.DB.prepare('UPDATE progress SET problem_version = 0 WHERE user_id = ?').bind(oldProblem.id).run();
    // A problem that was removed.
    await env.DB.prepare(
      `INSERT INTO progress (user_id, problem_id, runs, first_run_at, updated_at, solved_at, runs_to_solve, best_cost_usd)
       VALUES (?, 'removed-problem', 1, 0, 0, 0, 1, 1)`,
    )
      .bind(oldSim.id)
      .run();

    const summary = (await (await call('/api/stats')).json()) as Record<string, any>;
    expect(summary.problems[ID]).toEqual({ attempted: 1, solved: 1, medianRunsToSolve: 1 });
    expect(summary.problems['removed-problem']).toBeUndefined();
    expect(summary.solvers).toBe(1);
    expect(await (await call(`/api/stats/${ID}`)).json()).toMatchObject({ attempted: 1, solved: 1, costUsd: { count: 1 } });
    // Their own stale solve does not place them among the others either.
    expect(((await (await call(`/api/stats/${ID}`, { token: oldSim.token })).json()) as Record<string, any>).you).toBeNull();
    const board = (await (await call('/api/leaderboard')).json()) as Record<string, any>;
    expect(board.entries.map((e: { displayName: string }) => e.displayName)).toEqual(['Current']);
  });

  it('starts a problem over on the first run after its version changed', async () => {
    const { id, token } = await signedInUser();
    await run(token, { source: problem.starter, solved: false });
    await run(token, { source: problem.solution, solved: true });
    await env.DB.prepare('UPDATE progress SET problem_version = 0 WHERE user_id = ?').bind(id).run();

    // An import does not: it neither counts as a run nor replaces what is stored.
    expect(await (await run(token, { source: 'x', solved: false, imported: true })).json()).toMatchObject({ progress: { status: 'solved', runs: 2 } });

    const next = (await (await run(token, { source: problem.starter, solved: false })).json()) as Record<string, any>;
    expect(next.progress).toEqual({ status: 'attempted', runs: 1, source: problem.starter });
    const row = await env.DB.prepare('SELECT sim_version, problem_version FROM progress WHERE user_id = ?').bind(id).first();
    expect(row).toEqual({ sim_version: SIM_VERSION, problem_version: 1 });
    expect(await (await run(token, { source: problem.solution, solved: true })).json()).toMatchObject({ progress: { status: 'solved', runs: 2, runsToSolve: 2 } });
  });
});
