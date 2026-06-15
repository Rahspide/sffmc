// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

export { loadConfig } from "./config.ts"
export type { PluginContext } from "./context.ts"
export { on, off, emit, clearAll } from "./events.ts"
export { mergeHooks, TRANSFORM_HOOKS, GATE_HOOKS, SIDE_EFFECT_HOOKS } from "./merge-hooks.ts"
export type { PluginServer } from "./merge-hooks.ts"
