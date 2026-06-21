import { watch } from "chokidar";
import type { MemoryDB } from "./memory";
import { upsert, remove } from "./memory";
import { readFileSync } from "fs";
import { relative, basename } from "path";
import { ensureRedactionRules, isSensitiveFilename } from "@sffmc/shared";
import { AGENTS_FILE, MEMORY_BANK_DIR } from "./constants.ts";

/** Watcher tuning parameters (second release migration chokidar awaitWriteFinish.stabilityThreshold, chokidar awaitWriteFinish.pollInterval).
 *  Defaults match the prior hardcoded values (300ms / 100ms). */
export interface WatcherConfig {
  /** Chokidar `awaitWriteFinish.stabilityThreshold` in ms. */
  stabilityMs: number
  /** Chokidar `awaitWriteFinish.pollInterval` in ms. */
  pollIntervalMs: number
}

export const DEFAULT_WATCHER_CONFIG: WatcherConfig = {
  stabilityMs: 300,
  pollIntervalMs: 100,
}

export function startWatcher(
  rootDir: string,
  db: MemoryDB,
  /** Optional watcher tuning; defaults to { stabilityMs: 300, pollIntervalMs: 100 }
   *  which preserves the prior hardcoded behaviour. */
  watchCfg: WatcherConfig = DEFAULT_WATCHER_CONFIG,
): { stop: () => void } {
  // Pre-load redaction rules (user YAML + builtins) so the watcher's hot
  // path can stay sync. Fire-and-forget — `isSensitiveFilename` falls back
  // to BUILTIN_RULES if the cache isn't ready yet.
  void ensureRedactionRules().catch(() => {
    // Best-effort; fall back to built-ins if config can't be read.
  })

  const patterns = [
    `${rootDir}/${MEMORY_BANK_DIR}/*.md`,
    `${rootDir}/${AGENTS_FILE}`,
    `${rootDir}/*.md`,
  ];

  const watcher = watch(patterns, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: watchCfg.stabilityMs,
      pollInterval: watchCfg.pollIntervalMs,
    },
  });

  function indexFile(filePath: string): void {
    if (isSensitiveFilename(filePath)) return;
    try {
      const content = readFileSync(filePath, "utf-8");
      if (!content.trim()) return;

      const relPath = relative(rootDir, filePath);
      const section = determineSection(filePath, rootDir);

      upsert(db, relPath, section, content);
    } catch {
      // file may be deleted mid-read or inaccessible
    }
  }

  watcher.on("add", indexFile);
  watcher.on("change", indexFile);
  watcher.on("unlink", (filePath: string) => {
    const relPath = relative(rootDir, filePath);
    remove(db, relPath);
  });

  return { stop: () => watcher.close() };
}

function determineSection(filePath: string, rootDir: string): string {
  const rel = relative(rootDir, filePath);
  if (rel.startsWith(`${MEMORY_BANK_DIR}/`)) {
    const parts = rel.split("/");
    return parts.slice(1).join("/").replace(/\.md$/, "");
  }
  if (basename(filePath) === AGENTS_FILE) return "agents";
  return basename(filePath).replace(/\.md$/, "");
}
