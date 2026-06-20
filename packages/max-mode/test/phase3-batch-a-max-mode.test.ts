// SPDX-License-Identifier: MIT
// @sffmc/max-mode — see ../../LICENSE
//
// Phase-3 LOW migration test (v0.14.3) — max-mode X3.
// See .slim/deepwork/phase-2-3-hardcode-migration-plan.md §3.6.
//
// Verifies the new YAML-configurable field on MaxModeConfig:
//
//   - X3  maxMode.fallbackConfidence    (default 0.3, range 0.0-1.0 float)
//         Confidence assigned by `fallbackVerdict()` when the judge LLM
//         is unavailable, throws, or returns unparseable output.
//         Was: literal `confidence: 0.3` in judge.ts:88 (pre-migration).
//         Now: optional 5th arg to `judgeCandidates(..., fallbackConfidence)`,
//         default 0.3. Configured via MaxModeConfig.fallbackConfidence.
//
// Reference pattern: `packages/max-mode/test/phase2-batch-a-max-mode.test.ts`
// (X1/X2 migration). All checks use an isolated temp configHome so the
// user's real `~/.config/SFFMC/max-mode.yaml` is never touched.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../../max-mode/src/index";
import { judgeCandidates } from "../../max-mode/src/judge";

// ---------------------------------------------------------------------------
// Isolated configHome so we don't pick up the user's real
// ~/.config/SFFMC/max-mode.yaml. Same pattern as phase2-batch-a-max-mode.
// ---------------------------------------------------------------------------

let tempHome: string | undefined;
let configHome: string | undefined;

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), "sffmc-max-mode-x3-"));
  configHome = join(tempHome!, ".config", "SFFMC");
  mkdirSync(configHome!, { recursive: true });
});

afterAll(() => {
  if (tempHome) {
    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
  }
});

function clearMaxModeYaml(): void {
  const path = join(configHome!, "max-mode.yaml");
  if (existsSync(path)) rmSync(path);
}

function writeMaxModeYaml(contents: string): void {
  const path = join(configHome!, "max-mode.yaml");
  clearMaxModeYaml();
  writeFileSync(path, contents);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function mkCandidate(draft: string, id = "c") {
  return {
    id,
    temperature: 1.0,
    draft,
    toolCalls: [],
    tokens: 0,
  };
}

// Two candidates, distinct draft lengths so the longest-draft heuristic
// can pick a stable winner (candidate index 1).
const candidates = [
  mkCandidate("short", "a"),
  mkCandidate("a much longer draft than the first one", "b"),
];

// ===========================================================================
// X3 (a) — defaultConfig + loadConfig baseline
// ===========================================================================

describe("X3 — maxMode.fallbackConfidence (default + loadConfig)", () => {
  it("(a) defaultConfig.fallbackConfidence === 0.3 (matches v0.14.3 literal)", () => {
    expect(defaultConfig.fallbackConfidence).toBe(0.3);
  });

  it("(a) defaultConfig.fallbackConfidence is a finite float, not NaN/Infinity", () => {
    expect(Number.isFinite(defaultConfig.fallbackConfidence)).toBe(true);
    expect(Number.isNaN(defaultConfig.fallbackConfidence)).toBe(false);
  });

  it("(a) defaultConfig.fallbackConfidence is within the plan-stated range (0.0-1.0)", () => {
    expect(defaultConfig.fallbackConfidence).toBeGreaterThanOrEqual(0.0);
    expect(defaultConfig.fallbackConfidence).toBeLessThanOrEqual(1.0);
  });

  it("(a) loadConfig with no YAML file returns fallbackConfidence = 0.3", async () => {
    clearMaxModeYaml();
    // Re-import loadConfig so each test sees a fresh module state.
    const { loadConfig } = await import("@sffmc/shared");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.fallbackConfidence).toBe(0.3);
  });
});

// ===========================================================================
// X3 (b) — YAML override
// ===========================================================================

describe("X3 — maxMode.fallbackConfidence (YAML override)", () => {
  it("(b) YAML override changes the value (mid-range: 0.5)", async () => {
    writeMaxModeYaml("fallbackConfidence: 0.5\n");
    const { loadConfig } = await import("@sffmc/shared");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.fallbackConfidence).toBe(0.5);
  });

  it("(b) YAML override at the plan-stated lower bound (0.0) flows through", async () => {
    writeMaxModeYaml("fallbackConfidence: 0.0\n");
    const { loadConfig } = await import("@sffmc/shared");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.fallbackConfidence).toBe(0.0);
  });

  it("(b) YAML override at the plan-stated upper bound (1.0) flows through", async () => {
    writeMaxModeYaml("fallbackConfidence: 1.0\n");
    const { loadConfig } = await import("@sffmc/shared");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.fallbackConfidence).toBe(1.0);
  });

  it("(b) YAML override with high precision float (0.75) is preserved", async () => {
    writeMaxModeYaml("fallbackConfidence: 0.75\n");
    const { loadConfig } = await import("@sffmc/shared");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.fallbackConfidence).toBe(0.75);
  });
});

// ===========================================================================
// X3 (c) — judgeCandidates uses fallbackConfidence in fallbackVerdict()
// ===========================================================================

describe("X3 — judgeCandidates uses configured fallbackConfidence", () => {
  it("(c) SDK unavailable → verdict.confidence === fallbackConfidence (0.5)", async () => {
    // Pass 0.5 explicitly as the 5th arg to verify the value flows through
    // to `fallbackVerdict()` when the SDK is absent.
    const verdict = await judgeCandidates(
      candidates,
      "test-model",
      // ctx without client.session.message → triggers early fallback path.
      {} as unknown as Parameters<typeof judgeCandidates>[2],
      8000,    // judgeDraftMaxChars (X2)
      0.5,     // fallbackConfidence (X3)
    );
    expect(verdict.winner).toBe(1); // longest-draft heuristic unchanged
    expect(verdict.confidence).toBe(0.5);
  });

  it("(c) SDK throws → verdict.confidence === fallbackConfidence (0.5)", async () => {
    const mockMessage = async () => {
      throw new Error("network error");
    };
    const ctx = {
      client: { session: { message: mockMessage } },
    } as unknown as Parameters<typeof judgeCandidates>[2];

    const verdict = await judgeCandidates(
      candidates,
      "test-model",
      ctx,
      8000,
      0.5,
    );
    expect(verdict.confidence).toBe(0.5);
  });

  it("(c) SDK returns unparseable verdict → fallbackConfidence flows through", async () => {
    const mockMessage = async () => ({
      content: [{ type: "text" as const, text: "I pick number 2!" }],
      usage: { totalTokens: 50 },
    });
    const ctx = {
      client: { session: { message: mockMessage } },
    } as unknown as Parameters<typeof judgeCandidates>[2];

    const verdict = await judgeCandidates(
      candidates,
      "test-model",
      ctx,
      8000,
      0.5,
    );
    expect(verdict.confidence).toBe(0.5);
  });

  it("(c) SDK succeeds → fallbackConfidence is NOT used (verdict.confidence comes from LLM)", async () => {
    // When the judge LLM returns a valid verdict, the LLM's confidence wins.
    // The fallbackConfidence arg must NOT overwrite it.
    const mockMessage = async () => ({
      content: [
        {
          type: "text" as const,
          text: '{"winner": 0, "reasoning": "more concise", "confidence": 0.92}',
        },
      ],
      usage: { totalTokens: 50 },
    });
    const ctx = {
      client: { session: { message: mockMessage } },
    } as unknown as Parameters<typeof judgeCandidates>[2];

    const verdict = await judgeCandidates(
      candidates,
      "test-model",
      ctx,
      8000,
      // Intentionally a tiny fallback value — should be ignored on success.
      0.05,
    );
    expect(verdict.winner).toBe(0);
    expect(verdict.confidence).toBe(0.92); // LLM-supplied, not 0.05
  });
});

// ===========================================================================
// X3 (d) — backward compatibility: default fallbackConfidence = 0.3
// ===========================================================================

describe("X3 — judgeCandidates default fallbackConfidence (backward compat)", () => {
  it("(d) omitting the 5th arg falls back to 0.3 (matches v0.14.3 pre-migration)", async () => {
    // Same 3-arg call shape used in agentic/test/max-mode.test.ts (pre-X3).
    // The 4th and 5th args are optional with sensible defaults.
    const verdict = await judgeCandidates(
      candidates,
      "test-model",
      {} as unknown as Parameters<typeof judgeCandidates>[2],
    );
    expect(verdict.winner).toBe(1);
    expect(verdict.confidence).toBe(0.3);
  });

  it("(d) passing only the 4th arg (judgeDraftMaxChars) keeps fallbackConfidence default 0.3", async () => {
    const verdict = await judgeCandidates(
      candidates,
      "test-model",
      {} as unknown as Parameters<typeof judgeCandidates>[2],
      4000,    // judgeDraftMaxChars
      // fallbackConfidence omitted → 0.3
    );
    expect(verdict.confidence).toBe(0.3);
  });
});

// ===========================================================================
// X3 (e) — integration: X1+X2+X3 together
// ===========================================================================

describe("X3 — integration with X1 and X2 in full MaxModeConfig", () => {
  it("(e) YAML can override all three fields at once without disturbing defaults", async () => {
    writeMaxModeYaml([
      "maxCandidates: 25",
      "judgeDraftMaxChars: 12000",
      "fallbackConfidence: 0.6",
      "",
    ].join("\n"));
    const { loadConfig } = await import("@sffmc/shared");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.maxCandidates).toBe(25);
    expect(cfg.judgeDraftMaxChars).toBe(12000);
    expect(cfg.fallbackConfidence).toBe(0.6);
  });

  it("(e) YAML override of one field does NOT disturb X3 fallbackConfidence", async () => {
    // Override only maxCandidates — fallbackConfidence should stay default 0.3.
    writeMaxModeYaml("maxCandidates: 7\n");
    const { loadConfig } = await import("@sffmc/shared");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.maxCandidates).toBe(7);
    expect(cfg.fallbackConfidence).toBe(0.3);
  });
});
