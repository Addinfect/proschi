import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FREE_LIMITS, limitsFor, PLANS } from '../src/plans';
import { call, resetDatabase, signedInUser } from './helpers';

/** Plans and their limits: src/plans.ts and GET /api/me/limits. */

describe('plans', () => {
  beforeEach(resetDatabase);
  afterEach(() => {
    delete PLANS.team;
  });

  it('give an unknown plan the free limits', () => {
    expect(FREE_LIMITS).toEqual({ documents: 5, versionsPerDocument: 20, documentBytes: 64 * 1024 });
    expect(limitsFor('free')).toBe(FREE_LIMITS);
    expect(limitsFor('gold')).toBe(FREE_LIMITS);
    expect(limitsFor('toString')).toBe(FREE_LIMITS);
    expect(limitsFor(null)).toBe(FREE_LIMITS);
  });

  it('are reported with what the account uses', async () => {
    expect((await call('/api/me/limits')).status).toBe(401);
    const { id, token } = await signedInUser();
    expect((await env.DB.prepare('SELECT plan FROM users WHERE id = ?').bind(id).first<{ plan: string }>())?.plan).toBe('free');
    await call('/api/me/documents/d1', { method: 'PUT', token, body: { name: 'a.proschi', source: '', baseVersion: 0 } });
    const response = await call('/api/me/limits', { token });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ plan: 'free', limits: FREE_LIMITS, usage: { documents: 1 } });

    await env.DB.prepare("UPDATE users SET plan = 'gold' WHERE id = ?").bind(id).run();
    expect(await (await call('/api/me/limits', { token })).json()).toMatchObject({ plan: 'free', limits: FREE_LIMITS });
  });

  it("apply the account's plan to synced diagrams", async () => {
    PLANS.team = { documents: 1, versionsPerDocument: 2, documentBytes: 10 };
    const { id, token } = await signedInUser();
    await env.DB.prepare("UPDATE users SET plan = 'team' WHERE id = ?").bind(id).run();
    expect(await (await call('/api/me/limits', { token })).json()).toMatchObject({ plan: 'team', limits: PLANS.team });
    const put = (docId: string, source: string) => call(`/api/me/documents/${docId}`, { method: 'PUT', token, body: { name: 'a.proschi', source, baseVersion: 0 } });
    expect((await put('big', 'x'.repeat(11))).status).toBe(413);
    expect((await put('d1', 'x'.repeat(10))).status).toBe(200);
    const full = await put('d2', '');
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: 'document_limit', limit: 1, used: 1 });
    expect(await (await call('/api/me/documents', { token })).json()).toMatchObject({ limit: 1, used: 1 });
  });
});
