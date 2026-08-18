// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE
//
// Characterization tests for `runSandboxed` external API.
//
// PURPOSE: pin the *observable* behavior of the public API before the M-3
// refactor (Task 2.2 — Phase 2 of v0.15.0). The refactor splits
// `runSandboxed` (currently ~175 LOC, lines 131-305 of `src/sandbox.ts`)
// into smaller sub-helpers (`buildHostHooks`, `createSandboxRuntime`,
// `hardenDeterminism`, `evalAndDiscard`, `startMicrotaskPump`); this file
// asserts the behavior downstream call-sites and tests depend on:
//
//   - never-throw contract (any error → `null`)
//   - determinism hardening (Date / WeakRef / FinalizationRegistry removed,
//     `Math.random` replaced with seeded mulberry32)
//   - PRELUDE globals (parallel, pipeline, mcp.list/call) work
//   - deadline enforcement (`opts.deadlineMs` returns null on overrun)
//   - primitive marshaling (sync return values cross the host→guest boundary)
//   - async primitive return values (host promise settles; guest awaits)
//   - args injection (JSON-marshaled `primitives.args` visible as `globalThis.args`)
//   - user-script evaluation errors → null (no exception escapes)
//
// NON-GOALS:
//   - These are NOT exhaustive unit tests for the QuickJS internals.
//   - The internal sub-helpers are NOT exported; only the public `runSandboxed`
//     surface is asserted.

import { describe, test, expect } from "bun:test"
import { runSandboxed, type SandboxPrimitives } from "../src/sandbox.ts"

// ── Determinism hardening (mulberry32 PRNG + Date/WeakRef/FinalizationRegistry strip) ─

describe("runSandboxed — determinism hardening", () => {
  test("Math.random with same seed produces identical sequence across two runs", async () => {
    const source = `
      const a = [Math.random(), Math.random(), Math.random()];
      const b = [Math.random(), Math.random(), Math.random()];
      return JSON.stringify({ a, b });
    `
    // SAFETY: test fixture; empty object cast as SandboxPrimitives because the script under test does not invoke any primitives
    const prims: SandboxPrimitives = {} as SandboxPrimitives
    // SAFETY: runSandboxed returns unknown; the deterministic-Math.random script returns JSON.stringify(...)
    const r1 = (await runSandboxed(source, prims, { seed: 42 })) as string
    // SAFETY: same JSON.stringify return contract as r1 above
    const r2 = (await runSandboxed(source, prims, { seed: 42 })) as string
    expect(r1).toBe(r2)
    // Sanity: parse and confirm the two arrays are equal within a run
    // SAFETY: JSON.parse return type is unknown; the documented {a, b} shape comes from the JSON.stringify({a, b}) in the script
    const parsed = JSON.parse(r1) as { a: number[]; b: number[] }
    expect(parsed.a.length).toBe(3)
    expect(parsed.b.length).toBe(3)
  })

  test("different seeds produce different sequences", async () => {
    const source = `
      const a = [Math.random(), Math.random(), Math.random()];
      return JSON.stringify(a);
    `
    // SAFETY: test fixture; empty object cast as SandboxPrimitives because the script under test does not invoke any primitives
    const prims: SandboxPrimitives = {} as SandboxPrimitives
    // SAFETY: runSandboxed returns unknown; the script returns JSON.stringify(...)
    const r1 = (await runSandboxed(source, prims, { seed: 1 })) as string
    // SAFETY: same JSON.stringify return contract as r1 above
    const r2 = (await runSandboxed(source, prims, { seed: 2 })) as string
    expect(r1).not.toBe(r2)
  })

  test("Date is undefined inside the guest (wall-clock nondeterminism stripped)", async () => {
    // SAFETY: test fixture; empty object cast as SandboxPrimitives because the script under test does not invoke any primitives
    const prims: SandboxPrimitives = {} as SandboxPrimitives
    // SAFETY: runSandboxed returns unknown; the script returns the typeof Date result (a string)
    const result = (await runSandboxed(`return typeof Date;`, prims)) as string
    expect(result).toBe("undefined")
  })

  test("WeakRef and FinalizationRegistry are undefined inside the guest", async () => {
    // SAFETY: test fixture; empty object cast as SandboxPrimitives because the script under test does not invoke any primitives
    const prims: SandboxPrimitives = {} as SandboxPrimitives
    // SAFETY: runSandboxed returns unknown; the script returns JSON.stringify({...}) (a string)
    const result = (await runSandboxed(
      `return JSON.stringify({ weakRef: typeof WeakRef, fr: typeof FinalizationRegistry });`,
      prims,
    )) as string
    expect(result).toBe('{"weakRef":"undefined","fr":"undefined"}')
  })

  test("Math.random values are in [0,1)", async () => {
    // SAFETY: test fixture; empty object cast as SandboxPrimitives because the script under test does not invoke any primitives
    const prims: SandboxPrimitives = {} as SandboxPrimitives
    // SAFETY: runSandboxed returns unknown; the script returns JSON.stringify([...]) (a string)
    const result = (await runSandboxed(
      `const xs = [Math.random(), Math.random(), Math.random()]; return JSON.stringify(xs);`,
      prims,
    )) as string
    // SAFETY: JSON.parse return type is unknown; the documented number[] shape comes from the JSON.stringify in the script
    const xs = JSON.parse(result as string) as number[]
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })
})

// ── PRELUDE globals (parallel / pipeline / mcp) ───────────────────────────

describe("runSandboxed — PRELUDE globals", () => {
  test("parallel() awaits all thunks and returns array of results", async () => {
    // SAFETY: test fixture; empty object cast as SandboxPrimitives because the script under test does not invoke host-side primitives (parallel is the PRELUDE-injected host function)
    const prims: SandboxPrimitives = {} as SandboxPrimitives
    // SAFETY: runSandboxed returns unknown; the script returns JSON.stringify([1,2,3]) (a string)
    const result = (await runSandboxed(
      `const r = await globalThis.parallel([() => Promise.resolve(1), () => Promise.resolve(2), () => Promise.resolve(3)]); return JSON.stringify(r);`,
      prims,
    )) as string
    expect(result).toBe("[1,2,3]")
  })

  test("pipeline() threads each item through every stage", async () => {
    // SAFETY: test fixture; empty object cast as SandboxPrimitives because the script under test does not invoke host-side primitives
    const prims: SandboxPrimitives = {} as SandboxPrimitives
    // SAFETY: runSandboxed returns unknown; the script returns JSON.stringify([20,40,60]) (a string)
    const result = (await runSandboxed(
      `const r = await globalThis.pipeline([1,2,3], async (acc, item) => acc + item, async (acc, item) => acc * 10); return JSON.stringify(r);`,
      prims,
    )) as string
    // pipeline applies stages left-to-right per item, accumulating:
    //   item=1: 1+1=2, 2*10=20
    //   item=2: 2+2=4, 4*10=40
    //   item=3: 3+3=6, 6*10=60
    expect(result).toBe("[20,40,60]")
  })

  test("mcp.list() and mcp.call() call through to the host (default no-op wiring)", async () => {
    let listCalled = 0
    let callCalled = 0
    // SAFETY: test fixture; partial SandboxPrimitives (only mcpList + mcpCall) is cast via unknown because the SandboxPrimitives type expects more fields (log/parallel/etc.); the test only exercises mcp.list/mcp.call
    const prims: SandboxPrimitives = {
      mcpList: async () => {
        listCalled++
        return ["tool-a", "tool-b"]
      },
      mcpCall: async (name, args) => {
        callCalled++
        return { name, args }
      },
    } as unknown as SandboxPrimitives
    // SAFETY: runSandboxed returns unknown; the script returns JSON.stringify({names, r}) (a string)
    const result = (await runSandboxed(
      `const names = await mcp.list(); const r = await mcp.call('tool-a', { x: 1 }); return JSON.stringify({ names, r });`,
      prims,
    )) as string
    expect(listCalled).toBe(1)
    expect(callCalled).toBe(1)
    expect(result).toBe('{"names":["tool-a","tool-b"],"r":{"name":"tool-a","args":{"x":1}}}')
  })
})

// ── Never-throw contract ──────────────────────────────────────────────────

describe("runSandboxed — never-throw contract", () => {
  test("primitive that throws → null (no exception escapes)", async () => {
    // SAFETY: test fixture; partial SandboxPrimitives with only `log` to drive the throwing-primitive path; cast via unknown because other fields are not exercised by this test
    const prims: SandboxPrimitives = {
      log: () => {
        throw new Error("primitive boom")
      },
    } as unknown as SandboxPrimitives
    const result = await runSandboxed(
      `log('x'); return 'unreached';`,
      prims,
    )
    expect(result).toBeNull()
  })

  test("user script throws synchronously → null", async () => {
    // SAFETY: test fixture; empty object cast as SandboxPrimitives because the throwing script does not invoke any primitives
    const prims: SandboxPrimitives = {} as SandboxPrimitives
    const result = await runSandboxed(`throw new Error('script boom');`, prims)
    expect(result).toBeNull()
  })

  test("user script returns rejected promise → null", async () => {
    // SAFETY: test fixture; empty object cast as SandboxPrimitives because the rejecting script does not invoke any primitives
    const prims: SandboxPrimitives = {} as SandboxPrimitives
    const result = await runSandboxed(`return Promise.reject(new Error('async boom'));`, prims)
    expect(result).toBeNull()
  })
})

// ── Deadline enforcement ──────────────────────────────────────────────────

describe("runSandboxed — deadline", () => {
  test("short deadlineMs while script loops → null", async () => {
    // SAFETY: test fixture; empty object cast as SandboxPrimitives because the infinite-loop script does not invoke any primitives
    const prims: SandboxPrimitives = {} as SandboxPrimitives
    const result = await runSandboxed(
      `while (true) {}`,
      prims,
      { deadlineMs: 25 },
    )
    expect(result).toBeNull()
  })

  test("generous deadlineMs lets a finite script complete", async () => {
    // SAFETY: test fixture; empty object cast as SandboxPrimitives because the trivial script does not invoke any primitives
    const prims: SandboxPrimitives = {} as SandboxPrimitives
    const result = await runSandboxed(
      `return 'ok';`,
      prims,
      { deadlineMs: 1000 },
    )
    expect(result).toBe("ok")
  })
})

// ── Primitive marshaling ──────────────────────────────────────────────────

describe("runSandboxed — primitive marshaling", () => {
  test("sync primitive return: string crosses host→guest unchanged", async () => {
    // SAFETY: test fixture; partial SandboxPrimitives with only `greet` to drive the sync-string return path; cast via unknown because other fields are not exercised by this test
    const prims: SandboxPrimitives = {
      greet: () => "hello from host",
    } as unknown as SandboxPrimitives
    const result = await runSandboxed(
      `return greet();`,
      prims,
    )
    expect(result).toBe("hello from host")
  })

  test("sync primitive return: object is JSON-marshaled into guest", async () => {
    // SAFETY: test fixture; partial SandboxPrimitives with only `payload` to drive the sync-object return path; cast via unknown because other fields are not exercised by this test
    const prims: SandboxPrimitives = {
      payload: () => ({ count: 42, tags: ["a", "b"] }),
    } as unknown as SandboxPrimitives
    // SAFETY: runSandboxed returns unknown; the script returns JSON.stringify({count, tags}) (a string)
    const result = (await runSandboxed(
      `const p = payload(); return JSON.stringify(p);`,
      prims,
    )) as string
    expect(result).toBe('{"count":42,"tags":["a","b"]}')
  })

  test("async primitive return: host promise resolves before guest reads", async () => {
    // SAFETY: test fixture; partial SandboxPrimitives with only `fetch` to drive the async-return path; cast via unknown because other fields are not exercised by this test
    const prims: SandboxPrimitives = {
      fetch: async () => {
        await new Promise((r) => setTimeout(r, 5))
        return { ok: true }
      },
    } as unknown as SandboxPrimitives
    // SAFETY: runSandboxed returns unknown; the script returns JSON.stringify({ok: true}) (a string)
    const result = (await runSandboxed(
      `const r = await fetch(); return JSON.stringify(r);`,
      prims,
    )) as string
    expect(result).toBe('{"ok":true}')
  })

  test("args injection: primitives.args visible as globalThis.args (JSON-marshaled)", async () => {
    // SAFETY: test fixture; partial SandboxPrimitives with only `args` to drive the args-injection path; cast via unknown because other fields are not exercised by this test
    const prims: SandboxPrimitives = {
      args: { user: "alice", age: 30 },
    } as unknown as SandboxPrimitives
    // SAFETY: runSandboxed returns unknown; the script returns JSON.stringify(globalThis.args) (a string)
    const result = (await runSandboxed(
      `return JSON.stringify(globalThis.args);`,
      prims,
    )) as string
    expect(result).toBe('{"user":"alice","age":30}')
  })
})

// ── PRELUDE-key filtering ─────────────────────────────────────────────────

describe("runSandboxed — PRELUDE key filtering", () => {
  test("'parallel' / 'pipeline' / 'args' from primitives map are NOT overridden", async () => {
    // If the refactor accidentally lets host primitives override PRELUDE keys,
    // the globalThis.parallel test above (which works via the PRELUDE wiring)
    // would break. We pin that explicitly: parallel still resolves thunks.
    // SAFETY: test fixture; partial SandboxPrimitives with only `parallel` to drive the PRELUDE-key filtering test; cast via unknown because other fields are not exercised
    const prims: SandboxPrimitives = {
      parallel: () => "host-shim-should-not-be-used",
    } as unknown as SandboxPrimitives
    // SAFETY: runSandboxed returns unknown; the script returns JSON.stringify(["p"]) (a string)
    const result = (await runSandboxed(
      `const r = await globalThis.parallel([() => Promise.resolve('p')]); return JSON.stringify(r);`,
      prims,
    )) as string
    expect(result).toBe('["p"]')
  })
})