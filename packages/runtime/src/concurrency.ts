// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Concurrency primitives extracted from WorkflowRuntime (M-1 god-object
// refactor, Task 1.6 façade reduction). The runtime previously held two
// promise-based concurrency helpers inline (lines 98-143 of the pre-extract
// runtime.ts): a `makeSemaphore(max)` for global agent-call throttling, and
// `acquireLock(key)` for per-runID mutual exclusion during concurrent
// `resume()` calls.
//
// Why separate file: both helpers are pure async plumbing with no
// domain-specific state — they belong in a `concurrency.ts` module rather
// than the runtime façade. The runtime holds one `Semaphore` (per-runtime)
// and a `Concurrency` instance (also per-runtime, see Task 2.7 L-3) that
// it calls `acquireLock("workflow-resume:" + runID)` on via
// `this.concurrency.acquireLock(...)`. Test files import directly from this
// module for unit tests of the helpers in isolation (concurrency.test.ts).

/** Promise-based counting semaphore. `run(fn)` wraps a thunk so concurrent
 *  callers above `max` queue until a slot frees. Used by
 *  `WorkflowRuntime` to throttle LLM agent invocations against the
 *  YAML-configured `maxConcurrentAgents` cap.
 *
 *  `makeSemaphore` returns a fresh closure instance per call — `active` and
 *  `queue` are captured in the closure, so each semaphore has independent
 *  state already. No per-instance fields are needed on a class wrapper. */
export function makeSemaphore(max: number) {
  let active = 0
  const queue: Array<() => void> = []
  const release = () => {
    active--
    if (queue.length === 0) return
    const next = queue.shift()
    if (next) next()
  }
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const attempt = () => {
          active++
          fn().then(
            (value) => { release(); resolve(value) },
            (err) => { release(); reject(err) },
          )
        }
        if (active < max) attempt()
        else queue.push(attempt)
      })
    },
    get active() { return active },
    get max() { return max },
  }
}

/** Per-key promise-chain mutex (L-3, Task 2.7).
 *
 *  Each `acquireLock(key)` appends a new tail entry to the chain under
 *  `key`; the returned `release()` resolves it. Callers with the same key
 *  run strictly in registration order. Different keys do NOT serialize.
 *
 *  Previously this state lived at module scope (`const lockMap`), which
 *  meant all `acquireLock` callers in the process shared the same chain.
 *  Promoted to a class with an instance-scoped `lockMap` so each
 *  `Concurrency` instance owns its own chains — WorkflowRuntime gets one
 *  instance, tests can create fresh instances for hermetic isolation, and
 *  multi-runtime scenarios don't cross-contaminate lock chains. */
export class Concurrency {
  /** Per-key promise chain. Each value is the LATEST tail under `key`
   *  — stored by direct identity (the Promise object itself), not wrapped
   *  in `prev.then(...)`. Serialization still works because the caller's
   *  returned promise chains through `prev = lockMap.get(key)`, so a
   *  second acquirer always waits for the previous tail to resolve
   *  before its own lock fires. Storing `next` directly (rather than the
   *  chained promise) lets the release cleanup `lockMap.get(key) === next`
   *  actually match, so the entry is removed from the map once the last
   *  acquirer releases — preventing unbounded growth of stale chained
   *  Promise references in long-lived runtimes. */
  private lockMap = new Map<string, Promise<void>>()

  /** Number of keys currently tracked in `lockMap`. Exposed for tests so
   *  the leak regression net can verify cleanup works without resorting
   *  to private-state reflection. In production, callers should not need
   *  this — it's here strictly to pin the leak-fix invariant. */
  lockMapSize(): number {
    return this.lockMap.size
  }

  /** Acquire the lock under `key`, returning a `release()` callback that
   *  resolves the next waiter (or removes the tail entry if no successor).
   *  Used by `WorkflowRuntime.resume()` to serialize concurrent resumes of
   *  the same runID — without it, two parallel `resume(wf_X)` calls can
   *  both read "not in memory", both load the script, and both launch a
   *  new sandbox, racing on the same DB row. */
  acquireLock(key: string): Promise<{ release: () => void }> {
    const prev = this.lockMap.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const next = new Promise<void>((resolve) => { release = resolve })
    this.lockMap.set(key, next)
    return prev.then(() => ({
      release: () => {
        release()
        if (this.lockMap.get(key) === next) this.lockMap.delete(key)
      },
    }))
  }
}
