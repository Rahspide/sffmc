// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE
import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
let _migrated = false;
export async function migrateLegacyDataPaths(): Promise<void> {
  if (_migrated) return;
  _migrated = true;
  const home = homedir();
  try { await rename(join(home, ".config", "SFFMC"), join(home, ".config", "sffmc")); } catch {}
  try { await rename(join(home, ".local", "share", "SFFMC"), join(home, ".local", "share", "sffmc")); } catch {}
}
