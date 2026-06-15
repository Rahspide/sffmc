// SPDX-License-Identifier: MIT
// @sffmc/agentic — see ../../LICENSE
//
// SFFMC agentic MSP — composes max-mode, workflow, compose, health.
// Phase 1 skeleton: no sub-features registered yet. Phase 2 will wire them.

import { mergeHooks, type PluginContext, type PluginServer } from "@sffmc/shared"

const server = async (ctx: PluginContext): Promise<PluginServer> => {
  const merged = mergeHooks([
    // Phase 2: server returns from sub-features go here
  ])
  return { ...merged, id: "@sffmc/agentic" }
}

export default { id: "@sffmc/agentic", server }
