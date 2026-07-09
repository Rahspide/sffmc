// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Microtask pump + deadline race, extracted from sandbox.ts per the
// v0.16.0 refactor plan (ora-11, File 6). Guest microtasks (resolved
// Promises) need to be drained on the host clock. The pump self-
// reschedules via `setTimeout` with a fast window (active pumping)
// and a slow window (idle pumping) so the host doesn't busy-loop
// while the script is still working. The deadline race wraps the
// pump + script in a one-shot timer that rejects if the deadline
// fires first.

import { type QuickJSRuntime } from "quickjs-emscripten"
import { getSandboxFastMs, getSandboxFastWindow, getSandboxSlowMs } from "./constants.ts"

/** Start the microtask pump. Returns a `stop()` handle. The pump
 *  self-reschedules: a recursive setTimeout chain where each timer
 *  drains pending jobs and re-arms. */
export function startMicrotaskPump(rt: QuickJSRuntime): { stop: () => void } {
  const FAST_MS = getSandboxFastMs()
  const SLOW_MS = getSandboxSlowMs()
  const FAST_WINDOW = getSandboxFastWindow()
  let pumpTimer: ReturnType<typeof setTimeout> | undefined
  let idleTicks = 0

  const drainAndSchedule = (): void => {
    idleTicks = drainPendingJobsOrIdle(rt, idleTicks)
    pumpTimer = setTimeout(
      drainAndSchedule,
      computePumpDelayMs(idleTicks, FAST_MS, SLOW_MS, FAST_WINDOW),
    )
  }

  pumpTimer = setTimeout(drainAndSchedule, FAST_MS)
  pumpTimer.unref?.()
  return {
    stop: (): void => {
      if (pumpTimer) clearTimeout(pumpTimer)
    },
  }
}

/** Drain any pending guest jobs and return the next idle-tick count:
 *  resets to 0 on work found (the next pump tick fires FAST), or
 *  increments otherwise. */
export function drainPendingJobsOrIdle(rt: QuickJSRuntime, idleTicks: number): number {
  if (rt.hasPendingJob()) {
    rt.executePendingJobs()
    return 0
  }
  return idleTicks + 1
}

/** Adaptive cadence delay: FAST while `idleTicks < FAST_WINDOW`,
 *  SLOW once the pump has been idle longer. Pure. */
export function computePumpDelayMs(
  idleTicks: number,
  fastMs: number,
  slowMs: number,
  fastWindow: number,
): number {
  return idleTicks < fastWindow ? fastMs : slowMs
}

/** Wall-clock deadline race: rejects after `ms` with a clear error.
 *  Returns the rejecting promise AND the underlying timer so the
 *  caller can cancel it once the guest resolves. */
export function createDeadlineRace(
  ms: number,
): { promise: Promise<never>; timer: ReturnType<typeof setTimeout> } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("workflow script deadline exceeded")),
      ms,
    )
  })
  return { promise, timer: timer as ReturnType<typeof setTimeout> }
}

