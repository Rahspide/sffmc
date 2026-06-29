// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// OutcomeStore — domain wrapper around BoundedLRU for settled-workflow
// outcomes (M-1 god-object refactor, Task 1.4).
//
// Replaces the `completedOutcomes: BoundedLRU<string, WorkflowOutcome>`
// field previously held inline on WorkflowRuntime. Three call sites
// existed before the extract: a read in `wait()` (line 436, non-destructive
// to preserve the late-wait contract), writes in completeRun/failRun/cancel,
// and a clear in `close()`. The domain-shaped API makes those call sites
// read clearly at the runtime level:
//
//   - `put(k, v)` — settle-write (replaces `lru.set`).
//   - `get(k)` — late-wait read (replaces `lru.get`).
//   - `take(k)` — read-and-remove; exported but not currently used by
//                runtime.ts (the runtime wants the cached outcome to
//                survive multiple late reads — see the second-wait
//                characterization test). Kept here so a future "leak-free
//                consume" semantics can adopt it without rewriting callers.
//   - `size`, `capacity`, `clear` — match the BoundedLRU shape that the
//                                    integration tests in lru-cache.test.ts
//                                    previously read via reflection.
//
// Backing storage: BoundedLRU preserves insertion order and evicts the
// oldest entry when the configured `maxSize` is exceeded. Capacity is
// sourced from `RuntimeOpts.completedOutcomesCacheSize ?? resolveOutcomesCacheSize()`
// at construction time so a single OutcomeStore per runtime is enough.

import { BoundedLRU } from "./lru.ts"

export class OutcomeStore<K, V> {
  private readonly lru: BoundedLRU<K, V>

  constructor(maxSize: number = 500) {
    if (!Number.isInteger(maxSize) || maxSize < 0) {
      throw new Error(
        `OutcomeStore: maxSize must be a non-negative integer, got ${maxSize}`,
      )
    }
    this.lru = new BoundedLRU<K, V>(maxSize)
  }

  /** Insert or update an outcome keyed by `key`. If the resulting size
   *  exceeds capacity, the oldest entries are evicted. */
  put(key: K, value: V): void {
    this.lru.set(key, value)
  }

  /** Read the outcome for `key` without removing it. Used by the late-wait
   *  path: a settled runID is removed from `this.runs` so its McpBridge,
   *  journalResults, AbortController, and closures are GC-eligible, but
   *  subsequent `wait()` calls still resolve to the same cached outcome
   *  instead of a synthetic "unknown runID" failure (see the
   *  v0.14.x C-2 comment at runtime.ts:432-445). Returns undefined if
   *  the key is absent (either never inserted or already evicted). */
  get(key: K): V | undefined {
    return this.lru.get(key)
  }

  /** Read the outcome for `key` and remove it in one shot. Returns
   *  undefined if the key is absent. Not currently used by the runtime —
   *  kept on the API surface so callers that want consume-once
   *  semantics (e.g. a one-shot RPC handler) can adopt it without
   *  revisiting the LRU directly. */
  take(key: K): V | undefined {
    const v = this.lru.get(key)
    if (v !== undefined) {
      this.lru.delete(key)
    }
    return v
  }

  /** Number of cached outcomes currently held. */
  get size(): number {
    return this.lru.size
  }

  /** Configured capacity (the maxSize passed to the constructor). */
  get capacity(): number {
    return this.lru.capacity
  }

  /** Drop every cached outcome. Invoked by `WorkflowRuntime.close()`. */
  clear(): void {
    this.lru.clear()
  }
}
