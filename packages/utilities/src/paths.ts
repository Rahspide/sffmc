// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./logger.ts";

const log = createLogger("sffmc/shared");

/** Filename used for the SQLite memory index. Single source of truth so the
 *  memory plugin and the dream tool can't drift (b36 audit drift hazard). */
export const MEMORY_DB_FILENAME = "index.sqlite";

/** File extension for append-only line-delimited JSON log files (workflow
 *  journal, checkpoint store). Single source of truth so consumers and
 *  the recovery scanner agree on the suffix. */
export const JOURNAL_EXT = ".jsonl";

/** Alias for `JOURNAL_EXT`. Used by extra/checkpoint.ts where the file is
 *  semantically a checkpoint, not a journal — but the on-disk format is
 *  the same line-delimited JSON. */
export const CHECKPOINT_EXT = JOURNAL_EXT;

/** Compose the standard XDG-style config dir for SFFMC.
 *  The uppercase `SFFMC` namespace is the canonical on-disk location
 *  (kept for backward compatibility — pre-v0.15 installs wrote here). */
export const configHome = (home: string = homedir()): string =>
  join(home, ".config", "SFFMC");

/** Compose the standard XDG-style data dir for SFFMC.
 *  Same backward-compat note as `configHome`. */
export const dataHome = (home: string = homedir()): string =>
  join(home, ".local", "share", "SFFMC");

/** Resolve the default on-disk path for the memory index. */
export const DEFAULT_MEMORY_DB_PATH = (home: string = homedir()): string =>
  join(dataHome(home), "memory", MEMORY_DB_FILENAME);

// Note: a prior `migrateLegacyDataPaths()` helper lived here (v0.11.1
// Manriel audit follow-up). It was exported but never wired into the
// bootstrap path, so it could never fire. Removed in v0.15.3 — the
// canonical path stays uppercase `SFFMC/` for backward compatibility.
// If a future migration to lowercase `sffmc/` is desired, it should be
// wired into plugin `activation.ts` (call once at startup, guarded by
// a "did we already migrate" marker file) and ship as a planned
// breaking change with a CHANGELOG entry, not as silent code.