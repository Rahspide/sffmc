// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

export { loadConfig } from "./config.ts"
export type { PluginContext } from "./context.ts"
export { __listBuiltinRedactionRules, __resetRedactionCache, ensureRedactionRules, isSensitiveFilename, isSensitiveSourcePath, redactSecrets } from "./redact-secrets.ts"
export type { RedactionCategory, RedactionResult } from "./redact-secrets.ts"
export type { RichPluginContext } from "./context.ts"
export { SESSION_CREATED } from "./event-names.ts"
export { extractErrorType, isToolError, JSON_OBJECT_RE, LONG_OUTPUT_THRESHOLD, NoLLMClientError } from "./errors.ts"
export { on, off, emit, clearAll } from "./events.ts"
export { hasMetadataError } from "./has-metadata-error.ts"
export { createLogger } from "./logger.ts"
export type { Logger } from "./logger.ts"
export {
  HOOK_CHAT_MESSAGES_TRANSFORM,
  HOOK_CHAT_SYSTEM_TRANSFORM,
  HOOK_COMMAND_EXECUTE_BEFORE,
  HOOK_PERMISSION_ASK,
  HOOK_SESSION_END,
  HOOK_SESSION_START,
  HOOK_TEXT_COMPLETE,
  HOOK_TOOL_EXECUTE_AFTER,
  HOOK_TOOL_EXECUTE_BEFORE,
  mergeHooks,
  TRANSFORM_HOOKS,
  GATE_HOOKS,
  SIDE_EFFECT_HOOKS,
} from "./merge-hooks.ts"
export type { PluginServer } from "./merge-hooks.ts"
export { DEFAULT_FAILURE_THRESHOLD, DEFAULT_CANDIDATE_COUNT, MAX_COMMAND, MAX_PATTERN } from "./max-command.ts"
export {
  CHECKPOINT_EXT,
  configHome,
  dataHome,
  DEFAULT_MEMORY_DB_PATH,
  JOURNAL_EXT,
  MEMORY_DB_FILENAME,
  migrateLegacyDataPaths,
} from "./paths.ts"
export { SECONDS_PER_DAY, __resetClock, __setClock, unixNow } from "./time.ts"
export { defaultFsOps, createMockFsOps } from "./fs-ops.ts"
export type { FsOps, MockFsOpsState } from "./fs-ops.ts"
export { isSafeRunID, RUN_ID_REGEX, safeRunID } from "./safe-run-id.ts"
