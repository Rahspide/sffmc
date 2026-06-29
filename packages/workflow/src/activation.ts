// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// WorkflowActivation — extracted from WorkflowRuntime (M-1 god-object
// refactor, Task 1.5). Owns the in-flight run registry previously held
// inline as `private runs = new Map<string, InternalRunEntry>()` in
// runtime.ts:209.
//
// Why an "activation" registry and not a "scheduler": there is no
// scheduling in runtime.ts — no cron, no queue depth, no timer-driven
// dispatch. The Map holds entries whose sandbox .then() callbacks drive
// completion (via `completeRun` / `failRun`), and entries are registered
// by `start()` / `resume()` / `startChildWorkflow()` and removed by
// `cancel()` / `completeRun()` / `failRun()` / `close()`. The brief's
// "WorkflowScheduler" name was a misnomer — the actual concern is
// tracking which runs are currently active (i.e. *activation* state).
//
// Class name rationale: the brief's `WorkflowScheduler` implies
// time-based scheduling which doesn't exist. `RunRegistry` would be
// technically accurate but `WorkflowActivation` matches the brief's
// prose ("Consumes: activation logic in runtime.ts (run-queue,
// resume)") and the lifecycle vocabulary used throughout runtime.ts
// (entries are "active" while their status === "running").
//
// The brief sketched `enqueue / cancel / pending`. The real Map usage
// in runtime.ts requires `register / get / release / has / clear /
// iter / pending / size` — see activation.test.ts for the full
// contract. `cancel(runId)` was deliberately NOT carried over: the
// runtime's `cancel()` method does much more than a Map.delete
// (DB update, event emit, outcome cache write, AbortController abort);
// collapsing that into the registry would either lose behavior or
// force the registry to depend on events / persistence / outcome
// caches, violating the "single concern" extraction goal.

/** In-flight run registry. Stores entries by runID and exposes the
 *  operations WorkflowRuntime previously performed against
 *  `this.runs` (a Map<string, InternalRunEntry>).
 *
 *  Generic over the entry shape V so the registry can hold
 *  `InternalRunEntry` in production and minimal fixtures in tests
 *  without `as any` casts.
 *
 *  Iteration order matches Map insertion order (ECMAScript
 *  spec guarantee). The runtime relies on this for `list()` —
 *  the resulting array reflects the order runs were started. */
export class WorkflowActivation<V = unknown> {
  private readonly runs = new Map<string, V>()

  /** Register an entry under `runID`. Subsequent `get(runID)` returns
   *  the same instance reference. Mirrors `Map.set()` semantics:
   *  overwrites a prior entry under the same runID (resume() depends
   *  on this — it re-registers after cancel() released the previous
   *  entry). */
  register(runID: string, entry: V): void {
    this.runs.set(runID, entry)
  }

  /** Retrieve the entry registered under `runID`, or `undefined` if
   *  no such entry exists. Mirrors `Map.get()`. */
  get(runID: string): V | undefined {
    return this.runs.get(runID)
  }

  /** Existence check — equivalent to `get(runID) !== undefined` but
   *  avoids materializing the entry reference. Mirrors `Map.has()`.
   *  Used by `recoverOrphanedWorkflows()` to skip rows that are
   *  also live in memory. */
  has(runID: string): boolean {
    return this.runs.has(runID)
  }

  /** Remove the entry registered under `runID`. No-op if no such
   *  entry exists — matches `Map.delete()` (never throws on missing
   *  keys). Called by `cancel()`, `completeRun()`, `failRun()` in
   *  the runtime to drop settled entries so their McpBridge /
   *  journalResults / AbortController / closures are GC-eligible
   *  (v0.14.x C-2). */
  release(runID: string): void {
    this.runs.delete(runID)
  }

  /** Remove every entry. Used by `close()` after the cancel-all loop
   *  — the per-settle `release()` calls are the primary path, but
   *  `close()` is the final defense against leaked entries from
   *  crashed/exception paths that bypassed the normal settle. */
  clear(): void {
    this.runs.clear()
  }

  /** Number of currently-registered entries. Mirrors `Map.size`.
   *  Test/diagnostic surface; not used in production runtime hot
   *  paths. */
  size(): number {
    return this.runs.size
  }

  /** Iterate over [runID, entry] pairs in insertion order. Mirrors
   *  `for (const [id, entry] of map)` which the runtime uses in
   *  `list()` and `close()`. Returns a fresh array of pairs so the
   *  caller cannot mutate the registry's iteration cursor. */
  iter(): Array<[string, V]> {
    return [...this.runs.entries()]
  }

  /** Read-only snapshot of currently-registered runIDs in insertion
   *  order. Returns a fresh array (not a live view) so callers
   *  cannot mutate the registry by holding the returned reference.
   *  Matches the brief's `pending(): readonly string[]` interface. */
  pending(): readonly string[] {
    return [...this.runs.keys()]
  }
}