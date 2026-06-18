// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE
import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Filename used for the SQLite memory index. Single source of truth so the
 *  memory plugin and the dream tool can't drift (b36 audit drift hazard). */
export const MEMORY_DB_FILENAME = "index.sqlite";

/** Resolve the default on-disk path for the memory index.
 *  Path intentionally uses the uppercase `SFFMC` namespace (the legacy
 *  source-of-truth location pre-migration). `migrateLegacyDataPaths()` is
 *  responsible for moving this to lowercase on first run. */
export const DEFAULT_MEMORY_DB_PATH = (home: string = homedir()): string =>
  join(home, ".local", "share", "SFFMC", "memory", MEMORY_DB_FILENAME);

let _migrated = false;
export async function migrateLegacyDataPaths(): Promise<void> {
  if (_migrated) return;
  _migrated = true;
  const home = homedir();
  try { await rename(join(home, ".config", "SFFMC"), join(home, ".config", "sffmc")); } catch {}
  try { await rename(join(home, ".local", "share", "SFFMC"), join(home, ".local", "share", "sffmc")); } catch {}
}
