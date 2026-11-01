import { SIM_VERSION } from '../../frontend/src/sim/version';
import { METRIC_EVENTS } from '../../frontend/src/services/metricsEvents';
import { auditStatement, requireAdmin, MIN_SETUP_TOKEN } from './adminAuth';
import { cleanName, configuredProviders } from './auth';
import type { Ctx } from './context';
import { now, secretOk, type Env } from './env';
import { HttpError, json, readJson } from './http';
import { errorText } from './log';

/**
 * The admin panel's data (/admin/, backend/README.md "Admin panel"); every
 * route needs an admin session (src/adminAuth.ts). What the admin changes is
 * written to the audit log (`admin_audit`) in the same batch as the change.
 *
 *   GET    /api/admin/overview                   users, sign-ups, activity, content and usage counts
 *   GET    /api/admin/health                     database, cron jobs, configuration, errors
 *   GET    /api/admin/users?q=&filter=&sort=&offset=   accounts, 50 at a time
 *   GET    /api/admin/users/<id>                 one account in detail
 *   PATCH  /api/admin/users/<id> {displayName?, publicProfile?}
 *   POST   /api/admin/users/<id>/block {reason?} blocks it: signed out everywhere, no sign-in, profile and short links hidden
 *   POST   /api/admin/users/<id>/unblock
 *   POST   /api/admin/users/<id>/sign-out        ends its sessions and apps' tokens
 *   DELETE /api/admin/users/<id>/email           removes its email reminders' address
 *   DELETE /api/admin/users/<id>                 deletes the account and everything in it
 *   GET    /api/admin/shares?q=&offset=          short links, newest first
 *   DELETE /api/admin/shares/<id>
 *   GET    /api/admin/events?kind=&level=&before=   app events, newest first
 *   GET    /api/admin/audit?before=              the audit log, newest first
 */

const NO_STORE = { 'Cache-Control': 'no-store' };
const PAGE = 50;
const DAY = 86_400;
export const AUDIT_RETENTION_DAYS = 400;

const utcDay = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

/** `a***@example.com`: enough to recognise an address, not to copy it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

function offsetOf(url: URL): number {
  const offset = Number(url.searchParams.get('offset') ?? 0);
  return Number.isInteger(offset) && offset >= 0 && offset <= 1_000_000 ? offset : 0;
}

/** A LIKE pattern matching `text` anywhere, its own % and _ taken literally. */
const contains = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** GET /api/admin/overview */
export async function getOverview(request: Request, ctx: Ctx): Promise<Response> {
  await requireAdmin(request, ctx);
  const { DB } = ctx.env;
  const t = now();
  const today = utcDay(t);
  const dayAgo = (n: number) => utcDay(t - n * DAY);
  const since30 = t - 30 * DAY;
  const [users, signups, content, usage, events] = await DB.batch([
    DB.prepare(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(blocked_at IS NOT NULL), 0) AS blocked,
         COALESCE(SUM(public_profile = 1), 0) AS public,
         COALESCE(SUM(created_at >= ?1), 0) AS new_1d,
         COALESCE(SUM(created_at >= ?2), 0) AS new_7d,
         COALESCE(SUM(created_at >= ?3), 0) AS new_30d,
         COALESCE(SUM(last_seen_day = ?4), 0) AS active_1d,
         COALESCE(SUM(last_seen_day >= ?5), 0) AS active_7d,
         COALESCE(SUM(last_seen_day >= ?6), 0) AS active_30d,
         (SELECT COUNT(*) FROM email_prefs WHERE confirmed_at IS NOT NULL) AS emails
       FROM users`,
    ).bind(t - DAY, t - 7 * DAY, since30, today, dayAgo(6), dayAgo(29)),
    DB.prepare(`SELECT date(created_at, 'unixepoch') AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day ORDER BY day`).bind(since30),
    DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM shares) AS shares,
         (SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL) AS documents,
         (SELECT COUNT(*) FROM progress) AS attempts,
         (SELECT COUNT(*) FROM progress WHERE solved_at IS NOT NULL) AS solves,
         (SELECT COUNT(*) FROM card_reviews) AS card_reviews,
         (SELECT COUNT(*) FROM challenge_attempts WHERE submitted_at IS NOT NULL) AS challenges,
         (SELECT COUNT(*) FROM game_runs WHERE submitted_at IS NOT NULL) AS game_runs`,
    ),
    DB.prepare('SELECT day, event, count FROM daily_counts WHERE day >= ? ORDER BY day').bind(dayAgo(29)),
    DB.prepare(`SELECT kind, level, COUNT(*) AS n FROM app_events WHERE at >= ? GROUP BY kind, level`).bind(t - DAY),
  ]);
  const u = users.results[0] as Record<string, number>;
  const c = content.results[0] as Record<string, number>;
  const days: { day: string; counts: Record<string, number> }[] = [];
  const byDay = new Map<string, Record<string, number>>();
  for (let i = 29; i >= 0; i--) {
    const counts: Record<string, number> = {};
    days.push({ day: dayAgo(i), counts });
    byDay.set(dayAgo(i), counts);
  }
  for (const r of usage.results as { day: string; event: string; count: number }[]) {
    const counts = byDay.get(r.day);
    if (counts) counts[r.event] = r.count;
  }
  const signupsByDay = new Map((signups.results as { day: string; n: number }[]).map((r) => [r.day, r.n]));
  return json(
    {
      users: {
        total: u.total,
        blocked: u.blocked,
        public: u.public,
        emailReminders: u.emails,
        new: { day: u.new_1d, week: u.new_7d, month: u.new_30d },
        active: { day: u.active_1d, week: u.active_7d, month: u.active_30d },
      },
      signups: days.map(({ day }) => ({ day, count: signupsByDay.get(day) ?? 0 })),
      content: {
        shares: c.shares,
        documents: c.documents,
        attempts: c.attempts,
        solves: c.solves,
        cardReviews: c.card_reviews,
        challenges: c.challenges,
        gameRuns: c.game_runs,
      },
      usage: { events: METRIC_EVENTS, days },
      events: events.results,
    },
    200,
    NO_STORE,
  );
}

/** The tables the health page counts rows of. */
const TABLES = [
  'users',
  'identities',
  'sessions',
  'progress',
  'card_reviews',
  'card_state',
  'achievements',
  'lesson_reads',
  'challenge_attempts',
  'game_meta',
  'game_runs',
  'shares',
  'documents',
  'document_versions',
  'email_prefs',
  'daily_counts',
  'app_events',
  'admin_audit',
] as const;

/** The daily and hourly jobs (src/cron.ts) that record a `cron` event when they run. */
export const CRON_JOBS = ['reminders', 'sessions', 'game_runs', 'tombstones', 'usage_counts', 'app_events'] as const;

/** GET /api/admin/health */
export async function getHealth(request: Request, ctx: Ctx): Promise<Response> {
  await requireAdmin(request, ctx);
  const { env } = ctx;
  const { DB } = env;
  const t = now();
  const started = Date.now();
  let database: { ok: boolean; latencyMs: number; sizeBytes?: number; error?: string; migration?: string };
  let tables: Record<string, number> = {};
  try {
    const ping = await DB.prepare('SELECT 1').run();
    database = { ok: true, latencyMs: Date.now() - started, sizeBytes: ping.meta.size_after };
    const counts = await DB.batch(TABLES.map((name) => DB.prepare(`SELECT COUNT(*) AS n FROM ${name}`)));
    tables = Object.fromEntries(TABLES.map((name, i) => [name, (counts[i].results[0] as { n: number }).n]));
    const migration = await DB.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')
      .first<{ name: string }>()
      .catch(() => null);
    if (migration) database.migration = migration.name;
  } catch (e) {
    database = { ok: false, latencyMs: Date.now() - started, error: errorText(e).split('\n')[0] };
  }
  const [cron, errors, email, reminders, lastError] = await DB.batch([
    DB.prepare(
      `SELECT e.message AS job, e.level, e.at, e.detail FROM app_events e
       JOIN (SELECT message, MAX(id) AS id FROM app_events WHERE kind = 'cron' GROUP BY message) last ON last.id = e.id ORDER BY e.message`,
    ),
    DB.prepare(
      `SELECT kind, COALESCE(SUM(at >= ?1), 0) AS day, COUNT(*) AS week FROM app_events
       WHERE at >= ?2 AND kind IN ('server_error', 'rate_limited', 'sign_in_failed', 'blocked_sign_in', 'reminder_failed', 'admin_sign_in_failed') GROUP BY kind`,
    ).bind(t - DAY, t - 7 * DAY),
    DB.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(confirmed_at IS NOT NULL), 0) AS confirmed, COALESCE(SUM(paused_at IS NOT NULL), 0) AS paused FROM email_prefs`,
    ),
    DB.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM daily_counts WHERE event = 'email_reminder_sent' AND day >= ?`).bind(utcDay(t - 6 * DAY)),
    DB.prepare(`SELECT at, message, detail FROM app_events WHERE kind = 'server_error' ORDER BY id DESC LIMIT 1`),
  ]);
  const version = env.CF_VERSION_METADATA;
  return json(
    {
      checkedAt: t,
      worker: {
        environment: env.ENVIRONMENT ?? 'development',
        simVersion: SIM_VERSION,
        ...(version ? { versionId: version.id, versionTag: version.tag || undefined, deployedAt: version.timestamp } : {}),
      },
      database: { ...database, tables },
      cron: { jobs: CRON_JOBS, runs: (cron.results as { job: string; level: string; at: number; detail: string | null }[]).map((r) => ({ ...r, detail: parse(r.detail) })) },
      errors: Object.fromEntries((errors.results as { kind: string; day: number; week: number }[]).map((r) => [r.kind, { day: r.day, week: r.week }])),
      lastError: lastError.results[0] ? { ...(lastError.results[0] as object), detail: parse((lastError.results[0] as { detail: string | null }).detail) } : null,
      email: { ...(email.results[0] as object), bound: Boolean(env.EMAIL), sentLast7Days: (reminders.results[0] as { n: number }).n },
      config: {
        sessionSecret: secretOk(env),
        providers: configuredProviders(env),
        appRedirects: Boolean(env.APP_REDIRECT_URIS?.trim()),
        metricsToken: (env.METRICS_TOKEN?.length ?? 0) >= 16,
        // Still set once the admin is set up: it only works while there is no passkey, but is better removed.
        setupToken: (env.ADMIN_SETUP_TOKEN?.length ?? 0) >= MIN_SETUP_TOKEN,
      },
    },
    200,
    NO_STORE,
  );
}

function parse(detail: string | null): unknown {
  if (!detail) return null;
  try {
    return JSON.parse(detail);
  } catch {
    return detail;
  }
}

type Filter = 'all' | 'blocked' | 'active' | 'public' | 'email';
const FILTERS: Record<Filter, string> = {
  all: '1',
  blocked: 'u.blocked_at IS NOT NULL',
  active: 'u.last_seen_day >= ?3',
  public: 'u.public_profile = 1',
  email: 'EXISTS (SELECT 1 FROM email_prefs e WHERE e.user_id = u.id)',
};
const SORTS: Record<string, string> = {
  created: 'u.created_at DESC, u.id',
  seen: 'u.last_seen_day IS NULL, u.last_seen_day DESC, u.created_at DESC, u.id',
  name: 'u.display_name COLLATE NOCASE, u.id',
  solved: 'solved DESC, u.created_at DESC, u.id',
};

/** GET /api/admin/users?q=&filter=all|blocked|active|public|email&sort=created|seen|name|solved&offset= */
export async function listUsers(request: Request, ctx: Ctx): Promise<Response> {
  await requireAdmin(request, ctx);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const filter = (url.searchParams.get('filter') ?? 'all') as Filter;
  if (!Object.prototype.hasOwnProperty.call(FILTERS, filter)) throw new HttpError(400, `filter must be one of ${Object.keys(FILTERS).join(', ')}`);
  const sort = url.searchParams.get('sort') ?? 'created';
  if (!Object.prototype.hasOwnProperty.call(SORTS, sort)) throw new HttpError(400, `sort must be one of ${Object.keys(SORTS).join(', ')}`);
  const offset = offsetOf(url);
  // ?1 the query as typed (an id or a provider's user id), ?2 as a pattern on the display name, ?3 a week ago (the last
  // parameter is always bound and used, as D1 refuses bindings a statement does not use).
  const where = `(?1 = '' OR u.id = ?1 OR u.display_name LIKE ?2 ESCAPE '\\' OR EXISTS (SELECT 1 FROM identities i WHERE i.user_id = u.id AND i.subject = ?1))
    AND ${FILTERS[filter]} AND ?3 IS NOT NULL`;
  const params = [q, contains(q), utcDay(now() - 6 * DAY)];
  const { DB } = ctx.env;
  const [rows, total] = await DB.batch([
    DB.prepare(
      `SELECT u.id, u.display_name, u.public_profile, u.created_at, u.last_seen_day, u.blocked_at, u.blocked_reason,
         (SELECT group_concat(provider) FROM identities i WHERE i.user_id = u.id) AS providers,
         (SELECT COUNT(*) FROM progress p WHERE p.user_id = u.id AND p.solved_at IS NOT NULL) AS solved,
         EXISTS (SELECT 1 FROM email_prefs e WHERE e.user_id = u.id) AS has_email
       FROM users u WHERE ${where} ORDER BY ${SORTS[sort]} LIMIT ${PAGE} OFFSET ${offset}`,
    ).bind(...params),
    DB.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${where}`).bind(...params),
  ]);
  type Row = {
    id: string;
    display_name: string;
    public_profile: number;
    created_at: number;
    last_seen_day: string | null;
    blocked_at: number | null;
    blocked_reason: string | null;
    providers: string | null;
    solved: number;
    has_email: number;
  };
  return json(
    {
      total: (total.results[0] as { n: number }).n,
      offset,
      pageSize: PAGE,
      users: (rows.results as unknown as Row[]).map((r) => ({
        id: r.id,
        displayName: r.display_name,
        publicProfile: r.public_profile === 1,
        createdAt: r.created_at,
        lastSeenDay: r.last_seen_day,
        blockedAt: r.blocked_at,
        blockedReason: r.blocked_reason,
        providers: r.providers ? r.providers.split(',').sort() : [],
        solved: r.solved,
        hasEmail: r.has_email === 1,
      })),
    },
    200,
    NO_STORE,
  );
}

const USER_ID = /^[0-9a-f-]{36}$/;

function assertUserId(id: string): void {
  if (!USER_ID.test(id)) throw new HttpError(404, 'No such user');
}

/** GET /api/admin/users/<id> */
export async function getUser(request: Request, ctx: Ctx, id: string): Promise<Response> {
  await requireAdmin(request, ctx);
  assertUserId(id);
  const { DB } = ctx.env;
  const user = await DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<Record<string, string | number | null>>();
  if (!user) throw new HttpError(404, 'No such user');
  const [identities, sessions, progress, cards, achievements, challenges, game, shares, documents, versions, email, lessons, audit] = await DB.batch([
    DB.prepare('SELECT provider, subject FROM identities WHERE user_id = ? ORDER BY provider').bind(id),
    DB.prepare('SELECT kind, COUNT(*) AS n, MAX(created_at) AS last_created FROM sessions WHERE user_id = ? AND expires_at > ? GROUP BY kind').bind(id, now()),
    DB.prepare('SELECT problem_id, runs, first_run_at, updated_at, solved_at, runs_to_solve FROM progress WHERE user_id = ? ORDER BY updated_at DESC').bind(id),
    DB.prepare('SELECT COUNT(*) AS reviews, MAX(reviewed_at) AS last, (SELECT COUNT(*) FROM card_state WHERE user_id = ?1) AS cards FROM card_reviews WHERE user_id = ?1').bind(id),
    DB.prepare('SELECT COUNT(*) AS n FROM achievements WHERE user_id = ?').bind(id),
    DB.prepare('SELECT COUNT(*) AS n, MAX(score) AS best, MAX(day) AS last FROM challenge_attempts WHERE user_id = ? AND submitted_at IS NOT NULL').bind(id),
    DB.prepare('SELECT COUNT(*) AS runs, COALESCE(SUM(submitted_at IS NOT NULL), 0) AS submitted, MAX(score) AS best, MAX(started_at) AS last FROM game_runs WHERE user_id = ?').bind(id),
    DB.prepare('SELECT id, title, created_at, image IS NOT NULL AS has_image FROM shares WHERE user_id = ? ORDER BY created_at DESC').bind(id),
    DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(source)), 0) AS bytes, MAX(updated_at) AS last FROM documents WHERE user_id = ? AND deleted_at IS NULL').bind(id),
    DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM document_versions WHERE user_id = ? AND deleted_at IS NULL').bind(id),
    DB.prepare('SELECT email, confirmed_at, paused_at, streak_on, cards_on, recap_on, time_zone, last_sent_at FROM email_prefs WHERE user_id = ?').bind(id),
    DB.prepare('SELECT COUNT(*) AS n FROM lesson_reads WHERE user_id = ?').bind(id),
    DB.prepare('SELECT id, at, action, detail FROM admin_audit WHERE target = ? ORDER BY id DESC LIMIT 20').bind(id),
  ]);
  type Row = Record<string, string | number | null>;
  const first = (r: D1Result) => (r.results[0] ?? {}) as Row;
  const e = email.results[0] as Row | undefined;
  return json(
    {
      user: {
        id: user.id,
        displayName: user.display_name,
        publicProfile: user.public_profile === 1,
        dailyGoal: user.daily_goal,
        createdAt: user.created_at,
        lastSeenDay: user.last_seen_day,
        blockedAt: user.blocked_at,
        blockedReason: user.blocked_reason,
        plan: user.plan,
      },
      identities: identities.results,
      sessions: (sessions.results as Row[]).map((r) => ({ kind: r.kind, count: r.n, lastCreatedAt: r.last_created })),
      progress: (progress.results as Row[]).map((r) => ({
        problemId: r.problem_id,
        runs: r.runs,
        firstRunAt: r.first_run_at,
        updatedAt: r.updated_at,
        solvedAt: r.solved_at,
        runsToSolve: r.runs_to_solve,
      })),
      cards: { reviews: first(cards).reviews ?? 0, cards: first(cards).cards ?? 0, lastReviewAt: first(cards).last ?? null },
      achievements: first(achievements).n ?? 0,
      lessonsRead: first(lessons).n ?? 0,
      challenges: { submitted: first(challenges).n ?? 0, best: first(challenges).best ?? null, lastDay: first(challenges).last ?? null },
      game: { runs: first(game).runs ?? 0, submitted: first(game).submitted ?? 0, best: first(game).best ?? null, lastStartedAt: first(game).last ?? null },
      shares: (shares.results as Row[]).map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, hasImage: r.has_image === 1 })),
      documents: { count: first(documents).n ?? 0, bytes: first(documents).bytes ?? 0, lastUpdatedAt: first(documents).last ?? null },
      documentVersions: { count: first(versions).n ?? 0, bytes: first(versions).bytes ?? 0 },
      email: e
        ? {
            address: maskEmail(String(e.email)),
            confirmed: e.confirmed_at !== null,
            paused: e.paused_at !== null,
            reminders: { streak: e.streak_on === 1, cards: e.cards_on === 1, recap: e.recap_on === 1 },
            timeZone: e.time_zone,
            lastSentAt: e.last_sent_at,
          }
        : null,
      audit: (audit.results as Row[]).map((r) => ({ id: r.id, at: r.at, action: r.action, detail: parse(r.detail as string | null) })),
    },
    200,
    NO_STORE,
  );
}

/** 404 unless the user exists. */
async function assertUser(ctx: Ctx, id: string): Promise<void> {
  assertUserId(id);
  if (!(await ctx.env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(id).first())) throw new HttpError(404, 'No such user');
}

const signOutStatements = (ctx: Ctx, id: string) => [
  ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
  ctx.env.DB.prepare('DELETE FROM app_auth_codes WHERE user_id = ?').bind(id),
];

/** PATCH /api/admin/users/<id> {displayName?, publicProfile?}: a name that slipped past moderation, or a profile to take down. */
export async function patchUser(request: Request, ctx: Ctx, id: string): Promise<Response> {
  const admin = await requireAdmin(request, ctx);
  await assertUser(ctx, id);
  const body = await readJson(request);
  const sets: string[] = [];
  const values: (string | number)[] = [];
  const changed: Record<string, unknown> = {};
  if (body.displayName !== undefined) {
    const name = typeof body.displayName === 'string' ? cleanName(body.displayName) : undefined;
    if (!name) throw new HttpError(400, 'displayName must be a non-empty string');
    sets.push('display_name = ?');
    values.push(name);
    changed.displayName = true;
  }
  if (body.publicProfile !== undefined) {
    if (typeof body.publicProfile !== 'boolean') throw new HttpError(400, 'publicProfile must be true or false');
    sets.push('public_profile = ?');
    values.push(body.publicProfile ? 1 : 0);
    changed.publicProfile = body.publicProfile;
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to change: give displayName or publicProfile');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values, id),
    auditStatement(ctx.env, admin, 'user.update', id, changed),
  ]);
  return new Response(null, { status: 204 });
}

const MAX_REASON = 500;

/**
 * POST /api/admin/users/<id>/block {reason?}: signed out everywhere (apps
 * too), refused at sign-in, and every session check fails; the public
 * profile is turned off (the user can turn it on again once unblocked) and
 * short links answer 404 while blocked.
 */
export async function blockUser(request: Request, ctx: Ctx, id: string): Promise<Response> {
  const admin = await requireAdmin(request, ctx);
  await assertUser(ctx, id);
  const body = await readJson(request);
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_REASON) : '';
  const [blocked] = await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE users SET blocked_at = ?, blocked_reason = ?, public_profile = 0 WHERE id = ? AND blocked_at IS NULL').bind(now(), reason || null, id),
    ...signOutStatements(ctx, id),
  ]);
  if (blocked.meta.changes === 0) throw new HttpError(409, 'Already blocked');
  await ctx.env.DB.batch([auditStatement(ctx.env, admin, 'user.block', id, reason ? { reason } : undefined)]);
  return new Response(null, { status: 204 });
}

/** POST /api/admin/users/<id>/unblock */
export async function unblockUser(request: Request, ctx: Ctx, id: string): Promise<Response> {
  const admin = await requireAdmin(request, ctx);
  await assertUser(ctx, id);
  const [unblocked] = await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE users SET blocked_at = NULL, blocked_reason = NULL WHERE id = ? AND blocked_at IS NOT NULL').bind(id),
  ]);
  if (unblocked.meta.changes === 0) throw new HttpError(409, 'Not blocked');
  await ctx.env.DB.batch([auditStatement(ctx.env, admin, 'user.unblock', id)]);
  return new Response(null, { status: 204 });
}

/** POST /api/admin/users/<id>/sign-out */
export async function signOutUser(request: Request, ctx: Ctx, id: string): Promise<Response> {
  const admin = await requireAdmin(request, ctx);
  await assertUser(ctx, id);
  const [sessions] = await ctx.env.DB.batch([...signOutStatements(ctx, id), auditStatement(ctx.env, admin, 'user.sign_out', id)]);
  return json({ sessions: sessions.meta.changes }, 200, NO_STORE);
}

/** DELETE /api/admin/users/<id>/email */
export async function deleteUserEmail(request: Request, ctx: Ctx, id: string): Promise<Response> {
  const admin = await requireAdmin(request, ctx);
  await assertUser(ctx, id);
  const [deleted] = await ctx.env.DB.batch([ctx.env.DB.prepare('DELETE FROM email_prefs WHERE user_id = ?').bind(id)]);
  if (deleted.meta.changes === 0) throw new HttpError(404, 'No email address');
  await ctx.env.DB.batch([auditStatement(ctx.env, admin, 'user.email.delete', id)]);
  return new Response(null, { status: 204 });
}

/** DELETE /api/admin/users/<id>: the account and everything in it, as the user's own Delete account does. */
export async function deleteUser(request: Request, ctx: Ctx, id: string): Promise<Response> {
  const admin = await requireAdmin(request, ctx);
  await assertUser(ctx, id);
  await ctx.env.DB.batch([ctx.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id), auditStatement(ctx.env, admin, 'user.delete', id)]);
  return new Response(null, { status: 204 });
}

/** GET /api/admin/shares?q=&offset=: q matches a short link's id, title or owner id. */
export async function listAdminShares(request: Request, ctx: Ctx): Promise<Response> {
  await requireAdmin(request, ctx);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const offset = offsetOf(url);
  const where = `(?1 = '' OR s.id = ?1 OR s.user_id = ?1 OR s.title LIKE ?2 ESCAPE '\\')`;
  const { DB } = ctx.env;
  const [rows, total] = await DB.batch([
    DB.prepare(
      `SELECT s.id, s.title, s.created_at, s.image IS NOT NULL AS has_image, length(s.source) AS bytes, s.user_id, u.display_name, u.blocked_at
       FROM shares s JOIN users u ON u.id = s.user_id WHERE ${where} ORDER BY s.created_at DESC, s.id LIMIT ${PAGE} OFFSET ${offset}`,
    ).bind(q, contains(q)),
    DB.prepare(`SELECT COUNT(*) AS n FROM shares s WHERE ${where}`).bind(q, contains(q)),
  ]);
  const origin = url.origin;
  type Row = { id: string; title: string; created_at: number; has_image: number; bytes: number; user_id: string; display_name: string; blocked_at: number | null };
  return json(
    {
      total: (total.results[0] as { n: number }).n,
      offset,
      pageSize: PAGE,
      shares: (rows.results as unknown as Row[]).map((r) => ({
        id: r.id,
        url: `${origin}/s/${r.id}`,
        title: r.title,
        createdAt: r.created_at,
        hasImage: r.has_image === 1,
        bytes: r.bytes,
        owner: { id: r.user_id, displayName: r.display_name, blocked: r.blocked_at !== null },
      })),
    },
    200,
    NO_STORE,
  );
}

/** DELETE /api/admin/shares/<id> */
export async function deleteAdminShare(request: Request, ctx: Ctx, id: string): Promise<Response> {
  const admin = await requireAdmin(request, ctx);
  const row = /^[0-9A-Za-z]{1,32}$/.test(id) ? await ctx.env.DB.prepare('SELECT user_id FROM shares WHERE id = ?').bind(id).first<{ user_id: string }>() : null;
  if (!row) throw new HttpError(404, 'No such short link');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(id),
    auditStatement(ctx.env, admin, 'share.delete', id, { owner: row.user_id }),
  ]);
  return new Response(null, { status: 204 });
}

function beforeOf(url: URL): number {
  const before = Number(url.searchParams.get('before') ?? 0);
  return Number.isInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
}

/** GET /api/admin/events?kind=&level=&before=<id>: 100 at a time, newest first; `next` is the `before` of the next page. */
export async function listEvents(request: Request, ctx: Ctx): Promise<Response> {
  await requireAdmin(request, ctx);
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') ?? '';
  const level = url.searchParams.get('level') ?? '';
  const { DB } = ctx.env;
  const [rows, kinds] = await DB.batch([
    DB.prepare(
      `SELECT id, at, level, kind, message, detail FROM app_events
       WHERE id < ?1 AND (?2 = '' OR kind = ?2) AND (?3 = '' OR level = ?3) ORDER BY id DESC LIMIT 100`,
    ).bind(beforeOf(url), kind, level),
    DB.prepare('SELECT kind, COUNT(*) AS n FROM app_events GROUP BY kind ORDER BY kind'),
  ]);
  const events = (rows.results as { id: number; at: number; level: string; kind: string; message: string; detail: string | null }[]).map((r) => ({ ...r, detail: parse(r.detail) }));
  return json({ events, kinds: kinds.results, next: events.length === 100 ? events[events.length - 1].id : null }, 200, NO_STORE);
}

/** GET /api/admin/audit?before=<id> */
export async function listAudit(request: Request, ctx: Ctx): Promise<Response> {
  await requireAdmin(request, ctx);
  const url = new URL(request.url);
  const { results } = await ctx.env.DB.prepare(
    `SELECT a.id, a.at, a.action, a.target, a.detail, p.name AS passkey FROM admin_audit a LEFT JOIN admin_passkeys p ON p.id = a.passkey_id
     WHERE a.id < ? ORDER BY a.id DESC LIMIT 100`,
  )
    .bind(beforeOf(url))
    .all<{ id: number; at: number; action: string; target: string | null; detail: string | null; passkey: string | null }>();
  const entries = results.map((r) => ({ ...r, detail: parse(r.detail) }));
  return json({ entries, next: entries.length === 100 ? entries[entries.length - 1].id : null }, 200, NO_STORE);
}

/** Deletes audit entries older than AUDIT_RETENTION_DAYS (the daily cron). */
export async function pruneAudit(env: Env): Promise<number> {
  const { meta } = await env.DB.prepare('DELETE FROM admin_audit WHERE at < ?').bind(now() - AUDIT_RETENTION_DAYS * DAY).run();
  return meta.changes;
}

