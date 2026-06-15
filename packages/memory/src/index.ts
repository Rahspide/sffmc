// SPDX-License-Identifier: MIT
// @sffmc/memory — see ../../LICENSE
//
// SFFMC memory MSP — composes memory + checkpoint + judge + dream.
// Phase 2: replaces prior standalone memory impl with mergeHooks() of 4 sub-features.

import { server as memoryServer } from "./plugin.ts"
import { checkpointServer, judgeServer, dreamServer } from "../../extra/src/index.ts"
import { mergeHooks, type PluginContext, type PluginServer } from "@sffmc/shared"

export const id = "@sffmc/memory"

export const server = async (ctx: PluginContext): Promise<PluginServer> => {
  const merged = mergeHooks([
    await memoryServer(ctx),
    await checkpointServer(ctx),
    await judgeServer(ctx),
    await dreamServer(ctx),
  ])
  return { ...merged, id }
}

export default { id, server }
