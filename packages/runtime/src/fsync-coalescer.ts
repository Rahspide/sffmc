// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// FSync coalescer, extracted from persistence.ts per the v0.16.0
// refactor plan (ora-9, Phase 7). High-frequency appendJournalSync
// callers (e.g. 100+ events per workflow) would otherwise fsync per
// append, costing O(n) syscalls. This class coalesces fsync calls
// within a configurable window: each append schedules a deferred
// fsync that fires once per window across all tracked paths.
//
// Per-instance (composition, not module-level singleton) so concurrent
// persistence instances don't share or cancel each other's timers.

import { openSync, fsyncSync, closeSync } from "node:fs"
import { createLogger } from "@sffmc/utilities"

const log = createLogger("fsync-coalescer")

export class FSyncCoalescer {
  /** Per-instance journal paths awaiting fsync. Initialised lazily so
   *  the common no-append path costs zero memory. */
  private pendingPaths: Set<string> | null = null
  /** Per-instance coalesce timer. Null when no fsync is pending. */
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly coalesceMs: () => number,
    private readonly onError?: (e: unknown) => void,
  ) {}

  /** Arm a coalesced fsync if one isn't already pending. Idempotent —
   *  multiple `add()` calls within the window collapse to a single fsync
   *  that drains all pending paths. The `unref()` call lets the
   *  process exit even if a coalesce window is open. */
  add(path: string): void {
    if (this.pendingPaths === null) {
      this.pendingPaths = new Set<string>()
    }
    this.pendingPaths.add(path)
    if (this.timer !== null) return
    this.timer = setTimeout(() => this.flush(), this.coalesceMs())
    this.timer.unref?.()
  }

  /** Drain this instance's pending fsync set. Each path is opened
   *  RDONLY, fsync'd, and closed — the RDONLY open is sufficient
   *  because fsync flushes the kernel's page cache for that inode,
   *  which is the durable surface that subsequent reads will see.
   *  Failures (file removed mid-coalesce, EACCES) are best-effort
   *  and silently dropped; the in-memory journal data is already
   *  durable from the perspective of a reader who re-opens the file. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.pendingPaths || this.pendingPaths.size === 0) return
    const paths = this.pendingPaths
    this.pendingPaths = null
    for (const p of paths) {
      let fd: number
      try {
        fd = openSync(p, "r")
      } catch (e) {
        log.debug({ err: e, path: p }, "fsync-coalescer: openSync failed (file likely removed)")
        continue // best-effort: file may have been removed
      }
      try {
        fsyncSync(fd)
      } catch (e) {
        if (this.onError) this.onError(e)
      } finally {
        try { closeSync(fd) } catch (e) { log.debug({ err: e, fd, path: p }, "fsync-coalescer: closeSync failed"); /* ignore */ }
      }
    }
  }

  /** Test helper — returns the number of pending paths. */
  size(): number {
    return this.pendingPaths?.size ?? 0
  }

  /** Test helper — returns a copy of the pending paths Set (or null
   *  when the lazy initializer hasn't fired). The copy is a defensive
   *  snapshot so callers can't mutate the internal state. */
  paths(): Set<string> | null {
    return this.pendingPaths ? new Set(this.pendingPaths) : null
  }
}
