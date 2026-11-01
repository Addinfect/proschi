import { SIM_VERSION } from '../../frontend/src/sim/version';
import { getActivity } from './activity';
import { blockUser, deleteAdminShare, deleteUser, deleteUserEmail, getHealth, getOverview, getUser, listAdminShares, listAudit, listEvents, listUsers, patchUser, signOutUser, unblockUser } from './admin';
import { addPasskey, addPasskeyOptions, adminLogout, adminStatus, deletePasskey, listPasskeys, login as adminLogin, loginOptions, revokeAdminSessions, setup as adminSetup, setupOptions } from './adminAuth';
import { getAchievements, markAchievementsSeen } from './achievements';
import { revoke, token } from './apptokens';
import { getCardState, postCardReviews } from './cards';
import { getGameLeaderboard, getGameMe, postGameBuy, postGameEquip, postGameRun, postGameSubmit, postGameSync } from './game';
import { getChallengeLeaderboard, getChallengeToday, postChallengeAttempt, postChallengeStart } from './challenge';
import { configuredProviders, finishLogin, isProvider, logout, revokeAllSessions, startLogin, unlinkIdentity } from './auth';
import { createContext, type Ctx } from './context';
import { hourlyCron } from './cron';
import { deleteAllDocuments, deleteDocument, getLimits, listDocuments, putDocument } from './documents';
import { recordThrottled, routeOf } from './events';
import { getMetricsSummary, postMetrics } from './metrics';
import type { Env } from './env';
import { assertSameOrigin, errorResponse, HttpError, json, withSecurityHeaders } from './http';
import { errorText, log } from './log';
import { deleteMe, exportMe, getMe, importProgress, recordRun, updateMe } from './progress';
import { postLessonsRead } from './lessons';
import { reviewDesign } from './review';
import { confirmEmail, confirmPage, deleteEmail, getEmailPrefs, patchEmail, putEmail, unsubscribe, unsubscribePage } from './reminders';
import { getPublicProfile } from './profile';
import { servePublicProfile } from './profilePage';
import { createShare, deleteShare, getShare, listShares, oembed, shareImage, sharePage } from './shares';
import { getLeaderboard, getProblemLeaderboard, getProblemStats, getStats } from './stats';
import { createVersion, deleteVersion, getVersion, listVersions, resolveVersion } from './versions';

/**
 * proschi.app: the site (frontend/dist, served as static assets without
 * running this code) and, under /api and /auth, the API (backend/README.md):
 *
 *   GET    /auth/providers                  sign-in providers on offer
 *   GET    /auth/<provider>/start?return=   → the provider's sign-in page (&link=1: add it to the signed-in account)
 *   GET    /auth/<provider>/callback        → the return path, signed in (session cookie)
 *   GET    /auth/<provider>/start?client=app&redirect_uri=&code_challenge=&code_challenge_method=S256[&state=]
 *                                           a native app's sign-in: the callback → redirect_uri?code=
 *   POST   /auth/token {grant_type, code, code_verifier | refresh_token}   an app's bearer tokens
 *   POST   /auth/revoke {token}             ends an app's sign-in
 *   POST   /auth/logout
 *   GET    /api/health                      the Worker and D1 answer
 *   GET    /api/me                          account and progress
 *   PATCH  /api/me {displayName?, publicProfile?, dailyGoal?}
 *   DELETE /api/me
 *   GET    /api/me/export                   everything stored about the user, as a download
 *   GET    /api/me/activity?day=YYYY-MM-DD  daily goal, streak, weekly recap and each day's activity
 *   GET    /api/me/email                    email reminders: the address and settings ({email: null} without one)
 *   PUT    /api/me/email {email, timeZone, streak?, cards?, recap?}   sets the address (a new one gets a confirmation email)
 *   PATCH  /api/me/email {streak?, cards?, recap?, timeZone?, resume?}   which reminders; resume: true after a pause
 *   DELETE /api/me/email                    removes the address
 *   GET    /api/email/confirm?token=        the confirmation link's page; POST confirms
 *   GET    /api/email/unsubscribe?token=    the unsubscribe link's page; POST unsubscribes (one-click, RFC 8058, no session)
 *   POST   /api/me/import {items}           the browser's progress, on first sign-in
 *   POST   /api/me/lessons {ids}            lessons and roadmap guides read
 *   GET    /api/me/achievements?day=        every badge with its progress, and the skill map (stores newly earned badges)
 *   POST   /api/me/achievements/seen {ids?} marks earned badges as celebrated
 *   GET    /api/me/documents?since=<ms>     the editor's synced diagrams changed since (tombstones too), {documents, cursor}
 *   PUT    /api/me/documents/<id> {name, source, imports?, baseVersion}   saves one (409 {document} when it changed since)
 *   DELETE /api/me/documents/<id>?baseVersion=   leaves a tombstone (409 {document} when it changed since)
 *   DELETE /api/me/documents                 every synced diagram of the account
 *   POST   /api/me/documents/<id>/versions {tag, note?, documentVersion}   tags an immutable version (409 stale|tag_taken|version_limit)
 *   GET    /api/me/documents/<id>/versions   its versions, newest first
 *   GET    /api/me/documents/<id>/versions/<tag|latest>   one, with its content
 *   DELETE /api/me/documents/<id>/versions/<tag>   deletes one (its tag stays taken)
 *   GET    /api/me/versions/resolve?name=&tag=   a cloud reference by diagram name and tag (409 ambiguous_name)
 *   GET    /api/me/limits                   the account's plan, its limits and what it uses
 *   POST   /api/me/sessions/revoke-all      sign out everywhere
 *   DELETE /api/me/identities/<provider>    unlink a sign-in
 *   POST   /api/problems/<id>/runs {source, solved, imported?, day?}
 *   GET    /api/problems/<id>/leaderboard?metric=cost|p99   the problem's top 10 who opted in, by cheapest or fastest passing design (+ your rank, signed in)
 *   GET    /api/stats                       every problem's summary
 *   GET    /api/stats/<id>                  one problem's distributions (+ yours, signed in)
 *   GET    /api/leaderboard                 users who opted in, by problems solved (with their public ids)
 *   GET    /api/users/<id>/profile          a public profile (404 unless the user opted in)
 *   GET    /api/cards/state?day=YYYY-MM-DD   card review states (+ that day's counts)
 *   POST   /api/cards/reviews {reviews}     up to 200 card reviews; answers the cards' new states
 *   GET    /api/challenge/today             the daily challenge's cards (+ your attempt and challenge streak, signed in)
 *   POST   /api/challenge/today/start {day?}            records when the first card was shown (once per user and day)
 *   POST   /api/challenge/today/attempt {answers, day?, localDay?}   grades, scores and keeps your first attempt of the day
 *   GET    /api/challenge/leaderboard?day=  the day's top 20 who opted in, with their public ids (+ your rank, signed in)
 *   GET    /api/game/me                     Scale or Fail: your progress, best scores and today's daily run
 *   POST   /api/game/runs {mode, scenario?, ascension?}   starts a ranked run: {runId, setup} (the server picks the seed)
 *   POST   /api/game/runs/<id>/submit {actions, day?}   replays the run and keeps its score (once)
 *   POST   /api/game/buy {id}               spends Blueprints on an unlock or a perk level
 *   POST   /api/game/equip {perks}          the perks to take into runs
 *   POST   /api/game/sync {events}          runs, purchases and perks from signed out, replayed in order
 *   GET    /api/game/leaderboard?scenario=&ascension= | ?day=   top 20 who opted in (+ your rank, signed in)
 *   POST   /api/shares {source, imports?, image?}   a short link to a diagram, with a preview PNG: {id, url, …}
 *   GET    /api/shares/<id>                 a short link's diagram (no sign-in needed)
 *   DELETE /api/shares/<id>                 the owner deletes one
 *   GET    /api/me/shares                   the user's short links
 *   GET    /api/oembed?url=                 oEmbed for a short link
 *   POST   /api/review {source, model, problem?, tests?, metrics?}   AI design review (a stub: 501)
 *   GET    /s/<id>                          a short link: preview meta tags, then the editor
 *   GET    /s/<id>.png                      its preview image (→ /og.png without one)
 *   POST   /api/metrics {event} | {events}  anonymous daily usage counts (allow-listed event names, no identifiers)
 *   GET    /api/metrics/summary?days=30     the daily counts; only with X-Metrics-Token (404 without METRICS_TOKEN set)
 *   …      /api/admin/*                     the admin panel: passkey sign-in (src/adminAuth.ts) and its data (src/admin.ts)
 *
 * and, outside the API, public profiles at addresses of their own (src/profilePage.ts):
 *
 *   GET    /u/<id>                          the practice page showing the profile, with its title and image in the meta tags
 *   GET    /u/<id>.png                      the profile's Open Graph card (1200×630)
 */

async function route(request: Request, ctx: Ctx, pathname: string): Promise<Response> {
  const { env } = ctx;
  const method = request.method;
  const parts = pathname.split('/').filter(Boolean);
  const is = (m: string, ...path: string[]) => method === m && parts.length === path.length && path.every((p, i) => p === '*' || p === parts[i]);
  // The email links' POSTs carry their only credential in the token and never read the session, so they skip the
  // same-origin check: mail clients send one-click unsubscribes (RFC 8058) from their own servers, and the confirm
  // page's form arrives with `Origin: null` (its Referrer-Policy is no-referrer).
  if (is('POST', 'api', 'email', 'unsubscribe')) return unsubscribe(request, ctx);
  if (is('POST', 'api', 'email', 'confirm')) return confirmEmail(request, ctx);
  assertSameOrigin(request);

  if (is('GET', 'auth', 'providers')) return json({ providers: configuredProviders(env) }, 200, { 'Cache-Control': 'public, max-age=300' });
  if ((is('GET', 'auth', '*', 'start') || is('GET', 'auth', '*', 'callback')) && isProvider(parts[1])) {
    return parts[2] === 'start' ? startLogin(request, ctx, parts[1]) : finishLogin(request, ctx, parts[1]);
  }
  if (is('POST', 'auth', 'logout')) return logout(request, ctx);
  if (is('POST', 'auth', 'token')) return token(request, ctx);
  if (is('POST', 'auth', 'revoke')) return revoke(request, ctx);
  if (is('GET', 'api', 'health')) return health(ctx);
  if (is('GET', 'api', 'me')) return getMe(request, ctx);
  if (is('PATCH', 'api', 'me')) return updateMe(request, ctx);
  if (is('DELETE', 'api', 'me')) return deleteMe(request, ctx);
  if (is('GET', 'api', 'me', 'export')) return exportMe(request, ctx);
  if (is('GET', 'api', 'me', 'activity')) return getActivity(request, ctx);
  if (is('GET', 'api', 'me', 'email')) return getEmailPrefs(request, ctx);
  if (is('PUT', 'api', 'me', 'email')) return putEmail(request, ctx);
  if (is('PATCH', 'api', 'me', 'email')) return patchEmail(request, ctx);
  if (is('DELETE', 'api', 'me', 'email')) return deleteEmail(request, ctx);
  if (is('GET', 'api', 'email', 'confirm')) return confirmPage(request, ctx);
  if (is('GET', 'api', 'email', 'unsubscribe')) return unsubscribePage(request, ctx);
  if (is('POST', 'api', 'me', 'import')) return importProgress(request, ctx);
  if (is('POST', 'api', 'me', 'lessons')) return postLessonsRead(request, ctx);
  if (is('GET', 'api', 'me', 'achievements')) return getAchievements(request, ctx);
  if (is('POST', 'api', 'me', 'achievements', 'seen')) return markAchievementsSeen(request, ctx);
  if (is('GET', 'api', 'me', 'documents')) return listDocuments(request, ctx);
  if (is('DELETE', 'api', 'me', 'documents')) return deleteAllDocuments(request, ctx);
  if (is('GET', 'api', 'me', 'limits')) return getLimits(request, ctx);
  if (is('POST', 'api', 'me', 'documents', '*', 'versions')) return createVersion(request, ctx, parts[3]);
  if (is('GET', 'api', 'me', 'documents', '*', 'versions')) return listVersions(request, ctx, parts[3]);
  if (is('GET', 'api', 'me', 'documents', '*', 'versions', '*')) return getVersion(request, ctx, parts[3], parts[5]);
  if (is('DELETE', 'api', 'me', 'documents', '*', 'versions', '*')) return deleteVersion(request, ctx, parts[3], parts[5]);
  if (is('GET', 'api', 'me', 'versions', 'resolve')) return resolveVersion(request, ctx);
  if (is('PUT', 'api', 'me', 'documents', '*')) return putDocument(request, ctx, parts[3]);
  if (is('DELETE', 'api', 'me', 'documents', '*')) return deleteDocument(request, ctx, parts[3]);
  if (is('POST', 'api', 'me', 'sessions', 'revoke-all')) return revokeAllSessions(request, ctx);
  if (is('DELETE', 'api', 'me', 'identities', '*')) return unlinkIdentity(request, ctx, parts[3]);
  if (is('POST', 'api', 'problems', '*', 'runs')) return recordRun(request, ctx, parts[2]);
  if (is('GET', 'api', 'problems', '*', 'leaderboard')) return getProblemLeaderboard(request, ctx, parts[2]);
  if (is('GET', 'api', 'stats')) return getStats(ctx);
  if (is('GET', 'api', 'stats', '*')) return getProblemStats(request, ctx, parts[2]);
  if (is('GET', 'api', 'leaderboard')) return getLeaderboard(ctx);
  if (is('GET', 'api', 'users', '*', 'profile')) return getPublicProfile(ctx, parts[2]);
  if (is('GET', 'api', 'cards', 'state')) return getCardState(request, ctx);
  if (is('POST', 'api', 'cards', 'reviews')) return postCardReviews(request, ctx);
  if (is('GET', 'api', 'challenge', 'today')) return getChallengeToday(request, ctx);
  if (is('POST', 'api', 'challenge', 'today', 'start')) return postChallengeStart(request, ctx);
  if (is('POST', 'api', 'challenge', 'today', 'attempt')) return postChallengeAttempt(request, ctx);
  if (is('GET', 'api', 'challenge', 'leaderboard')) return getChallengeLeaderboard(request, ctx);
  if (is('GET', 'api', 'game', 'me')) return getGameMe(request, ctx);
  if (is('POST', 'api', 'game', 'runs')) return postGameRun(request, ctx);
  if (is('POST', 'api', 'game', 'runs', '*', 'submit')) return postGameSubmit(request, ctx, parts[3]);
  if (is('POST', 'api', 'game', 'buy')) return postGameBuy(request, ctx);
  if (is('POST', 'api', 'game', 'equip')) return postGameEquip(request, ctx);
  if (is('POST', 'api', 'game', 'sync')) return postGameSync(request, ctx);
  if (is('GET', 'api', 'game', 'leaderboard')) return getGameLeaderboard(request, ctx);
  if (is('POST', 'api', 'review')) return reviewDesign(request, ctx);
  if (is('POST', 'api', 'shares')) return createShare(request, ctx);
  if (is('GET', 'api', 'shares', '*')) return getShare(ctx, parts[2]);
  if (is('DELETE', 'api', 'shares', '*')) return deleteShare(request, ctx, parts[2]);
  if (is('GET', 'api', 'me', 'shares')) return listShares(request, ctx);
  if (is('GET', 'api', 'oembed')) return oembed(request, ctx);
  if ((method === 'GET' || method === 'HEAD') && parts.length === 2 && parts[0] === 's') {
    return parts[1].endsWith('.png') ? shareImage(request, ctx, parts[1].slice(0, -'.png'.length)) : sharePage(request, ctx, parts[1]);
  }
  if (is('POST', 'api', 'metrics')) return postMetrics(request, ctx);
  if (is('GET', 'api', 'metrics', 'summary')) return getMetricsSummary(request, ctx);
  if (parts[0] === 'api' && parts[1] === 'admin') return adminRoute(request, ctx, is, parts);
  return errorResponse(404, 'Not found');
}

/** /api/admin/*: the admin panel (backend/README.md "Admin panel"). */
function adminRoute(request: Request, ctx: Ctx, is: (m: string, ...path: string[]) => boolean, parts: string[]): Promise<Response> | Response {
  const id = parts[3];
  if (is('GET', 'api', 'admin', 'status')) return adminStatus(request, ctx);
  if (is('POST', 'api', 'admin', 'setup', 'options')) return setupOptions(request, ctx);
  if (is('POST', 'api', 'admin', 'setup')) return adminSetup(request, ctx);
  if (is('POST', 'api', 'admin', 'login', 'options')) return loginOptions(request, ctx);
  if (is('POST', 'api', 'admin', 'login')) return adminLogin(request, ctx);
  if (is('POST', 'api', 'admin', 'logout')) return adminLogout(request, ctx);
  if (is('GET', 'api', 'admin', 'passkeys')) return listPasskeys(request, ctx);
  if (is('POST', 'api', 'admin', 'passkeys', 'options')) return addPasskeyOptions(request, ctx);
  if (is('POST', 'api', 'admin', 'passkeys')) return addPasskey(request, ctx);
  if (is('DELETE', 'api', 'admin', 'passkeys', '*')) return deletePasskey(request, ctx, id);
  if (is('POST', 'api', 'admin', 'sessions', 'revoke-all')) return revokeAdminSessions(request, ctx);
  if (is('GET', 'api', 'admin', 'overview')) return getOverview(request, ctx);
  if (is('GET', 'api', 'admin', 'health')) return getHealth(request, ctx);
  if (is('GET', 'api', 'admin', 'users')) return listUsers(request, ctx);
  if (is('GET', 'api', 'admin', 'users', '*')) return getUser(request, ctx, id);
  if (is('PATCH', 'api', 'admin', 'users', '*')) return patchUser(request, ctx, id);
  if (is('DELETE', 'api', 'admin', 'users', '*')) return deleteUser(request, ctx, id);
  if (is('POST', 'api', 'admin', 'users', '*', 'block')) return blockUser(request, ctx, id);
  if (is('POST', 'api', 'admin', 'users', '*', 'unblock')) return unblockUser(request, ctx, id);
  if (is('POST', 'api', 'admin', 'users', '*', 'sign-out')) return signOutUser(request, ctx, id);
  if (is('DELETE', 'api', 'admin', 'users', '*', 'email')) return deleteUserEmail(request, ctx, id);
  if (is('GET', 'api', 'admin', 'shares')) return listAdminShares(request, ctx);
  if (is('DELETE', 'api', 'admin', 'shares', '*')) return deleteAdminShare(request, ctx, id);
  if (is('GET', 'api', 'admin', 'events')) return listEvents(request, ctx);
  if (is('GET', 'api', 'admin', 'audit')) return listAudit(request, ctx);
  return errorResponse(404, 'Not found');
}

/** GET /api/health: for the deploy's smoke test and uptime checks. */
async function health(ctx: Ctx): Promise<Response> {
  try {
    await ctx.env.DB.prepare('SELECT 1').first();
  } catch (e) {
    log('error', 'Health check: D1 failed', { requestId: ctx.requestId, error: errorText(e) });
    return errorResponse(503, 'Database unavailable');
  }
  return json({ ok: true, env: ctx.env.ENVIRONMENT ?? 'development', simVersion: SIM_VERSION }, 200, { 'Cache-Control': 'no-store' });
}

export default {
  async fetch(request, env, exec): Promise<Response> {
    const { pathname } = new URL(request.url);
    const page = pathname.startsWith('/u/');
    if (!page && !/^\/(api|auth|s)(\/|$)/.test(pathname)) return env.ASSETS.fetch(request);
    const started = Date.now();
    const ctx = createContext(request, env, exec);
    let response: Response;
    let error: string | undefined;
    /** A page or image of the site's (src/profilePage.ts), with the headers of one, not an API answer. */
    let pageResponse = false;
    try {
      if (page) {
        response = await servePublicProfile(request, ctx);
        pageResponse = true;
      } else response = await route(request, ctx, pathname);
    } catch (e) {
      if (e instanceof HttpError) response = errorResponse(e.status, e.message, e.headers);
      else {
        error = errorText(e);
        response = errorResponse(500, 'Internal error');
      }
    }
    // For the admin's health page (src/events.ts): the path only, no user id or IP, at most once a minute per path.
    if (error) {
      const route = routeOf(pathname);
      recordThrottled(env, exec, `500 ${route}`, 'error', 'server_error', error.split('\n')[0], { method: request.method, path: route, requestId: ctx.requestId, stack: error });
    } else if (response.status === 429) {
      const route = routeOf(pathname);
      recordThrottled(env, exec, `429 ${route}`, 'warn', 'rate_limited', `Rate limit hit on ${route}`, { method: request.method, path: route });
    }
    // The path only: the query of an OAuth callback holds the authorization code.
    log(error ? 'error' : 'info', 'request', {
      requestId: ctx.requestId,
      method: request.method,
      path: pathname,
      status: response.status,
      ms: Date.now() - started,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      ...(error ? { error } : {}),
    });
    if (pageResponse) {
      const out = new Response(response.body, response);
      out.headers.set('X-Request-Id', ctx.requestId);
      return out;
    }
    return withSecurityHeaders(response, ctx);
  },

  async scheduled(controller, env): Promise<void> {
    await hourlyCron(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
