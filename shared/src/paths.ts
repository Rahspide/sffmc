// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE
import { rename } from "node:fs/promises";
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

/** Compose the standard XDG-style config dir for SFFMC. The uppercase
 *  `SFFMC` namespace is the legacy location; `migrateLegacyDataPaths()`
 *  is responsible for moving it to lowercase on first run. */
export const configHome = (home: string = homedir()): string =>
  join(home, ".config", "SFFMC");

/** Compose the standard XDG-style data dir for SFFMC. */
export const dataHome = (home: string = homedir()): string =>
  join(home, ".local", "share", "SFFMC");

/** Resolve the default on-disk path for the memory index.
 *  Path intentionally uses the uppercase `SFFMC` namespace (the legacy
 *  source-of-truth location pre-migration). `migrateLegacyDataPaths()` is
 *  responsible for moving this to lowercase on first run. */
export const DEFAULT_MEMORY_DB_PATH = (home: string = homedir()): string =>
  join(dataHome(home), "memory", MEMORY_DB_FILENAME);

let _migrated = false;
export async function migrateLegacyDataPaths(): Promise<void> {
  if (_migrated) return;
  _migrated = true;
  const home = homedir();
  try {
    await rename(join(home, ".config", "SFFMC"), join(home, ".config", "sffmc"));
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code !== "ENOENT") {
      log.warn("Legacy config migration failed:", (e as Error).message);
    }
  }
  try {
    await rename(join(home, ".local", "share", "SFFMC"), join(home, ".local", "share", "sffmc"));
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code !== "ENOENT") {
      log.warn("Legacy data migration failed:", (e as Error).message);
    }
  }
}
