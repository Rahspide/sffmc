// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// REGRESSION tests for sandbox-bridge.ts handle lifecycle.
//
// v0.16.0-SOLID refactor extracted `dumpHostFnArgs`, `marshalIn`,
// `bridgeAsyncHostResult`, etc. into a dedicated module. The bridge
// is the hot path for host↔guest function calls: every guest-side
// `mcp.call(name, args)` round-trips through `dumpHostFnArgs` on the
// way in, and every host→guest value marshals through `marshalIn` on
// the way back. Handle leaks here accumulate across every workflow
// step, so unit tests for the dispose order matter.

// QuickJSHandle + QuickJSContext are duck-typed in this file. The real
// types from quickjs-emscripten require the WASM module to instantiate,
// which is heavy. These tests cover the dispose-order invariants in
// isolation — they assert "did dispose run?" not "did QuickJS behave?".

import { describe, test, expect } from "bun:test"
import { dumpHostFnArgs } from "../src/sandbox-bridge.ts"

interface FakeHandle {
  disposed: boolean
  label: string
  /** Sentinel payload returned by `ctx.dump(h)`. */
  dumpPayload: unknown
  /** Optional: set to true to make `ctx.dump(h)` throw. */
  dumpThrows?: boolean
  dispose(): void
}

interface FakeCtx {
  dump(h: FakeHandle): unknown
}

function makeHandle(label: string, payload: unknown, opts: { dumpThrows?: boolean } = {}): FakeHandle {
  const h: FakeHandle = {
    label,
    disposed: false,
    dumpPayload: payload,
    dumpThrows: opts.dumpThrows,
    dispose() {
      this.disposed = true
    },
  }
  return h
}

describe("dumpHostFnArgs — handle lifecycle", () => {
  test("dumps every arg in order and disposes every handle on the happy path", () => {
    const h1 = makeHandle("h1", "first")
    const h2 = makeHandle("h2", 42)
    const h3 = makeHandle("h3", { nested: true })
    const ctx: FakeCtx = {
      dump: (h) => h.dumpPayload,
    }

    const args = dumpHostFnArgs(ctx as any, [h1, h2, h3])

    expect(args).toEqual(["first", 42, { nested: true }])
    expect(h1.disposed).toBe(true)
    expect(h2.disposed).toBe(true)
    expect(h3.disposed).toBe(true)
  })

  // REGRESSION (v0.16.0-SOLID, sandbox-bridge): before the try/finally
  // fix, `h.dispose()` lived AFTER `args.push(ctx.dump(h))`. When
  // `ctx.dump(h)` threw (e.g. on a non-serializable handle, a custom
  // host function returning a circular object, or a QuickJS internal
  // failure), the dispose was skipped and the guest handle leaked. In
  // a long-running workflow with thousands of mcp/agent calls this
  // leaked a handle per call — a real OOM risk. The fix wraps the
  // dump in try/finally so dispose runs regardless.
  test("REGRESSION: still disposes when ctx.dump throws", () => {
    const h1 = makeHandle("h1", "ok")
    const h2 = makeHandle("h2", "throw-target", { dumpThrows: true })
    const h3 = makeHandle("h3", "after-throw")
    const ctx: FakeCtx = {
      dump: (h) => {
        if (h.dumpThrows) throw new Error("boom")
        return h.dumpPayload
      },
    }

    let caught: unknown = null
    try {
      dumpHostFnArgs(ctx as any, [h1, h2, h3])
    } catch (e) {
      caught = e
    }

    // The dump failure must propagate (so the caller can observe it).
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("boom")

    // Both reached handles disposed despite the throw — no leak.
    // h1 was disposed before h2's throw; h2 was disposed via finally
    // when its own dump threw. h3 was never reached (loop exited via
    // throw before h3), so it stays live.
    expect(h1.disposed).toBe(true)
    expect(h2.disposed).toBe(true)
    expect(h3.disposed).toBe(false)
  })

  test("REGRESSION: continues disposing reached handles when one dump throws", () => {
    // Even if h2's dump throws and h3 never gets pushed, the loop
    // should still have disposed h2 via the finally. This test
    // verifies the per-handle try/finally rather than a loop-level one
    // (a loop-level try/finally would dispose h3 too — which is wrong
    // because h3 was never reached).
    const h1 = makeHandle("h1", 1)
    const h2 = makeHandle("h2", "boom", { dumpThrows: true })
    const h3 = makeHandle("h3", 3)
    const ctx: FakeCtx = {
      dump: (h) => {
        if (h.dumpThrows) throw new Error("boom")
        return h.dumpPayload
      },
    }

    expect(() => dumpHostFnArgs(ctx as any, [h1, h2, h3])).toThrow("boom")
    expect(h1.disposed).toBe(true)
    expect(h2.disposed).toBe(true)
    expect(h3.disposed).toBe(false)
  })

  test("empty handle array returns empty result", () => {
    const ctx: FakeCtx = { dump: () => { throw new Error("should not be called") } }
    expect(dumpHostFnArgs(ctx as any, [])).toEqual([])
  })
})