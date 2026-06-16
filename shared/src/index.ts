// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

export { loadConfig } from "./config.ts"
export type { PluginContext } from "./context.ts"
export type { RichPluginContext } from "./context.ts"
export { extractErrorType, isToolError } from "./errors.ts"
export { on, off, emit, clearAll } from "./events.ts"
export { MAX_COMMAND, MAX_SUBCOMMANDS, MAX_PATTERN } from "./max-command.ts"
export type { MaxSubcommand } from "./max-command.ts"
export { mergeHooks, TRANSFORM_HOOKS, GATE_HOOKS, SIDE_EFFECT_HOOKS } from "./merge-hooks.ts"
export type { PluginServer } from "./merge-hooks.ts"
export { createLogger } from "./logger.ts"
export type { Logger } from "./logger.ts"
export { SFFMC_DATA_HOME, SFFMC_CONFIG_HOME, migrateLegacyDataPaths, __resetMigrationFlag } from "./paths.ts"
