// SPDX-License-Identifier: MIT
// @sffmc/health — see ../../LICENSE

// Check schema + factory. The 13 health checks all follow the same shape:
// a fixed `name` plus an async predicate over `repoRoot` returning status/detail.
// The factory binds the name once; lambdas only produce the outcome pair.
//
// Pattern precedent: `shared/src/has-metadata-error.ts` — small, single-purpose
// helper extracted to its own file. Here the helper is a factory, not a
// predicate, but the same "one helper, one file" rule applies.

/** What each health check returns. The `name` is bound by the factory. */
export interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

/** Status + detail pair produced by a check predicate. The factory adds `name`. */
export type CheckOutcome = Omit<CheckResult, "name">;

/** Aggregate result returned by `runAllChecks` (and serialized by `sffmc_health`). */
export interface HealthResult {
  ok: boolean;
  checks: CheckResult[];
  summary: string;
}

/** A check function — takes the repo root, returns a full CheckResult. */
export type CheckFn = (repoRoot: string) => Promise<CheckResult>;

/**
 * Wraps a check predicate with a fixed name. The predicate takes repoRoot and
 * returns a CheckOutcome (status + detail); the factory produces a CheckFn
 * that calls the predicate and stamps the result with `name`. This eliminates
 * the `name: "xxx"` line from every return in every check lambda.
 *
 *   export const checkFoo = createCheck("foo", async (repoRoot) => {
 *     const count = await countThings(repoRoot);
 *     return count > 0
 *       ? { status: "ok", detail: `${count} things found` }
 *       : { status: "fail", detail: "no things found" };
 *   });
 */
export function createCheck(
  name: string,
  predicate: (repoRoot: string) => Promise<CheckOutcome>,
): CheckFn {
  return async (repoRoot) => ({
    name,
    ...(await predicate(repoRoot)),
  });
}
