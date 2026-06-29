// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Public facade for the checkpoint subsystem.
// Populated incrementally as concerns are extracted from checkpoint.ts
// (M-1 god-object refactor, Task 1.7). The final state re-exports every
// public symbol from its concern module.

export { crc32 } from "./crc.js";
export {
  CURRENT_VERSION,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_FLUSH_THRESHOLD,
  DEFAULT_MAX_BUFFER_SESSIONS,
} from "./constants.js";
export {
  __setCheckpointDir,
  filePath,
  getCheckpointDir,
  ensureDir,
} from "./paths.js";
export {
  CheckpointTooLargeError,
  type CheckpointHooks,
  type CheckpointState,
  type CheckpointTool,
  type MigrationResult,
  type SessionBufferEntry,
  type ToolCall,
} from "./types.js";