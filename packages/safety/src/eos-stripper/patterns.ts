export const DEFAULT_EOS_PATTERNS: string[] = [
  "</s>",
  "<|endoftext|>",
  "<|im_end|>",
  "<|eot_id|>",
  "<|end|>",
  "<|end_of_turn|>",
  "<|endofmessage|>",
  "<|return|>",
  "[/INST]",
  "<end_of_utterance>",
];

/**
 * Strip EOS patterns from the END of text only.
 * Patterns in the middle are presumed intentional.
 */
export function stripEos(text: string, patterns: string[]): string {
  let scratch = text;
  let changed = true;

  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      if (scratch.endsWith(pattern)) {
        scratch = scratch.slice(0, scratch.length - pattern.length);
        changed = true;
        break;
      }
    }
    // Also try trimmed — some models emit whitespace then EOS
    for (const pattern of patterns) {
      const trimmed = scratch.trimEnd();
      if (trimmed !== scratch && trimmed.endsWith(pattern)) {
        scratch = trimmed.slice(0, trimmed.length - pattern.length);
        changed = true;
        break;
      }
    }
  }

  // Strip trailing whitespace that may have been left after EOS removal
  return scratch.trimEnd();
}

/**
 * Returns true if the text consists entirely of EOS tokens and whitespace.
 */
export function looksLikeEosOnly(text: string, patterns: string[]): boolean {
  if (text.trim().length === 0) return false;
  let stripped = text;
  for (const p of patterns) {
    stripped = stripped.replaceAll(p, "");
  }
  return stripped.trim().length === 0;
}
