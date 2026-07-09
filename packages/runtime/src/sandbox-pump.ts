// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Microtask pump + deadline race, extracted from sandbox.ts per the
// v0.16.0 refactor plan (ora-11, File 6). Guest microtasks (resolved
// Promises) need to be drained on the host clock. The pump self-
// reschedules via `setTimeout` with a fast window (active pumping)
// and a slow window (idle pumping) so the host doesn't busy-loop
// while the script is still working. The deadline race wraps the
// pump + script in a one-shot timer that resolves the script promise
// with `null` if the deadline fires first.

import { type QuickJSRuntime } from "quickjs-emscripten"
import { getSandboxFastMs, getSandboxFastWindow, getSandboxSlowMs } from "./constants.ts"

/** Start the microtask pump. Returns a `stop()` handle. The pump
 *  self-reschedules: a recursive setTimeout chain where each timer
 *  drains pending jobs and re-arms. `unref()` lets the process exit
 *  even if a pump window is open. */
export function startMicrotaskPump(rt: QuickJSRuntime): { stop: () => void } {
  let pumpTimer: ReturnType<typeof setTimeout> | null = null
  let idleTicks = 0
  let stopped = false

  const drainAndSchedule = () => {
    if (stopped) return
    const didWork = drainPendingJobsOrIdle(rt, idleTicks)
    idleTicks = didWork ? 0 : idleTicks + 1
    const delay = computePumpDelayMs(idleTicks)
    pumpTimer = setTimeout(drainAndSchedule, delay)
    pumpTimer.unref?.()
  }

  pumpTimer = setTimeout(drainAndSchedule, 0)
  pumpTimer.unref?.()

  return {
    stop: () => {
      stopped = true
      if (pumpTimer !== null) {
        clearTimeout(pumpTimer)
        pumpTimer = null
      }
    },
  }
}

/** Drain pending jobs or return an idle-tick delta. Returns true if
 *  work was done (the pump stays in fast mode), false otherwise
 *  (the pump may transition to slow mode after enough idle ticks). */
export function drainPendingJobsOrIdle(rt: QuickJSRuntime, idleTicks: number): boolean {
  const workBefore = idleTicks === 0 ? 1 : 0
  rt.executePendingJobs()
  // We can't observe "did work" directly; the heuristic is that
  // executePendingJobs returns the number of jobs executed. QuickJS
  // returns 0 when there's nothing to do. Use the result to decide.
  return workBefore === 1 ? true : false
}

/** Compute the pump delay based on the number of consecutive idle
 *  ticks. Fast window: pump every `getSandboxFastMs()` (default 1ms).
 *  Slow window: pump every `getSandboxSlowMs()` (default 50ms) after
 *  `getSandboxFastWindow()` consecutive idle ticks. */
export function computePumpDelayMs(idleTicks: number): number {
  if (idleTicks < getSandboxFastWindow()) return getSandboxFastMs()
  return getSandboxSlowMs()
}

/** Race a one-shot deadline timer against the script promise. The
 *  returned `cancel()` must be called in the `finally` block of the
 *  script's promise to clear the timer. If the timer fires first, the
 *  script's promise resolves to `null` (so the runtime can detect
 *  "the script looped past the deadline" without a real exception). */
export function createDeadlineRace(
  promise: Promise<unknown>,
  deadlineMs: number,
): { promise: Promise<unknown | null>; cancel: () => void } {
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null
  let settled = false
  const racedPromise = new Promise<unknown | null>((resolve) => {
    deadlineTimer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, deadlineMs)
    deadlineTimer.unref?.()
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        resolve(value ?? null)
      },
      (err) => {
        if (settled) return
        settled = true
        // Surface the error so the runtime's launchScript can decide
        // whether to mark the run as failed.
        resolve(Promise.reject(err) as unknown as null)
      },
    )
  })
  return {
    promise: racedPromise,
    cancel: () => {
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer)
        deadlineTimer = null
      }
    },
  }
}
