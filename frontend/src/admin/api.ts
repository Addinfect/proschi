import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api } from '../services/api';

/**
 * The admin panel's API (backend/src/adminAuth.ts and admin.ts, under
 * /api/admin). The admin session is an HttpOnly cookie of its own; every
 * call is same-origin.
 */

export interface Status {
  passkeys: boolean;
  setupAvailable: boolean;
  signedIn: boolean;
}

export const getStatus = () => api<Status>('/api/admin/status');

/** Registers the first passkey with the setup token; signed in afterwards. */
export async function setUp(setupToken: string, name: string): Promise<void> {
  const options = await api<PublicKeyCredentialCreationOptionsJSON>('/api/admin/setup/options', { method: 'POST', body: { setupToken } });
  const response = await startRegistration({ optionsJSON: options });
  await api('/api/admin/setup', { method: 'POST', body: { setupToken, name, response } });
}

export async function signIn(): Promise<void> {
  const options = await api<PublicKeyCredentialRequestOptionsJSON>('/api/admin/login/options', { method: 'POST' });
  const response = await startAuthentication({ optionsJSON: options });
  await api('/api/admin/login', { method: 'POST', body: { response } });
}

export const signOut = () => api('/api/admin/logout', { method: 'POST' });

export interface Passkey {
  id: string;
  name: string;
  transports: string[];
  createdAt: number;
  lastUsedAt: number | null;
  current: boolean;
}

export const getPasskeys = () => api<{ passkeys: Passkey[]; sessions: number }>('/api/admin/passkeys');

export async function addPasskey(name: string): Promise<void> {
  const options = await api<PublicKeyCredentialCreationOptionsJSON>('/api/admin/passkeys/options', { method: 'POST' });
  const response = await startRegistration({ optionsJSON: options });
  await api('/api/admin/passkeys', { method: 'POST', body: { name, response } });
}

export const deletePasskey = (id: string) => api(`/api/admin/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const revokeAdminSessions = () => api('/api/admin/sessions/revoke-all', { method: 'POST' });

export interface Overview {
  users: {
    total: number;
    blocked: number;
    public: number;
    emailReminders: number;
    new: { day: number; week: number; month: number };
    active: { day: number; week: number; month: number };
  };
  signups: { day: string; count: number }[];
  content: { shares: number; documents: number; attempts: number; solves: number; cardReviews: number; challenges: number; gameRuns: number };
  usage: { events: string[]; days: { day: string; counts: Record<string, number> }[] };
  events: { kind: string; level: string; n: number }[];
}

export const getOverview = () => api<Overview>('/api/admin/overview');

export interface CronRun {
  job: string;
  level: string;
  at: number;
  detail: Record<string, unknown> | null;
}

export interface Health {
  checkedAt: number;
  worker: { environment: string; simVersion: number; versionId?: string; versionTag?: string; deployedAt?: string };
  database: { ok: boolean; latencyMs: number; sizeBytes?: number; migration?: string; error?: string; tables: Record<string, number> };
  cron: { jobs: string[]; runs: CronRun[] };
  errors: Record<string, { day: number; week: number }>;
  lastError: { at: number; message: string; detail: Record<string, unknown> | null } | null;
  email: { total: number; confirmed: number; paused: number; bound: boolean; sentLast7Days: number };
  config: { sessionSecret: boolean; providers: string[]; appRedirects: boolean; metricsToken: boolean; setupToken: boolean };
}

export const getHealth = () => api<Health>('/api/admin/health');

export interface UserRow {
  id: string;
  displayName: string;
  publicProfile: boolean;
  createdAt: number;
  lastSeenDay: string | null;
  blockedAt: number | null;
  blockedReason: string | null;
  providers: string[];
  solved: number;
  hasEmail: boolean;
}

export type UserFilter = 'all' | 'blocked' | 'active' | 'public' | 'email';
export type UserSort = 'created' | 'seen' | 'name' | 'solved';

export const listUsers = (params: { q: string; filter: UserFilter; sort: UserSort; offset: number }) =>
  api<{ total: number; offset: number; pageSize: number; users: UserRow[] }>(`/api/admin/users?${new URLSearchParams({ ...params, offset: String(params.offset) })}`);

export interface AuditEntry {
  id: number;
  at: number;
  action: string;
  target?: string | null;
  detail: Record<string, unknown> | null;
  passkey?: string | null;
}

export interface UserDetail {
  user: {
    id: string;
    displayName: string;
    publicProfile: boolean;
    dailyGoal: number;
    createdAt: number;
    lastSeenDay: string | null;
    blockedAt: number | null;
    blockedReason: string | null;
    /** `users.plan`, e.g. free. */
    plan: string;
  };
  identities: { provider: string; subject: string }[];
  sessions: { kind: string; count: number; lastCreatedAt: number }[];
  progress: { problemId: string; runs: number; firstRunAt: number; updatedAt: number; solvedAt: number | null; runsToSolve: number | null }[];
  cards: { reviews: number; cards: number; lastReviewAt: number | null };
  achievements: number;
  lessonsRead: number;
  challenges: { submitted: number; best: number | null; lastDay: string | null };
  game: { runs: number; submitted: number; best: number | null; lastStartedAt: number | null };
  shares: { id: string; title: string; createdAt: number; hasImage: boolean }[];
  documents: { count: number; bytes: number; lastUpdatedAt: number | null };
  email: { address: string; confirmed: boolean; paused: boolean; reminders: Record<string, boolean>; timeZone: string; lastSentAt: number | null } | null;
  audit: AuditEntry[];
}

const user = (id: string) => `/api/admin/users/${encodeURIComponent(id)}`;

export const getUser = (id: string) => api<UserDetail>(user(id));
export const patchUser = (id: string, body: { displayName?: string; publicProfile?: boolean }) => api(user(id), { method: 'PATCH', body });
export const blockUser = (id: string, reason: string) => api(`${user(id)}/block`, { method: 'POST', body: { reason } });
export const unblockUser = (id: string) => api(`${user(id)}/unblock`, { method: 'POST' });
export const signOutUser = (id: string) => api<{ sessions: number }>(`${user(id)}/sign-out`, { method: 'POST' });
export const deleteUserEmail = (id: string) => api(`${user(id)}/email`, { method: 'DELETE' });
export const deleteUser = (id: string) => api(user(id), { method: 'DELETE' });

export interface ShareRow {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  hasImage: boolean;
  bytes: number;
  owner: { id: string; displayName: string; blocked: boolean };
}

export const listShares = (q: string, offset: number) =>
  api<{ total: number; offset: number; pageSize: number; shares: ShareRow[] }>(`/api/admin/shares?${new URLSearchParams({ q, offset: String(offset) })}`);
export const deleteShare = (id: string) => api(`/api/admin/shares/${encodeURIComponent(id)}`, { method: 'DELETE' });

export interface AppEvent {
  id: number;
  at: number;
  level: 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  detail: unknown;
}

export const listEvents = (params: { kind: string; level: string; before?: number }) =>
  api<{ events: AppEvent[]; kinds: { kind: string; n: number }[]; next: number | null }>(
    `/api/admin/events?${new URLSearchParams({ kind: params.kind, level: params.level, ...(params.before ? { before: String(params.before) } : {}) })}`,
  );

export const listAudit = (before?: number) => api<{ entries: AuditEntry[]; next: number | null }>(`/api/admin/audit${before ? `?before=${before}` : ''}`);
