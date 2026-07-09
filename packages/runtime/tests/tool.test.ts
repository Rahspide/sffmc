// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Tests for `createWorkflowTool` in tool.ts. The tool is the bridge
// between LLM-shaped args (`run_id`, `timeout_ms`, `agent_timeout_ms`,
// snake_case throughout) and runtime-shaped args (`runID`, `timeoutMs`,
// `agentTimeoutMs`, camelCase).
//
// A field rename in `createWorkflowTool` silently breaks every LLM tool
// call. The test below pins the dispatch contract end-to-end without
// requiring a full WorkflowRuntime — pure dispatch via hand-rolled spy.

import { describe, test, expect, beforeEach, mock } from "bun:test"
import { createWorkflowTool } from "../src/tool.ts"

type Spy = ReturnType<typeof mock>
interface RuntimeSpy {
  start: Spy
  status: Spy
  wait: Spy
  cancel: Spy
  resume: Spy
}

function makeRuntimeSpy(): RuntimeSpy {
  return {
    start:  mock(async () => ({ runID: "wf_aaaaaaaaaaaaaaaaaaaaaaaaaa" })),
    status: mock(async () => ({ runID: "wf_aaaaaaaaaaaaaaaaaaaaaaaaaa", status: "running" })),
    wait:   mock(async () => ({ runID: "wf_aaaaaaaaaaaaaaaaaaaaaaaaaa", status: "completed" })),
    cancel: mock(async () => undefined),
    resume: mock(async () => ({ runID: "wf_aaaaaaaaaaaaaaaaaaaaaaaaaa", resumed: true })),
  }
}

describe("createWorkflowTool: contract & dispatch", () => {
  let spy: RuntimeSpy
  let tool: ReturnType<typeof createWorkflowTool>

  beforeEach(() => {
    spy = makeRuntimeSpy()
    tool = createWorkflowTool(spy as never)
  })

  // ─── description & parameters schema (LLM registration contract) ─────

  test("description is a non-empty string mentioning all five operations", () => {
    expect(tool.description.length).toBeGreaterThan(20)
    for (const op of ["run", "status", "wait", "cancel", "resume"]) {
      expect(tool.description).toContain(op)
    }
  })

  test("description mentions both workflow search dirs", () => {
    expect(tool.description).toContain(".sffmc/workflows/")
    expect(tool.description).toContain(".claude/workflows/")
  })

  test("parameters.operation enum is exactly [run, status, wait, cancel, resume]", () => {
    expect(tool.parameters.properties.operation.enum).toEqual([
      "run", "status", "wait", "cancel", "resume",
    ])
  })

  test("parameters.required is exactly [\"operation\"]", () => {
    expect(tool.parameters.required).toEqual(["operation"])
  })

  test("parameters declares run_id / timeout_ms / agent_timeout_ms", () => {
    expect(tool.parameters.properties.run_id.type).toBe("string")
    expect(tool.parameters.properties.timeout_ms.type).toBe("number")
    expect(tool.parameters.properties.agent_timeout_ms.type).toBe("number")
  })

  // ─── input validation (defensive typeof guard) ──────────────────────────

  test("execute() rejects null args", async () => {
    const r = await tool.execute(null as never)
    expect(r).toMatch(/Error.*operation/)
  })

  test("execute() rejects args without operation field", async () => {
    const r = await tool.execute({} as never)
    expect(r).toContain("operation")
    expect(r).toMatch(/^Error/)
  })

  test("execute() rejects non-string operation", async () => {
    const r = await tool.execute({ operation: 42 } as never)
    expect(r).toMatch(/^Error/)
  })

  // ─── operation: run (the most complex path) ─────────────────────────────

  test("operation=run: rejects when neither name nor script is present", async () => {
    const r = await tool.execute({ operation: "run" })
    expect(r).toMatch(/provide either/)
    expect(spy.start).toHaveBeenCalledTimes(0)
  })

  test("operation=run: rejects when BOTH name and script are provided", async () => {
    const r = await tool.execute({ operation: "run", name: "x", script: "y" })
    expect(r).toContain("not both")
    expect(spy.start).toHaveBeenCalledTimes(0)
  })

  test("operation=run: with name → forwards name + injects sessionID='tool-call'", async () => {
    await tool.execute({ operation: "run", name: "deep-research" })
    expect(spy.start).toHaveBeenCalledTimes(1)
    const arg = spy.start.mock.calls[0]![0] as { name: string; script: unknown; args: unknown; workspace: unknown; sessionID: string }
    expect(arg.name).toBe("deep-research")
    expect(arg.script).toBeUndefined()
    expect(arg.sessionID).toBe("tool-call")
  })

  test("operation=run: with script → forwards script verbatim", async () => {
    const script = "export const meta = { name: 'inline', description: 'x' }"
    await tool.execute({ operation: "run", script })
    expect(spy.start).toHaveBeenCalledTimes(1)
    const arg = spy.start.mock.calls[0]![0] as { script: string; sessionID: string }
    expect(arg.script).toBe(script)
    expect(arg.sessionID).toBe("tool-call")
  })

  test("operation=run: forwards args and workspace", async () => {
    await tool.execute({
      operation: "run",
      name: "x",
      args: { question: "why" },
      workspace: "/abs/path",
    })
    const arg = spy.start.mock.calls[0]![0] as { args: unknown; workspace: string }
    expect(arg.args).toEqual({ question: "why" })
    expect(arg.workspace).toBe("/abs/path")
  })

  // ─── operation: status / wait / cancel / resume (snake_case → camelCase) ─

  test("operation=status: maps run_id → runID, JSON-stringifies output", async () => {
    // spy returns whatever runID was passed in (we test mapping via the
    // call-arg assertion, not the spy return value)
    const r = await tool.execute({ operation: "status", run_id: "wf_xxxxxxxxxxxxxxxxxxxxxxxx" })
    expect(spy.status).toHaveBeenCalledTimes(1)
    expect(spy.status.mock.calls[0]![0]).toEqual({ runID: "wf_xxxxxxxxxxxxxxxxxxxxxxxx" })
    // Output is JSON.stringify(await runtime.status(...))
    expect(typeof r).toBe("string")
    expect(JSON.parse(r)).toEqual({ runID: "wf_aaaaaaaaaaaaaaaaaaaaaaaaaa", status: "running" })
  })

  test("operation=wait: maps timeout_ms → timeoutMs", async () => {
    await tool.execute({ operation: "wait", run_id: "wf_x", timeout_ms: 5000 })
    expect(spy.wait).toHaveBeenCalledTimes(1)
    expect(spy.wait.mock.calls[0]![0]).toEqual({ runID: "wf_x", timeoutMs: 5000 })
  })

  test("operation=wait: without timeout_ms → timeoutMs is undefined", async () => {
    await tool.execute({ operation: "wait", run_id: "wf_x" })
    expect(spy.wait.mock.calls[0]![0]).toEqual({ runID: "wf_x", timeoutMs: undefined })
  })

  test("operation=cancel: returns {cancelled: run_id}", async () => {
    const r = await tool.execute({ operation: "cancel", run_id: "wf_x" })
    expect(JSON.parse(r)).toEqual({ cancelled: "wf_x" })
    expect(spy.cancel).toHaveBeenCalledTimes(1)
  })

  test("operation=resume: maps agent_timeout_ms → agentTimeoutMs", async () => {
    await tool.execute({ operation: "resume", run_id: "wf_x", agent_timeout_ms: 60000 })
    expect(spy.resume.mock.calls[0]![0]).toEqual({ runID: "wf_x", agentTimeoutMs: 60000 })
  })

  // ─── error handling ───────────────────────────────────────────────────

  test("operation=<unknown>: returns Error interpolating the value", async () => {
    const r = await tool.execute({ operation: "explode" })
    expect(r).toMatch(/^Error/)
    expect(r).toContain("explode")
  })

  test("execute() catches runtime.start() Error throw", async () => {
    spy.start.mockImplementation(async () => { throw new Error("boom") })
    const r = await tool.execute({ operation: "run", name: "x" })
    expect(r).toBe("Error: boom")
    expect(spy.start).toHaveBeenCalledTimes(1)
  })

  test("execute() catches non-Error throw via String()", async () => {
    spy.start.mockImplementation(async () => { throw "raw-string-error" })
    const r = await tool.execute({ operation: "run", name: "x" })
    expect(r).toBe("Error: raw-string-error")
  })

  test("execute() ignores malformed _ctx second argument", async () => {
    const r = await tool.execute(
      { operation: "status", run_id: "wf_x" },
      { weird: Symbol() as never } as never,
    )
    // Output reflects spy's return value (not the run_id we passed —
    // runtime.status returns its own data). Just check that status was
    // called and returned a JSON object.
    expect(spy.status).toHaveBeenCalledTimes(1)
    expect(() => JSON.parse(r)).not.toThrow()
  })
})
