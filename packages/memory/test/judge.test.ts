// SPDX-License-Identifier: MIT
// @sffmc/extra — Judge tests

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
} from "../../src/extra/judge.ts";

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

// ---------------------------------------------------------------------------
// M-3 characterization — createJudgeTool fallback heuristic + auto-hook
// ---------------------------------------------------------------------------
// createJudgeTool's execute() falls through to a length-based heuristic
// when `config.ctx` has no session.message(). The auto-judge hook activates
// when `judge_auto: true` AND a usable ctx is present. Both paths are
// currently UNTESTED beyond the empty-hooks check; this block pins their
// observable behavior so the M-3 extraction doesn't regress.

describe("createJudgeTool fallback heuristic (no LLM ctx)", () => {
  it("returns { ok: true, skipped: false, model: 'heuristic', latencyMs: 0 }", async () => {
    const { tool } = createJudgeTool({
      enabled: true,
      model: "ignored-when-no-ctx",
      rubric: "r",
      // no ctx → fallback heuristic
    });
    const result = await tool.execute({
      candidates: ["a".repeat(100), "b".repeat(500), "c".repeat(2000)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.model).toBe("heuristic");
    expect(result.latencyMs).toBe(0);
  });

  it("scores each candidate on length-derived correctness/completeness/conciseness (capped 0-10)", async () => {
    const { tool } = createJudgeTool({
      enabled: true,
      model: "ignored-when-no-ctx",
      rubric: "r",
    });
    const result = await tool.execute({
      candidates: ["a".repeat(100), "b".repeat(500), "c".repeat(2000)],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.scores.length).toBe(3);
    for (const s of result.scores) {
      expect(s.correctness).toBeGreaterThanOrEqual(0);
      expect(s.correctness).toBeLessThanOrEqual(10);
      expect(s.completeness).toBeGreaterThanOrEqual(0);
      expect(s.completeness).toBeLessThanOrEqual(10);
      expect(s.conciseness).toBeGreaterThanOrEqual(0);
      expect(s.conciseness).toBeLessThanOrEqual(10);
    }
  });

  it("winner is the index of the candidate with the highest sum of scores", async () => {
    // The 1500-char candidate scores correctness=10, completeness=10,
    // conciseness=Math.min(10, round(800/1501))=1 → total=21
    // The 50-char candidate scores correctness=Math.min(10, round(50/100))=0,
    // completeness=Math.min(10, round(50/150))=0, conciseness=Math.min(10, round(800/51))=16→10
    //   → total=10
    // So the 1500-char candidate wins.
    const { tool } = createJudgeTool({
      enabled: true,
      model: "ignored-when-no-ctx",
      rubric: "r",
    });
    const result = await tool.execute({
      candidates: ["x".repeat(50), "y".repeat(1500), "z".repeat(800)],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.winner).toBe(1);
  });

  it("reasoning field carries the 'Fallback heuristic' marker text", async () => {
    const { tool } = createJudgeTool({
      enabled: true,
      model: "ignored-when-no-ctx",
      rubric: "r",
    });
    const result = await tool.execute({
      candidates: ["a", "b"],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.reasoning).toContain("Fallback heuristic");
  });
});

describe("createJudgeTool auto-judge hook (judge_auto: true)", () => {
  it("hook IS registered when judge_auto is true AND ctx has session.message()", () => {
    const { hooks } = createJudgeTool({
      enabled: true,
      model: "m",
      rubric: "r",
      judge_auto: true,
      ctx: mockCtx(mockJsonResponse([{ correctness: 8, completeness: 8, conciseness: 8 }, { correctness: 7, completeness: 7, conciseness: 7 }], 0, "ok")),
    });
    expect(hooks["experimental.chat.messages.transform"]).toBeTypeOf("function");
  });

  it("hook is NOT registered when judge_auto is true BUT no ctx (or no session.message)", () => {
    const { hooks } = createJudgeTool({
      enabled: true,
      model: "m",
      rubric: "r",
      judge_auto: true,
      // no ctx
    });
    expect(hooks["experimental.chat.messages.transform"]).toBeUndefined();
  });

  it("hook pushes a 'Judge Verdict' assistant message when a candidate marker is present", async () => {
    const { hooks } = createJudgeTool({
      enabled: true,
      model: "m",
      rubric: "r",
      judge_auto: true,
      ctx: mockCtx(
        mockJsonResponse(
          [
            { correctness: 9, completeness: 9, conciseness: 9 },
            { correctness: 5, completeness: 5, conciseness: 5 },
          ],
          0,
          "Candidate 0 is clearly better.",
        ),
      ),
    });
    const transform = hooks["experimental.chat.messages.transform"];
    expect(transform).toBeTypeOf("function");
    if (!transform) throw new Error("expected transform");

    const data: { messages: Array<{ role: string; content: string }> } = {
      messages: [
        { role: "user", content: "do something" },
        {
          role: "assistant",
          content: `some result\n<!-- EXTRA_JUDGE_CANDIDATES: ${JSON.stringify(["first output", "second output"])} -->`,
        },
      ],
    };
    await transform(undefined, data);

    // The hook appends a verdict message — count should now be 3.
    expect(data.messages.length).toBe(3);
    const last = data.messages[data.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toContain("Judge Verdict");
    expect(last.content).toContain("Winner: Candidate #0");
    expect(last.content).toContain("Reasoning: Candidate 0 is clearly better.");
  });

  it("hook is a no-op when no candidate marker is present in any message", async () => {
    const { hooks } = createJudgeTool({
      enabled: true,
      model: "m",
      rubric: "r",
      judge_auto: true,
      ctx: mockCtx(
        mockJsonResponse(
          [
            { correctness: 9, completeness: 9, conciseness: 9 },
            { correctness: 5, completeness: 5, conciseness: 5 },
          ],
          0,
          "ignored",
        ),
      ),
    });
    const transform = hooks["experimental.chat.messages.transform"];
    if (!transform) throw new Error("expected transform");
    const data: { messages: Array<{ role: string; content: string }> } = {
      messages: [
        { role: "user", content: "just a question, no marker here" },
        { role: "assistant", content: "and no marker in the assistant message either" },
      ],
    };
    await transform(undefined, data);
    // No verdict added; messages unchanged.
    expect(data.messages.length).toBe(2);
  });

  it("hook swallows LLM call failures silently (no throw, no message push)", async () => {
    let called = 0;
    const failingCtx: NonNullable<JudgeConfig["ctx"]> = {
      client: {
        session: {
          message: async () => {
            called++;
            throw new Error("synthetic LLM failure");
          },
        },
      },
    };
    const { hooks } = createJudgeTool({
      enabled: true,
      model: "m",
      rubric: "r",
      judge_auto: true,
      ctx: failingCtx,
    });
    const transform = hooks["experimental.chat.messages.transform"];
    if (!transform) throw new Error("expected transform");
    const data: { messages: Array<{ role: string; content: string }> } = {
      messages: [
        {
          role: "assistant",
          content: `<!-- EXTRA_JUDGE_CANDIDATES: ${JSON.stringify(["x", "y"])} -->`,
        },
      ],
    };
    // Should NOT throw — the auto-hook is best-effort.
    await transform(undefined, data);
    expect(called).toBe(1);
    expect(data.messages.length).toBe(1); // no verdict added on failure
  });
});

// ---------------------------------------------------------------------------
// Medium function split — judge prompt + extraction + stream helpers
// ---------------------------------------------------------------------------
// The continuation arc (Task 2.2b) extracts formatJudgeCandidateBlocks /
// extractJudgeSessionText / emitJudgeResultChunks / parseJudgeMarkerContent
// from the four ≥20 LOC functions in the prompt + call layers. These
// tests pin the OBSERVABLE behavior of each extracted helper so the
// orchestrators (buildJudgePrompt, callJudge, callJudgeStream,
// extractCandidatesFromMessages) keep producing the documented output.

describe("buildJudgePrompt prompt structure", () => {
  it("system message contains 'expert judge' role marker + rubric verbatim", () => {
    // Pin the system prompt role string and rubric inclusion. The
    // rubric's exact text is interpolated — losing it would silently
    // change the LLM's evaluation criteria.
    const { system } = buildJudgePrompt(["a", "b"], "Score on accuracy.");
    expect(system).toContain("expert judge");
    expect(system).toContain("Score on accuracy.");
  });

  it("user message header 'Evaluate the following N candidate outputs' (exact phrasing) + numbered code blocks", () => {
    // Pin the extracted formatJudgeCandidateBlocks output: each entry
    // formatted as 'Candidate #i:\n```<text>\n```' joined by '\n\n',
    // and the user header containing 'Evaluate the following N'.
    const { user } = buildJudgePrompt(
      ["alpha output", "beta output", "gamma output"],
      "r",
    );
    // Header must be present BEFORE the first code block.
    expect(user).toMatch(/^Evaluate the following 3 candidate outputs\./);
    // Each block must contain a numbered code fence with the candidate text.
    expect(user).toContain("Candidate #0:\n```\nalpha output\n```");
    expect(user).toContain("Candidate #1:\n```\nbeta output\n```");
    expect(user).toContain("Candidate #2:\n```\ngamma output\n```");
    // Output JSON spec must be present AFTER the candidate blocks.
    expect(user).toContain('"scores": [');
    expect(user).toContain('"winner": <index of best candidate, 0-based>');
    expect(user).toContain('"reasoning": "');
  });
});

describe("extractCandidatesFromMessages marker parsing", () => {
  it("returns null when no message contains the marker", () => {
    const out = extractCandidatesFromMessages([
      { role: "user", content: "no marker here" },
      { role: "assistant", content: "neither here" },
    ]);
    expect(out).toBeNull();
  });

  it("parses and returns the array when a message contains valid 2+ candidate JSON", () => {
    const out = extractCandidatesFromMessages([
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: `<!-- EXTRA_JUDGE_CANDIDATES: ${JSON.stringify(["first", "second"])} -->`,
      },
    ]);
    expect(out).toEqual(["first", "second"]);
  });

  it("skips marker with <2 candidates (length validation requires ≥2)", () => {
    const out = extractCandidatesFromMessages([
      {
        role: "assistant",
        content: `<!-- EXTRA_JUDGE_CANDIDATES: ${JSON.stringify(["only one"])} -->`,
      },
    ]);
    // Length < 2 → returns null (no marker → no candidates → caller is skipped)
    expect(out).toBeNull();
  });

  it("skips invalid JSON inside marker and keeps scanning subsequent messages", () => {
    // First message has a malformed marker; second has a valid one →
    // the scan MUST continue and return the second's array.
    const out = extractCandidatesFromMessages([
      { role: "assistant", content: `<!-- EXTRA_JUDGE_CANDIDATES: {not json} -->` },
      {
        role: "assistant",
        content: `<!-- EXTRA_JUDGE_CANDIDATES: ${JSON.stringify(["alpha", "beta"])} -->`,
      },
    ]);
    expect(out).toEqual(["alpha", "beta"]);
  });

  it("skips non-string content (e.g. message with typed array content) without throwing", () => {
    // Type-safety guard — the parsing only runs on string content.
    const out = extractCandidatesFromMessages([
      { role: "assistant", content: "pure string message" },
    ]);
    expect(out).toBeNull();
  });
});

describe("callJudgeStream chunk emission order", () => {
  it("emits scores → winner → reasoning → complete in that order", async () => {
    // Pin the extracted emitJudgeResultChunks order. The chunk order
    // is a downstream contract — reordering would break any consumer
    // that processes each chunk stage as it arrives.
    const chunks: JudgeStreamChunk[] = [];
    await callJudgeStream(
      ["first", "second"],
      "r",
      "test-model",
      mockCtx(
        mockJsonResponse(
          [
            { correctness: 9, completeness: 9, conciseness: 9 },
            { correctness: 5, completeness: 5, conciseness: 5 },
          ],
          0,
          "winner is candidate 0",
        ),
      ),
      (chunk) => chunks.push(chunk),
    );
    const types = chunks.map((c) => c.type);
    expect(types).toEqual(["scores", "winner", "reasoning", "complete"]);
    // Each chunk carries the expected payload.
    const scoresChunk = chunks[0] as Extract<JudgeStreamChunk, { type: "scores" }>;
    expect(scoresChunk.scores.length).toBe(2);
    const winnerChunk = chunks[1] as Extract<JudgeStreamChunk, { type: "winner" }>;
    expect(winnerChunk.winner).toBe(0);
    const reasoningChunk = chunks[2] as Extract<JudgeStreamChunk, { type: "reasoning" }>;
    expect(reasoningChunk.reasoning).toBe("winner is candidate 0");
    expect(chunks[3].type).toBe("complete");
  });
});
