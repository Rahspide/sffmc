import type { MemoryEntry } from "./memory";

const RECON_BUDGETS = {
  memory: 6144,
  checkpoint: 6144,
  taskTree: 4096,
  agents: 8192,
} as const;

export function buildRecon(
  memory: MemoryEntry[],
  checkpoint: string | null,
  taskTree: string,
  tail: string,
  agents: string,
): string {
  const sections: string[] = [];

  const memoryText = memory
    .map(
      (e) =>
        `[${e.source_path}${e.section ? ` > ${e.section}` : ""}]\n${e.content}`,
    )
    .join("\n\n");
  sections.push(
    `## Memory (${RECON_BUDGETS.memory} chars)\n${truncate(memoryText, RECON_BUDGETS.memory)}`,
  );

  if (checkpoint) {
    sections.push(
      `## Checkpoint (${RECON_BUDGETS.checkpoint} chars)\n${truncate(checkpoint, RECON_BUDGETS.checkpoint)}`,
    );
  }

  const taskTreeText = taskTree || "(empty)";
  sections.push(
    `## Task Tree (${RECON_BUDGETS.taskTree} chars)\n${truncate(taskTreeText, RECON_BUDGETS.taskTree)}`,
  );

  sections.push(`## Recent Context (${tail.length} chars)\n${tail}`);

  sections.push(
    `## AGENTS.md (${RECON_BUDGETS.agents} chars)\n${truncate(agents, RECON_BUDGETS.agents)}`,
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

export function parseAgentsMd(content: string): string {
  return content.slice(0, RECON_BUDGETS.agents);
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
