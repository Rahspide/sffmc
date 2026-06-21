// SPDX-License-Identifier: MIT
// @sffmc/extra — F6' Judge tests

import { describe, it, expect } from "bun:test";
import {
  createJudgeTool,
  buildJudgePrompt,
  parseJudgeResponse,
  extractCandidatesFromMessages,
  callJudgeStream,
  DEFAULT_MAX_CANDIDATES,
  MIN_MAX_CANDIDATES,
  MAX_MAX_CANDIDATES,
  type JudgeConfig,
  type JudgeExecuteResult,
  type JudgeScore,
  type JudgeStreamChunk,
} from "../../extra/src/judge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock LLM response that the judge will parse. */
function mockJsonResponse(scores: JudgeScore[], winner: number, reasoning: string): string {
  return JSON.stringify({ scores, winner, reasoning });
}

/** Create a mock ctx with a client.session.message that returns a canned response. */
function mockCtx(cannedText: string, latencyMs = 150): NonNullable<JudgeConfig["ctx"]> {
  return {
    client: {
      session: {
        message: async () => {
          // Simulate latency for latencyMs measurement
          return {
            content: [{ type: "text", text: cannedText }],
            usage: { totalTokens: 500 },
          };
        },
      },
    },
  };
}

/** Default config for tests: enabled, with a mock ctx. */
function enabledConfig(overrides: Partial<JudgeConfig> = {}): JudgeConfig {
  return {
    enabled: true,
    model: "test-model",
    rubric: "Test rubric: score on quality.",
    ctx: mockCtx(
      mockJsonResponse(
        [
          { correctness: 8, completeness: 7, conciseness: 9 },
          { correctness: 6, completeness: 9, conciseness: 5 },
          { correctness: 9, completeness: 8, conciseness: 7 },
        ],
        2,
        "Candidate 2 has the best balance of correctness and completeness.",
      ),
    ),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — buildJudgePrompt
// ---------------------------------------------------------------------------

describe("buildJudgePrompt", () => {
  it("includes rubric in system message", () => {
    const rubric = "Custom rubric: test.";
    const { system } = buildJudgePrompt(["a", "b"], rubric);
    expect(system).toContain(rubric);
    expect(system).toContain("expert judge");
  });

  it("includes each candidate with index in user message", () => {
    const candidates = ["first output", "second output", "third output"];
    const { user } = buildJudgePrompt(candidates, "rubric");
    expect(user).toContain("Candidate #0:");
    expect(user).toContain("first output");
    expect(user).toContain("Candidate #1:");
    expect(user).toContain("second output");
    expect(user).toContain("Candidate #2:");
    expect(user).toContain("third output");
    expect(user).toContain("3 candidate outputs");
  });
});

// ---------------------------------------------------------------------------
// Tests — parseJudgeResponse
// ---------------------------------------------------------------------------

describe("parseJudgeResponse", () => {
  it("parses a valid JSON response", () => {
    const raw = JSON.stringify({
      scores: [
        { correctness: 8, completeness: 7, conciseness: 9 },
        { correctness: 6, completeness: 9, conciseness: 5 },
      ],
      winner: 0,
      reasoning: "First is better.",
    });
    const result = parseJudgeResponse(raw, 2);
    expect(result).not.toBeNull();
    expect(result!.scores.length).toBe(2);
    expect(result!.winner).toBe(0);
    expect(result!.reasoning).toBe("First is better.");
  });

  it("parses JSON wrapped in markdown fences", () => {
    const raw = '```json\n{\n  "scores": [{"correctness":5,"completeness":5,"conciseness":5}], "winner":0, "reasoning":"ok"}\n```';
    const result = parseJudgeResponse(raw, 1);
    expect(result).not.toBeNull();
    expect(result!.winner).toBe(0);
  });

  it("rejects response with wrong number of scores", () => {
    const raw = JSON.stringify({
      scores: [{ correctness: 8, completeness: 7, conciseness: 9 }],
      winner: 0,
      reasoning: "test",
    });
    expect(parseJudgeResponse(raw, 3)).toBeNull();
  });

  it("rejects response with out-of-range scores", () => {
    const raw = JSON.stringify({
      scores: [{ correctness: 15, completeness: 7, conciseness: 9 }],
      winner: 0,
      reasoning: "test",
    });
    expect(parseJudgeResponse(raw, 1)).toBeNull();
  });

  it("rejects response with invalid winner index", () => {
    const raw = JSON.stringify({
      scores: [{ correctness: 5, completeness: 5, conciseness: 5 }],
      winner: 3,
      reasoning: "test",
    });
    expect(parseJudgeResponse(raw, 2)).toBeNull();
  });

  it("rejects response with missing reasoning", () => {
    const raw = JSON.stringify({
      scores: [{ correctness: 5, completeness: 5, conciseness: 5 }],
      winner: 0,
      reasoning: "",
    });
    expect(parseJudgeResponse(raw, 1)).toBeNull();
  });

  it("rejects non-JSON text", () => {
    expect(parseJudgeResponse("just some text, no json here", 2)).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parseJudgeResponse("", 2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — Tool with real LLM (mocked)
// ---------------------------------------------------------------------------

describe("execute with mocked LLM", () => {
  it("with 3 candidates returns parsed scores, winner, reasoning", async () => {
    const { tool } = createJudgeTool(enabledConfig());
    const result = await tool.execute({
      candidates: ["output A", "output B", "output C"],
    }) as JudgeExecuteResult;

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.scores).toHaveLength(3);
    expect(result.scores[0].correctness).toBe(8);
    expect(result.scores[1].completeness).toBe(9);
    expect(result.scores[2].conciseness).toBe(7);
    expect(result.winner).toBe(2);
    expect(result.reasoning).toBe("Candidate 2 has the best balance of correctness and completeness.");
    expect(result.model).toBe("test-model");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("with rubric override uses custom rubric in prompt", async () => {
    // We verify this indirectly: create a ctx that captures the prompt sent
    let capturedMessages: Array<{ role: string; content: string }> = [];

    const cfg = enabledConfig({
      ctx: {
        client: {
          session: {
            message: async (params) => {
              capturedMessages = params.messages as Array<{ role: string; content: string }>;
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    scores: [
                      { correctness: 8, completeness: 7, conciseness: 9 },
                      { correctness: 6, completeness: 9, conciseness: 5 },
                    ],
                    winner: 0,
                    reasoning: "Custom rubric applied.",
                  }),
                }],
                usage: { totalTokens: 300 },
              };
            },
          },
        },
      },
    });

    const { tool } = createJudgeTool(cfg);
    const result = await tool.execute({
      candidates: ["x", "y"],
      rubric: "Custom rubric: prioritize brevity!",
    });

    expect(result.ok).toBe(true);
    // Verify the custom rubric was sent to the LLM
    const systemMsg = capturedMessages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain("prioritize brevity");
  });

  it("with 1 candidate returns error (min 2 required)", async () => {
    const { tool } = createJudgeTool(enabledConfig());
    const result = await tool.execute({
      candidates: ["only one"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("at least 2");
  });

  it("parse failure returns { ok: false, error: 'judge parse failed' }", async () => {
    const cfg = enabledConfig({
      ctx: mockCtx("not json at all, just random text {broken"),
    });
    const { tool } = createJudgeTool(cfg);
    const result = await tool.execute({
      candidates: ["a", "b"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("judge call failed");
    expect(result.error).toContain("judge parse failed");
  });

  it("with enabled: false returns { ok: true, skipped: true }", async () => {
    const { tool } = createJudgeTool({
      enabled: false,
      model: "test",
      rubric: "test",
    });
    const result = await tool.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("feature disabled");
  });

  it("latency field present and non-negative", async () => {
    const { tool } = createJudgeTool(enabledConfig());
    const result = await tool.execute({
      candidates: ["a", "b", "c"],
    }) as JudgeExecuteResult;

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.latencyMs).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Tests — extractCandidatesFromMessages
// ---------------------------------------------------------------------------

describe("extractCandidatesFromMessages", () => {
  it("extracts candidates from marker in message content", () => {
    const candidates = extractCandidatesFromMessages([
      { role: "user", content: 'some text <!-- EXTRA_JUDGE_CANDIDATES: ["a","b","c"] --> more text' },
    ]);
    expect(candidates).toEqual(["a", "b", "c"]);
  });

  it("returns null when no marker present", () => {
    const candidates = extractCandidatesFromMessages([
      { role: "user", content: "just a normal message" },
    ]);
    expect(candidates).toBeNull();
  });

  it("returns null when marker has invalid JSON", () => {
    const candidates = extractCandidatesFromMessages([
      { role: "user", content: "<!-- EXTRA_JUDGE_CANDIDATES: not-json -->" },
    ]);
    expect(candidates).toBeNull();
  });

  it("returns null when marker has fewer than 2 candidates", () => {
    const candidates = extractCandidatesFromMessages([
      { role: "user", content: '<!-- EXTRA_JUDGE_CANDIDATES: ["only-one"] -->' },
    ]);
    expect(candidates).toBeNull();
  });

  it("returns null for empty messages array", () => {
    const candidates = extractCandidatesFromMessages([]);
    expect(candidates).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — callJudgeStream (streaming mode)
// ---------------------------------------------------------------------------

describe("callJudgeStream", () => {
  it("emits scores chunk before complete chunk", async () => {
    const chunks: JudgeStreamChunk[] = [];
    const ctx = mockCtx(
      mockJsonResponse(
        [
          { correctness: 8, completeness: 7, conciseness: 9 },
          { correctness: 6, completeness: 9, conciseness: 5 },
        ],
        0,
        "First candidate wins.",
      ),
    );

    await callJudgeStream(
      ["candidate A", "candidate B"],
      "test rubric",
      "test-model",
      ctx,
      (chunk) => chunks.push(chunk),
    );

    // Find positions of scores and complete chunks
    const scoresIdx = chunks.findIndex((c) => c.type === "scores");
    const completeIdx = chunks.findIndex((c) => c.type === "complete");

    expect(scoresIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThanOrEqual(0);
    expect(scoresIdx).toBeLessThan(completeIdx);
  });

  it("emits winner chunk with the correct index", async () => {
    const chunks: JudgeStreamChunk[] = [];
    const ctx = mockCtx(
      mockJsonResponse(
        [
          { correctness: 5, completeness: 5, conciseness: 5 },
          { correctness: 9, completeness: 8, conciseness: 7 },
          { correctness: 6, completeness: 7, conciseness: 8 },
        ],
        1, // winner is index 1
        "Candidate 1 is the best overall.",
      ),
    );

    await callJudgeStream(
      ["a", "b", "c"],
      "rubric",
      "m",
      ctx,
      (chunk) => chunks.push(chunk),
    );

    const winnerChunk = chunks.find((c) => c.type === "winner");
    expect(winnerChunk).toBeDefined();
    expect(winnerChunk!.winner).toBe(1);
  });

  it("emits error chunk on parse failure", async () => {
    const chunks: JudgeStreamChunk[] = [];
    const ctx = mockCtx("not valid json at all {{{broken");

    let threw = false;
    try {
      await callJudgeStream(
        ["a", "b"],
        "rubric",
        "m",
        ctx,
        (chunk) => chunks.push(chunk),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const errorChunk = chunks.find((c) => c.type === "error");
    expect(errorChunk).toBeDefined();
    expect(errorChunk!.error).toContain("parse failed");
  });

  it("returns JudgeResult with all fields on success", async () => {
    const ctx = mockCtx(
      mockJsonResponse(
        [
          { correctness: 7, completeness: 6, conciseness: 8 },
          { correctness: 8, completeness: 8, conciseness: 5 },
        ],
        1,
        "Reasoning text.",
      ),
    );

    const result = await callJudgeStream(
      ["x", "y"],
      "rubric",
      "m",
      ctx,
      () => {}, // no-op callback
    );

    expect(result.ok).toBe(true);
    expect(result.scores).toHaveLength(2);
    expect(result.winner).toBe(1);
    expect(result.reasoning).toBe("Reasoning text.");
    expect(result.model).toBe("m");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("emits complete chunk as final non-error chunk", async () => {
    const chunks: JudgeStreamChunk[] = [];
    const ctx = mockCtx(
      mockJsonResponse(
        [
          { correctness: 5, completeness: 5, conciseness: 5 },
          { correctness: 6, completeness: 6, conciseness: 6 },
        ],
        1,
        "OK.",
      ),
    );

    await callJudgeStream(
      ["a", "b"],
      "r",
      "m",
      ctx,
      (chunk) => chunks.push(chunk),
    );

    const nonErrorChunks = chunks.filter((c) => c.type !== "error");
    const lastChunk = nonErrorChunks[nonErrorChunks.length - 1];
    expect(lastChunk.type).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// Tests — Tool shape (regression guards)
// ---------------------------------------------------------------------------

describe("createJudgeTool shape", () => {
  it("returns { tool, hooks }", () => {
    const result = createJudgeTool({ enabled: false, model: "m", rubric: "r" });
    expect(result.tool).toBeDefined();
    expect(result.hooks).toBeDefined();
  });

  it("tool has no 'name' field (fix-17 regression)", () => {
    const { tool } = createJudgeTool({ enabled: false, model: "m", rubric: "r" });
    expect((tool as Record<string, unknown>).name).toBeUndefined();
  });

  it("tool has description, parameters, execute", () => {
    const { tool } = createJudgeTool({ enabled: false, model: "m", rubric: "r" });
    expect(typeof tool.description).toBe("string");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.properties).toBeDefined();
    expect(tool.parameters.properties.candidates).toBeDefined();
    expect(tool.parameters.properties.candidates.type).toBe("array");
    expect(tool.parameters.required).toContain("candidates");
    expect(typeof tool.execute).toBe("function");
  });

  it("hooks are empty when judge_auto is not set", () => {
    const { hooks } = createJudgeTool({ enabled: true, model: "m", rubric: "r" });
    expect(hooks["experimental.chat.messages.transform"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// second release migration (v0.14.3) — judge prompt maxCandidates
// ---------------------------------------------------------------------------
// judge.ts:115 — DEFAULT_MAX_CANDIDATES is exported (= 8). MIN/MAX bounds
// (2-20) are also exported. The factory clamps `config.maxCandidates` to
// the 2-20 range and uses the clamped value for BOTH the JSON-Schema
// `maxItems` and the runtime `candidates.length > N` check, so the schema
// and the execute() guard never disagree.
//
// These tests cover:
//   1. Exported constants match the documented values (8, 2, 20).
//   2. Default (omitted) config → schema maxItems = 8, runtime accepts
//      up to 8, rejects 9. Description mentions "8+".
//   3. Custom maxCandidates → schema maxItems reflects it. Description
//      mentions the new value.
//   4. Runtime execute() enforces the configured cap (not the default 8).
//   5. Out-of-range values are clamped: < 2 → 2, > 20 → 20.
//   6. Non-integer values are floored.
//   7. Lower bound check still rejects 1 candidate regardless of cap.

describe("judge prompt maxCandidates config", () => {
  it("exports the documented default and bounds", () => {
    expect(DEFAULT_MAX_CANDIDATES).toBe(8);
    expect(MIN_MAX_CANDIDATES).toBe(2);
    expect(MAX_MAX_CANDIDATES).toBe(20);
  });

  it("omitting maxCandidates uses DEFAULT_MAX_CANDIDATES (8)", () => {
    const { tool } = createJudgeTool({ enabled: false, model: "m", rubric: "r" });
    const schema = tool.parameters.properties.candidates as { maxItems: number; minItems: number };
    expect(schema.maxItems).toBe(8);
    expect(schema.minItems).toBe(2);
    // Description mentions the default cap so callers know when streaming is worth it.
    expect(tool.description).toContain("8+ candidates");
  });

  it("custom maxCandidates: 12 → schema maxItems=12, description updated", () => {
    const { tool } = createJudgeTool({
      enabled: false,
      model: "m",
      rubric: "r",
      maxCandidates: 12,
    });
    const schema = tool.parameters.properties.candidates as { maxItems: number };
    expect(schema.maxItems).toBe(12);
    expect(tool.description).toContain("12+ candidates");
  });

  it("custom maxCandidates: 2 (lower bound) → schema maxItems=2", () => {
    const { tool } = createJudgeTool({
      enabled: false,
      model: "m",
      rubric: "r",
      maxCandidates: 2,
    });
    const schema = tool.parameters.properties.candidates as { maxItems: number };
    expect(schema.maxItems).toBe(2);
  });

  it("custom maxCandidates: 20 (upper bound) → schema maxItems=20", () => {
    const { tool } = createJudgeTool({
      enabled: false,
      model: "m",
      rubric: "r",
      maxCandidates: 20,
    });
    const schema = tool.parameters.properties.candidates as { maxItems: number };
    expect(schema.maxItems).toBe(20);
  });

  it("execute() enforces the configured cap (maxCandidates: 4) — 5th candidate rejected", async () => {
    const { tool } = createJudgeTool(enabledConfig({ maxCandidates: 4 }));
    const result = await tool.execute({
      candidates: ["a", "b", "c", "d", "e"], // 5 > configured 4
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("maximum 4 candidates");
  });

  it("execute() enforces the configured cap (maxCandidates: 4) — 4 candidates accepted", async () => {
    // Build a custom ctx that returns 4 scores (the default mock returns 3).
    const fourScoreJson = mockJsonResponse(
      [
        { correctness: 8, completeness: 7, conciseness: 9 },
        { correctness: 6, completeness: 9, conciseness: 5 },
        { correctness: 9, completeness: 8, conciseness: 7 },
        { correctness: 7, completeness: 6, conciseness: 8 },
      ],
      0,
      "Candidate 0 is the best.",
    );
    const { tool } = createJudgeTool(
      enabledConfig({ maxCandidates: 4, ctx: mockCtx(fourScoreJson) }),
    );
    const result = await tool.execute({
      candidates: ["a", "b", "c", "d"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.scores).toHaveLength(4);
  });

  it("execute() with default cap rejects 9 candidates (above 8)", async () => {
    const { tool } = createJudgeTool(enabledConfig());
    const result = await tool.execute({
      candidates: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], // 9
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("maximum 8 candidates");
  });

  it("execute() still rejects < 2 candidates (lower bound unchanged)", async () => {
    const { tool } = createJudgeTool(enabledConfig({ maxCandidates: 20 }));
    const result = await tool.execute({
      candidates: ["only one"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("at least 2");
  });

  it("below MIN is clamped to 2", () => {
    const { tool } = createJudgeTool({
      enabled: false,
      model: "m",
      rubric: "r",
      maxCandidates: 0,
    });
    const schema = tool.parameters.properties.candidates as { maxItems: number };
    expect(schema.maxItems).toBe(2);
  });

  it("above MAX is clamped to 20", () => {
    const { tool } = createJudgeTool({
      enabled: false,
      model: "m",
      rubric: "r",
      maxCandidates: 100,
    });
    const schema = tool.parameters.properties.candidates as { maxItems: number };
    expect(schema.maxItems).toBe(20);
  });

  it("non-integer is floored (e.g. 12.7 → 12)", () => {
    const { tool } = createJudgeTool({
      enabled: false,
      model: "m",
      rubric: "r",
      maxCandidates: 12.7,
    });
    const schema = tool.parameters.properties.candidates as { maxItems: number };
    expect(schema.maxItems).toBe(12);
  });

  it("execute() after clamping accepts up to the clamped cap", async () => {
    // maxCandidates: 100 → clamped to 20. So 20 candidates should be
    // accepted and 21 should be rejected.
    // Build a custom ctx that returns 20 scores.
    const twentyScoreJson = mockJsonResponse(
      Array.from({ length: 20 }, (_, i) => ({
        correctness: 5 + (i % 6),
        completeness: 5 + ((i + 1) % 6),
        conciseness: 5 + ((i + 2) % 6),
      })),
      0,
      "Candidate 0 wins.",
    );
    const { tool } = createJudgeTool(
      enabledConfig({ maxCandidates: 100, ctx: mockCtx(twentyScoreJson) }),
    );
    const ok20 = await tool.execute({
      candidates: Array.from({ length: 20 }, (_, i) => `cand-${i}`),
    });
    expect(ok20.ok).toBe(true);
    if (!ok20.ok) throw new Error("expected ok");

    const bad21 = await tool.execute({
      candidates: Array.from({ length: 21 }, (_, i) => `cand-${i}`),
    });
    expect(bad21.ok).toBe(false);
    if (bad21.ok) throw new Error("expected error");
    expect(bad21.error).toContain("maximum 20 candidates");
  });
});
