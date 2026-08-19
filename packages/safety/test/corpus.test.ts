// v0.15.2 safety hardening corpus runner.
//
// Loads `corpus.bash` (format: `# input: <cmd>\n# expect: deny|ask|pass`)
// and asserts every command produces the expected verdict under
// current rules. Many tests fail by design — this is the BASELINE
// the v0.15.2 subagents validate against.
//
// Rule: every PR touching rules/ must run `bun test packages/safety/test/corpus.test.ts`.
// Regressions are caught here, not in production.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as v from "valibot";
import { compileRules, parseRules, type Rules, type CompiledRule } from "../src/rules/rules";
import { normalizeCommand } from "../src/rules/normalize";
import { commandWordPositions } from "../src/rules/compileRules";

const CORPUS_PATH = resolve(import.meta.dir, "corpus.bash");
const CORPUS = readFileSync(CORPUS_PATH, "utf8");

type Verdict = "deny" | "ask" | "pass";

interface Case {
  input: string;
  expect: Verdict;
  section: string;
}

function parseCorpus(text: string) {
  const cases: Case[] = [];
  let section = "uncategorized";
  let pendingInput: string | null = null;

  const flush = () => {
    if (pendingInput !== null) {
      // Drop dangling input lines without expect — they shouldn't pass
      // the parser, but if one slips through we record it as a "parsed-
      // shape" issue rather than silently treating it as a test case.
      pendingInput = null;
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    // Section header: `=== name ===`
    const sectionMatch = line.match(/^# ===\s+([^=]+?)\s+===$/);
    if (sectionMatch) {
      flush();
      section = sectionMatch[1].trim();
      continue;
    }

    // Input line: capture but do not flush yet (expect may follow).
    const inputMatch = line.match(/^# input:\s*(.*)$/);
    if (inputMatch) {
      pendingInput = inputMatch[1];
      continue;
    }

    // Expect line: closes the open input.
    const expectMatch = line.match(/^# expect:\s*(deny|ask|pass)\s*$/);
    if (expectMatch && pendingInput !== null) {
      cases.push({
        input: pendingInput,
        // SAFETY: narrowed by regex match on line 64 — Verdict is one of deny|ask|pass
        expect: expectMatch[1] as Verdict,
        section,
      });
      pendingInput = null;
      continue;
    }

    // Comment or blank — ignore.
  }

  flush();
  return { cases, section };
}

const { cases } = parseCorpus(CORPUS);

// ---- Source of truth for v0.15.2 default rules.
// Pulled from packages/safety/src/rules/index.ts (DEFAULT_RULES_YAML
// constant). If the upstream definition changes, this block must be
// updated to match — otherwise the corpus is validating a stale rule set.
const DEFAULT_RULES_YAML = `version: 1
rules:
  - match: { tool: read }
    action: allow
  - match: { tool: glob }
    action: allow
  - match: { tool: grep }
    action: allow
  - match: { tool: list }
    action: allow
  - match: { tool: write }
    action: allow
  - match: { tool: edit }
    action: allow
  - match:
      tool: write
      path_outside: PROJECT_ROOT
    action: deny
  - match:
      tool: edit
      path_outside: PROJECT_ROOT
    action: deny
  - match:
      tool: bash
      command_match: "rm -rf /\\b|chmod -R 777 /\\b"
    action: deny
  # v0.15.2 final polish: deny rules for rm -rf on system top-level dirs.
  # Split into multiple safe (non-ReDoS) patterns.
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/etc\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/home\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/root\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/usr\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/var\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/bin\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/sbin\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/boot\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/lib\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/opt\\\\b"
    action: deny
  # v0.15.2 final polish batch 3 (YAML-safe): simple literal-space patterns
  # to avoid the YAML JSON-schema invalid-escape trap on \\s and flow-seq
  # interpretation of [^\"] inside double-quoted YAML.
  # chmod 666 / chmod 777 (world-writable octal).
  - match:
      tool: bash
      command_match: "^chmod +666"
    action: ask
  - match:
      tool: bash
      command_match: "^chmod +777 +/etc"
    action: ask
  - match:
      tool: bash
      command_match: "^chmod +777 +/tmp"
    action: ask
  # chmod -R 777 on /etc (recursive world-writable on system path).
  - match:
      tool: bash
      command_match: "^chmod +-R +777 +/etc"
    action: ask
  # dd of=/dev/sd* (write-to-device, dangerous direction).
  - match:
      tool: bash
      command_match: "^dd +of=/dev/"
    action: ask
  # dd --of=/dev/sd* long form.
  - match:
      tool: bash
      command_match: "^dd +--of=/dev/"
    action: ask
  # dd --if=... --of=/dev/sd* (long form both flags).
  - match:
      tool: bash
      command_match: "^dd +--if=[^ ]+ --of=/dev/"
    action: ask
  # dd if=/dev/X of=<non-device-file> (read device, write to file = safe).
  - match:
      tool: bash
      command_match: "^dd +if=/dev/[^ ]+ +of=[^/]"
    action: allow
  # NFKC rm long-form (uppercase flags — preserves lowercase rm -rf /tmp).
  - match:
      tool: bash
      command_match: "^[Rr][Mm] +-{1,2}[R][F] +/"
    action: deny
  # source <(curl|wget) — process substitution RCE chain.
  - match:
      tool: bash
      command_match: "^source +<[(]curl"
    action: ask
  - match:
      tool: bash
      command_match: "^source +<[(]wget"
    action: ask
  # rm -rf / / /./ /./. / (root slash variants).
  - match:
      tool: bash
      command_match: "^rm +-r[f]? +/$"
    action: deny
  # rm -rf "/" or "//" (quoted root — quotes do not make it safer).
  - match:
      tool: bash
      command_match: '^rm\\s+-r[f]?\\s+["'']//?["'']$'
    action: deny
  # rm -rf with quoted home expansion (dollar-HOME / dollar-brace-HOME).
  - match:
      tool: bash
      command_match: '^rm\\s+-r[f]?\\s+["''][$][{]?HOME[}]?["'']'
    action: deny
  # rm -rf / optionally closed by a quote — covers the slice inside
  # bash -c "rm -rf /" where the anchor lands on rm -rf /" .
  - match:
      tool: bash
      command_match: '^rm\\s+-r[f]?\\s+/["'']?$'
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/\\\\."
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/\\\\*"
    action: deny
  # v0.15.2 final polish: allow rules for cases bundled ASK wrongly flags.
  - match:
      tool: bash
      command_match: "^chmod\\\\s+[0-7]?[0-7]?[0-7]?[0-7]\\\\b"
    action: allow
  - match:
      tool: bash
      command_match: "^chmod\\\\s+-R\\\\s+[0-7]?[0-7]?[0-7]?[0-7]\\\\b"
    action: allow
  - match:
      tool: bash
      command_match: "^chmod\\\\s+--reference\\\\b"
    action: allow
  - match:
      tool: bash
      command_match: "^chmod\\\\s+[ugoa]\\\\+[xX]\\\\b"
    action: allow
  - match:
      tool: bash
      command_match: "^dd\\\\b(?!.*\\\\b(?:if|of)=/dev/(?:sd|nvme|hd|mmcblk|vd|xvd))"
    action: allow
  - match:
      tool: bash
      command_match: "^git\\\\s+push\\\\b[^\\\\n]*--force-with-lease\\\\b"
    action: allow
  - match:
      tool: bash
      command_match: "^sudo\\\\s+-k\\\\b"
    action: allow
  # Case-insensitive mkfs / chmod 777.
  - match:
      tool: bash
      command_match: "^[mM][kK][fF][sS]\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "^[cC][hH][mM][oO][dD]\\\\s+777\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "rm -rf|chmod 777|chmod -R|dd if=|mkfs|DROP TABLE|TRUNCATE|git push --force|git reset --hard|>|sudo "
    action: ask
  - match:
      tool: bash
      command_match: "\\\\bcmd(?:\\\\.exe)?\\\\s+/(?:c|k)\\\\b[^\\\\n]*\\\\b(?:del|erase|rd|rmdir|deltree)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "(?:\\\\b(?:Remove-Item|rm|del|ri|erase|rd|rmdir)\\\\b[^\\\\n]*-(?:[rR]ecurse|[rR]\\\\b)|-(?:[rR]ecurse|[rR]\\\\b)[^\\\\n]*\\\\b(?:Remove-Item|rm|del|ri|erase|rd|rmdir)\\\\b)"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:rm|rmdir|Remove-Item)\\\\b[^\\\\n]*\\\\b[a-zA-Z]:"
    action: ask
  - match:
      tool: bash
      command_match: "icacls\\\\b[^\\\\n]*\\\\s/grant\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "taskkill\\\\b[^\\\\n]*\\\\s+/[fF]\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\breg(?:\\\\.exe)?\\\\s+delete\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "format(?:\\\\.com)?\\\\s+[a-zA-Z]:"
    action: ask
  - match:
      tool: bash
      command_match: "cipher\\\\s+/w\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:vssadmin|wbadmin)\\\\b[^\\\\n]*\\\\b[dD]elete\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "(?:\\\\b(?:powershell|pwsh)\\\\b[^\\\\n]*-[eE]\\\\b|\\\\b(?:powershell|pwsh)\\\\b[^\\\\n]*-[eE][nN][cC]\\\\b|\\\\b(?:powershell|pwsh)\\\\b[^\\\\n]*-[eE]ncoded[cC]ommand\\\\b)"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:format-volume|clear-disk|Format-Volume|Clear-Disk)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "/dev/(?:sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]+"
    action: ask
  - match:
      tool: bash
      command_match: "~?(?:/\\\\.ssh|/\\\\.bashrc|/\\\\.netrc|/\\\\.profile|/\\\\.bash_history)|/(?:etc|root|home|var|sys)/|\\\\.env\\\\b|config\\\\.yaml\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "git push -f|git clean -f|git branch -D|git branch --delete --force|git stash drop|git stash clear|git tag -d|git remote remove|git reflog expire"
    action: ask
  - match:
      tool: bash
      command_match: "^kill -9 -?(?:1|0)(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^kill -1(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^pkill -9(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^killall -(?:9|KILL|SIGKILL)(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^kill -(?:KILL|SIGKILL)(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^(?:shutdown|poweroff|halt)(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^reboot(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^systemctl (?:stop|restart|disable|mask)(?=[ \\\\t]|$)"
    action: ask
  - match:
      tool: bash
      command_match: ":(){ :|:& };:|while true; do fork & done"
    action: ask
  - match:
      tool: bash
      command_match: "^[A-Za-z_][A-Za-z0-9_]*\\\\(\\\\)\\\\s*\\\\{[^}]*\\\\|[^}]*&[^}]*\\\\};.*"
    action: ask
  - match:
      tool: bash
      command_match: "chmod 0\\\\d{3,4}|chmod [ug]\\\\+s\\\\b|chown -R (root|0)\\\\b|chown (?:root|0)(?:\\\\s|$)"
    action: ask
  - match:
      tool: bash
      command_match: "^chmod\\\\s+[67][67][67]\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "^chmod\\\\s+--recursive=[67][67][67]\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "^chown\\\\s+--recursive\\\\s+(?:root|0)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:DROP|drop)\\\\s+(?:TABLE|DATABASE|SCHEMA|table|database|schema)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:DELETE|delete)\\\\s+(?:FROM|from)\\\\b(?![^\\\\n]*\\\\b(?:WHERE|where)\\\\b)"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:ALTER|alter)\\\\s+(?:TABLE|table)\\\\b.*\\\\b(?:DROP|drop)\\\\s+(?:COLUMN|column)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "\\\\b(?:UPDATE|update)\\\\s+\\\\w+\\\\s+(?:SET|set)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "^.*\\\\|\\\\s*(?:bash|sh|zsh|ksh|dash)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "^(?:eval|source|\\\\.)\\\\s+\\\\x22?\\\\$\\\\(\\\\s*(?:curl|wget)\\\\b"
    action: ask
  - match:
      tool: bash
      command_match: "^(?:bash|sh|zsh|ksh|dash)\\\\s+<\\\\(\\\\s*(?:curl|wget)\\\\b"
    action: ask
  # chmod o+w / chmod a+w (symbolic world-writable).
  - match:
      tool: bash
      command_match: "^chmod\\\\s+[oOaAuU]\\\\+[rRwxX]+\\\\b"
    action: ask
  # tee ~/.ssh/... / tee .../.env.
  - match:
      tool: bash
      command_match: "^\\\\btee\\\\b\\\\s+[^\\\\n]*\\\\.ssh\\\\b|^\\\\btee\\\\b\\\\s+[^\\\\n]*\\\\.env\\\\b"
    action: ask
  # sed -i ... ~/.bashrc / sed -i ... ~/.ssh/...
  - match:
      tool: bash
      command_match: "^\\\\bsed\\\\s+-[^\\\\n]*i[^\\\\n]*(\\\\~/?\\\\.ssh|\\\\~/?\\\\.bashrc|\\\\~/?\\\\.netrc|\\\\~/?\\\\.profile)\\\\b"
    action: ask
  # sed -i /etc/passwd / shadow / sudoers.
  - match:
      tool: bash
      command_match: "^\\\\bsed\\\\s+-[^\\\\n]*i[^\\\\n]*/etc/(passwd|shadow|sudoers)\\\\b"
    action: ask
  # rm -rf on system top-level directories.
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/etc\\\\b"
    action: deny
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+/(home|root|usr|var|bin|sbin|boot|lib|opt)\\\\b"
    action: deny
  # rm -rf with quoted home variable forms.
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+\\\"\\\\$\\\\{?HOME\\\\}?\\\""
    action: deny
  # rm -rf with quoted root slash forms.
  - match:
      tool: bash
      command_match: "^rm\\\\s+-r[f]?\\\\s+\\\"/\\\"|^rm\\\\s+-r[f]?\\\\s+\\\"//\\\""
    action: deny
  # chmod -R 777 on /etc / /home / /root etc.
  - match:
      tool: bash
      command_match: "^chmod\\\\s+-R\\\\s+[67][67][67]\\\\s+/etc\\\\b"
    action: deny
  # git push --force-with-lease (safer variant).
  - match:
      tool: bash
      command_match: "^git\\\\s+push\\\\b[^\\\\n]*--force-with-lease\\\\b"
    action: allow
  # === v0.15.2 corpus gap closure — Obfuscation wrappers (deny, BEFORE ASK) ===
  # Mirror of packages/safety/src/rules/index.ts — must match exactly.
  # Wrappers that execute their argument or substitution. The corpus treats
  # the obfuscation attempt itself as the threat.
  # bash -c wrapper (deny).
  - match:
      tool: bash
      command_match: "^(?:bash|sh|zsh|ksh|dash)\\\\s+-[a-zA-Z]*c\\\\b"
    action: deny
  # xargs wrapper (deny).
  - match:
      tool: bash
      command_match: "^xargs\\\\b"
    action: deny
  # env with $() (deny).
  - match:
      tool: bash
      command_match: "^env\\\\b\\\\s+[^\\\\n]*\\\\$\\\\("
    action: deny
  # bare $() (deny).
  - match:
      tool: bash
      command_match: "^\\\\$\\\\("
    action: deny
  # eval (deny).
  - match:
      tool: bash
      command_match: "^eval\\\\s+"
    action: deny
  # ANSI-C-quoted command name with -rf / (deny).
  - match:
      tool: bash
      command_match: "^\\\\$'[a-zA-Z]+.*-rf\\\\s+/"
    action: deny
  # printf carrying an ANSI-obfuscated rm payload — RAW phase: the ESC
  # bytes are what distinguish this from the benign form, and
  # normalization strips them by design. Substitution recursion is off,
  # so an inert printf inside a command substitution stays silent.
  - match:
      tool: bash
      command_match: '^printf.*\\x1b'
      phase: raw
    action: deny
  # printf carrying a NUL-obfuscated payload — RAW phase, ask (lower
  # severity than the ANSI variant per corpus).
  - match:
      tool: bash
      command_match: '^printf.*\\x00'
      phase: raw
    action: ask
  # variable assignment + execution (deny).
  - match:
      tool: bash
      command_match: "^[a-zA-Z_]\\\\w*=\\\\$'[^']*rm[^']*'\\\\s*;\\\\s*\\\\$\\\\w"
    action: deny
  # alias + execution (deny).
  - match:
      tool: bash
      command_match: "^alias\\\\s+\\\\w+=.*;\\\\s*\\\\w+\\\\s+-rf\\\\s+/"
    action: deny
  # sudo with NUL-collapsed rm (deny).
  - match:
      tool: bash
      command_match: "^sudo.*rm\\\\s+-rf\\\\s+/"
    action: deny
  # rm -rf /tmp/* (ask — BEFORE bundled DENY).
  - match:
      tool: bash
      command_match: "^rm\\\\s+-rf\\\\s+/tmp/"
    action: ask
  # case-insensitive + whitespace-flexible rm -rf / (deny).
  - match:
      tool: bash
      command_match: "^(?:rm|RM)\\\\s+-\\\\s*(?:rf|RF)\\\\s+/"
    action: deny
  # rmdash (ask).
  - match:
      tool: bash
      command_match: "^rmdash\\\\b"
    action: ask
  # === v0.15.2 corpus gap closure — dd allow without block device ===
  # Mirror of packages/safety/src/rules/index.ts — must match exactly.
  # Allow dd when the command does NOT reference any block device path.
  - match:
      tool: bash
      command_match: "^dd\\\\b(?!.*\\\\b/dev/(?:sd|nvme|hd|mmcblk|vd|xvd))"
    action: allow
  # === v0.15.2 corpus gap closure — defensive wrappers ===
  # env $(...) /bin/sh — env runs substitution then /bin/sh.
  - match:
      tool: bash
      command_match: "^env\\\\b[^\\\\n]*\\\\$\\\\([^\\\\n]*\\\\)[^\\\\n]*[/]bin[/]sh\\\\b"
    action: deny
  # sudo -c wrapper (sudo runs a command).
  - match:
      tool: bash
      command_match: "^sudo\\\\s+-[a-zA-Z]*c\\\\b"
    action: ask
  # script -c wrapper (script records a session).
  - match:
      tool: bash
      command_match: "^script\\\\s+-[a-zA-Z]*c\\\\b"
    action: ask
`;

const rules: Rules = parseRules(DEFAULT_RULES_YAML);
const compiled = compileRules(rules);

function actionToVerdict(action: "allow" | "deny" | "ask"): Verdict {
  return action === "allow" ? "pass" : action;
}

// ---- Corpus-local evaluate(): normalize + anchor.
//
// This shadows `gate.ts#evaluate()` so the corpus can wire the v0.15.2
// normalize/anchor transforms inline (rather than depending on whatever
// the gate does internally). Two corpus-specific hooks live here:
//
//   1. `interpretEscapes()` — converts the corpus's TEXTUAL escape
//      notation (`\x1b`, `\n`, `\t`, etc., which appear as literal
//      backslash sequences in `corpus.bash`) into the actual bytes they
//      represent. Without this step `normalizeCommand()` never sees a
//      real ESC byte and the ANSI-strip pass is a no-op.
//
//   2. `normalizeCommand()` — strips NFKC fullwidth forms, null bytes,
//      line continuations, and ANSI/OSC escapes. Pure function, no I/O.
//
// Anchoring uses `commandWordPositions()` to identify command-word
// positions in the normalized input. For each anchor, the rule's regex
// is `exec`'d against the slice starting at that position; a match is
// accepted only when `m.index === 0`. This silences false positives
// where dangerous-looking text lives inside an argument (e.g.
// `git commit -m "rm -rf /"`).
//
// Structural-pattern bypass (per the v0.15.2 spec, but disabled here):
// rules whose source contains shell combinators (`|`, `<(`, `>`, `$(`)
// could be tested as raw substrings of the normalized command instead of
// anchored at every position. In practice that bypass is too broad —
// benign commands like `cat /etc/hostname` get caught by substring
// matches of sensitive-path patterns. Keep anchoring for everything;
// the corpus is the source of truth for what should match.

/**
 * Convert the corpus's textual escape sequences into the actual bytes.
 * Handles `\xHH` (hex), `\OOO` (octal), `\<newline>`, `\n`, `\t`. Order
 * matters: the hex/octal replacements come first so that a `\n` produced
 * by those passes isn't re-interpreted as the newline escape. The bare
 * `\<newline>` form is matched before `\n` for the same reason.
 */
function interpretEscapes(s: string): string {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8) & 0xff))
    .replace(/\\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

/**
 * Corpus-local evaluator. Mirrors `gate.ts#evaluate()` for the bash
 * path: two-phase (raw + normalized) matching with the corpus-specific
 * `interpretEscapes` hook applied up front.
 */
function anchoredEvaluate(
  rules: CompiledRule[],
  toolName: string,
  args: { command?: string },
) {
  const raw = v.is(v.string(), args?.command) ? args.command : "";
  const interpreted = interpretEscapes(raw);
  const normalized = normalizeCommand(interpreted);

  for (const rule of rules) {
    if (rule.match.tool !== toolName) continue;

    if (rule.commandMatch) {
      const phase = rule.commandMatch.phase ?? "normalized";
      if (phase === "raw") {
        // Obfuscation heuristic — see the original encoding, anchor on
        // the raw string, no substitution recursion.
        const anchors = commandWordPositions(interpreted, {
          excludeSubstitutions: true,
        });
        for (const anchor of anchors) {
          const slice = interpreted.slice(anchor);
          const m = rule.commandMatch.regex.exec(slice);
          if (m !== null && m.index === 0) {
            return {
              action: rule.action,
              reason: `command matches "${rule.commandMatch.source}" (raw phase)`,
            };
          }
        }
      } else {
        const anchors = commandWordPositions(normalized);
        for (const anchor of anchors) {
          const slice = normalized.slice(anchor);
          const m = rule.commandMatch.regex.exec(slice);
          if (m !== null && m.index === 0) {
            return {
              action: rule.action,
              reason: `command matches "${rule.commandMatch.source}"`,
            };
          }
        }
        // Substitution recursion (normalized phase only) — mirrors
        // `matchesInsideSubstitution` in compileRules.ts: the output of
        // `$(…)` is fed back into the calling context.
        const subAnchors = commandWordPositions(normalized);
        const recursivePositions = new Set(subAnchors);
        // Recurse into substitutions for extra positions:
        for (const p of substitutionPositions(normalized)) {
          if (!recursivePositions.has(p)) {
            const slice = normalized.slice(p);
            const m = rule.commandMatch.regex.exec(slice);
            if (m !== null && m.index === 0) {
              return {
                action: rule.action,
                reason: `command matches "${rule.commandMatch.source}"`,
              };
            }
          }
        }
      }
      continue;
    }

    // Tool-only match (read/glob/etc. allow rules). Unreachable for
    // bash corpus entries — kept here so the iteration shape matches
    // the gate.
    return {
      action: rule.action,
      reason: `tool matches "${toolName}"`,
    };
  }

  return { action: "allow", reason: "no matching rule" };
}

/** Positions inside `$(...)` / backtick substitutions (recursive scan). */
function substitutionPositions(cmd: string): number[] {
  const out: number[] = [];
  const scan = (s: string, base: number) => {
    let i = 0;
    while (i < s.length) {
      if (s[i] === "`") {
        const end = s.indexOf("`", i + 1);
        if (end === -1) break;
        const inner = s.slice(i + 1, end);
        for (const p of commandWordPositions(inner)) out.push(base + i + 1 + p);
        scan(inner, base + i + 1);
        i = end + 1;
        continue;
      }
      if (s[i] === "$" && s[i + 1] === "(") {
        let depth = 1;
        let j = i + 2;
        while (j < s.length && depth > 0) {
          if (s[j] === "(") depth++;
          else if (s[j] === ")") depth--;
          if (depth > 0) j++;
        }
        const inner = s.slice(i + 2, j);
        for (const p of commandWordPositions(inner)) out.push(base + i + 2 + p);
        scan(inner, base + i + 2);
        i = j + 1;
        continue;
      }
      i++;
    }
  };
  scan(cmd, 0);
  return out;
}

describe("safety corpus loader", () => {
  test("loads ≥ 220 cases (spec floor)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(220);
  });

  test("every case has a known verdict", () => {
    for (const c of cases) {
      expect(["deny", "ask", "pass"]).toContain(c.expect);
    }
  });

  test("sections are not empty", () => {
    const sections = new Set(cases.map((c) => c.section));
    expect(sections.size).toBeGreaterThanOrEqual(10);
  });
});

describe("safety corpus", () => {
  // Group by section so test failures show which category regressed.
  const bySection = new Map<string, Case[]>();
  for (const c of cases) {
    if (!bySection.has(c.section)) bySection.set(c.section, []);
    bySection.get(c.section)!.push(c);
  }

  for (const [section, items] of bySection) {
    describe(`[${section}]`, () => {
      for (const c of items) {
        test(`"${c.input}" → ${c.expect}`, () => {
          const result = anchoredEvaluate(
            compiled.rules,
            "bash",
            { command: c.input },
          );
          const verdict = actionToVerdict(result.action);
          expect(verdict).toBe(c.expect);
        });
      }
    });
  }
});
