import { watch } from "chokidar";
import type { MemoryDB } from "./memory";
import { upsert, remove } from "./memory";
import { readFileSync } from "fs";
import { relative, basename } from "path";
import { AGENTS_FILE, MEMORY_BANK_DIR } from "./constants.ts";

/** Patterns for filenames that should never be indexed into the memory DB.
 *  Prevents sensitive files (credentials, secrets, tokens) from being
 *  injected into LLM context via recon. */
const SENSITIVE_FILE_PATTERNS = [
  /credentials/i, /secrets?/i, /\.env/i, /password/i,
  /token/i, /api[_-]?key/i, /private/i,
];

function isSensitiveFile(filePath: string): boolean {
  const name = basename(filePath);
  return SENSITIVE_FILE_PATTERNS.some(p => p.test(name));
}

export function startWatcher(
  rootDir: string,
  db: MemoryDB,
): { stop: () => void } {
  const patterns = [
    `${rootDir}/${MEMORY_BANK_DIR}/*.md`,
    `${rootDir}/${AGENTS_FILE}`,
    `${rootDir}/*.md`,
  ];

  const watcher = watch(patterns, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  function indexFile(filePath: string): void {
    if (isSensitiveFile(filePath)) return;
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
