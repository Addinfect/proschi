import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * The admin panel (/admin/) in the build with accounts, API mocked: the
 * passkey gate before setup and after, and signed in, the overview, an
 * account's detail and blocking it.
 */

const USER = '22222222-2222-4222-8222-222222222222';
const today = new Date().toISOString().slice(0, 10);
const days = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10));

const OVERVIEW = {
  users: { total: 3, blocked: 0, public: 1, emailReminders: 1, new: { day: 1, week: 2, month: 3 }, active: { day: 1, week: 2, month: 2 } },
  signups: days.map((day) => ({ day, count: day === today ? 1 : 0 })),
  content: { shares: 1, documents: 0, attempts: 1, solves: 1, cardReviews: 0, challenges: 0, gameRuns: 0 },
  usage: { events: ['editor_open', 'practice_open'], days: days.map((day) => ({ day, counts: day === today ? { editor_open: 41 } : {} })) },
  events: [{ kind: 'server_error', level: 'error', n: 2 }],
};

const USERS = {
  total: 1,
  offset: 0,
  pageSize: 50,
  users: [{ id: USER, displayName: 'spammer9000', publicProfile: false, createdAt: 1_800_000_000, lastSeenDay: today, blockedAt: null, blockedReason: null, providers: ['google'], solved: 0, hasEmail: false }],
};

function detail(blocked: boolean) {
  return {
    user: { id: USER, displayName: 'spammer9000', publicProfile: false, dailyGoal: 10, createdAt: 1_800_000_000, lastSeenDay: today, blockedAt: blocked ? 1_800_000_100 : null, blockedReason: blocked ? 'spam' : null, plan: 'free' },
    identities: [{ provider: 'google', subject: 'g-77' }],
    sessions: blocked ? [] : [{ kind: 'web', count: 1, lastCreatedAt: 1_800_000_000 }],
    progress: [],
    cards: { reviews: 0, cards: 0, lastReviewAt: null },
    achievements: 0,
    lessonsRead: 0,
    challenges: { submitted: 0, best: null, lastDay: null },
    game: { runs: 0, submitted: 0, best: null, lastStartedAt: null },
    shares: [{ id: 'AbCdEf1234', title: 'Buy cheap stuff', createdAt: 1_800_000_000, hasImage: false }],
    documents: { count: 0, bytes: 0, lastUpdatedAt: null },
    email: null,
    audit: blocked ? [{ id: 1, at: 1_800_000_100, action: 'user.block', detail: { reason: 'spam' } }] : [],
  };
}

async function mockAdmin(page: Page, status: { passkeys: boolean; setupAvailable: boolean; signedIn: boolean }) {
  let blocked = false;
  const posts: { path: string; body: unknown }[] = [];
  await page.route(
    (url) => url.pathname.startsWith('/api/admin/'),
    (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') {
        posts.push({ path, body: request.postDataJSON() });
        if (path.endsWith('/block')) blocked = true;
        return route.fulfill({ status: 204 });
      }
      if (path === '/api/admin/status') return route.fulfill({ json: status });
      if (path === '/api/admin/overview') return route.fulfill({ json: OVERVIEW });
      if (path === '/api/admin/users') return route.fulfill({ json: USERS });
      if (path === `/api/admin/users/${USER}`) return route.fulfill({ json: detail(blocked) });
      return route.fulfill({ status: 404, json: { error: `not mocked: ${path}` } });
    },
  );
  return posts;
}

test.describe('admin panel', () => {
  test('asks for the setup token before the first passkey, and for the passkey after', async ({ page }) => {
    await mockAdmin(page, { passkeys: false, setupAvailable: true, signedIn: false });
    await page.goto('admin/');
    await expect(page.getByRole('heading', { name: 'Set up the admin panel' })).toBeVisible();
    await expect(page.getByLabel('Setup token')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create passkey' })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await mockAdmin(page, { passkeys: true, setupAvailable: false, signedIn: false });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible();
    await expect(page.getByLabel('Setup token')).toHaveCount(0);
  });

  test('without a setup token, says how to set one', async ({ page }) => {
    await mockAdmin(page, { passkeys: false, setupAvailable: false, signedIn: false });
    await page.goto('admin/');
    await expect(page.getByText('npx wrangler secret put ADMIN_SETUP_TOKEN')).toBeVisible();
  });

  test('signed in: the overview, an account, and blocking it', async ({ page }) => {
    const posts = await mockAdmin(page, { passkeys: true, setupAvailable: false, signedIn: true });
    await page.goto('admin/');
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('figure', { name: /Sign-ups/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Server error: 2' })).toBeVisible();

    await page.getByRole('tab', { name: 'Users' }).click();
    await expect(page).toHaveURL(/#\/users$/);
    await page.getByRole('button', { name: 'spammer9000' }).click();
    await expect(page).toHaveURL(new RegExp(`#/users/${USER}$`));
    await expect(page.getByRole('heading', { name: 'spammer9000' })).toBeVisible();
    await expect(page.getByText('free plan')).toBeVisible();

    await page.getByLabel('Reason for blocking').fill('spam');
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(page.getByText('Blocked and signed out.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unblock' })).toBeVisible();
    expect(posts).toEqual([{ path: `/api/admin/users/${USER}/block`, body: { reason: 'spam' } }]);

    await page.getByRole('button', { name: '← All accounts' }).click();
    await expect(page).toHaveURL(/#\/users$/);
  });
});
