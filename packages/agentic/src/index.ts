// SPDX-License-Identifier: MIT
// @sffmc/agentic — see ../../LICENSE
//
// SFFMC agentic MSP — composes max-mode, workflow, compose, health.
// Phase 2: wires all 4 sub-features via mergeHooks().

import { server as maxModeServer } from "../../max-mode/src/index.ts"
import { server as workflowServer } from "../../workflow/src/index.ts"
import { server as composeServer } from "../../compose/src/index.ts"
import { server as healthServer } from "../../health/src/index.ts"
import { mergeHooks, type PluginContext, type PluginServer } from "@sffmc/shared";

export const id = "@sffmc/agentic"

export const server = async (ctx: PluginContext): Promise<PluginServer> => {
  const merged = mergeHooks([
    await maxModeServer(ctx),
    await workflowServer(ctx),
    await composeServer(ctx),
    await healthServer(ctx),
  ])
  return { ...merged, id }
}

export default { id, server }
