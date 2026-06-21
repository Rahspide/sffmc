// SPDX-License-Identifier: MIT
// @sffmc/safety — see ../../LICENSE
//
// SFFMC safety MSP — composes watchdog, rules, auto-max, eos-stripper, log-whitelist.
// second release: wires all 5 modules via mergeHooks().

import { server as watchdogServer } from "../../watchdog/src/index.ts"
import { server as rulesServer } from "../../rules/src/index.ts"
import { server as autoMaxServer } from "../../auto-max/src/index.ts"
import { server as eosServer } from "../../eos-stripper/src/index.ts"
import { server as logServer } from "../../log-whitelist/src/index.ts"
import { mergeHooks, type PluginContext, type PluginServer } from "@sffmc/shared";

export const id = "@sffmc/safety"

export const server = async (ctx: PluginContext): Promise<PluginServer> => {
  const merged = mergeHooks([
    await watchdogServer(ctx),
    await rulesServer(ctx),
    await autoMaxServer(ctx),
    await eosServer(ctx),
    await logServer(ctx),
  ])
  return { ...merged, id }
}

export default { id, server }
