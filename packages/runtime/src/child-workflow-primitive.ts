// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Child workflow + journal-helper primitives, extracted from WorkflowRuntime
// per the v0.16.0 refactor plan (ora-7, Phase 6). The runtime holds a
// reference to a `ChildWorkflowPrimitive` instance and delegates
// `spawnChildWorkflow`, `startChildWorkflow`, `setPhase`, and `appendLog`
// to it, preserving the call-site shape while moving the implementation
// into a focused module.
//
// Why a class (not free functions): the 4 methods form a small orchestration
// surface that touches 6 collaborators (persistence, events, runs registry,
// startChildWorkflow callback, settleEntry callback, + utilities for
// script resolution and hash). Bundling them makes the dependency graph
// explicit and unit-testable in isolation.

import { createHash } from "node:crypto"
import type { IChildWorkflowPrimitive } from "./runtime-services.ts"
import { resolveWorkflow, isInlineScript } from "./resolve.ts"
import { parseMeta } from "./meta.ts"
import { computeScriptSha, generateRunID } from "./persistence.ts"
import { makeEntry } from "./internal-run-entry.ts"
import { WorkspaceJail } from "./workspace.ts"
import type { InternalRunEntry } from "./internal-run-entry.ts"
import type { WorkflowPersistence } from "./persistence.ts"
import type { WorkflowEventEmitter } from "./event-emitter.ts"
import type { WorkflowActivation } from "./activation.ts"

const WORKFLOW_STRUCTURAL_ERROR = "WorkflowStructuralError"

export interface ChildWorkflowPrimitiveDeps {
  persistence: WorkflowPersistence
  events: WorkflowEventEmitter
  runs: WorkflowActivation<InternalRunEntry>
  /** Flush counters to the DB (debounced). */
  scheduleFlush: (entry: InternalRunEntry) => void
  /** Start a child workflow sub-run. Recursively uses
   *  ChildWorkflowPrimitive.startChildWorkflow. */
  startChildWorkflow: (
    parent: InternalRunEntry,
    script: string,
    name: string,
    args: unknown,
    childRunID: string,
  ) => Promise<InternalRunEntry>
  /** Append a journal event (wrapper around persistence.appendJournal). */
  appendJournal: (runID: string, event: unknown) => void
  /** Settle the run (launch script + route to completeRun/failRun). */
  settleEntry: (
    entry: InternalRunEntry,
    script: string,
    name: string,
    args: unknown,
    jail: WorkspaceJail,
  ) => Promise<void>
}

export class ChildWorkflowPrimitive implements IChildWorkflowPrimitive {
  constructor(private readonly deps: ChildWorkflowPrimitiveDeps) {}

  /** workflow(nameOrScript, args?) — spawn a child workflow. */
  async spawn(
    entry: InternalRunEntry,
    nameOrScript: string,
    childArgs: unknown,
    workflowOcc: Map<string, number>,
  ): Promise<unknown> {
    const spec = String(nameOrScript)
    const base = createHash("sha256")
      .update(JSON.stringify({ spec, args: childArgs ?? null }))
      .digest("hex")
    const n = workflowOcc.get(base) ?? 0
    workflowOcc.set(base, n + 1)
    const key = "wf:" + base + ":" + n

    // Journal hit
    if (entry.journalResults.has(key)) {
      entry.counters.recordJournalHit()
      this.deps.scheduleFlush(entry)
      return entry.journalResults.get(key)
    }

    // Resolve child script
    let childScript: string
    try {
      const workspace = entry.workspace ?? process.cwd()
      const resolved = isInlineScript(spec)
        ? { source: spec, meta: parseMeta(spec), kind: "inline" as const }
        : await resolveWorkflow(spec, workspace)
      childScript = resolved.source
    } catch (e) {
      throw new Error(`${WORKFLOW_STRUCTURAL_ERROR}: unknown workflow: ${JSON.stringify(spec)}`)
    }

    const childName = isInlineScript(spec) ? "inline:" + base.slice(0, 12) : spec

    // Launch child sub-run
    const childRunID = generateRunID()
    entry.childRunIDs.add(childRunID)

    const childEntry = await this.deps.startChildWorkflow(entry, childScript, childName, childArgs, childRunID)

    // Wait for child outcome
    const childOutcome = await childEntry.outcomePromise

    // Structural errors propagate
    if (childOutcome.status === "failed" && childOutcome.error?.includes(WORKFLOW_STRUCTURAL_ERROR)) {
      const idx = childOutcome.error.indexOf(WORKFLOW_STRUCTURAL_ERROR)
      throw new Error(childOutcome.error.slice(idx))
    }

    // Runtime failure → null
    if (childOutcome.status !== "completed") {
      return null
    }

    const value = childOutcome.result ?? null

    // Journal successful child
    if (value !== null) {
      this.deps.persistence.appendJournalSync(entry.runID, {
        t: "agent",
        key,
        result: value,
        pass: entry.journalPass,
      })
    }

    return value
  }

  /** startChildWorkflow — launch a child sub-run. Called by `spawn()` and
   *  recursively by itself for nested workflows. */
  async start(
    parent: InternalRunEntry,
    script: string,
    name: string,
    args: unknown,
    _childRunID: string,
  ): Promise<InternalRunEntry> {
    // Simplified: create a new entry, run it inline
    const parsed = parseMeta(script)

    const scriptSha = computeScriptSha(script)
    // Child inherits parent's workspace so the whole workflow tree
    // stays jailed to the same directory. Persisted so child resume also
    // restores the same root.
    const childWorkspace = parent.workspace
    const runID = this.deps.persistence.createRun(name, name, scriptSha, undefined, childWorkspace, args)
    await this.deps.persistence.writeScript(runID, script)

    const entry = makeEntry({ runID, name: parsed.ok ? parsed.meta.name : name, cfg: parent.cfg, workspace: childWorkspace })

    this.deps.runs.register(runID, entry)

    this.deps.events.emit("workflow:started", { runID, name })

    // Settle the child run inline. The settleEntry callback is provided
    // by the runtime (it routes to RunCompleter.settleEntry).
    this.deps.scheduleFlush(entry)
    this.deps.settleEntry(entry, script, name, args, new WorkspaceJail(childWorkspace ?? process.cwd()))

    return entry
  }

  /** phase(title) — set the current phase for a run. */
  setPhase(entry: InternalRunEntry, title: string): void {
    entry.currentPhase = title
    this.deps.appendJournal(entry.runID, {
      t: "phase",
      title,
      pass: entry.journalPass,
    })
    this.deps.events.emit("workflow:phase", { runID: entry.runID, title })
  }

  /** log(msg) — append a log message to the run journal. */
  appendLog(entry: InternalRunEntry, msg: string): void {
    this.deps.appendJournal(entry.runID, {
      t: "log",
      msg,
      pass: entry.journalPass,
    })
    this.deps.events.emit("workflow:log", { runID: entry.runID, message: msg })
  }
}
