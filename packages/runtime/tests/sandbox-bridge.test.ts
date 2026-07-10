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
import { dumpHostFnArgs, marshalIn } from "../src/sandbox-bridge.ts"

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

// ─────────────────────────────────────────────────────────────────────────
// marshalIn — handle lifecycle regressions (gen-2 #8)
// ─────────────────────────────────────────────────────────────────────────
//
// Before the gen-2 fix, `marshalIn` returned a `QuickJSHandle` for non-
// primitive values via a 3-handle JSON-round-trip path: `json`,
// `evalCode("JSON.parse")` → `parseFn`, then `callFunction(parseFn, …)`.
// The two `dispose()` calls were AFTER `callFunction` returned. When
// `ctx.callFunction` threw (e.g. parse-evaluation error, internal QuickJS
// failure), both `json` AND `parseFn` leaked. When `ctx.unwrapResult`
// threw on the parse result, `json` leaked. Long-running workflows marshal
// values for every host→guest async resolution, so this leaked a handle
// per call — OOM risk in production. The fix wraps each acquisition in
// try/finally so disposal runs on every exit path. These tests verify the
// invariant for both throw sites.

interface EvalResultFake {
  alive: boolean
  dispose(): void
}

interface MarshalHandleFake {
  alive: boolean
  dispose(): void
}

interface MarshalCtxFake {
  alive: boolean
  undefined: MarshalHandleFake
  null: MarshalHandleFake
  true: MarshalHandleFake
  false: MarshalHandleFake
  newString(s: string): MarshalHandleFake
  newNumber(n: number): MarshalHandleFake
  evalCode(code: string): EvalResultFake
  unwrapResult(res: EvalResultFake): MarshalHandleFake
  callFunction(
    fn: MarshalHandleFake,
    thisVal: MarshalHandleFake,
    arg: MarshalHandleFake,
  ): EvalResultFake
}

function makeMarshalHandle(): MarshalHandleFake {
  const h: MarshalHandleFake = {
    alive: true,
    dispose() {
      h.alive = false
    },
  }
  return h
}

function makeMarshalCtx(opts: {
  evalCodeThrows?: boolean
  unwrapEvalThrows?: boolean
  callFunctionThrows?: boolean
  unwrapCallThrows?: boolean
} = {}): MarshalCtxFake {
  let evalCodeCallCount = 0
  let unwrapEvalCallCount = 0
  let callFunctionCallCount = 0
  let unwrapCallCallCount = 0
  return {
    alive: true,
    undefined: makeMarshalHandle(),
    null: makeMarshalHandle(),
    true: makeMarshalHandle(),
    false: makeMarshalHandle(),
    newString(_s: string) {
      return makeMarshalHandle()
    },
    newNumber(_n: number) {
      return makeMarshalHandle()
    },
    evalCode(_code: string) {
      evalCodeCallCount++
      if (opts.evalCodeThrows) {
        // Per QuickJS semantics, evalCode either returns a result-object or
        // never returns (the throw aborts the chain). The fake simulates the
        // exception path by throwing here; nothing to dispose on this branch
        // (no result was produced).
        throw new Error("evalCode boom")
      }
      return makeMarshalHandle() as unknown as EvalResultFake
    },
    unwrapResult(_res: EvalResultFake) {
      // unwrapResult is called twice in marshalIn: once for the eval result
      // and once for the callFunction result. Decide which one triggered
      // the call via call count.
      if (unwrapEvalCallCount === 0) {
        unwrapEvalCallCount++
        if (opts.unwrapEvalThrows) throw new Error("unwrapResult(eval) boom")
      } else {
        if (opts.unwrapCallThrows) {
          // Unwrap the final call result throws; the marshal path must have
          // already disposed json and parseFn by then (no further state to
          // leak).
          unwrapCallCallCount++
          throw new Error("unwrapResult(call) boom")
        }
        unwrapCallCallCount++
      }
      return makeMarshalHandle()
    },
    callFunction(_fn, _thisVal, _arg) {
      callFunctionCallCount++
      if (opts.callFunctionThrows) {
        throw new Error("callFunction boom")
      }
      return makeMarshalHandle() as unknown as EvalResultFake
    },
  } satisfies MarshalCtxFake
}

describe("marshalIn — handle lifecycle (gen-2 #8)", () => {
  test("primitive path on string never acquires JSON-round-trip handles", () => {
    // Track whether evalCode/unwrapResult/callFunction ever fire. Primitive
    // paths must short-circuit without touching them.
    let roundTripInvoked = false
    const ctx = makeMarshalCtx() as unknown as Parameters<typeof marshalIn>[0]
    ;(ctx as unknown as { evalCode: (c: string) => EvalResultFake }).evalCode = (
      _c: string,
    ) => {
      roundTripInvoked = true
      return makeMarshalHandle() as unknown as EvalResultFake
    }
    ;(ctx as unknown as { callFunction: (...args: unknown[]) => EvalResultFake }).callFunction = (
      ..._args: unknown[]
    ) => {
      roundTripInvoked = true
      return makeMarshalHandle() as unknown as EvalResultFake
    }

    let out: unknown = null
    try {
      out = marshalIn(ctx, "hello")
    } catch (_e) {
      // primitive path never throws
    }
    expect(out).not.toBeNull()
    expect(roundTripInvoked).toBe(false)
  })

  test("happy path: every acquired handle is disposed before returning", () => {
    // Track the three internal handles acquired in the JSON-round-trip path.
    // All must be disposed when marshalIn returns successfully. (The
    // returned handle from unwrapResult(callRes) is the caller's
    // responsibility — we don't track it here.)
    const refs: {
      json?: MarshalHandleFake
      parseFn?: MarshalHandleFake
      callRes?: { alive: boolean; dispose(): void }
    } = {}
    const ctx = makeMarshalCtx() as unknown as Parameters<typeof marshalIn>[0]
    ;(ctx as unknown as { newString: (s: string) => MarshalHandleFake }).newString = (
      _s: string,
    ) => {
      refs.json = makeMarshalHandle()
      return refs.json
    }
    ;(ctx as unknown as {
      unwrapResult: (r: EvalResultFake) => MarshalHandleFake
    }).unwrapResult = (r) => {
      // First call is on the eval result (returns parseFn). Second call
      // is on callRes — the real ctx.unwrapResult disposes the result it
      // was given, so the mock must do the same.
      if (!refs.parseFn) {
        const h = makeMarshalHandle()
        refs.parseFn = h
        return h
      }
      // Dispose the callRes passed in (simulates real ctx.unwrapResult
      // consuming result types).
      if (typeof (r as { dispose?: () => void }).dispose === "function") {
        ;(r as { dispose: () => void }).dispose()
      }
      return makeMarshalHandle()
    }
    ;(ctx as unknown as { callFunction: (...args: unknown[]) => EvalResultFake }).callFunction = (
      ..._args: unknown[]
    ) => {
      refs.callRes = makeMarshalHandle() as { alive: boolean; dispose(): void }
      return refs.callRes as unknown as EvalResultFake
    }

    let threw: unknown = null
    try {
      marshalIn(ctx, { a: 1 })
    } catch (e) {
      threw = e
    }

    expect(threw).toBeNull()
    expect(refs.json).toBeDefined()
    expect(refs.json!.alive).toBe(false)
    expect(refs.parseFn).toBeDefined()
    expect(refs.parseFn!.alive).toBe(false)
    // callRes is consumed by the final ctx.unwrapResult(callRes) — its
    // dispose() runs inside unwrapResult, so it must also be dead.
    expect(refs.callRes).toBeDefined()
    expect(refs.callRes!.alive).toBe(false)
  })

  // REGRESSION: when ctx.callFunction throws, BOTH json AND parseFn must be
  // disposed. Previously only the happy path disposed them — both leaked.
  test("REGRESSION: disposes json + parseFn when ctx.callFunction throws", () => {
    const refs: { json?: MarshalHandleFake; parseFn?: MarshalHandleFake } = {}
    const ctx = makeMarshalCtx({ callFunctionThrows: true }) as unknown as Parameters<typeof marshalIn>[0]
    ;(ctx as unknown as { newString: (s: string) => MarshalHandleFake }).newString = (
      _s: string,
    ) => {
      refs.json = makeMarshalHandle()
      return refs.json
    }
    let observedParseFn: MarshalHandleFake | null = null
    ;(ctx as unknown as {
      unwrapResult: (r: EvalResultFake) => MarshalHandleFake
    }).unwrapResult = (_r) => {
      const h = makeMarshalHandle()
      refs.parseFn = h
      observedParseFn = h
      return h
    }

    let caught: unknown = null
    try {
      marshalIn(ctx, { a: 1 })
    } catch (e) {
      caught = e
    }

    // The throw must propagate so the caller can observe it.
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("callFunction boom")

    // BOTH handles must be disposed despite the callFunction throw.
    expect(refs.json).toBeDefined()
    expect(refs.parseFn).toBeDefined()
    expect(refs.json!.alive).toBe(false)
    expect(refs.parseFn!.alive).toBe(false)
  })

  // REGRESSION: when ctx.unwrapResult throws on the parse-evaluation result,
  // the previously-allocated `json` handle must still be disposed. Previously
  // parseFn was never assigned; json leaked.
  test("REGRESSION: disposes json when ctx.unwrapResult throws on parse", () => {
    const refs: { json?: MarshalHandleFake } = {}
    const ctx = makeMarshalCtx({
      unwrapEvalThrows: true,
    }) as unknown as Parameters<typeof marshalIn>[0]
    ;(ctx as unknown as { newString: (s: string) => MarshalHandleFake }).newString = (
      _s: string,
    ) => {
      refs.json = makeMarshalHandle()
      return refs.json
    }

    let caught: unknown = null
    try {
      marshalIn(ctx, { a: 1 })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("unwrapResult(eval) boom")
    expect(refs.json).toBeDefined()
    expect(refs.json!.alive).toBe(false)
  })

  // Edge case: when ctx.evalCode itself throws (no result produced), the json
  // handle must still be disposed.
  test("REGRESSION: disposes json when ctx.evalCode throws", () => {
    const refs: { json?: MarshalHandleFake } = {}
    const ctx = makeMarshalCtx({ evalCodeThrows: true }) as unknown as Parameters<
      typeof marshalIn
    >[0]
    ;(ctx as unknown as { newString: (s: string) => MarshalHandleFake }).newString = (
      _s: string,
    ) => {
      refs.json = makeMarshalHandle()
      return refs.json
    }

    let caught: unknown = null
    try {
      marshalIn(ctx, { a: 1 })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("evalCode boom")
    expect(refs.json).toBeDefined()
    expect(refs.json!.alive).toBe(false)
  })
})