/**
 * What an account may keep, per plan (`users.plan`, backend/README.md
 * "Plans and limits"). Everyone is on the free plan today: there are no
 * payments and no way to change plan but SQL. The one place a paid plan
 * will raise a limit.
 */

export interface Limits {
  /** Live (not deleted) synced diagrams (src/documents.ts). */
  documents: number;
  /** Live (not deleted) versions of one diagram (src/versions.ts). */
  versionsPerDocument: number;
  /** A diagram's source plus its imports (as JSON), in characters. */
  documentBytes: number;
}

export const FREE_LIMITS: Readonly<Limits> = Object.freeze({ documents: 5, versionsPerDocument: 20, documentBytes: 64 * 1024 });

/** Every plan by its `users.plan` value. Exported for the tests, which add one to check a plan's limits apply. */
export const PLANS: Record<string, Readonly<Limits>> = { free: FREE_LIMITS };

/** The plan's limits; an unknown plan gets the free plan's. */
export function limitsFor(plan: string | null | undefined): Readonly<Limits> {
  return (plan && Object.prototype.hasOwnProperty.call(PLANS, plan) ? PLANS[plan] : undefined) ?? FREE_LIMITS;
}

/** The plan as the API reports it: an unknown one is reported as free, since that is what it gets. */
export function planName(plan: string | null | undefined): string {
  return plan && Object.prototype.hasOwnProperty.call(PLANS, plan) ? plan : 'free';
}
