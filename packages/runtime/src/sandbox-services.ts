// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE
//
// Sandbox service interfaces (SOLID, Dependency Inversion Principle).
//
// Per the v0.16.0-SOLID extension, the `runSandboxed` orchestrator no
// longer imports concrete helper modules directly. Instead it accepts
// a `SandboxServices` container whose members implement these
// interfaces. The default container (`defaultServices` in
// `./sandbox.ts`) wires the real QuickJS-backed implementations.
// Tests can pass mock implementations to verify orchestration logic
// in isolation.
//
// What each service is responsible for:
//
//   SandboxRuntimeFactory  — allocate a QuickJS runtime sized by YAML
//                            config (memory, stack, deadline interrupt)
//   EvalExecutor            — eval guest code with labeled error
//                            disposal, return-or-discard result handles
//   MicrotaskPumpFactory    — start a cadence-based pump that drains
//                            pending guest jobs while we await a
//                            promise; returns a `stop()` handle
//   DeadlineFactory         — wall-clock race; rejects after `ms`
//                            so a parked guest can be hard-killed
//   HostBridge              — inject host functions as guest globals;
//                            marshal host values into the guest;
//                            bridge async host results to guest
//                            deferreds
//
// The interfaces are intentionally narrow. The orchestrator only
// depends on the methods it actually calls. Adding a new helper
// means adding a new interface — not expanding an existing one.

import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from "quickjs-emscripten"

/** Allocate a QuickJS runtime sized by config and wire a wall-clock
 *  interrupt handler. The deadline is captured in the interrupt
 *  closure, so it must be computed BEFORE `newRuntime()` is called. */
export interface SandboxRuntimeFactory {
  create(opts: {
    QJS: QuickJSWASMModule
    seed?: number
    memoryMB?: number
    stackSize?: number
    /** Wall-clock deadline for the script in milliseconds. */
    deadlineMs: number
  }): QuickJSRuntime
}

/** Eval a guest expression. `discard` throws away the result; `return`
 *  yields the live handle to the caller (which is responsible for
 *  disposal). Both throw a labeled error on eval failure. */
export interface EvalExecutor {
  discard(ctx: QuickJSContext, code: string, label: string): void
  return(ctx: QuickJSContext, code: string, label: string): QuickJSHandle
}

/** Start a microtask pump that drains pending guest jobs while the
 *  host awaits a guest promise. Adaptive cadence: fast right after
 *  finding work, slow when idle. Returns `{ stop }`. */
export interface MicrotaskPumpFactory {
  start(rt: QuickJSRuntime): { stop: () => void }
}

/** Wall-clock deadline race. Returns a rejecting promise and the
 *  underlying timer so the caller can cancel once the guest
 *  resolves. The pump-only interrupt handler can't kill a guest
 *  parked on a pending host promise — this timer covers that
 *  case. */
export interface DeadlineFactory {
  create(ms: number): { promise: Promise<never>; timer: NodeJS.Timeout }
}

/** Inject host functions as guest globals and marshal host values
 *  into the guest. `inject` and `marshalIn` are the only methods the
 *  orchestrator calls. Async host results are bridged via the
 *  `deferreds` array — disposed in the orchestrator's `finally`. */
export interface HostBridge {
  inject(
    ctx: QuickJSContext,
    hooks: Record<string, (...args: unknown[]) => unknown | Promise<unknown>>,
    track: <H extends QuickJSHandle>(h: H) => H,
    deferreds: QuickJSDeferredPromise[],
  ): void
}

/** Marshal a host JS value INTO the guest. Separated from
 *  `HostBridge` (Interface Segregation) — the two are independent
 *  responsibilities and tests may want to mock one without the other. */
export interface MarshalingService {
  marshalIn(ctx: QuickJSContext, value: unknown): QuickJSHandle
}

/** Default identifiers for the services. Used by
 *  `defaultServices` in `./sandbox.ts` and by tests that need to
 *  mock a single service. */
export type SandboxServiceName =
  | "runtime"
  | "eval"
  | "pump"
  | "deadline"
  | "bridge"
  | "marshaller"

/** Container passed to `runSandboxed`. All members are required. */
export interface SandboxServices {
  runtime: SandboxRuntimeFactory
  eval: EvalExecutor
  pump: MicrotaskPumpFactory
  deadline: DeadlineFactory
  bridge: HostBridge
  marshaller: MarshalingService
}
