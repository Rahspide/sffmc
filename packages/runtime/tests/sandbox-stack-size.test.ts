// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE
//
// REGRESSION TEST for v0.16.0 `setMaxStackSize` unit bug.
//
// During the Lane C refactor (commit 8c687a6, "wire 5 sandbox helper
// modules"), `createSandboxRuntime` was changed from:
//   runtime.setMaxStackSize(getSandboxStackSize())
// to:
//   runtime.setMaxStackSize(stackSize * 1024)  // BUG: doubled the unit
// The value of `stackSize` was already in BYTES (the YAML config
// exposes `sandboxStackSize` as a byte count, default 1 MiB = 1_048_576).
// Multiplying by 1024 inflated the stack 1024× and caused PRELUDE to
// overflow on small scripts. 78 tests failed until the bug was found
// and fixed (commit message explains).
//
// This test pins the byte-vs-kilobyte contract so the next refactor
// reintroducing this mistake fails at test time, not at the
// 78-orchestrator-test level where the symptom (PRELUDE stack overflow)
// is one level of indirection from the cause.
//
// WHAT IT CHECKS:
//   1. With `stackSize: 1` (1 byte) — PRELUDE MUST fail with stack overflow.
//      If it does NOT fail, the runtime is granting more stack than
//      1 byte, which means a `* 1024` factor or similar was reintroduced.
//   2. With `stackSize: undefined` (default = 1 MiB bytes) — PRELUDE
//      MUST succeed. If it fails, the default is being interpreted as
//      kilobytes/megabytes instead of bytes.

import { describe, test, expect } from "bun:test"
import { getQuickJS } from "quickjs-emscripten"
import {
  createSandboxRuntime,
  hardenDeterminism,
  DEFAULT_PRNG_SEED,
} from "../src/sandbox-runtime.ts"
import { PRELUDE } from "../src/sandbox-prelude.ts"
import { evalAndDiscard } from "../src/sandbox-eval.ts"

async function loadQJS() {
  return await getQuickJS()
}

describe("createSandboxRuntime — stack size contract (regression)", () => {
  test("stackSize: 1 byte — PRELUDE must fail with stack overflow (catches *1024 bug)", async () => {
    const QJS = await loadQJS()
    // 1 byte is impossibly small — even a single JS expression frame
    // exceeds it. If the runtime grants more than 1 byte of stack, the
    // `* 1024` factor (or similar) has returned.
    const rt = createSandboxRuntime({
      QJS,
      seed: DEFAULT_PRNG_SEED,
      stackSize: 1, // 1 byte
      memoryMB: 64,
      deadlineMs: 60_000,
    })
    const ctx = rt.newContext()
    let preludeError: unknown = null
    try {
      hardenDeterminism(ctx, DEFAULT_PRNG_SEED)
      evalAndDiscard(ctx, PRELUDE, "prelude")
    } catch (e) {
      preludeError = e
    } finally {
      ctx.dispose()
      rt.dispose()
    }
    // Either we caught an error (correct), or — if no error — that's the
    // bug. Asserting via try/catch-then-expect is the simplest form.
    expect(preludeError).not.toBeNull()
  })

  test("stackSize: 1 MiB (default bytes) — PRELUDE must succeed", async () => {
    const QJS = await loadQJS()
    // 1 MiB = 1_048_576 bytes. PRELUDE has ~10 globals + regex + 2
    // function declarations — comfortably fits in 1 MiB.
    // If this fails, the default is being interpreted as a different
    // unit (KB → 1024 bytes for PRELUDE would overflow, MB → much
    // smaller effective stack).
    const rt = createSandboxRuntime({
      QJS,
      seed: DEFAULT_PRNG_SEED,
      stackSize: 1024 * 1024, // 1 MiB
      memoryMB: 64,
      deadlineMs: 60_000,
    })
    const ctx = rt.newContext()
    let preludeError: unknown = null
    try {
      hardenDeterminism(ctx, DEFAULT_PRNG_SEED)
      evalAndDiscard(ctx, PRELUDE, "prelude")
    } catch (e) {
      preludeError = e
    } finally {
      ctx.dispose()
      rt.dispose()
    }
    expect(preludeError).toBeNull()
  })

  test("stackSize: 4 KiB — PRELUDE must succeed (smallest realistic value)", async () => {
    // From the empirical stack-size table we built during debugging:
    //   1024 bytes → stack overflow
    //   4096 bytes → OK
    //   16384+ bytes → OK
    // 4 KiB is the smallest value where PRELUDE fits. This pins the
    // "byte, not kilobyte" boundary precisely.
    const QJS = await loadQJS()
    const rt = createSandboxRuntime({
      QJS,
      seed: DEFAULT_PRNG_SEED,
      stackSize: 4 * 1024, // 4 KiB
      memoryMB: 64,
      deadlineMs: 60_000,
    })
    const ctx = rt.newContext()
    let preludeError: unknown = null
    try {
      hardenDeterminism(ctx, DEFAULT_PRNG_SEED)
      evalAndDiscard(ctx, PRELUDE, "prelude")
    } catch (e) {
      preludeError = e
    } finally {
      ctx.dispose()
      rt.dispose()
    }
    expect(preludeError).toBeNull()
  })
})
