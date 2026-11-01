import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { login, runAuth } from '../src/login';
import { BASE, FakeApi, tempStore } from './fakeApi';

/** A GET to the CLI's loopback server, as the browser makes it after the sign-in. */
function visit(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    })
      .on('error', reject)
      .end();
  });
}

/** A fake browser: records the sign-in URL and comes back to the redirect_uri with `params(start)`. */
function browser(params: (start: URL) => Record<string, string>, pages: { status: number; body: string }[] = []) {
  const opened: URL[] = [];
  let visits: Promise<void> = Promise.resolve();
  const open = (href: string) => (visits = go(href));
  const go = async (href: string) => {
    const start = new URL(href);
    opened.push(start);
    const back = new URL(start.searchParams.get('redirect_uri')!);
    back.search = new URLSearchParams(params(start)).toString();
    // Something else on the port first, as a browser's favicon request would be.
    pages.push(await visit(`${back.origin}/favicon.ico`));
    pages.push(await visit(back.href));
  };
  // The CLI does not wait for the browser; tests wait for its pages with `visited()`.
  return { open, opened, pages, visited: () => visits };
}

describe('proschi login', () => {
  it('signs in with PKCE S256 over a loopback redirect and stores the tokens, never printing them', async () => {
    const api = new FakeApi();
    const store = tempStore(false);
    const b = browser((start) => ({ code: 'the-code', state: start.searchParams.get('state')! }));
    const out: string[] = [];
    const code = await runAuth('login', ['--base', BASE, '--provider', 'google'], (s) => out.push(s), (s) => out.push(s), { store, fetch: api.fetch, open: b.open });
    expect(code).toBe(0);
    await b.visited();
    const start = b.opened[0];
    expect(start.origin + start.pathname).toBe(`${BASE}/auth/google/start`);
    expect(start.searchParams.get('client')).toBe('proschi-cli');
    expect(start.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*\/callback$/);
    expect(start.searchParams.get('state')!.length).toBeGreaterThanOrEqual(32);
    expect(b.pages.map((p) => p.status)).toEqual([404, 200]);
    expect(b.pages[1].body).toContain('You can close this tab');
    expect(store.get(BASE)).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    expect(out.join('\n')).toContain(start.href); // The link, for a machine without a browser.
    expect(out.at(-1)).toBe(`Signed in to ${BASE}`);
    expect(out.join('\n')).not.toMatch(/access-2|refresh-2|the-code/);
    expect(api.calls).toEqual(['POST /auth/token']);
  });

  it('rejects a callback whose state does not match, without exchanging the code', async () => {
    const api = new FakeApi();
    const store = tempStore(false);
    const b = browser(() => ({ code: 'the-code', state: 'forged' }));
    await expect(login({ base: BASE, store, fetch: api.fetch, open: b.open })).rejects.toThrow(/state mismatch/);
    await b.visited();
    expect(b.pages[1].status).toBe(400);
    expect(api.calls).toEqual([]);
    expect(store.get(BASE)).toBeUndefined();
  });

  it('reports a cancelled sign-in', async () => {
    const b = browser((start) => ({ error: 'access_denied', state: start.searchParams.get('state')! }));
    await expect(login({ base: BASE, store: tempStore(false), fetch: new FakeApi().fetch, open: b.open })).rejects.toThrow('The sign-in was cancelled');
  });

  it('times out when the browser never comes back, and closes the server', async () => {
    let redirect = '';
    const open = async (href: string) => void (redirect = new URL(href).searchParams.get('redirect_uri')!);
    await expect(login({ base: BASE, store: tempStore(false), fetch: new FakeApi().fetch, open, timeoutMs: 50 })).rejects.toThrow(/No sign-in within .*; run proschi login again/);
    await expect(visit(redirect)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('prints the link when no browser opens, and refuses a non-https site', async () => {
    const out: string[] = [];
    expect(await runAuth('login', ['--base', 'http://proschi.app'], (s) => out.push(s), (s) => out.push(s))).toBe(2);
    expect(out.pop()).toMatch(/not https/);
    expect(await runAuth('login', ['--provider', 'gitlab'], (s) => out.push(s), (s) => out.push(s))).toBe(2);
    expect(out.pop()).toBe("Unknown provider 'gitlab'; use github or google");

    const b = browser((start) => ({ code: 'the-code', state: start.searchParams.get('state')! }));
    const open = async (href: string) => {
      setTimeout(() => void b.open(href), 10);
      throw new Error('no browser');
    };
    expect(await runAuth('login', ['--base', BASE], (s) => out.push(s), (s) => out.push(s), { store: tempStore(false), fetch: new FakeApi().fetch, open })).toBe(0);
    expect(out).toContain('Could not open a browser; open the link above.');
  });
});

describe('proschi logout and whoami', () => {
  it('revokes the refresh token and deletes the stored tokens', async () => {
    const api = new FakeApi();
    const store = tempStore();
    const out: string[] = [];
    const deps = { store, fetch: api.fetch };
    expect(await runAuth('whoami', ['--base', BASE], (s) => out.push(s), (s) => out.push(s), deps)).toBe(0);
    expect(out.pop()).toBe(`Signed in to ${BASE} as Ada`);
    expect(await runAuth('logout', ['--base', BASE], (s) => out.push(s), (s) => out.push(s), deps)).toBe(0);
    expect(out.pop()).toBe(`Signed out of ${BASE}`);
    expect(api.refreshTokens.has('refresh-1')).toBe(false);
    expect(store.get(BASE)).toBeUndefined();
    expect(await runAuth('logout', ['--base', BASE], (s) => out.push(s), (s) => out.push(s), deps)).toBe(0);
    expect(out.pop()).toBe(`Not signed in to ${BASE}`);
    expect(await runAuth('whoami', ['--base', BASE], (s) => out.push(s), (s) => out.push(s), deps)).toBe(1);
    expect(out.pop()).toBe(`error: Not signed in to ${BASE}; run proschi login`);
  });

  it('deletes the tokens even when the site cannot be reached', async () => {
    const store = tempStore();
    const out: string[] = [];
    const offline = async () => {
      throw new Error('offline');
    };
    expect(await runAuth('logout', ['--base', BASE], (s) => out.push(s), (s) => out.push(s), { store, fetch: offline })).toBe(0);
    expect(out.pop()).toMatch(/^Deleted the stored sign-in/);
    expect(store.get(BASE)).toBeUndefined();
  });
});
