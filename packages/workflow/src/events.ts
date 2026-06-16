// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import type { AgentFailureReason, WorkflowStatus } from "./types.ts"

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface WorkflowStartedEvent {
  runID: string
  name: string
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
  | WorkflowAgentFailedEvent
  | WorkflowPhaseEvent
  | WorkflowLogEvent
  | WorkflowFinishedEvent
  | WorkflowStepCheckpointEvent

export type EventName =
  | "workflow:started"
  | "workflow:agent_failed"
  | "workflow:phase"
  | "workflow:log"
  | "workflow:finished"
  | "workflow:step_checkpoint"

// ---------------------------------------------------------------------------
// Event bus factory
// ---------------------------------------------------------------------------

type Listener<T = WorkflowEventPayload> = (event: T) => void

export function createEventBus() {
  const listeners = new Map<string, Array<{ fn: Listener; key: string }>>()
  let listenerIdCounter = 0

  /**
   * Register a listener for a workflow event.
   * Returns a key that can be passed to `off()` to unsubscribe.
   */
  function on(name: EventName, fn: Listener): string {
    const key = `${name}_${++listenerIdCounter}`
    const list = listeners.get(name) ?? []
    list.push({ fn, key })
    listeners.set(name, list)
    return key
  }

  /** Unsubscribe a listener by key. */
  function off(key: string): void {
    for (const [name, list] of listeners) {
      const idx = list.findIndex((l) => l.key === key)
      if (idx >= 0) {
        list.splice(idx, 1)
        if (list.length === 0) listeners.delete(name)
        return
      }
    }
  }

  /** Emit an event to all registered listeners for that event name. */
  function emit(name: EventName, payload: WorkflowEventPayload): void {
    const list = listeners.get(name)
    if (!list) return
    // Copy list — listeners may call off() during iteration
    for (const { fn, key } of [...list]) {
      try {
        fn(payload)
      } catch (e) {
        console.error(`[workflow] error in listener ${key} for event ${name}:`, e)
      }
    }
  }

  /** Remove all listeners. */
  function clearAll(): void {
    listeners.clear()
  }

  return { on, off, emit, clearAll }
}
