import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiClient, NotSignedInError } from '../src/api';
import { credentialsPath, normalizeBase } from '../src/credentials';
import { BASE, FakeApi, fakeClient, tempStore } from './fakeApi';

describe('credentials store', () => {
  it('lives in the per-user config folder', () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: '/x/conf' }, 'linux', '/home/a')).toBe('/x/conf/proschi/credentials.json');
    expect(credentialsPath({}, 'darwin', '/Users/a')).toBe('/Users/a/.config/proschi/credentials.json');
    expect(credentialsPath({ XDG_CONFIG_HOME: 'relative' }, 'linux', '/home/a')).toBe('/home/a/.config/proschi/credentials.json');
    expect(credentialsPath({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a')).toMatch(/proschi[\\/]credentials\.json$/);
  });

  it.skipIf(process.platform === 'win32')('is readable by the user only, written atomically, and keyed by site', () => {
    const store = tempStore(false);
    store.set(BASE, { accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
    store.set('https://other.test', { accessToken: 'b', refreshToken: 's', expiresAt: 2 });
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(store.file)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(store.file))).toEqual(['credentials.json']);
    store.delete(BASE);
    expect(store.get(BASE)).toBeUndefined();
    expect(store.get('https://other.test')?.accessToken).toBe('b');
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(store.file))).toEqual(['credentials.json']);
  });

  it('ignores malformed sessions and reports a broken file', () => {
    const store = tempStore();
    writeFileSync(store.file, JSON.stringify({ version: 1, sessions: { [BASE]: { accessToken: 1 } } }));
    expect(store.get(BASE)).toBeUndefined();
    writeFileSync(store.file, '{');
    expect(() => store.get(BASE)).toThrow(/is not valid JSON; delete it and run proschi login/);
  });

  it('accepts https sites and http on localhost only', () => {
    expect(normalizeBase('https://proschi.app/')).toBe('https://proschi.app');
    expect(normalizeBase('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(() => normalizeBase('http://proschi.app')).toThrow(/not https/);
    expect(() => normalizeBase('http://localhost.evil.test')).toThrow(/not https/);
    expect(() => normalizeBase('file:///etc/passwd')).toThrow(/not https/);
    expect(() => normalizeBase('https://user:pw@proschi.app')).toThrow(/address only/);
    expect(() => normalizeBase('https://proschi.app/app?x=1')).toThrow(/address only/);
    expect(() => normalizeBase('nope')).toThrow(/not a URL/);
  });
});

describe('API client', () => {
  it('sends the bearer token', async () => {
    const api = new FakeApi();
    expect(await fakeClient(api).get('/api/me')).toMatchObject({ user: { displayName: 'Ada' } });
    expect(api.calls).toEqual(['GET /api/me']);
  });

  it('refreshes an expired token first, storing the rotated pair', async () => {
    const api = new FakeApi();
    const store = tempStore();
    store.set(BASE, { ...store.get(BASE)!, expiresAt: Date.now() - 1 });
    await fakeClient(api, store).get('/api/me');
    expect(api.calls).toEqual(['POST /auth/token', 'GET /api/me']);
    expect(store.get(BASE)).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    expect(readFileSync(store.file, 'utf8')).not.toContain('refresh-1');
  });

  it('refreshes once after a 401 and retries', async () => {
    const api = new FakeApi();
    api.access.clear(); // Revoked or expired early.
    const store = tempStore();
    await fakeClient(api, store).get('/api/me');
    expect(api.calls).toEqual(['GET /api/me', 'POST /auth/token', 'GET /api/me']);
    expect(store.get(BASE)?.refreshToken).toBe('refresh-2');
  });

  it('ends the sign-in when the refresh token is refused', async () => {
    const api = new FakeApi();
    api.access.clear();
    api.refreshTokens.clear();
    const store = tempStore();
    await expect(fakeClient(api, store).get('/api/me')).rejects.toThrow(new NotSignedInError(`The sign-in to ${BASE} has ended; run proschi login`));
    expect(store.get(BASE)).toBeUndefined();
  });

  it('refreshes once when two clients find the token expired together', async () => {
    const api = new FakeApi();
    const store = tempStore();
    store.set(BASE, { ...store.get(BASE)!, expiresAt: Date.now() - 1 });
    const a = new ApiClient({ base: BASE, store, fetch: api.fetch });
    const b = new ApiClient({ base: BASE, store, fetch: api.fetch });
    await Promise.all([a.get('/api/me'), b.get('/api/me')]);
    expect(api.calls.filter((c) => c === 'POST /auth/token')).toHaveLength(1);
    expect(readdirSync(dirname(store.file))).toEqual(['credentials.json']);
  });

  it('says to sign in without tokens, and never follows redirects', async () => {
    const api = new FakeApi();
    await expect(fakeClient(api, tempStore(false)).get('/api/me')).rejects.toThrow(`Not signed in to ${BASE}; run proschi login`);
    const seen: RequestInit[] = [];
    const client = new ApiClient({ base: BASE, store: tempStore(), fetch: async (url, init) => (seen.push(init), api.fetch(url, init)) });
    await client.get('/api/me');
    expect(seen[0].redirect).toBe('error');
  });
});
