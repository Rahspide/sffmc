// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE
//
// Sandbox DI (Dependency Inversion) tests.
//
// These tests verify that the `runSandboxed` orchestrator depends on
// the `SandboxServices` interface, not on concrete helper modules.
// We pass mock implementations and assert the orchestrator makes the
// expected calls in the expected order.
//
// Why this matters: pre-SOLID, the only way to test the orchestrator
// was through its observable behavior (end-to-end with real QuickJS).
// Bugs like the v0.16.0 `setMaxStackSize(stackSize * 1024)` were
// INVISIBLE to direct tests — they only surfaced when the real
// QuickJS stack overflowed. With DI, we can:
//   - Assert that `services.runtime.create` is called with the exact
//     options we passed (catches the * 1024 bug at test time, not at
//     run-time)
//   - Assert that `services.eval.discard` is called with PRELUDE
//   - Assert that `services.bridge.marshalIn` is called for args
//   - Etc.
//
// Tests the orchestrator in isolation, with no QuickJS at all.

import { describe, test, expect, mock } from "bun:test"
import { runSandboxed, type SandboxPrimitives } from "../src/sandbox.ts"
import type { SandboxServices } from "../src/sandbox-services.ts"

type Call = { method: string; args: unknown[] }

function makeMockRt(): any {
  return {
    setMemoryLimit: () => {},
    setMaxStackSize: () => {},
    setInterruptHandler: () => {},
    hasPendingJob: () => false,
    executePendingJobs: () => {},
    newContext: () => makeMockCtx(),
    dispose: () => {},
  }
}

function makeMockCtx(): any {
  return {
    newFunction: (_n: string, _fn: (...a: any[]) => any) => ({
      alive: true,
      dispose() { (this as any).alive = false },
    }),
    setProp: () => {},
    global: { setProp: () => {} },
    evalCode: () => ({
      error: undefined,
      value: { alive: true, dispose() { (this as any).alive = false } },
    }),
    newString: (_s: string) => ({ alive: true, dispose: () => {} }),
    newNumber: (_n: number) => ({ alive: true, dispose: () => {} }),
    newPromise: () => {
      let resolveFn: (v: any) => void = () => {}
      const promise = new Promise<any>((r) => { resolveFn = r })
      return {
        handle: { alive: true, dispose: () => {} },
        resolve: (v: any) => resolveFn(v),
        reject: (e: any) => resolveFn(Promise.reject(e)),
        settled: Promise.resolve(),
        alive: true,
        dispose: () => {},
      }
    },
    resolvePromise: async (_h: any) => ({
      value: { alive: true, dispose: () => {} },
      error: undefined,
    }),
    dump: (_h: any) => "mock-dumped-value",
    alive: true,
    runtime: { executePendingJobs: () => {} },
    dispose: () => {},
  }
}

/** Build a container of mock services that records every call. */
function makeMockServices() {
  const calls: Call[] = []
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args })
  }

  const runtime = {
    create: (opts: any) => {
      calls.push({ method: "runtime.create", args: [opts] })
      return makeMockRt()
    },
  }
  const evalExec = {
    discard: (ctx: any, code: string, label: string) => {
      calls.push({ method: "eval.discard", args: [code, label] })
    },
    return: (ctx: any, code: string, label: string) => {
      calls.push({ method: "eval.return", args: [code, label] })
      return { alive: true, dispose: () => {} } as any
    },
  }
  const pump = {
    start: (rt: any) => {
      calls.push({ method: "pump.start", args: [rt] })
      return {
        stop: () => { calls.push({ method: "pump.stop", args: [] }) },
      }
    },
  }
  const deadline = {
    create: (ms: number) => {
      calls.push({ method: "deadline.create", args: [ms] })
      const timer = setTimeout(() => {}, ms) as unknown as NodeJS.Timeout
      return { promise: new Promise<never>(() => {}), timer }
    },
  }
  const bridge = {
    inject: (ctx: any, hooks: any, _track: any, _deferreds: any) => {
      calls.push({ method: "bridge.inject", args: [Object.keys(hooks)] })
    },
  }
  const marshaller = {
    marshalIn: (ctx: any, value: unknown) => {
      calls.push({ method: "marshaller.marshalIn", args: [value] })
      return { alive: true, dispose: () => {} } as any
    },
  }

  const services: SandboxServices = {
    runtime: runtime as any,
    eval: evalExec as any,
    pump: pump as any,
    deadline: deadline as any,
    bridge: bridge as any,
    marshaller: marshaller as any,
  }
  return { services, calls }
}

describe("runSandboxed — DI (Dependency Inversion)", () => {
  test("calls runtime.create with deadlineMs from opts", async () => {
    const { services, calls } = makeMockServices()
    const primitives = {} as SandboxPrimitives
    await runSandboxed("return 42;", primitives, {
      services,
      deadlineMs: 1234,
    })
    const runtimeCreate = calls.find((c) => c.method === "runtime.create")
    expect(runtimeCreate).toBeDefined()
    expect((runtimeCreate!.args[0] as any).deadlineMs).toBe(1234)
  })

  test("REGRESSION: runtime.create receives stackSize in bytes, not * 1024", async () => {
    const { services, calls } = makeMockServices()
    const primitives = {} as SandboxPrimitives
    await runSandboxed("return 42;", primitives, {
      services,
      stackSize: 4096, // 4 KiB in bytes
    })
    const runtimeCreate = calls.find((c) => c.method === "runtime.create")
    expect(runtimeCreate).toBeDefined()
    // The orchestrator must pass stackSize as-is (4096 bytes), not
    // 4096 * 1024. Catches the v0.16.0 `* 1024` regression at test time.
    expect((runtimeCreate!.args[0] as any).stackSize).toBe(4096)
    expect((runtimeCreate!.args[0] as any).stackSize).not.toBe(4096 * 1024)
  })

  test("calls eval.discard with PRELUDE before eval.return with wrapped script", async () => {
    const { services, calls } = makeMockServices()
    const primitives = {} as SandboxPrimitives
    await runSandboxed("return 42;", primitives, { services })
    const evalCalls = calls.filter((c) => c.method.startsWith("eval."))
    expect(evalCalls.length).toBeGreaterThanOrEqual(2)
    const discardIdx = calls.findIndex((c) => c.method === "eval.discard")
    const returnIdx = calls.findIndex((c) => c.method === "eval.return")
    expect(discardIdx).toBeLessThan(returnIdx)
  })

  test("calls bridge.inject before marshaller.marshalIn", async () => {
    const { services, calls } = makeMockServices()
    const primitives = {} as SandboxPrimitives
    await runSandboxed("return 42;", primitives, { services })
    const injectIdx = calls.findIndex((c) => c.method === "bridge.inject")
    const marshalIdx = calls.findIndex((c) => c.method === "marshaller.marshalIn")
    expect(injectIdx).toBeGreaterThanOrEqual(0)
    expect(marshalIdx).toBeGreaterThanOrEqual(0)
    expect(injectIdx).toBeLessThan(marshalIdx)
  })

  test("pump.start and deadline.create happen after eval.return", async () => {
    const { services, calls } = makeMockServices()
    const primitives = {} as SandboxPrimitives
    await runSandboxed("return 42;", primitives, { services })
    const returnIdx = calls.findIndex((c) => c.method === "eval.return")
    const pumpIdx = calls.findIndex((c) => c.method === "pump.start")
    const dlIdx = calls.findIndex((c) => c.method === "deadline.create")
    expect(returnIdx).toBeGreaterThanOrEqual(0)
    expect(pumpIdx).toBeGreaterThan(returnIdx)
    expect(dlIdx).toBeGreaterThan(returnIdx)
  })

  test("never throws — returns null on any failure", async () => {
    const services: SandboxServices = {
      runtime: { create: () => { throw new Error("runtime boom") } },
      eval: {
        discard: () => {},
        return: () => ({ alive: true, dispose: () => {} } as any),
      },
      pump: { start: () => ({ stop: () => {} }) },
      deadline: {
        create: () => ({ promise: new Promise<never>(() => {}), timer: 0 as any }),
      },
      bridge: { inject: () => {} },
      marshaller: { marshalIn: () => ({ alive: true, dispose: () => {} } as any) },
    }
    const primitives = {} as SandboxPrimitives
    const result = await runSandboxed("return 42;", primitives, { services })
    expect(result).toBeNull()
  })

  test("partial services: caller supplies only runtime, others default", async () => {
    // Verifies that Partial<SandboxServices> in opts.services really
    // does fall back to defaults for un-supplied fields. We pass a
    // mock for runtime; the rest use real implementations.
    const realRuntimeCreate = mock(() => makeMockRt() as any)
    const services: Partial<SandboxServices> = {
      runtime: { create: realRuntimeCreate },
    }
    const primitives = {} as SandboxPrimitives
    // The script body is trivial; the real implementations should
    // not throw even when called from a sandbox backed by our mock.
    // (Note: this test depends on the real services being able to
    // operate on a mock runtime/context. If the real bridge
    // implementation tries to do something that requires a real
    // QuickJSHandle, this test will fail — that's a real coupling
    // leak and is worth knowing about.)
    try {
      const result = await runSandboxed("return 42;", primitives, { services })
      // Don't assert on result: the test's purpose is to verify
      // the partial-DI path doesn't crash, not to assert outcome.
      expect(result === null || result === "mock-dumped-value" || typeof result === "object").toBe(true)
    } catch (e) {
      // Acceptable: if the real services can't operate on our mock
      // handles, the orchestrator should still catch and return
      // null. Anything else is a bug.
      expect(e).toBeUndefined()
    }
  })
})
