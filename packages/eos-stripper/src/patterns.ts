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
  let result = text;
  let changed = true;

  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      if (result.endsWith(pattern)) {
        result = result.slice(0, result.length - pattern.length);
        changed = true;
        break;
      }
    }
    // Also try trimmed — some models emit whitespace then EOS
    for (const pattern of patterns) {
      const trimmed = result.trimEnd();
      if (trimmed !== result && trimmed.endsWith(pattern)) {
        result = trimmed.slice(0, trimmed.length - pattern.length);
        changed = true;
        break;
      }
    }
  }

  // Strip trailing whitespace that may have been left after EOS removal
  return result.trimEnd();
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
