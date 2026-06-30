// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// Script resolution — extracted from WorkflowRuntime (M-1 god-object
// refactor, Task 1.6 façade reduction). The runtime's `start()` method
// previously held `resolveScript()` inline as a private method (lines 654-687
// of the pre-extract runtime.ts). The function has no runtime-instance
// state — it just resolves one of three input shapes (builtin by name,
// inline script string, or file path under workspace) to the workflow
// source string, applying a lexical jail check for the file-path branch.
//
// Why extract: the resolution logic is a pure function over the input +
// `process.cwd()` + the filesystem, with no dependency on `this`. Keeping
// it on the runtime inflates the façade with detail that doesn't belong in
// the "start a workflow, return runID" hot path. Splitting it out makes
// both the runtime and the resolver easier to read.

import { readFile } from "node:fs/promises"
import path from "node:path"
import { getBuiltin, loadBuiltin } from "./builtin-registry.ts"
import { resolveWorkflow, isInlineScript } from "./resolve.ts"
import type { WorkflowStartInput } from "./types.ts"

/** Resolve a `WorkflowStartInput` to the workflow source string. Three
 *  accepted input shapes (matching the prior `resolveScript` branches):
 *
 *  - `input.name` (no `input.script`): look up a builtin by name, then
 *    fall back to a saved workflow under the workspace's `.sffmc/workflows/`.
 *  - `input.script` (inline): returned verbatim after `isInlineScript()` confirms
 *    it begins with the `export const meta` magic prefix.
 *  - `input.file` (filesystem path): `path.resolve(workspace, input.file)`,
 *    with a hard jail check that throws if the resolved path escapes the
 *    workspace. The check allows equality with the workspace root but
 *    blocks any traversal via `..` segments.
 *
 *  Throws when none of the three input shapes is present ("workflow start
 *  requires name, script, or file"), or when the resolved file path
 *  escapes the workspace. */
export async function resolveWorkflowScript(
  input: WorkflowStartInput & { name?: string },
): Promise<string> {
  if (input.name && !input.script) {
    const builtin = getBuiltin(input.name)
    if (builtin) {
      const entry = await loadBuiltin(input.name)
      return entry.script
    }
    const workspace = input.workspace ?? process.cwd()
    const resolved = await resolveWorkflow(input.name, workspace)
    return resolved.source
  }

  if (input.script) {
    if (isInlineScript(input.script)) return input.script
  }

  if (input.file) {
    const workspace = input.workspace ?? process.cwd()
    const resolved = path.resolve(workspace, input.file)
    const normalizedResolved = path.resolve(resolved)
    const normalizedWorkspace = path.resolve(workspace)
    if (!normalizedResolved.startsWith(normalizedWorkspace + path.sep) && normalizedResolved !== normalizedWorkspace) {
      throw new Error(`Workflow file escapes workspace: ${JSON.stringify(input.file)}`)
    }
    return readFile(resolved, "utf-8")
  }

  throw new Error("workflow start requires name, script, or file")
}
