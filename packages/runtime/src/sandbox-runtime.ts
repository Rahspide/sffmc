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
const DEFAULT_PRNG_SEED = 0x9e3779b9

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
  runtime.setMaxStackSize(stackSize * 1024)
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + opts.deadlineMs))
  return runtime
}

/** Harden the guest context for determinism. Deletes Date (no wall-clock
 *  access), installs a seeded Math.random, and removes WeakRef /
 *  FinalizationRegistry (the latter has nondeterministic GC timing). */
export function hardenDeterminism(ctx: QuickJSContext, seed: number): void {
  const code = hardenGuestCode(seed)
  const result = ctx.evalCode(code, "harden.js", { type: "global" })
  if (result.error) {
    const errStr = ctx.dump(result.error)
    result.error.dispose()
    throw new Error(`hardenDeterminism eval failed: ${errStr}`)
  }
  result.value.dispose()
}

/** Hardening script source. Uses the `mulberry32` PRNG seeded from the
 *  caller-supplied seed (stable across replays of the same workflow). */
export function hardenGuestCode(seed: number): string {
  // Mulberry32 — small, fast, good-enough distribution for the
  // 2^32 state space we need. Seed advances 0 → seed via a known
  //  walk so the first 8 outputs are stable for a given seed.
  const s = seed >>> 0
  return `
    (() => {
      delete globalThis.Date;
      let __s = ${s} >>> 0;
      globalThis.Math.random = () => {
        __s = (__s + 0x6D2B79F5) >>> 0;
        let t = __s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      delete globalThis.WeakRef;
      delete globalThis.FinalizationRegistry;
    })();
  `
}
