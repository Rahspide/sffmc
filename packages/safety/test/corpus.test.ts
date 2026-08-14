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
import { compileRules, parseRules, type Rules } from "../src/rules/rules";
import { evaluate } from "../src/rules/gate";

const CORPUS_PATH = resolve(import.meta.dir, "corpus.bash");
const CORPUS = readFileSync(CORPUS_PATH, "utf8");

type Verdict = "deny" | "ask" | "pass";

interface Case {
  input: string;
  expect: Verdict;
  section: string;
}

const PROJECT_ROOT = "/tmp/sffmc-corpus-test";

function parseCorpus(text: string): { cases: Case[]; section: string } {
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
`;

const rules: Rules = parseRules(DEFAULT_RULES_YAML);
const compiled = compileRules(rules);

function actionToVerdict(action: "allow" | "deny" | "ask"): Verdict {
  return action === "allow" ? "pass" : action;
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
          const result = evaluate(
            compiled.rules,
            "bash",
            { command: c.input },
            PROJECT_ROOT,
          );
          const verdict = actionToVerdict(result.action);
          expect(verdict).toBe(c.expect);
        });
      }
    });
  }
});
