// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// FlushManager — debounced DB counter flush, extracted from WorkflowRuntime
// (M-1 god-object refactor, Task 1.6 façade reduction). The runtime
// previously held `scheduleFlush()` + `flushNow()` inline (lines 1284-1328
// of the pre-extract runtime.ts) plus a `flushTimers: Map<runID, Timeout>`
// field. The two methods are pure plumbing over the persistence DB
// connection and an internal timer map; they don't need runtime instance
// state beyond `persistence.getDB()` for the UPDATE.
//
// Why a class: the helpers share `flushTimers` state, so wrapping them in a
// class is the natural way to keep that state encapsulated (a free function
// would need a module-scope Map, which is harder to test and harder to
// scope to a single runtime instance). The class owns its own map; the
// runtime holds one FlushManager and delegates both methods.
//
// Reflection-test compatibility: `runtime-coverage.test.ts` drives
// `flushNow` directly via `runtime as unknown as { flushNow: (e: unknown) => void }`.
// To keep that cast working, the runtime keeps a thin `flushNow(entry)`
// method that delegates to the manager. `scheduleFlush` is only called from
// inside the runtime, so no test-fixture compatibility is needed there.

import type { CounterManager } from "./counter-manager.ts"
import type { WorkflowPersistence } from "./persistence.ts"
import { getFlushDebounceMs } from "./constants.ts"
import { createLogger } from "@sffmc/utilities"

const log = createLogger("workflow")

/** Read-only count tuple shape that `flushNow()` updates. `InternalRunEntry`
 *  satisfies this structurally, but exposing the shape separately lets the
 *  class accept test fake entries that only carry the relevant fields. */
export interface FlushableCounters {
  counters?: Pick<CounterManager, "running" | "succeeded" | "failed">
  runID: string
}

/** Debounce timer per runID. Each `scheduleFlush()` within the debounce
 *  window collapses to a single `flushNow()` fire; the timer is unref'd so
 *  it doesn't keep the runtime alive at shutdown (the runtime's `close()`
 *  also clears all pending timers explicitly). Window comes from
 *  `getFlushDebounceMs()` so user YAML overrides take effect.
 *
 *  Why a `flushEntries` registry alongside `flushTimers`: the timer
 *  callback must read the LATEST entry reference, not the one captured at
 *  `scheduleFlush` time. The runtime may replace an entry (cancel +
 *  resume) between schedule and fire — the captured reference would then
 *  be stale and write the OLD counters to the DB. The registry stores
 *  the most recently scheduled entry per runID so the timer always
 *  flushes current counters. In normal (non-cancel-resume) operation the
 *  entry identity is stable and the registry ref matches the captured
 *  ref exactly — the behavior is unchanged. */
export class FlushManager {
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Latest entry reference per runID. Always overwritten on
   *  `scheduleFlush` so a mid-window entry replacement still wins. */
  private readonly flushEntries = new Map<string, FlushableCounters>()
  private readonly debounceMs: number

  constructor(
    private readonly persistence: WorkflowPersistence,
    debounceMs?: number,
  ) {
    this.debounceMs = debounceMs ?? getFlushDebounceMs()
  }

  /** Schedule a debounced flush for `entry.runID`. If a timer is already
   *  pending for this runID, the existing timer is kept — the latest
   *  entry reference (this one) is recorded in `flushEntries` so the
   *  timer fires against the most recent counters when it elapses. */
  scheduleFlush(entry: FlushableCounters): void {
    const runID = entry.runID
    this.flushEntries.set(runID, entry)
    if (this.flushTimers.has(runID)) return
    const t = setTimeout(() => {
      this.flushTimers.delete(runID)
      const latest = this.flushEntries.get(runID)
      this.flushEntries.delete(runID)
      if (latest) this.flushNow(latest)
    }, this.debounceMs)
    t.unref?.()
    this.flushTimers.set(runID, t)
  }

  /** Cancel any pending timer and run the DB UPDATE synchronously. Reads
   *  `running / succeeded / failed` from `entry.counters` (defensively
   *  coerced via `?? 0` for fake-entry test fixtures that omit the field)
   *  and writes them to `workflow_runs`. DB errors are caught and logged at
   *  WARN level so a transient SQLite hiccup doesn't crash the runtime, but
   *  operators can still spot counter↔DB drift in production logs. */
  flushNow(entry: FlushableCounters): void {
    const runID = entry.runID
    const t = this.flushTimers.get(runID)
    if (t) {
      clearTimeout(t)
      this.flushTimers.delete(runID)
    }
    this.flushEntries.delete(runID)
    const db = this.persistence.getDB()
    try {
      db.run(
        `UPDATE workflow_runs SET running = ?, succeeded = ?, failed = ?, time_updated = ? WHERE id = ?`,
        [
          entry.counters?.running ?? 0,
          entry.counters?.succeeded ?? 0,
          entry.counters?.failed ?? 0,
          Math.floor(Date.now() / 1000),
          runID,
        ],
      )
    } catch (e) {
      log.warn(`flushNow DB update error for ${runID}:`, e)
    }
  }

  /** Cancel every pending timer. Called by `WorkflowRuntime.close()`
   *  so the runtime doesn't leave dangling unref'd timers pinning the
   *  event loop after teardown. Also drops the entry registry so a
   *  follow-up `scheduleFlush` after close starts from a clean slate. */
  clearAll(): void {
    for (const [, t] of this.flushTimers) {
      clearTimeout(t)
    }
    this.flushTimers.clear()
    this.flushEntries.clear()
  }
}
