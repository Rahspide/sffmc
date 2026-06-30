// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Storage path resolution + test-only directory override.
// Extracted from checkpoint.ts (M-1 god-object refactor, Task 1.7).

import { homedir } from "node:os";
import { join } from "node:path";

import { defaultFsOps, type FsOps } from "@sffmc/shared";

let _overrideDir: string | null = null;

/** Test-only: override the default checkpoint directory. Set to a
 *  `mkdtempSync` path in `beforeEach` and reset between tests so
 *  production code never reads the test directory. */
export function __setCheckpointDir(dir: string): void {
  _overrideDir = dir;
}

/** Resolve the active checkpoint directory. Honors `_overrideDir`
 *  (set via `__setCheckpointDir`) before falling back to the
 *  XDG-style default. */
export function getCheckpointDir(): string {
  if (_overrideDir) return _overrideDir;
  return join(homedir(), ".local", "share", "sffmc", "extra", "checkpoints");
}

/** Idempotent `mkdir -p` with `0700` mode (checkpoints may contain
 *  sensitive tool outputs). */
export function ensureDir(dir: string, fs: FsOps = defaultFsOps): void {
  if (!fs.exists(dir)) {
    fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

/** On-disk path for a session checkpoint file: `<dir>/<sessionID>.jsonl`. */
export function filePath(sessionID: string, dir?: string): string {
  return join(dir ?? getCheckpointDir(), `${sessionID}.jsonl`);
}