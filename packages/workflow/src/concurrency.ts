// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

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
// and calls `acquireLock("workflow-resume:" + runID)` on each `resume()`.
// Test files import directly from this module for unit tests of the helpers
// in isolation (concurrency.test.ts).

/** Promise-based counting semaphore. `run(fn)` wraps a thunk so concurrent
 *  callers above `max` queue until a slot frees. Used by
 *  `WorkflowRuntime` to throttle LLM agent invocations against the
 *  YAML-configured `maxConcurrentAgents` cap. */
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

/** Module-scope chain map. Each `acquireLock(key)` appends a new tail entry to
 *  the chain under `key`; the returned `release()` resolves it. Callers with
 *  the same key run strictly in registration order.
 *
 *  Volatile scope: the map is module-scope, so locks reset across module
 *  reloads (e.g. test runner re-eval). Production runs in a single Node
 *  process so this is fine. If the runtime ever forks workers, each worker
 *  needs its own process module. */
const lockMap = new Map<string, Promise<void>>()

/** Acquire the lock under `key`, returning a `release()` callback that
 *  resolves the next waiter (or removes the tail entry if no successor).
 *  Used by `WorkflowRuntime.resume()` to serialize concurrent resumes of
 *  the same runID — without it, two parallel `resume(wf_X)` calls can both
 *  read "not in memory", both load the script, and both launch a new
 *  sandbox, racing on the same DB row. */
export function acquireLock(key: string): Promise<{ release: () => void }> {
  const prev = lockMap.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const next = new Promise<void>((resolve) => { release = resolve })
  lockMap.set(key, prev.then(() => next))
  return prev.then(() => ({
    release: () => {
      release()
      if (lockMap.get(key) === next) lockMap.delete(key)
    },
  }))
}
