// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// Event bus public surface (back-compat shim).
//
// The implementation moved to `event-emitter.ts` (WorkflowEventEmitter
// class, Task 1.3, M-1 god-object extract). This file re-exports both
// the class and the payload type definitions from there so existing
// consumers (`packages/workflow/src/index.ts`,
// `packages/workflow/tests/foundation.test.ts`) keep working without
// changes, and provides the `createEventBus` factory as a thin wrapper
// over `new WorkflowEventEmitter()` for back-compat.
//
// New code should prefer importing `WorkflowEventEmitter` directly from
// `./event-emitter.ts`; `createEventBus` is preserved for the
// foundation.test.ts smoke tests and any downstream consumers that
// imported it as a factory function.

import { WorkflowEventEmitter } from "./event-emitter.ts"

export { WorkflowEventEmitter }
export type {
  EventName,
  WorkflowEventPayload,
  WorkflowStartedEvent,
  WorkflowResumedEvent,
  WorkflowAgentFailedEvent,
  WorkflowPhaseEvent,
  WorkflowLogEvent,
  WorkflowFinishedEvent,
  WorkflowStepCheckpointEvent,
} from "./event-emitter.ts"

/** Back-compat factory — returns a fresh `WorkflowEventEmitter` instance.
 *  Use `new WorkflowEventEmitter()` in new code; this function exists to
 *  preserve the pre-Task-1.3 `createEventBus()` API for
 *  `foundation.test.ts` smoke tests and any downstream consumers. */
export function createEventBus(): WorkflowEventEmitter {
  return new WorkflowEventEmitter()
}
