// SPDX-License-Identifier: MIT
// @sffmc/extra — Checkpoint
// Public facade.
//
// M-1 god-object refactor (Task 1.7): the implementation that previously
// lived in this single 1296-LOC file has been split into focused modules
// under ./checkpoint/. This file is now a thin re-export shim that
// preserves the original public API:
//   - functions: crc32, __setCheckpointDir, filePath, readToolCalls,
//     listSessions, _findLRUVictim, createCheckpointTool
//   - constants: CURRENT_VERSION, DEFAULT_FLUSH_THRESHOLD,
//     DEFAULT_FLUSH_INTERVAL_MS, DEFAULT_MAX_BUFFER_SESSIONS
//   - classes:  CheckpointTooLargeError
//   - types:    ToolCall, CheckpointState, CheckpointTool, CheckpointHooks,
//     MigrationResult, SessionBufferEntry
//
// All existing imports of `packages/extra/src/checkpoint` (in tests,
// the bench script, and the extra index.ts) continue to work without
// modification.

export {
  crc32,
  __setCheckpointDir,
  filePath,
  readToolCalls,
  listSessions,
  _findLRUVictim,
  createCheckpointTool,
  CURRENT_VERSION,
  DEFAULT_FLUSH_THRESHOLD,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MAX_BUFFER_SESSIONS,
  CheckpointTooLargeError,
} from "./checkpoint/index";

export type {
  ToolCall,
  CheckpointState,
  CheckpointTool,
  CheckpointHooks,
  MigrationResult,
  SessionBufferEntry,
} from "./checkpoint/index";