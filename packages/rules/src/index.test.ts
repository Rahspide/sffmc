import { describe, it, expect, afterEach } from "bun:test";
import { parseRules, loadRules, isPanicMode, type Rules } from "./rules";
import { evaluate } from "./gate";
import { writeFileSync, unlinkSync } from "fs";

const TEST_RULES_PATH = "/tmp/sffmc-rules-test.yaml";

describe("parseRules", () => {
  it("parses valid YAML", () => {
    const yaml = `version: 1
rules:
  - match: { tool: read }
    action: allow
  - match:
      tool: bash
      command_match: "rm -rf"
    action: ask
`;
    const rules = parseRules(yaml);
    expect(rules.rules.length).toBe(2);
    expect(rules.rules[0].action).toBe("allow");
    expect(rules.rules[1].match.command_match).toBe("rm -rf");
  });

  it("throws on missing rules array", () => {
    expect(() => parseRules("version: 1\n")).toThrow();
  });

  it("throws on invalid action", () => {
    const yaml = `version: 1
rules:
  - match: { tool: read }
    action: maybe
`;
    expect(() => parseRules(yaml)).toThrow();
  });

  it("throws on missing match.tool", () => {
    const yaml = `version: 1
rules:
  - match: {}
    action: allow
`;
    expect(() => parseRules(yaml)).toThrow();
  });

  it("clears panic mode on successful parse", () => {
    const yaml = `version: 1
rules:
  - match: { tool: read }
    action: allow
`;
    parseRules(yaml);
    expect(isPanicMode()).toBe(false);
  });

  afterEach(() => {
    // Clear panic mode after each parseRules test
    try {
      parseRules(
        "version: 1\nrules:\n  - match: { tool: read }\n    action: allow\n",
      );
    } catch {
      /* ok */
    }
  });

  it("sets panic mode on parse error", () => {
    expect(() => parseRules("invalid: [")).toThrow();
    expect(isPanicMode()).toBe(true);
  });
});

describe("evaluate", () => {
  const rules = parseRules(`version: 1
rules:
  - match: { tool: read }
    action: allow
  - match: { tool: glob }
    action: allow
  - match: { tool: grep }
    action: allow
  - match: { tool: write }
    action: allow
  - match: { tool: edit }
    action: allow
  - match:
      tool: bash
      command_match: "rm -rf /|chmod -R 777 /"
    action: deny
  - match:
      tool: bash
      command_match: "rm -rf|sudo "
    action: ask
`);

  it("allows read", () => {
    const result = evaluate(rules, "read", {}, "/project");
    expect(result.action).toBe("allow");
  });

  it("allows common read tools", () => {
    expect(evaluate(rules, "glob", {}, "/p").action).toBe("allow");
    expect(evaluate(rules, "grep", {}, "/p").action).toBe("allow");
  });

  it("allows unknown tools by default", () => {
    const result = evaluate(rules, "unknown_tool", {}, "/project");
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("no matching rule");
  });

  it("asks for rm -rf (not root)", () => {
    const result = evaluate(
      rules,
      "bash",
      { command: "rm -rf node_modules" },
      "/project",
    );
    expect(result.action).toBe("ask");
  });

  it("denies rm -rf /", () => {
    const result = evaluate(
      rules,
      "bash",
      { command: "rm -rf /" },
      "/project",
    );
    expect(result.action).toBe("deny");
  });

  it("allows safe bash commands", () => {
    const result = evaluate(
      rules,
      "bash",
      { command: "ls -la" },
      "/project",
    );
    expect(result.action).toBe("allow");
  });

  it("asks for sudo commands", () => {
    const result = evaluate(
      rules,
      "bash",
      { command: "sudo systemctl restart nginx" },
      "/project",
    );
    expect(result.action).toBe("ask");
  });

  it("denies catastrophic command with anchored match", () => {
    const rules2 = parseRules(`version: 1
rules:
  - match:
      tool: bash
      command_match: "DROP TABLE|mkfs\\\\.|> /dev/sda"
    action: deny
`);
    const result = evaluate(
      rules2,
      "bash",
      { command: "DROP TABLE users" },
      "/project",
    );
    expect(result.action).toBe("deny");
  });
});

describe("evaluate path_outside", () => {
  const rules = parseRules(`version: 1
rules:
  - match:
      tool: write
      path_outside: PROJECT_ROOT
    action: deny
`);

  it("allows write inside project root", () => {
    const result = evaluate(
      rules,
      "write",
      { filePath: "/project/src/file.ts" },
      "/project",
    );
    // write without path_outside condition: first rule match is allow
    // But we have no allow rule for write with path_outside, so it falls through
    // The path_outside rule triggers only when path IS outside
    // Inside path → no match on path_outside → continue → no more rules → allow
    expect(result.action).toBe("allow");
  });

  it("denies write outside project root", () => {
    const result = evaluate(
      rules,
      "write",
      { filePath: "/etc/passwd" },
      "/project",
    );
    expect(result.action).toBe("deny");
  });

  it("allows relative paths (treated as inside)", () => {
    const result = evaluate(
      rules,
      "write",
      { filePath: "src/file.ts" },
      "/project",
    );
    expect(result.action).toBe("allow");
  });
});

describe("loadRules", () => {
  afterEach(() => {
    try { unlinkSync(TEST_RULES_PATH); } catch { /* ok */ }
  });

  it("returns empty rules if file missing", () => {
    const rules = loadRules("/tmp/nonexistent.yaml");
    expect(rules.rules.length).toBe(0);
  });

  it("loads from file", () => {
    writeFileSync(TEST_RULES_PATH, `version: 1
rules:
  - match: { tool: read }
    action: allow
`);
    const rules = loadRules(TEST_RULES_PATH);
    expect(rules.rules.length).toBe(1);
  });
});

describe("Plugin entry", () => {
  it("exports default object with id and server function", async () => {
    const mod = await import("./index");
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("@sffmc/rules");
    expect(typeof mod.default.server).toBe("function");
  });

  it("server returns hooks with tool.execute.before and permission.ask", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    expect(typeof hooks["tool.execute.before"]).toBe("function");
    expect(typeof hooks["permission.ask"]).toBe("function");
  });
});
