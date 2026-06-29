// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

/**
 * Bounded LRU cache backed by a `Map`.
 *
 * JavaScript's `Map` preserves insertion order, so the *oldest* entry is
 * always `map.keys().next().value`. When `size` would exceed `maxSize`,
 * we delete the oldest key in a loop until size ≤ maxSize. Re-setting an
 * existing key (via `set`) deletes-then-inserts so the new value lands at
 * the end (most-recently-used position).
 *
 * Default intent: late-`wait()` callers (see runtime.ts C-2 comment) get
 * a cached `WorkflowOutcome` so they don't see "unknown runID" for settled
 * runs. The bound prevents unbounded growth in long-lived daemons.
 */
export class BoundedLRU<K, V> {
  private readonly maxSize: number
  private readonly map = new Map<K, V>()

  constructor(maxSize: number) {
    if (!Number.isInteger(maxSize) || maxSize < 0) {
      throw new Error(`BoundedLRU: maxSize must be a non-negative integer, got ${maxSize}`)
    }
    this.maxSize = maxSize
  }

  /** Returns the value for `k`, or undefined if absent. Does NOT bump recency. */
  get(k: K): V | undefined {
    return this.map.get(k)
  }

  /** Insert or update. If `k` exists, it is moved to the most-recent position.
   *  If the resulting size exceeds `maxSize`, oldest entries are evicted. */
  set(k: K, v: V): void {
    if (this.maxSize === 0) return
    if (this.map.has(k)) {
      // delete-then-set so the new entry lands at the end (MRU).
      this.map.delete(k)
    }
    this.map.set(k, v)
    while (this.map.size > this.maxSize) {
      // Map preserves insertion order, so the first key is always the oldest.
      const oldestKey = this.map.keys().next().value
      if (oldestKey === undefined) break
      this.map.delete(oldestKey)
    }
  }

  /** Remove entry for `k`. Returns true if present. */
  delete(k: K): boolean {
    return this.map.delete(k)
  }

  /** Drop all entries. */
  clear(): void {
    this.map.clear()
  }

  /** Number of cached entries. */
  get size(): number {
    return this.map.size
  }

  /** Configured capacity. */
  get capacity(): number {
    return this.maxSize
  }
}