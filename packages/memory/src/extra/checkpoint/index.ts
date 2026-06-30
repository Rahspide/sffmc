// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Public facade for the checkpoint subsystem.
// Re-exports every public symbol from its concern module.
//
// M-1 god-object refactor (Task 1.7) — `checkpoint.ts` itself is now a
// re-export shim that imports from this module, so all consumers
// (tests, bench, packages/extra/src/index.ts) keep their original
// import paths.

export { crc32 } from "./crc";
export {
  CURRENT_VERSION,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_FLUSH_THRESHOLD,
  DEFAULT_MAX_BUFFER_SESSIONS,
} from "./constants";
export {
  __setCheckpointDir,
  filePath,
  getCheckpointDir,
  ensureDir,
} from "./paths";
export {
  CheckpointTooLargeError,
  type CheckpointHooks,
  type CheckpointState,
  type CheckpointTool,
  type MigrationResult,
  type SessionBufferEntry,
  type ToolCall,
} from "./types";
export { readToolCallsShim as readToolCalls, listSessions, deleteCheckpoint } from "./reader";
export { findLRUVictim as _findLRUVictim } from "./buffer";
export { createCheckpointTool } from "./factory";