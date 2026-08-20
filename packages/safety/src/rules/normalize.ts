// v0.15.2 safety hardening — command normalization.
//
// Pre-processing for the rule engine. The bash tool emits the command as a
// flat string; attackers (or buggy CLI tooling) can hide dangerous payloads
// behind four common obfuscations:
//
//   1. NFKC Unicode normalization   —  fullwidth `ｒｍ` → `rm`.
//   2. Null bytes                  —  `rm\x00 -rf /` evades naive substring match.
//   3. Line continuations           —  shell removes `\<newline>` before exec.
//   4. ANSI / OSC escape sequences  —  `printf '\x1b[31mrm…'` colors the payload.
//
// `normalizeCommand(cmd)` strips all four so the regex matcher (and the
// sibling `anchoredTest` in `compileRules.ts`) sees the same string the
// shell will actually execute. Pure function, no I/O, no shared state.
// Integration into the gate is wired by Subagent C in `gate.ts`.

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const NUL = String.fromCharCode(0)
const CSI_RE = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g")
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g")
const NULL_RE = new RegExp(NUL, "g")
// `\<newline>` is a shell line continuation. Strip both characters so the
// joined line is what the shell will execute. `\r?` covers CRLF.
const LINE_CONT_RE = /\\\r?\n/g;

/**
 * Return `cmd` with the four common obfuscation layers removed.
 *
 * Transformations are applied in this order:
 *
 *   1. NFKC — cheap canonicalization; may expose ANSI bytes if they were
 *      hidden inside a compatibility character (defence-in-depth).
 *   2. Null bytes — dropped before any further processing.
 *   3. Line continuations — joined so the regex sees one logical line.
 *   4. ANSI / OSC escapes — stripped last (they may have escaped `\n` or
 *      other control bytes that would have been consumed by an earlier
 *      step).
 *
 * The function is total: any input string, including empty or
 * pathological, returns a string.
 */
export function normalizeCommand(cmd: string): string {
  let result = cmd.normalize("NFKC");
  result = result.replace(NULL_RE, "");
  result = result.replace(LINE_CONT_RE, "");
  result = result.replace(CSI_RE, "");
  result = result.replace(OSC_RE, "");
  return result;
}