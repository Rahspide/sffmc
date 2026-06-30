// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Defaults + version constants.
// Extracted from checkpoint.ts (M-1 god-object refactor, Task 1.7).
//
// Behavioral note: `MAX_CHECKPOINT_FILE_SIZE` and `MAX_RESTORED_MESSAGES`
// were hardcoded module-level constants in earlier versions. They are
// now configurable via the factory's `config.maxFileSize` and
// `config.maxRestoredMessages` (defaults match the previous hardcoded
// values, so behavior is unchanged when no config is provided).
//
// `FLUSH_THRESHOLD`, `FLUSH_INTERVAL_MS`, and `MAX_BUFFER_SESSIONS`
// followed the same migration pattern. The originals are preserved
// as `DEFAULT_*` so callers that omit the new fields still see the
// prior behavior.

/** Default max checkpoint file size in bytes. Overridable via
 *  `ExtraConfig.checkpoint_max_file_size`. */
export const DEFAULT_MAX_CHECKPOINT_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Default max restored messages per checkpoint. Overridable via
 *  `ExtraConfig.checkpoint_max_restored_messages`. */
export const DEFAULT_MAX_RESTORED_MESSAGES = 50;

/** Default buffer flush threshold. Overridable via
 *  `ExtraConfig.checkpoint_flush_threshold`. */
export const DEFAULT_FLUSH_THRESHOLD = 50;

/** Default periodic flush interval in ms. Overridable via
 *  `ExtraConfig.checkpoint_flush_interval_ms`. */
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

/** Current on-disk checkpoint format version. Bump this when the
 *  header schema changes incompatibly. */
export const CURRENT_VERSION = 2;

/** Default max in-memory session buffers. Overridable via
 *  `ExtraConfig.checkpoint_max_buffered_sessions`. */
export const DEFAULT_MAX_BUFFER_SESSIONS = 50;