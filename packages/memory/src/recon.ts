import type { MemoryEntry } from "./memory";
import { isSensitiveSourcePath } from "@sffmc/shared";
import { RECON_AGENTS_BUDGET, RECON_TASKTREE_BUDGET } from "./constants.ts";

export { RECON_AGENTS_BUDGET, RECON_TASKTREE_BUDGET };

// .slim/deepwork/hardcode-audit-2026-06.md.
//
// `memory` and `checkpoint` were hardcoded at 6144 chars each. They are
// now configurable via `MemoryConfig.reconMemoryBudget` and
// `reconCheckpointBudget` (defaults preserve the prior values). The
// existing `RECON_AGENTS_BUDGET` / `RECON_TASKTREE_BUDGET` constants are
// left untouched (not flagged HIGH — they're the more reasonable 8K/4K
// already; left for a future polish pass).
const DEFAULT_RECON_MEMORY_BUDGET = 6144;
const DEFAULT_RECON_CHECKPOINT_BUDGET = 6144;

export function buildRecon(
  memory: MemoryEntry[],
  checkpoint: string | null,
  taskTree: string,
  tail: string,
  agents: string,
  /** Character budget for the memory section. Defaults to 6144. */
  reconMemoryBudget: number = DEFAULT_RECON_MEMORY_BUDGET,
  /** Character budget for the checkpoint section. Defaults to 6144. */
  reconCheckpointBudget: number = DEFAULT_RECON_CHECKPOINT_BUDGET,
): string {
  const sections: string[] = [];

  const memoryText = memory
    .filter(e => !isSensitiveSourcePath(e.source_path))
    .map(
      (e) =>
        `[${e.source_path}${e.section ? ` > ${e.section}` : ""}]\n${e.content}`,
    )
    .join("\n\n");
  sections.push(
    `## Memory (${reconMemoryBudget} chars)\n${truncate(memoryText, reconMemoryBudget)}`,
  );

  if (checkpoint) {
    sections.push(
      `## Checkpoint (${reconCheckpointBudget} chars)\n${truncate(checkpoint, reconCheckpointBudget)}`,
    );
  }

  const taskTreeText = taskTree || "(empty)";
  sections.push(
    `## Task Tree (${RECON_TASKTREE_BUDGET} chars)\n${truncate(taskTreeText, RECON_TASKTREE_BUDGET)}`,
  );

  sections.push(`## Recent Context (${tail.length} chars)\n${tail}`);

  sections.push(
    `## AGENTS.md (${RECON_AGENTS_BUDGET} chars)\n${truncate(agents, RECON_AGENTS_BUDGET)}`,
  );

  return `[Context Recon 8K — injected by F4' Memory]\n\n${sections.join("\n\n")}`;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  if (lastNewline > maxChars * 0.8) {
    return truncated.slice(0, lastNewline) + "\n[...truncated]";
  }
  return truncated + "\n[...truncated]";
}

export function tailFromMessages(
  messages: Array<{ content?: string; role?: string; [key: string]: unknown }>,
  maxChars: number,
): string {
  const lines: string[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0 && chars < maxChars; i--) {
    const content = messages[i]?.content;
    if (typeof content !== "string" || !content) continue;
    lines.unshift(content);
    chars += content.length;
  }
  return truncate(lines.join("\n"), maxChars);
}
