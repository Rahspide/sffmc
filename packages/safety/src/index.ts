// SPDX-License-Identifier: MIT
// @sffmc/safety — see ../../LICENSE
//
// SFFMC safety MSP — composes watchdog, rules, auto-max, eos-stripper, log-whitelist.
// Phase 1 skeleton: no sub-features registered yet. Phase 2 will wire them.

import { mergeHooks, type PluginContext, type PluginServer } from "@sffmc/shared"

const server = async (ctx: PluginContext): Promise<PluginServer> => {
  const merged = mergeHooks([
    // Phase 2: server returns from sub-features go here
  ])
  return { ...merged, id: "@sffmc/safety" }
}

export default { id: "@sffmc/safety", server }
