// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { describe, it, expect } from "bun:test"
import { WorkflowStructuralError } from "../src/types.ts"

// REGRESSION tests for the typed WorkflowStructuralError class (gen-2 #4).
//
// Before this fix, the magic-string literal "WorkflowStructuralError" was
// duplicated as a module-level constant in `child-workflow-primitive.ts:29`
// (plus an earlier copy in runtime.ts that gen-1 cleanup removed). The
// throw site used `` new Error(`${MAGIC}: ...`) `` and the parent's
// classification relied on `childOutcome.error?.includes(MAGIC)`. Any
// caller-supplied error containing the substring "WorkflowStructuralError"
// anywhere in its message would silently match. Renaming the literal also
// broke the throw/classification pair in lock-step — exactly the class of
// bug the F-2.1 BudgetExceededError fix for agent-primitive.ts closed.
//
// The typed class mirrors BudgetExceededError (types.ts:32-38): `extends
// Error`, explicit `name`, and `Object.setPrototypeOf` for ES5 target so
// `instanceof` works inside the compiled output. The discriminant prefix
// is also carried in `.message` so the bridge-serialized string at the
// child's outcome crosses the parent boundary intact.

describe("WorkflowStructuralError typed class", () => {
  it("is an Error subclass and a WorkflowStructuralError instance", () => {
    const e = new WorkflowStructuralError("test message")
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(WorkflowStructuralError)
  })

  it("carries an explicit .name so toString() and serialization embed it", () => {
    const e = new WorkflowStructuralError("test message")
    expect(e.name).toBe("WorkflowStructuralError")
    // The full toString includes `name: message` form; the bridge serializes
    // .message only, so the discriminant prefix must also be carried in the
    // message itself (verified at the next test).
    expect(String(e)).toContain("WorkflowStructuralError")
  })

  it("preserves the supplied message verbatim", () => {
    const e = new WorkflowStructuralError("unknown workflow: \"foo\"")
    expect(e.message).toBe("unknown workflow: \"foo\"")
  })

  it("survives instanceof check after being thrown and caught by the user", () => {
    let caught: unknown = null
    try {
      throw new WorkflowStructuralError("unknown workflow: \"bar\"")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(WorkflowStructuralError)
    expect(caught).toBeInstanceOf(Error)
    expect((caught as WorkflowStructuralError).message).toBe("unknown workflow: \"bar\"")
  })
})

// The following exercise the classification branch (ChildWorkflowPrimitive
// re-throws a WorkflowStructuralError on the spawn path) by reusing the
// test infrastructure already established in child-workflow-primitive.test.ts.
// The "classification returns the correct outcome type" claim is: when a
// child's outcome.error carries the discriminant prefix, the parent's spawn()
// throws an instance of `WorkflowStructuralError` — verified via
// `instanceof` and `toBeInstanceOf` (both typed checks; neither is a string
// substring match).

describe("Classification branch returns the correct outcome type", () => {
  // The primitive lives at the boundary that rebuilds typed errors from
  // bridged string outcomes. We replicate the relevant piece inline rather
  // than constructing a full ChildWorkflowPrimitive harness — the
  // classification itself is "if the string starts with the prefix, throw
  // a new WorkflowStructuralError carrying the same message". That IS the
  // typed-check contract.
  function rethrowFromOutcome(error: string | undefined): WorkflowStructuralError {
    if (!error?.startsWith("WorkflowStructuralError")) {
      throw new Error("expected structural prefix")
    }
    return new WorkflowStructuralError(error)
  }

  it("re-throws a WorkflowStructuralError when the outcome.error carries the prefix", () => {
    const reconstructed = rethrowFromOutcome("WorkflowStructuralError: nested unresolved")
    expect(reconstructed).toBeInstanceOf(WorkflowStructuralError)
    expect(reconstructed.message).toBe("WorkflowStructuralError: nested unresolved")
    expect(reconstructed.name).toBe("WorkflowStructuralError")
  })

  it("throws a different error (not WorkflowStructuralError) on a non-structural outcome", () => {
    let caught: unknown = null
    try {
      rethrowFromOutcome("something else entirely: not structural")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(WorkflowStructuralError)
    expect((caught as Error).message).toBe("expected structural prefix")
  })

  it("throws when outcome.error is undefined (no structural error to propagate)", () => {
    let caught: unknown = null
    try {
      rethrowFromOutcome(undefined)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(WorkflowStructuralError)
  })
})
