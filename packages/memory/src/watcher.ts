import { watch } from "chokidar";
import type { MemoryDB } from "./memory";
import { upsert, remove } from "./memory";
import { readFileSync } from "fs";
import { relative, basename } from "path";

export function startWatcher(
  rootDir: string,
  db: MemoryDB,
): { stop: () => void } {
  const patterns = [
    `${rootDir}/memory-bank/*.md`,
    `${rootDir}/AGENTS.md`,
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
  if (rel.startsWith("memory-bank/")) {
    const parts = rel.split("/");
    return parts.slice(1).join("/").replace(/\.md$/, "");
  }
  if (basename(filePath) === "AGENTS.md") return "agents";
  return basename(filePath).replace(/\.md$/, "");
}
