import { describe, it, expect } from "bun:test";
import { generateCandidates, buildCandidatePrompt, type Candidate } from "../../max-mode/src/candidates";
import { judgeCandidates, buildJudgePrompt, parseVerdict, type Verdict } from "../../max-mode/src/judge";
import { createRestoreState, stripToolExecutes, restoreToolExecutes } from "../../max-mode/src/restore";
import type { SchemaOnlyTool } from "../../max-mode/src/types";

// Local re-implementation of makeSchemaOnlyTools (only used in tests).
// Production code now uses stripToolExecutes/restoreToolExecutes from restore.ts.
function makeSchemaOnlyTools(tools: SchemaOnlyTool[]): SchemaOnlyTool[] {
  return tools.map((tool) => ({ definition: { ...tool.definition } }));
}

describe("candidates", () => {
  it("makeSchemaOnlyTools strips execute from tools", () => {
    const tools = [
      {
        definition: { name: "bash", description: "Run bash", parameters: {} },
        execute: () => "result",
      },
    ];
    const stripped = makeSchemaOnlyTools(tools);
    expect(stripped.length).toBe(1);
    expect(stripped[0].definition.name).toBe("bash");
    expect((stripped[0] as { execute?: unknown }).execute).toBeUndefined();
  });

  it("makeSchemaOnlyTools handles empty array", () => {
    const stripped = makeSchemaOnlyTools([]);
    expect(stripped.length).toBe(0);
  });

  it("buildCandidatePrompt includes candidate index", () => {
    const messages = buildCandidatePrompt("fix bug", 2, 5);
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Candidate #3 of 5");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("fix bug");
  });

  it("buildCandidatePrompt first candidate says #1", () => {
    const messages = buildCandidatePrompt("task", 0, 3);
    expect(messages[0].content).toContain("Candidate #1 of 3");
  });

  it("generateCandidates returns N candidates when SDK available", async () => {
    const mockMessage = async () => ({
      content: [{ type: "text" as const, text: "draft response" }],
      usage: { totalTokens: 100 },
    });

    const ctx: Record<string, unknown> = {
      client: { session: { message: mockMessage } },
      config: { model: "test-model" },
    };

    const candidates = await generateCandidates(
      "test prompt",
      { n: 3, models: [], temperature: 1.0 },
      ctx as unknown as Parameters<typeof generateCandidates>[2],
    );

    expect(candidates.length).toBe(3);
    for (const c of candidates) {
      expect(c.id).toMatch(/candidate-\d/);
      expect(c.draft).toBe("draft response");
      expect(c.tokens).toBe(100);
    }
  });

  it("generateCandidates throws when SDK not available", async () => {
    await expect(
      generateCandidates(
        "test",
        { n: 2, models: [], temperature: 0.5 },
        {} as unknown as Parameters<typeof generateCandidates>[2],
      ),
    ).rejects.toThrow("SDK client.session.message");
  });

  it("generateCandidates handles rejected promises gracefully", async () => {
    let call = 0;
    const mockMessage = async () => {
      call++;
      if (call === 2) throw new Error("simulated failure");
      return {
        content: [{ type: "text" as const, text: "ok" }],
        usage: { totalTokens: 50 },
      };
    };

    const ctx: Record<string, unknown> = {
      client: { session: { message: mockMessage } },
    };

    const candidates = await generateCandidates(
      "test",
      { n: 3, models: [], temperature: 1.0 },
      ctx as unknown as Parameters<typeof generateCandidates>[2],
    );

    expect(candidates.length).toBe(3);
    const failed = candidates.filter((c) => c.draft.startsWith("[ERROR]"));
    expect(failed.length).toBe(1);
    const ok = candidates.filter((c) => c.draft === "ok");
    expect(ok.length).toBe(2);
  });

  it("generateCandidates captures tool calls from response", async () => {
    const mockMessage = async () => ({
      content: [
        { type: "text" as const, text: "I will use bash" },
        {
          type: "toolCall" as const,
          toolCall: { name: "bash", args: { command: "ls" }, id: "tc-1" },
        },
      ],
      usage: { totalTokens: 80 },
    });

    const ctx: Record<string, unknown> = {
      client: { session: { message: mockMessage } },
    };

    const candidates = await generateCandidates(
      "test",
      { n: 1, models: [], temperature: 1.0 },
      ctx as unknown as Parameters<typeof generateCandidates>[2],
    );

    expect(candidates.length).toBe(1);
    expect(candidates[0].toolCalls.length).toBe(1);
    expect(candidates[0].toolCalls[0].name).toBe("bash");
    expect(candidates[0].toolCalls[0].args).toEqual({ command: "ls" });
  });
});

describe("judge", () => {
  const candidates: Candidate[] = [
    { id: "c-0", temperature: 1.0, draft: "Solution A", toolCalls: [], tokens: 100 },
    { id: "c-1", temperature: 1.0, draft: "Solution B is better", toolCalls: [], tokens: 120 },
    { id: "c-2", temperature: 1.0, draft: "Solution C", toolCalls: [], tokens: 90 },
  ];

  it("buildJudgePrompt includes all candidates", () => {
    const prompt = buildJudgePrompt(candidates);
    expect(prompt).toContain("Candidate 0");
    expect(prompt).toContain("Candidate 1");
    expect(prompt).toContain("Candidate 2");
    expect(prompt).toContain("Solution A");
    expect(prompt).toContain("Solution B is better");
  });

  it("buildJudgePrompt truncates long drafts", () => {
    const longCandidate: Candidate = {
      id: "c-long",
      temperature: 1.0,
      draft: "x".repeat(20000),
      toolCalls: [],
      tokens: 200,
    };
    const prompt = buildJudgePrompt([longCandidate]);
    expect(prompt.length).toBeLessThan(10000);
  });

  it("parseVerdict extracts valid JSON verdict", () => {
    const raw = '{"winner": 1, "reasoning": "best solution", "confidence": 0.85}';
    const verdict = parseVerdict(raw, 3);
    expect(verdict).not.toBeNull();
    expect(verdict!.winner).toBe(1);
    expect(verdict!.reasoning).toBe("best solution");
    expect(verdict!.confidence).toBe(0.85);
  });

  it("parseVerdict rejects out-of-range winner", () => {
    const raw = '{"winner": 5, "reasoning": "bad", "confidence": 0.5}';
    const verdict = parseVerdict(raw, 3);
    expect(verdict).toBeNull();
  });

  it("parseVerdict rejects confidence out of range", () => {
    const raw = '{"winner": 0, "reasoning": "ok", "confidence": 1.5}';
    const verdict = parseVerdict(raw, 3);
    expect(verdict).toBeNull();
  });

  it("parseVerdict rejects missing fields", () => {
    expect(parseVerdict('{"winner": 0}', 3)).toBeNull();
    expect(parseVerdict('{"reasoning": "x", "confidence": 0.5}', 3)).toBeNull();
  });

  it("parseVerdict handles JSON with surrounding text", () => {
    const raw = 'here is the verdict: {"winner": 0, "reasoning": "good", "confidence": 0.9} end';
    const verdict = parseVerdict(raw, 1);
    expect(verdict).not.toBeNull();
    expect(verdict!.winner).toBe(0);
  });

  it("parseVerdict returns null on invalid JSON", () => {
    expect(parseVerdict("not json at all", 3)).toBeNull();
    expect(parseVerdict("", 3)).toBeNull();
  });

  it("parseVerdict rejects empty reasoning", () => {
    const raw = '{"winner": 0, "reasoning": "", "confidence": 0.5}';
    expect(parseVerdict(raw, 1)).toBeNull();
  });

  it("judgeCandidates returns verdict via SDK", async () => {
    const mockMessage = async () => ({
      content: [
        {
          type: "text" as const,
          text: '{"winner": 1, "reasoning": "most complete", "confidence": 0.8}',
        },
      ],
      usage: { totalTokens: 50 },
    });

    const ctx: Record<string, unknown> = {
      client: { session: { message: mockMessage } },
    };

    const verdict = await judgeCandidates(
      candidates,
      "test-model",
      ctx as unknown as Parameters<typeof judgeCandidates>[2],
    );
    expect(verdict.winner).toBe(1);
    expect(verdict.confidence).toBe(0.8);
  });

  it("judgeCandidates falls back when SDK unavailable", async () => {
    const verdict = await judgeCandidates(
      candidates,
      "test-model",
      {} as unknown as Parameters<typeof judgeCandidates>[2],
    );
    expect(verdict.winner).toBe(1); // longest draft
    expect(verdict.confidence).toBe(0.3);
  });

  it("judgeCandidates falls back when SDK throws", async () => {
    const mockMessage = async () => {
      throw new Error("network error");
    };

    const ctx: Record<string, unknown> = {
      client: { session: { message: mockMessage } },
    };

    const verdict = await judgeCandidates(
      candidates,
      "test-model",
      ctx as unknown as Parameters<typeof judgeCandidates>[2],
    );
    expect(verdict.confidence).toBe(0.3);
  });

  it("judgeCandidates falls back on unparseable verdict", async () => {
    const mockMessage = async () => ({
      content: [{ type: "text" as const, text: "I pick number 2!" }],
      usage: { totalTokens: 50 },
    });

    const ctx: Record<string, unknown> = {
      client: { session: { message: mockMessage } },
    };

    const verdict = await judgeCandidates(
      candidates,
      "test-model",
      ctx as unknown as Parameters<typeof judgeCandidates>[2],
    );
    expect(verdict.confidence).toBe(0.3);
  });
});

describe("restore", () => {
  it("stripToolExecutes removes execute from tools", () => {
    const state = createRestoreState();
    const tools = [
      {
        definition: { name: "bash", description: "run", parameters: {} },
        execute: () => "result",
      },
      {
        definition: { name: "glob", description: "find", parameters: {} },
        execute: () => ["file"],
      },
    ];

    const result = stripToolExecutes(tools, state);
    expect(result.length).toBe(2);
    expect((result[0] as { execute?: unknown }).execute).toBeUndefined();
    expect((result[1] as { execute?: unknown }).execute).toBeUndefined();
    expect(state.stripped).toBe(true);
  });

  it("stripToolExecutes is idempotent", () => {
    const state = createRestoreState();
    const tools = [
      {
        definition: { name: "bash", description: "", parameters: {} },
        execute: () => "result",
      },
    ];

    stripToolExecutes(tools, state);
    const result2 = stripToolExecutes(tools, state);
    expect(state.stripped).toBe(true);
  });

  it("restoreToolExecutes puts execute back", () => {
    const state = createRestoreState();
    const tools = [
      {
        definition: { name: "bash", description: "", parameters: {} },
        execute: () => "original",
      },
    ];

    stripToolExecutes(tools, state);
    expect((tools[0] as { execute?: unknown }).execute).toBeUndefined();

    restoreToolExecutes(tools, state);
    expect(tools[0].execute).toBeDefined();
    expect(tools[0].execute!).toBeInstanceOf(Function);
    expect(state.stripped).toBe(false);
  });

  it("restoreToolExecutes is no-op when not stripped", () => {
    const state = createRestoreState();
    const tools = [
      {
        definition: { name: "bash", description: "", parameters: {} },
        execute: () => "result",
      },
    ];

    restoreToolExecutes(tools, state);
    expect(tools[0].execute).toBeDefined();
  });

  it("handles tools without execute", () => {
    const state = createRestoreState();
    const tools = [
      {
        definition: { name: "read", description: "", parameters: {} },
      },
    ];

    stripToolExecutes(tools, state);
    expect(state.stripped).toBe(true);
    // Should not crash
    expect(tools[0].definition.name).toBe("read");
  });
});

describe("Plugin entry", () => {
  it("exports default object with id and server function", async () => {
    const mod = await import("../../max-mode/src/index");
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("@sffmc/cognition");
    expect(typeof mod.default.server).toBe("function");
  });

  it("server returns expected hooks", async () => {
    const mod = await import("../../max-mode/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    expect(typeof hooks["command.execute.before"]).toBe("function");
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
    expect(typeof hooks["tool.execute.before"]).toBe("function");
    expect(typeof hooks["experimental.chat.messages.transform"]).toBe("function");
  });

  it("command.execute.before handles /max --dry-run", async () => {
    const mod = await import("../../max-mode/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    await hooks["command.execute.before"]!(
      { command: "/max --dry-run", sessionID: "s1" },
    );
  });

  it("command.execute.before handles /max execute to restore tools", async () => {
    const mod = await import("../../max-mode/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    await hooks["command.execute.before"]!(
      { command: "/max execute", sessionID: "s1" },
    );
  });

  it("command.execute.before ignores non-max commands", async () => {
    const mod = await import("../../max-mode/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    await hooks["command.execute.before"]!(
      { command: "/deepwork fix bug", sessionID: "s1" },
    );
  });
});
