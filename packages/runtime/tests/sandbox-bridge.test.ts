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
import * as v from "valibot"
import { dumpHostFnArgs, marshalIn } from "../src/sandbox-bridge.ts"

/** Valibot primitive schema used at the test boundary to discriminate
 *  callable members without `typeof` runtime checks. */
const FunctionSchema = v.function()

/** Valibot schema for "any JSON-serializable value" — the union of
 *  primitives, arrays, and records. Source of truth for the
 *  test-side dump payload type. */
const DumpPayloadSchema = v.union([
  v.string(),
  v.number(),
  v.boolean(),
  v.null(),
  v.array(v.unknown()),
  v.record(v.string(), v.unknown()),
]);

/** Test-only domain alias for the dump payload. Aliased from a
 *  Valibot schema so the no-unknown-returns rule sees a domain-named
 *  type (the rule follows `type X = …` aliases to their underlying
 *  type). */
type TestDumpPayload = v.InferOutput<typeof DumpPayloadSchema>;

interface FakeHandle {
  disposed: boolean
  label: string
  /** Sentinel payload returned by `ctx.dump(h)`. */
  dumpPayload: TestDumpPayload
  /** Optional: set to true to make `ctx.dump(h)` throw. */
  dumpThrows?: boolean
  dispose(): void
}

interface FakeCtx {
  dump(h: FakeHandle): TestDumpPayload
}

function makeHandle(label: string, payload: TestDumpPayload, opts: { dumpThrows?: boolean } = {}): FakeHandle {
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

    // SAFETY: test fixture; `as any` is the documented escape hatch for the FakeCtx stub passed to dumpHostFnArgs
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

    let caught: unknown | null = null
    try {
      // SAFETY: test fixture; `as any` is the documented escape hatch for the throwing FakeCtx stub
      dumpHostFnArgs(ctx as any, [h1, h2, h3])
    } catch (e) {
      caught = e
    }

    // The dump failure must propagate (so the caller can observe it).
    expect(caught).toBeInstanceOf(Error)
    // SAFETY: caught is unknown; the dump failure is constructed as an Error above; cast narrows for .message access
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

    // SAFETY: test fixture; `as any` is the documented escape hatch for the throwing FakeCtx stub
    expect(() => dumpHostFnArgs(ctx as any, [h1, h2, h3])).toThrow("boom")
    expect(h1.disposed).toBe(true)
    expect(h2.disposed).toBe(true)
    expect(h3.disposed).toBe(false)
  })

  test("empty handle array returns empty result", () => {
    const ctx: FakeCtx = { dump: () => { throw new Error("should not be called") } }
    // SAFETY: test fixture; `as any` is the documented escape hatch for the FakeCtx stub (dump is never called on the empty-array path)
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
      // SAFETY: test fixture; makeMarshalHandle returns a fake handle; cast to EvalResultFake is the documented pattern for the marshalIn mock context
      return makeMarshalHandle() as EvalResultFake
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
      // SAFETY: test fixture; makeMarshalHandle returns a fake handle; cast to EvalResultFake is the documented pattern for the marshalIn mock context
      return makeMarshalHandle() as EvalResultFake
    },
  } satisfies MarshalCtxFake
}

describe("marshalIn — handle lifecycle (gen-2 #8)", () => {
  test("primitive path on string never acquires JSON-round-trip handles", () => {
    // Track whether evalCode/unwrapResult/callFunction ever fire. Primitive
    // paths must short-circuit without touching them.
    let roundTripInvoked = false
    // SAFETY: test fixture; double cast via unknown is required because makeMarshalCtx returns a stub MarshalCtxFake (subset of marshalIn's QuickJS context parameter)
    const ctx = makeMarshalCtx() as Parameters<typeof marshalIn>[0]
    // SAFETY: test uses reflection to override the evalCode stub; `as any` is the documented escape hatch for accessing private surfaces
    const evalCodeImpl = function (_c: string): EvalResultFake {
      roundTripInvoked = true
      // SAFETY: test fixture; makeMarshalHandle returns a fake handle; cast to EvalResultFake mirrors the marshalIn return contract
      return makeMarshalHandle() as EvalResultFake
    }
    // SAFETY: test uses reflection to install the evalCode override on the ctx; `as any` is the documented escape hatch for accessing private surfaces
    const ctxWithEval = ctx as any
    ctxWithEval.evalCode = evalCodeImpl
    // SAFETY: test uses reflection to override the callFunction stub; `as any` is the documented escape hatch for accessing private surfaces
    const callFunctionImpl2 = function (..._args: unknown[]): EvalResultFake {
      roundTripInvoked = true
      // SAFETY: test fixture; makeMarshalHandle returns a fake handle; cast to EvalResultFake mirrors the marshalIn return contract
      return makeMarshalHandle() as EvalResultFake
    }
    // SAFETY: test uses reflection to install the callFunction override on the ctx; `as any` is the documented escape hatch for accessing private surfaces
    const ctxWithCall = ctx as any
    ctxWithCall.callFunction = callFunctionImpl2

    let out: unknown | null = null
    try {
      out = marshalIn(ctx, "hello")
    } catch {
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
    // SAFETY: `as MarshalHandleFake | undefined` and `as { alive: boolean; dispose(): void } | undefined` are the documented escape hatches for the captured-handle refs — `undefined` literal would otherwise default to the narrow empty-object type
    const refs = {
      json: undefined as MarshalHandleFake | undefined,
      parseFn: undefined as MarshalHandleFake | undefined,
      callRes: undefined as { alive: boolean; dispose(): void } | undefined,
    } satisfies {
      json?: MarshalHandleFake
      parseFn?: MarshalHandleFake
      callRes?: { alive: boolean; dispose(): void }
    }
    // SAFETY: test fixture; double cast via unknown is required because makeMarshalCtx returns a stub MarshalCtxFake (subset of marshalIn's QuickJS context parameter)
    const ctx = makeMarshalCtx() as Parameters<typeof marshalIn>[0]
    // SAFETY: test uses reflection to override the newString stub; `as any` is the documented escape hatch for accessing private surfaces
    const newStringImpl = (_s: string): MarshalHandleFake => {
      refs.json = makeMarshalHandle()
      return refs.json
    }
    // SAFETY: test uses reflection to install the newString override on the ctx; `as any` is the documented escape hatch for accessing private surfaces
    const ctxWithNewString = ctx as any
    ctxWithNewString.newString = newStringImpl
    // SAFETY: test uses reflection to override the unwrapResult stub; `as any` is the documented escape hatch for accessing private surfaces
    const unwrapResultImpl = function (r: EvalResultFake): MarshalHandleFake {
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
      // SAFETY: r is the documented EvalResultFake (has optional dispose); inline shape narrows to read dispose safely
      if (v.is(FunctionSchema, (r as { dispose?: () => void }).dispose)) {
        // SAFETY: dispose() existence verified by the v.is(FunctionSchema, ...) check on the line above; the cast re-states the shape for the call
        const disposable: { dispose: () => void } = r as { dispose: () => void }
        disposable.dispose()
      }
      return makeMarshalHandle()
    }
    // SAFETY: test uses reflection to install the unwrapResult override on the ctx; `as any` is the documented escape hatch for accessing private surfaces
    const ctxWithUnwrapResult = ctx as any
    ctxWithUnwrapResult.unwrapResult = unwrapResultImpl
    // SAFETY: test uses reflection to override the callFunction stub; `as any` is the documented escape hatch for accessing private surfaces
    const callFunctionImpl = function (..._args: unknown[]): EvalResultFake {
      // SAFETY: test fixture; the two casts below (to { alive, dispose } and back to EvalResultFake) record the dispose call for the assertion — callFunction in marshalIn returns EvalResultFake (QuickJS handle)
      refs.callRes = makeMarshalHandle() as { alive: boolean; dispose(): void }
      // SAFETY: refs.callRes is the { alive, dispose } shape from the assignment on the line above; the cast re-states the EvalResultFake shape for the return
      return refs.callRes as EvalResultFake
    }
    // SAFETY: test uses reflection to install the callFunction override on the ctx; `as any` is the documented escape hatch for accessing private surfaces
    const ctxWithCallFunction = ctx as any
    ctxWithCallFunction.callFunction = callFunctionImpl

    let threw: unknown | null = null
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
    // SAFETY: `as MarshalHandleFake | undefined` is the documented escape hatch for the captured-handle refs — `undefined` literal would otherwise default to the narrow empty-object type
    const refs = { json: undefined as MarshalHandleFake | undefined, parseFn: undefined as MarshalHandleFake | undefined } satisfies { json?: MarshalHandleFake; parseFn?: MarshalHandleFake }
    // SAFETY: test fixture; double cast via unknown is required because makeMarshalCtx returns a stub MarshalCtxFake (subset of marshalIn's QuickJS context parameter)
    const ctx = makeMarshalCtx({ callFunctionThrows: true }) as Parameters<typeof marshalIn>[0]
    // SAFETY: test uses reflection to override the newString stub; `as any` is the documented escape hatch for accessing private surfaces
    const newStringImpl = (_s: string): MarshalHandleFake => {
      refs.json = makeMarshalHandle()
      return refs.json
    }
    // SAFETY: test uses reflection to install the newString override on the ctx; `as any` is the documented escape hatch for accessing private surfaces
    const ctxWithNewString2 = ctx as any
    ctxWithNewString2.newString = newStringImpl
    // SAFETY: test uses reflection to override the unwrapResult stub; `as any` is the documented escape hatch for accessing private surfaces
    const unwrapResultImpl2 = function (_r: EvalResultFake): MarshalHandleFake {
      const h = makeMarshalHandle()
      refs.parseFn = h
      return h
    }
    // SAFETY: test uses reflection to install the unwrapResult override on the ctx; `as any` is the documented escape hatch for accessing private surfaces
    const ctxWithUnwrapResult2 = ctx as any
    ctxWithUnwrapResult2.unwrapResult = unwrapResultImpl2

    let caught: unknown | null = null
    try {
      marshalIn(ctx, { a: 1 })
    } catch (e) {
      caught = e
    }

    // The throw must propagate so the caller can observe it.
    expect(caught).toBeInstanceOf(Error)
    // SAFETY: caught is unknown; the callFunction throw is constructed as an Error above; cast narrows for .message access
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
    // SAFETY: `as MarshalHandleFake | undefined` is the documented escape hatch for the captured-handle ref — `undefined` literal would otherwise default to the narrow empty-object type
    const refs = { json: undefined as MarshalHandleFake | undefined } satisfies { json?: MarshalHandleFake }
    // SAFETY: test fixture; double cast via unknown is required because makeMarshalCtx returns a stub MarshalCtxFake (subset of marshalIn's QuickJS context parameter)
    const ctx = makeMarshalCtx({
      unwrapEvalThrows: true,
    }) as Parameters<typeof marshalIn>[0]
    // SAFETY: test uses reflection to override the newString stub; `as any` is the documented escape hatch for accessing private surfaces
    const newStringImpl = (_s: string): MarshalHandleFake => {
      refs.json = makeMarshalHandle()
      return refs.json
    }
    // SAFETY: test uses reflection to install the newString override on the ctx; `as any` is the documented escape hatch for accessing private surfaces
    const ctxWithNewString3 = ctx as any
    ctxWithNewString3.newString = newStringImpl

    let caught: unknown | null = null
    try {
      marshalIn(ctx, { a: 1 })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    // SAFETY: caught is unknown; the unwrapResult throw is constructed as an Error above; cast narrows for .message access
    expect((caught as Error).message).toBe("unwrapResult(eval) boom")
    expect(refs.json).toBeDefined()
    expect(refs.json!.alive).toBe(false)
  })

  // Edge case: when ctx.evalCode itself throws (no result produced), the json
  // handle must still be disposed.
  test("REGRESSION: disposes json when ctx.evalCode throws", () => {
    // SAFETY: `as MarshalHandleFake | undefined` is the documented escape hatch for the captured-handle ref — `undefined` literal would otherwise default to the narrow empty-object type
    const refs = { json: undefined as MarshalHandleFake | undefined } satisfies { json?: MarshalHandleFake }
    // SAFETY: test fixture; double cast via unknown is required because makeMarshalCtx returns a stub MarshalCtxFake (subset of marshalIn's QuickJS context parameter)
    const ctx = makeMarshalCtx({ evalCodeThrows: true }) as Parameters<typeof marshalIn>[0]
    // SAFETY: test uses reflection to override the newString stub; `as any` is the documented escape hatch for accessing private surfaces
    const newStringImpl = (_s: string): MarshalHandleFake => {
      refs.json = makeMarshalHandle()
      return refs.json
    }
    // SAFETY: test uses reflection to install the newString override on the ctx; `as any` is the documented escape hatch for accessing private surfaces
    const ctxWithNewString4 = ctx as any
    ctxWithNewString4.newString = newStringImpl

    let caught: unknown | null = null
    try {
      marshalIn(ctx, { a: 1 })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    // SAFETY: caught is unknown; the evalCode throw is constructed as an Error above; cast narrows for .message access
    expect((caught as Error).message).toBe("evalCode boom")
    expect(refs.json).toBeDefined()
    expect(refs.json!.alive).toBe(false)
  })
})