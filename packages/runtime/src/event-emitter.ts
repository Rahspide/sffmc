// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Event payload types for the WorkflowEventEmitter observability bus.
// Kept at the top of this file (re-exported by `events.ts` for back-
// compat) so callers that need the payload shapes can import them from
// a single module alongside the class.

import type { AgentFailureReason, WorkflowStatus } from "./types.ts"

export interface WorkflowStartedEvent {
  runID: string
  name: string
}

export interface WorkflowResumedEvent {
  runID: string
  name: string
  /** Status of the run immediately before resume() transitioned it to 'running'.
   *  Typically 'paused' (new) or 'crashed' (legacy backward-compat). */
  wasStatus: WorkflowStatus
}

export interface WorkflowAgentFailedEvent {
  runID: string
  agentKey: string
  reason: AgentFailureReason
}

export interface WorkflowPhaseEvent {
  runID: string
  title: string
}

export interface WorkflowLogEvent {
  runID: string
  message: string
}

export interface WorkflowFinishedEvent {
  runID: string
  status: WorkflowStatus
  error?: string
}

export interface WorkflowStepCheckpointEvent {
  runID: string
  stepIndex: number
  costTokens: number
}

export type WorkflowEventPayload =
  | WorkflowStartedEvent
  | WorkflowResumedEvent
  | WorkflowAgentFailedEvent
  | WorkflowPhaseEvent
  | WorkflowLogEvent
  | WorkflowFinishedEvent
  | WorkflowStepCheckpointEvent

export type EventName =
  | "workflow:started"
  | "workflow:resumed"
  | "workflow:agent_failed"
  | "workflow:phase"
  | "workflow:log"
  | "workflow:finished"
  | "workflow:step_checkpoint"

// ---------------------------------------------------------------------------
// Event bus implementation
// ---------------------------------------------------------------------------

import { createLogger } from "@sffmc/shared"

const log = createLogger("workflow")

type Listener = (event: WorkflowEventPayload) => void

// WorkflowEventEmitter — extracted from WorkflowRuntime (M-1 god-object
// refactor, Task 1.3). Owns the observability event bus previously held
// inline in `events.ts` (`createEventBus()`). The runtime holds one
// `WorkflowEventEmitter` per instance, shared across all runs — events are
// global to the runtime, not per-run, so the per-run/per-runtime split
// that applied to `CounterManager` (Task 1.2) does NOT apply here.
//
// Why a class: the brief sketched a factory function with an `on()` that
// returns an unsubscribe function, but the real `WorkflowRuntime` events
// bus (and the 33 characterization tests in `runtime-external-api.test.ts`)
// uses a key-based `on()` / `off(key)` / `emit()` / `clearAll()` contract.
// The class mirrors that contract exactly so the refactor doesn't drift
// the public API. The internal `events.ts` file still exports
// `createEventBus` as a thin factory wrapper for back-compat with the
// `foundation.test.ts` smoke tests and downstream consumers.

/** Per-runtime observability event bus. Constructed by `WorkflowRuntime`
 *  in its field initializer; consumed by `runtime.events.on/off/emit/clearAll`
 *  from inside the runtime and by external listeners (e.g. `index.ts`
 *  `server()`) for log forwarding. */
export class WorkflowEventEmitter {
  private listeners = new Map<string, Array<{ fn: Listener; key: string }>>()
  private listenerIdCounter = 0

  /** Register a listener for a workflow event. Returns a string key that
   *  can be passed to `off()` to unsubscribe. The key is monotonic per
   *  emitter instance, which is sufficient for in-process use (events
   *  don't cross runtime boundaries). */
  on(name: EventName, fn: Listener): string {
    const key = `${name}_${++this.listenerIdCounter}`
    const list = this.listeners.get(name) ?? []
    list.push({ fn, key })
    this.listeners.set(name, list)
    return key
  }

  /** Unsubscribe a listener by the key returned from `on()`. A no-op for
   *  unknown or already-removed keys — listeners may be removed multiple
   *  times (e.g. from inside a listener that was already cleared by
   *  `clearAll()`) without throwing. */
  off(key: string): void {
    for (const [name, list] of this.listeners) {
      const idx = list.findIndex((l) => l.key === key)
      if (idx >= 0) {
        list.splice(idx, 1)
        if (list.length === 0) this.listeners.delete(name)
        return
      }
    }
  }

  /** Emit a workflow event to all registered listeners for that event name.
   *  Iterates over a snapshot of the listener list so that listeners which
   *  call `on()` / `off()` / `clearAll()` during iteration do not affect
   *  the current emit. A listener that throws is caught and logged so one
   *  bad subscriber cannot block the others. */
  emit(name: EventName, payload: WorkflowEventPayload): void {
    const list = this.listeners.get(name)
    if (!list) return
    for (const { fn, key } of [...list]) {
      try {
        fn(payload)
      } catch (e) {
        log.error(`error in listener ${key} for event ${name}:`, e)
      }
    }
  }

  /** Remove all listeners across all event names. Called from
   *  `WorkflowRuntime.close()` so a teardown doesn't leak closures that
   *  pin the runtime instance. */
  clearAll(): void {
    this.listeners.clear()
  }
}
