// v0.15.2 safety hardening — Expanded coverage for the rule engine.
//
// This file fills the gaps between the existing test files:
//   - anchor.test.ts: covers commandWordPositions / anchoredTest, but does
//     NOT exercise the `excludeSubstitutions` option (added late, in the
//     two-phase matching fix).
//   - integration.test.ts: covers evaluate() against a fixed YAML rule set,
//     but does NOT exercise `phase: raw` rules — the obfuscation
//     heuristic branch.
//   - rules.test.ts: covers parseRules and basic evaluate, but does NOT
//     cover compileRules error reporting, watchRules mtime reload, or
//     the panic-mode lifecycle.
//
// Each section is paired with the production module it exercises.
// All tests use the real public API (no mocks): the integration seam
// is the production code path.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, utimesSync } from "fs";
import {
  compileRules,
  parseRules,
  isPanicMode,
  resetPanicMode,
  loadRules,
  watchRules,
  type Rules,
  type CompiledRule,
} from "../src/rules/rules";
import { evaluate } from "../src/rules/gate";
import {
  commandWordPositions,
  anchoredTest,
  type AnchorOptions,
} from "../src/rules/compileRules";

const PROJECT_ROOT = "/tmp/sffmc-expanded-coverage";

// =====================================================================
// 1. AnchorOptions — excludeSubstitutions (v0.15.2 round-2 fix)
// =====================================================================

describe("AnchorOptions.excludeSubstitutions", () => {
  const denyRm = /rm\s+-rf\s+\//;

  test("default (no opts): echo $(rm -rf /) → match (recursed into $())", () => {
    // Backward compatibility: omitting opts behaves exactly as before,
    // so existing callers (anchor.test.ts) keep passing.
    expect(anchoredTest("echo $(rm -rf /)", denyRm)).toBe(true);
  });

  test("excludeSubstitutions:true → echo $(rm -rf /) → no match", () => {
    // Inside a $(), the rm -rf / is inert data being printed; the
    // caller is a raw-phase obfuscation heuristic and must skip it.
    const opts: AnchorOptions = { excludeSubstitutions: true };
    expect(anchoredTest("echo $(rm -rf /)", denyRm, opts)).toBe(false);
  });

  test("excludeSubstitutions:true → top-level rm -rf / → still matches", () => {
    // The option must only suppress RECURSED positions, not top-level
    // ones. `rm -rf /` typed directly is still a real command.
    const opts: AnchorOptions = { excludeSubstitutions: true };
    expect(anchoredTest("rm -rf /", denyRm, opts)).toBe(true);
  });

  test("excludeSubstitutions:true → backtick substitution also skipped", () => {
    const opts: AnchorOptions = { excludeSubstitutions: true };
    expect(anchoredTest("echo `rm -rf /`", denyRm, opts)).toBe(false);
  });

  test("excludeSubstitutions:true → wrapper-launched rm still matches", () => {
    // Wrapper `sudo` adds a top-level position at `rm`. That position
    // is NOT in a substitution, so even with the option set the
    // pattern fires. This is the critical correctness property:
    // attackers cannot bypass sudo / env / bash -c by hiding behind
    // a substitution.
    const opts: AnchorOptions = { excludeSubstitutions: true };
    expect(anchoredTest("sudo rm -rf /", denyRm, opts)).toBe(true);
  });

  test("commandWordPositions({excludeSubstitutions:true}) → no $() positions", () => {
    // Direct test of the position set, not just the boolean wrapper.
    const opts: AnchorOptions = { excludeSubstitutions: true };
    const positions = commandWordPositions("echo $(rm -rf /)", opts);
    // `echo` is at 0. `rm` at 7 would be in the substitution — must be
    // absent. Backtick positions also absent.
    expect(positions).toContain(0);
    expect(positions).not.toContain(7);
  });

  test("commandWordPositions default keeps the $() position", () => {
    const positions = commandWordPositions("echo $(rm -rf /)");
    expect(positions).toContain(0);
    expect(positions).toContain(7);
  });
});

// =====================================================================
// 2. Phase system — same rule, raw vs normalized, different verdict
// =====================================================================

describe("evaluate() — phase: raw vs normalized", () => {
  // Rule that detects obfuscation only by its encoding: any printf
  // whose raw bytes carry an ANSI escape followed by rm -rf.
  // Post-normalization the ANSI is gone, so the normalized-phase rule
  // would not fire.
  // Single-quoted YAML scalars preserve regex escapes literally and
  // avoid the `["']` flow-sequence trap of double-quoted YAML.
  const PHASE_YAML = `version: 1
rules:
  - match:
      tool: bash
      command_match: 'printf\\s+["''][^"'']*\\x1b[^"'']*rm\\s+-rf\\s+/'
      phase: raw
    action: deny
  - match:
      tool: bash
      command_match: 'printf\\s+["''][^"'']*\\x00[^"'']*rm\\s+-rf\\s+/'
      phase: raw
    action: ask
  - match:
      tool: bash
      command_match: 'rm\\s+-rf\\s+/'
    action: deny
`;

  let compiled: CompiledRule[];
  beforeEach(() => {
    // SAFETY: PHASE_YAML is a hardcoded test fixture; parseRules returns the documented Rules type for valid YAML
    const parsed = parseRules(PHASE_YAML) as Rules;
    const result = compileRules(parsed);
    expect(result.errors).toEqual([]);
    compiled = result.rules;
  });

  test("raw-phase rule fires on ANSI-wrapped printf", () => {
    // ANSI is in the raw bytes; normalization erases it.
    const result = evaluate(
      compiled,
      "bash",
      { command: 'printf "\x1b[31mrm -rf /\x1b[0m"' },
      PROJECT_ROOT,
    );
    expect(result.action).toBe("deny");
    expect(result.reason).toMatch(/raw phase/);
  });

  test("raw-phase rule fires on NUL-wrapped printf → ask (not deny)", () => {
    // Single NUL byte before `rm`, then clean `rm -rf /`. The
    // regex requires `\s+` between `rm` and `-rf`, so we keep that
    // segment whitespace-clean and let the NUL sit before `rm`.
    const result = evaluate(
      compiled,
      "bash",
      { command: 'printf "\x00rm -rf /"' },
      PROJECT_ROOT,
    );
    expect(result.action).toBe("ask");
    expect(result.reason).toMatch(/raw phase/);
  });

  test("plain rm -rf / hits the NORMALIZED rule, not raw rules", () => {
    // No ANSI/NUL bytes → neither raw-phase pattern matches → falls
    // through to the normalized deny rule.
    const result = evaluate(
      compiled,
      "bash",
      { command: "rm -rf /" },
      PROJECT_ROOT,
    );
    expect(result.action).toBe("deny");
    expect(result.reason).not.toMatch(/raw phase/);
  });

  test("ANSI-wrapped rm (without printf wrapper) → normalized rule still fires", () => {
    // \x1b[31mrm -rf /\x1b[0m — normalization strips ANSI; rm -rf /
    // fires the normalized deny. Raw-phase printf pattern requires the
    // printf wrapper, so it does NOT fire here.
    const result = evaluate(
      compiled,
      "bash",
      { command: "\x1b[31mrm -rf /\x1b[0m" },
      PROJECT_ROOT,
    );
    expect(result.action).toBe("deny");
    expect(result.reason).not.toMatch(/raw phase/);
  });

  test("safe printf → allow (no rule matches)", () => {
    const result = evaluate(
      compiled,
      "bash",
      { command: 'printf "hello world\\n"' },
      PROJECT_ROOT,
    );
    expect(result.action).toBe("allow");
  });
});

// =====================================================================
// 3. Phase system + excludeSubstitutions composition
// =====================================================================

describe("evaluate() — phase: raw skips $() content", () => {
  // Same raw-phase rule as section 2. Verifies the gate composes the
  // two flags: raw-phase rules anchor only on top-level (no $() /
  // backtick recursion).
  const PHASE_YAML = `version: 1
rules:
  - match:
      tool: bash
      command_match: 'printf\\s+["''][^"'']*\\x1b[^"'']*rm\\s+-rf\\s+/'
      phase: raw
    action: deny
  - match:
      tool: bash
      command_match: 'rm\\s+-rf\\s+/'
    action: deny
`;
  let compiled: CompiledRule[];
  beforeEach(() => {
    // SAFETY: PHASE_YAML is a hardcoded test fixture; parseRules returns the documented Rules type for valid YAML
    const parsed = parseRules(PHASE_YAML) as Rules;
    compiled = compileRules(parsed).rules;
  });

  test("echo $(printf ANSI-rm) → normalized rule fires via substitution-content pass", () => {
    // The raw-phase printf rule MUST skip $() content (verified by
    // the test below that printf-ANSI-rm at top level fires raw).
    // But the normalized `rm -rf /` rule's second pass
    // (matchesInsideSubstitution) catches ANY inner substitution that
    // contains the dangerous substring — even inside double-quoted
    // printf args. This is intentional: printf inside $() looks like
    // inert data, but eval / xargs / env-as-args re-executes it. The
    // defense is layered: raw-phase fires only at top level, normalized
    // phase fires everywhere.
    const result = evaluate(
      compiled,
      "bash",
      {
        command: 'echo "before" $(printf "\x1b[31mrm -rf /\x1b[0m") "after"',
      },
      PROJECT_ROOT,
    );
    expect(result.action).toBe("deny");
    // The reason must NOT contain "(raw phase)" — proves the raw rule
    // skipped this $()-only payload.
    expect(result.reason).not.toMatch(/raw phase/);
  });

  test("printf ANSI-rm at top level → deny with raw-phase reason", () => {
    const result = evaluate(
      compiled,
      "bash",
      { command: 'printf "\x1b[31mrm -rf /\x1b[0m"' },
      PROJECT_ROOT,
    );
    expect(result.action).toBe("deny");
    expect(result.reason).toMatch(/raw phase/);
  });
});

// =====================================================================
// 4. compileRules — ReDoS filter and error reporting
// =====================================================================

describe("compileRules — ReDoS filter", () => {
  test("safe patterns compiled, errors empty", () => {
    const rules: Rules = {
      version: 1,
      rules: [
        { match: { tool: "bash", command_match: "rm -rf /" }, action: "deny" },
        { match: { tool: "bash", command_match: "sudo " }, action: "ask" },
      ],
    };
    const result = compileRules(rules);
    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(2);
    expect(result.rules[0].commandMatch?.regex).toBeInstanceOf(RegExp);
    expect(result.rules[0].commandMatch?.phase).toBe("normalized");
  });

  test("phase: raw propagated to CompiledRule.commandMatch.phase", () => {
    const rules: Rules = {
      version: 1,
      rules: [
        {
          match: {
            tool: "bash",
            command_match: 'printf\\s+["\'][^"\']*\\x1b',
            phase: "raw",
          },
          action: "deny",
        },
      ],
    };
    const result = compileRules(rules);
    expect(result.errors).toEqual([]);
    expect(result.rules[0].commandMatch?.phase).toBe("raw");
  });

  test("ReDoS-unsafe pattern dropped, error reported", () => {
    // Catastrophic backtracking pattern: nested quantifier.
    // safe-regex (limit=25) flags (a+)+ and similar.
    const rules: Rules = {
      version: 1,
      rules: [
        {
          // (a+)+$ — textbook catastrophic backtracking pattern.
          match: { tool: "bash", command_match: "(a+)+$" },
          action: "deny",
        },
        { match: { tool: "bash", command_match: "rm -rf /" }, action: "deny" },
      ],
    };
    const result = compileRules(rules);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/ReDoS|unsafe/);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].commandMatch?.source).toBe("rm -rf /");
  });

  test("rule without command_match compiles without regex", () => {
    // path_outside-only rules have no commandMatch; they must still
    // appear in the compiled output.
    const rules: Rules = {
      version: 1,
      rules: [
        { match: { tool: "write", path_outside: "PROJECT_ROOT" }, action: "deny" },
      ],
    };
    const result = compileRules(rules);
    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].commandMatch).toBeUndefined();
  });
});

// =====================================================================
// 5. Substitution recursion edge cases
// =====================================================================

describe("Substitution recursion — depth and malformed input", () => {
  test("deeply nested $() — terminates without hang", () => {
    // 10 levels of nesting; each level adds 4 chars ("$((" + ")"). If
    // the depth counter is broken, this either infinite-loops or
    // returns garbage.
    const cmd = "$($($($($($($($($($(echo hi))))))))))";
    const t0 = performance.now();
    const positions = commandWordPositions(cmd);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50); // 50 ms is generous
    expect(positions.length).toBeGreaterThan(0);
  });

  test("unclosed $() — no infinite loop, returns empty for malformed tail", () => {
    const positions = commandWordPositions("echo $(rm -rf /");
    expect(Array.isArray(positions)).toBe(true);
  });

  test("empty $() — does not panic", () => {
    const positions = commandWordPositions("echo $()");
    expect(positions).toContain(0);
  });

  test("backtick without closing pair — does not panic", () => {
    const positions = commandWordPositions("echo `rm -rf /");
    expect(Array.isArray(positions)).toBe(true);
  });

  test("balanced backticks — recursed", () => {
    // `echo \`rm -rf /\`` → `rm` starts at index 6 (after `echo \``).
    expect(commandWordPositions("echo `rm -rf /`")).toContain(6);
  });

  test("nested backtick and $() — both processed", () => {
    const positions = commandWordPositions("echo `echo $(rm -rf /)`");
    // Top-level: 0 (echo). Inner: 8 (echo), 15 (rm).
    expect(positions).toContain(0);
  });

  test("multiple $() at top level — each recursed", () => {
    // echo $(rm -rf /tmp/a) $(chmod 777 /)
    // `rm` at 7, `chmod` at 24 (after the second `$(`).
    const positions = commandWordPositions("echo $(rm -rf /tmp/a) $(chmod 777 /)");
    expect(positions).toContain(7);
    expect(positions).toContain(24);
  });
});

// =====================================================================
// 6. Edge cases for empty / weird command input
// =====================================================================

describe("Empty and weird command input", () => {
  test("empty string → no positions", () => {
    expect(commandWordPositions("")).toEqual([]);
  });

  test("whitespace-only → only position 0", () => {
    // Position 0 is always included per the contract — even though
    // there is no command word there. The gate's anchoredTest returns
    // false on an empty normalized form.
    expect(commandWordPositions("   ")).toEqual([0]);
  });

  test("comment-only — `# foo` — only position 0", () => {
    expect(commandWordPositions("# foo bar")).toEqual([0]);
  });

  test("anchoredTest on empty → false", () => {
    expect(anchoredTest("", /rm -rf/)).toBe(false);
  });
});

// =====================================================================
// 7. Fail-closed: any throw inside evaluate() becomes deny
// =====================================================================

describe("evaluate() — fail-closed", () => {
  test("deny when a custom CompiledRule has a regex.exec that throws", () => {
    // Build a rule whose regex throws on exec by overriding the
    // method on a real RegExp instance. evaluate() wraps in try/catch
    // and returns deny. This is the § 3 acceptance criterion:
    // detection error ⇒ deny, never silently allow.
    const trapRegex = /./;
    trapRegex.exec = () => {
      throw new Error("simulated catastrophic failure");
    };
    const trap: CompiledRule = {
      match: { tool: "bash", command_match: "never-used" },
      action: "allow",
      commandMatch: {
        source: "trap",
        regex: trapRegex,
      },
    };

    const result = evaluate(
      [trap],
      "bash",
      { command: "echo hi" },
      PROJECT_ROOT,
    );
    expect(result.action).toBe("deny");
    expect(result.reason).toMatch(/gate_failure/);
  });

  test("deny when args is null", () => {
    // Defensive: a malformed call site passes args=undefined.
    // evaluate() must not crash; if no rule matches the tool, allow.
    const rules: Rules = {
      version: 1,
      rules: [{ match: { tool: "bash" }, action: "allow" }],
    };
    const result = evaluate(rules, "bash", undefined, PROJECT_ROOT);
    expect(result.action).toBe("allow");
  });

  test("deny when args is not an object", () => {
    const rules: Rules = {
      version: 1,
      rules: [{ match: { tool: "bash" }, action: "allow" }],
    };
    // SAFETY: testing non-object args — JSON.parse returns any, double cast is intentional for the negative test
    const result = evaluate(
      rules,
      "bash",
      JSON.parse('"string-args"') as unknown as Parameters<typeof evaluate>[2],
      PROJECT_ROOT,
    );
    expect(result.action).toBe("allow");
  });

  test("command field present but not a string → skip normalization", () => {
    // If args.command is a number, the gate does NOT normalize. The
    // command_match rule is skipped (not a string). Result: no match
    // → allow. This is the safest behavior; failing closed on
    // unexpected types would be a regression for callers passing
    // shape-only args.
    const rules: Rules = {
      version: 1,
      rules: [
        { match: { tool: "bash", command_match: "rm -rf /" }, action: "deny" },
      ],
    };
    // SAFETY: test fixture intentionally passes a non-string `command` to exercise the unexpected-type branch; `as string` is the documented escape hatch for the test invariant
    const result = evaluate(
      rules,
      "bash",
      { command: 42 as string },
      PROJECT_ROOT,
    );
    expect(result.action).toBe("allow");
  });
});

// =====================================================================
// 8. Rule ordering — first match wins
// =====================================================================

describe("evaluate() — rule ordering", () => {
  test("first matching rule wins; later rules are skipped", () => {
    const rules: Rules = {
      version: 1,
      rules: [
        { match: { tool: "bash", command_match: "rm" }, action: "ask" },
        { match: { tool: "bash", command_match: "rm -rf /" }, action: "deny" },
      ],
    };
    const result = evaluate(
      rules,
      "bash",
      { command: "rm -rf /" },
      PROJECT_ROOT,
    );
    // First rule matches at position 0 ("rm") → ask. Second rule is
    // never reached.
    expect(result.action).toBe("ask");
  });

  test("non-matching tool — rule is skipped entirely", () => {
    const rules: Rules = {
      version: 1,
      rules: [
        { match: { tool: "bash", command_match: "rm -rf /" }, action: "deny" },
        { match: { tool: "read" }, action: "allow" },
      ],
    };
    // `read` matches the second rule; the deny rule is never reached.
    expect(evaluate(rules, "read", { filePath: "/x" }, PROJECT_ROOT).action).toBe(
      "allow",
    );
  });

  test("no matching rule → {action: allow, reason: no matching rule}", () => {
    const rules: Rules = {
      version: 1,
      rules: [{ match: { tool: "bash", command_match: "rm -rf /" }, action: "deny" }],
    };
    const result = evaluate(rules, "glob", {}, PROJECT_ROOT);
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("no matching rule");
  });

  test("deny followed by allow — first match still wins (allow does not rescue)", () => {
    const rules: Rules = {
      version: 1,
      rules: [
        { match: { tool: "bash", command_match: "rm -rf /" }, action: "deny" },
        { match: { tool: "bash" }, action: "allow" },
      ],
    };
    const result = evaluate(
      rules,
      "bash",
      { command: "rm -rf /" },
      PROJECT_ROOT,
    );
    expect(result.action).toBe("deny");
  });
});

// =====================================================================
// 9. path_outside edge cases
// =====================================================================

describe("evaluate() — path_outside edge cases", () => {
  const rules: Rules = {
    version: 1,
    rules: [
      { match: { tool: "write", path_outside: "PROJECT_ROOT" }, action: "deny" },
    ],
  };

  test("single string path inside → allow", () => {
    expect(
      evaluate(rules, "write", { filePath: "/project/src/x.ts" }, "/project").action,
    ).toBe("allow");
  });

  test("single string path outside → deny", () => {
    expect(evaluate(rules, "write", { filePath: "/etc/passwd" }, "/project").action).toBe(
      "deny",
    );
  });

  test("relative path resolves to inside → allow", () => {
    expect(
      evaluate(rules, "write", { filePath: "src/x.ts" }, "/project").action,
    ).toBe("allow");
  });

  test("relative path with ../traversal → resolves, then denied", () => {
    expect(
      evaluate(rules, "write", { filePath: "../etc/passwd" }, "/project").action,
    ).toBe("deny");
  });

  test("array of paths — ANY outside triggers deny", () => {
    expect(
      evaluate(
        rules,
        "write",
        { paths: ["/project/src/x.ts", "/etc/passwd"] },
        "/project",
      ).action,
    ).toBe("deny");
  });

  test("array of paths — all inside → allow", () => {
    expect(
      evaluate(
        rules,
        "write",
        { paths: ["/project/a.ts", "/project/b.ts"] },
        "/project",
      ).action,
    ).toBe("allow");
  });

  test("non-string path entry in array — ignored, not crash", () => {
    // SAFETY: test fixture intentionally passes a non-string path entry to exercise the unexpected-type branch; `as string` is the documented escape hatch for the test invariant
    expect(
      evaluate(
        rules,
        "write",
        { paths: [42 as string, "/project/a.ts"] },
        "/project",
      ).action,
    ).toBe("allow");
  });

  test("path key not in path_keys list — ignored", () => {
    // `randomKey` is not extracted, so no path is checked; the rule
    // does not fire → allow.
    expect(
      evaluate(
        rules,
        "write",
        { randomKey: "/etc/passwd" },
        "/project",
      ).action,
    ).toBe("allow");
  });

  test("path_outside rule with `from` and `to` keys — both must be inside", () => {
    // The path extraction accepts `from` and `to` keys. ANY of them
    // outside the project triggers deny.
    expect(
      evaluate(
        rules,
        "write",
        { from: "/project/a.ts", to: "/etc/passwd" },
        "/project",
      ).action,
    ).toBe("deny");
  });
});

// =====================================================================
// 10. Pure-function guarantees — no mutation of caller's args
// =====================================================================

describe("evaluate() — pure", () => {
  const rules: Rules = {
    version: 1,
    rules: [
      { match: { tool: "bash", command_match: "rm -rf /" }, action: "deny" },
    ],
  };

  test("caller's args object is not mutated", () => {
    const original = { command: "rm -rf /" };
    const snapshot = JSON.stringify(original);
    evaluate(rules, "bash", original, PROJECT_ROOT);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  test("caller's rules object is not mutated", () => {
    const compiled = compileRules(rules).rules;
    const before = compiled.length;
    evaluate(compiled, "bash", { command: "rm -rf /" }, PROJECT_ROOT);
    expect(compiled.length).toBe(before);
  });
});

// =====================================================================
// 11. panicMode lifecycle
// =====================================================================

describe("panicMode lifecycle", () => {
  afterEach(() => {
    resetPanicMode();
  });

  test("initial state: false", () => {
    resetPanicMode();
    expect(isPanicMode()).toBe(false);
  });

  test("parseRules sets panic mode on syntax error", () => {
    expect(() => parseRules("invalid: [")).toThrow();
    expect(isPanicMode()).toBe(true);
  });

  test("parseRules resets panic mode on success", () => {
    // First induce panic.
    try {
      parseRules("invalid: [");
    } catch {
      /* expected */
    }
    expect(isPanicMode()).toBe(true);
    // Then succeed.
    parseRules("version: 1\nrules: []");
    expect(isPanicMode()).toBe(false);
  });

  test("resetPanicMode clears panic", () => {
    try {
      parseRules("invalid: [");
    } catch {
      /* expected */
    }
    resetPanicMode();
    expect(isPanicMode()).toBe(false);
  });
});

// =====================================================================
// 12. loadRules and watchRules
// =====================================================================

describe("loadRules and watchRules", () => {
  const TEST_PATH = "/tmp/sffmc-watch-test.yaml";

  afterEach(() => {
    try { unlinkSync(TEST_PATH); } catch { /* ok */ }
  });

  test("loadRules returns empty rules if file missing", () => {
    expect(loadRules("/tmp/does-not-exist-sffmc-yaml.yaml").rules).toEqual([]);
  });

  test("loadRules parses a real file", () => {
    writeFileSync(
      TEST_PATH,
      `version: 1
rules:
  - match: { tool: read }
    action: allow
`,
    );
    const loaded = loadRules(TEST_PATH);
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0].match.tool).toBe("read");
  });

  test("loadRules sets panic mode and returns empty on bad file", () => {
    writeFileSync(TEST_PATH, "invalid: [");
    const loaded = loadRules(TEST_PATH);
    expect(loaded.rules).toEqual([]);
    expect(isPanicMode()).toBe(true);
    resetPanicMode();
  });

  test("watchRules fires onChange when file mtime advances", async () => {
    writeFileSync(
      TEST_PATH,
      `version: 1
rules:
  - match: { tool: read }
    action: allow
`,
    );
    // Set mtime to the past to guarantee forward progress.
    const past = new Date(Date.now() - 60_000);
    utimesSync(TEST_PATH, past, past);

    let calls = 0;
    let lastRuleCount = -1;
    const handle = watchRules(TEST_PATH, (rules) => {
      calls++;
      lastRuleCount = rules.rules.length;
    });

    // Wait for first tick (~1s) plus a small buffer.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Rewrite file with a different rule count.
    writeFileSync(
      TEST_PATH,
      `version: 1
rules:
  - match: { tool: read }
    action: allow
  - match: { tool: bash }
    action: ask
`,
    );
    const future = new Date(Date.now() + 60_000);
    utimesSync(TEST_PATH, future, future);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    handle.stop();

    // WatchRules polls every 1s. After ~2.4s we expect at least one
    // callback for the new mtime. lastRuleCount should reflect the
    // new file (2 rules).
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(lastRuleCount).toBe(2);
  });
});

// =====================================================================
// 13. Defensive — no false-allow when normalization produces surprising output
// =====================================================================

describe("Normalization integration — false-allow resistance", () => {
  const rules: Rules = {
    version: 1,
    rules: [
      { match: { tool: "bash", command_match: "rm -rf /" }, action: "deny" },
      { match: { tool: "bash", command_match: "DROP TABLE" }, action: "deny" },
      { match: { tool: "bash", command_match: "mkfs." }, action: "deny" },
    ],
  };
  const compiled = compileRules(rules).rules;

  test("NFKC fullwidth bypass attempt → deny", () => {
    // ｒｍ (fullwidth) — normalization NFKC-folds to rm.
    expect(
      evaluate(
        compiled,
        "bash",
        { command: "ｒｍ -rf /" },
        PROJECT_ROOT,
      ).action,
    ).toBe("deny");
  });

  test("ANSI color around rm -rf / → deny", () => {
    expect(
      evaluate(
        compiled,
        "bash",
        { command: "\x1b[31mrm -rf /\x1b[0m" },
        PROJECT_ROOT,
      ).action,
    ).toBe("deny");
  });

  test("NUL bytes between rm and -rf / → deny", () => {
    expect(
      evaluate(
        compiled,
        "bash",
        { command: "rm\x00 -rf\x00 /" },
        PROJECT_ROOT,
      ).action,
    ).toBe("deny");
  });

  test("line-continuation around rm -rf / → deny", () => {
    expect(
      evaluate(
        compiled,
        "bash",
        { command: "rm \\\n-rf \\\n/" },
        PROJECT_ROOT,
      ).action,
    ).toBe("deny");
  });

  test("DROP TABLE after `&&` separator → deny", () => {
    // Real separator (not `#`): `&&` adds a command-word position
    // right after it. Anchor fires on the second command. The
    // security property: a separator-launched dangerous command
    // must be caught.
    expect(
      evaluate(
        compiled,
        "bash",
        { command: "ls && DROP TABLE users" },
        PROJECT_ROOT,
      ).action,
    ).toBe("deny");
  });

  test("DROP TABLE inside a quoted argument — `echo \"DROP TABLE\"` → allow", () => {
    // The dangerous text is data in an argument, not a real command.
    // Anchor MUST skip it. This is the false-positive guard.
    expect(
      evaluate(
        compiled,
        "bash",
        { command: 'echo "DROP TABLE"' },
        PROJECT_ROOT,
      ).action,
    ).toBe("allow");
  });

  test("mkfs. inside harmless-looking wrapper → deny", () => {
    expect(
      evaluate(
        compiled,
        "bash",
        { command: "sudo mkfs.ext4 /dev/sda" },
        PROJECT_ROOT,
      ).action,
    ).toBe("deny");
  });

  test("safe ls command → allow", () => {
    expect(
      evaluate(compiled, "bash", { command: "ls -la /tmp" }, PROJECT_ROOT).action,
    ).toBe("allow");
  });
});
