// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Sandbox runtime allocation + hardening, extracted from sandbox.ts
// per the v0.16.0 refactor plan (ora-11, File 4). Allocates the
// QuickJS runtime sized by `opts` (YAML-configured memory/stack),
// installs the interrupt handler for the deadline race, and hardens
// the guest for determinism (no Date, no Math.random with a stable
// seed, no WeakRef/FinalizationRegistry).

import {
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten"
import { getSandboxMemoryMB, getSandboxStackSize } from "./constants.ts"

/** Fallback seed when no caller-supplied seed is set. Stable so existing
 *  single-shot tests stay deterministic. The runtime always passes
 *  seed=hash(runID) so production paths never see this default. */
export const DEFAULT_PRNG_SEED = 0x9e3779b9

export interface SandboxRuntimeOpts {
  QJS: QuickJSWASMModule
  seed?: number
  memoryMB?: number
  stackSize?: number
  deadlineMs: number
}

/** Allocate a QuickJS runtime sized by `opts` (YAML-configured memory/stack)
 *  and wire `shouldInterruptAfterDeadline(now + deadlineMs)` as the
 *  interrupt handler. The deadline is captured by reference in the
 *  closure, so it must be computed before `newRuntime()`. */
export function createSandboxRuntime(opts: SandboxRuntimeOpts): QuickJSRuntime {
  const seed = opts.seed ?? DEFAULT_PRNG_SEED
  const memoryMB = opts.memoryMB ?? getSandboxMemoryMB()
  const stackSize = opts.stackSize ?? getSandboxStackSize()
  const runtime = opts.QJS.newRuntime()
  runtime.setMemoryLimit(memoryMB * 1024 * 1024)
  // stackSize is in BYTES (not KB) — matches the original
  // `setMaxStackSize(getSandboxStackSize())` which returns bytes
  // (1 MiB default = 1_048_576 bytes).
  runtime.setMaxStackSize(stackSize)
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + opts.deadlineMs))
  return runtime
}

/** Install the determinism hardening: delete `Date` / `WeakRef` /
 *  `FinalizationRegistry` (nondeterministic or GC-liveness built-ins)
 *  and replace `Math.random` with a seeded mulberry32 PRNG so resume
 *  replay stays sound. Always disposes the eval result/error; never
 *  throws. */
export function hardenDeterminism(ctx: QuickJSContext, seed: number): void {
  const stripResult = ctx.evalCode(hardenGuestCode(seed))
  if (stripResult.error) {
    stripResult.error.dispose()
  } else {
    stripResult.value.dispose()
  }
}

/** Build the guest-side hardening script. Pure string template. */
export function hardenGuestCode(seed: number): string {
  return `
    delete globalThis.Date;
    (function () {
      // mulberry32 — tiny seeded PRNG; deterministic for a given seed.
      let s = ${seed >>> 0};
      Math.random = function () {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    delete globalThis.WeakRef;
    delete globalThis.FinalizationRegistry;
  `
}
