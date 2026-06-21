// SPDX-License-Identifier: MIT
// @sffmc/max-mode — see ../../LICENSE
//
// second release migration test (v0.14.3) — max-mode max-mode checkpoint integration + max-mode chokidar migration.
// See .slim/deepwork/phase-2-3-hardcode-migration-plan.md §2.6.
//
// Verifies the two new YAML-configurable fields on MaxModeConfig:
//
//   - max-mode checkpoint integration  maxMode.maxCandidates         (default 10, range 1-50)
//         Safety cap on parallel LLM candidates.
//         Was: `export const MAX_CANDIDATES = 10` in candidates.ts:6,
//         enforced at `Math.min(config.n, MAX_CANDIDATES)`.
//         Now: `MaxModeConfig.maxCandidates` (default 10),
//         enforced at `Math.min(config.n, config.maxCandidates ?? 10)`
//         in candidates.ts:114.
//
//   - max-mode chokidar migration  maxMode.judgeDraftMaxChars    (default 8000, range 500-32000)
//         Max chars of each candidate draft sent to the judge.
//         Was: literal `c.draft.slice(0, 8000)` in judge.ts:14.
//         Now: optional 2nd arg to `buildJudgePrompt(candidates, max)`
//         and optional 4th arg to `judgeCandidates(..., max)`,
//         default 8000. Configured via MaxModeConfig.judgeDraftMaxChars.
//
// Reference pattern: `packages/watchdog/test/d2-config.test.ts` (
// migration). All checks use an isolated temp configHome so the user's
// real `~/.config/SFFMC/max-mode.yaml` is never touched.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../../max-mode/src/index";
import { buildJudgePrompt } from "../../max-mode/src/judge";
import { generateCandidates } from "../../max-mode/src/candidates";
import { loadConfig } from "@sffmc/shared";

// ---------------------------------------------------------------------------
// Isolated configHome so we don't pick up the user's real
// ~/.config/SFFMC/max-mode.yaml. Same pattern as watchdog/d2-config.test.ts.
// ---------------------------------------------------------------------------

let tempHome: string | undefined;
let configHome: string | undefined;

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), "sffmc-max-mode-x1x2-"));
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

// ===========================================================================
// max-mode checkpoint integration — maxMode.maxCandidates (safety cap)
// ===========================================================================

describe("max-mode checkpoint integration — maxMode.maxCandidates", () => {
  it("(a) defaultConfig.maxCandidates === 10 (matches v0.14.2 module-level const)", () => {
    expect(defaultConfig.maxCandidates).toBe(10);
  });

  it("(a) loadConfig with no YAML file returns maxCandidates = 10", async () => {
    clearMaxModeYaml();
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.maxCandidates).toBe(10);
  });

  it("(b) YAML override changes the value", async () => {
    writeMaxModeYaml("maxCandidates: 20\n");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.maxCandidates).toBe(20);
  });

  it("(b) YAML override at the plan-stated upper bound (50) flows through", async () => {
    writeMaxModeYaml("maxCandidates: 50\n");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.maxCandidates).toBe(50);
  });

  it("(b) YAML override at the plan-stated lower bound (1) flows through", async () => {
    writeMaxModeYaml("maxCandidates: 1\n");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.maxCandidates).toBe(1);
  });

  it("(c) generateCandidates safety cap clamps n to maxCandidates when n > cap", async () => {
    // Build a 25-candidate request with maxCandidates=4. The safety cap
    // at `Math.min(config.n, config.maxCandidates ?? 10)` must clamp
    // the number of parallel session.message() calls to 4.
    const mockMessage = async () => ({
      content: [{ type: "text" as const, text: "draft" }],
      usage: { totalTokens: 1 },
    });
    const ctx = {
      client: { session: { message: mockMessage } },
      config: { model: "test-model" },
    } as unknown as Parameters<typeof generateCandidates>[2];

    let calls = 0;
    const countingCtx = {
      client: {
        session: {
          message: async () => {
            calls++;
            return {
              content: [{ type: "text" as const, text: "draft" }],
              usage: { totalTokens: 1 },
            };
          },
        },
      },
      config: { model: "test-model" },
    } as unknown as Parameters<typeof generateCandidates>[2];

    const result = await generateCandidates(
      "test",
      { n: 25, models: [], temperature: 1.0, maxCandidates: 4 },
      countingCtx,
    );

    expect(result.length).toBe(4); // clamped
    expect(calls).toBe(4);          // only 4 parallel calls fired
  });

  it("(c) generateCandidates does NOT clamp when n < maxCandidates", async () => {
    // n=3 with maxCandidates=10 → all 3 fire, no clamping.
    let calls = 0;
    const ctx = {
      client: {
        session: {
          message: async () => {
            calls++;
            return {
              content: [{ type: "text" as const, text: "ok" }],
              usage: { totalTokens: 1 },
            };
          },
        },
      },
      config: { model: "test-model" },
    } as unknown as Parameters<typeof generateCandidates>[2];

    const result = await generateCandidates(
      "test",
      { n: 3, models: [], temperature: 1.0, maxCandidates: 10 },
      ctx,
    );

    expect(result.length).toBe(3);
    expect(calls).toBe(3);
  });

  it("(c) generateCandidates uses default fallback (10) when maxCandidates is omitted", async () => {
    // Per user spec: `config.maxCandidates ?? 10` — when the field is
    // omitted from GenerateConfig, the safety cap falls back to 10
    // (matching the prior module-level const).
    let calls = 0;
    const ctx = {
      client: {
        session: {
          message: async () => {
            calls++;
            return {
              content: [{ type: "text" as const, text: "ok" }],
              usage: { totalTokens: 1 },
            };
          },
        },
      },
      config: { model: "test-model" },
    } as unknown as Parameters<typeof generateCandidates>[2];

    // Note: no `maxCandidates` field in the config object.
    const result = await generateCandidates(
      "test",
      { n: 50, models: [], temperature: 1.0 },
      ctx,
    );

    expect(result.length).toBe(10); // fallback cap
    expect(calls).toBe(10);
  });

  it("(c) module-level MAX_CANDIDATES export is removed (max-mode checkpoint integration migration complete)", async () => {
    // The prior `export const MAX_CANDIDATES = 10` constant must be gone.
    const mod = await import("../../max-mode/src/candidates");
    expect((mod as Record<string, unknown>).MAX_CANDIDATES).toBeUndefined();
  });
});

// ===========================================================================
// max-mode chokidar migration — maxMode.judgeDraftMaxChars (per-candidate draft truncation)
// ===========================================================================

describe("max-mode chokidar migration — maxMode.judgeDraftMaxChars", () => {
  const mkCandidate = (draft: string) => ({
    id: "c-0",
    temperature: 1.0,
    draft,
    toolCalls: [],
    tokens: 0,
  });

  it("(a) defaultConfig.judgeDraftMaxChars === 8000 (matches v0.14.2 literal)", () => {
    expect(defaultConfig.judgeDraftMaxChars).toBe(8000);
  });

  it("(a) loadConfig with no YAML file returns judgeDraftMaxChars = 8000", async () => {
    clearMaxModeYaml();
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.judgeDraftMaxChars).toBe(8000);
  });

  it("(a) buildJudgePrompt uses 8000-char default when no second arg passed", () => {
    // The default arg on buildJudgePrompt preserves the v0.14.2 behavior
    // exactly when callers (e.g. agentic/test/max-mode.test.ts) pass
    // only `candidates`.
    const longDraft = "x".repeat(20000);
    const prompt = buildJudgePrompt([mkCandidate(longDraft)]);
    // The truncated draft inside the prompt should be exactly 8000 chars.
    expect(prompt).toContain("x".repeat(8000));
    expect(prompt).not.toContain("x".repeat(8001));
  });

  it("(b) YAML override changes the value", async () => {
    writeMaxModeYaml("judgeDraftMaxChars: 4000\n");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.judgeDraftMaxChars).toBe(4000);
  });

  it("(b) YAML override at the plan-stated lower bound (500) flows through", async () => {
    writeMaxModeYaml("judgeDraftMaxChars: 500\n");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.judgeDraftMaxChars).toBe(500);
  });

  it("(b) YAML override at the plan-stated upper bound (32000) flows through", async () => {
    writeMaxModeYaml("judgeDraftMaxChars: 32000\n");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.judgeDraftMaxChars).toBe(32000);
  });

  it("(c) buildJudgePrompt truncates to the configured judgeDraftMaxChars", () => {
    const longDraft = "a".repeat(20000);
    const prompt = buildJudgePrompt([mkCandidate(longDraft)], 2000);
    expect(prompt).toContain("a".repeat(2000));
    expect(prompt).not.toContain("a".repeat(2001));
    // And the un-truncated portion (after 2000 chars) must NOT appear.
    expect(prompt).not.toContain("a".repeat(2500));
  });

  it("(c) buildJudgePrompt does NOT truncate drafts shorter than the cap", () => {
    const shortDraft = "short answer here";
    const prompt = buildJudgePrompt([mkCandidate(shortDraft)], 8000);
    expect(prompt).toContain("short answer here");
  });

  it("(c) buildJudgePrompt truncates each candidate independently", () => {
    // Both candidates longer than the cap (1500) so both get truncated.
    const candidates = [
      mkCandidate("a".repeat(2500)),
      mkCandidate("b".repeat(3000)),
    ];
    const prompt = buildJudgePrompt(candidates, 1500);
    // First candidate truncated at 1500
    expect(prompt).toContain("a".repeat(1500));
    expect(prompt).not.toContain("a".repeat(1501));
    // Second candidate truncated at 1500 (not 3000)
    expect(prompt).toContain("b".repeat(1500));
    expect(prompt).not.toContain("b".repeat(1501));
  });

  it("(c) buildJudgePrompt preserves candidate headers and tool-call annotation", () => {
    const candidate = { ...mkCandidate("body"), toolCalls: [{ name: "x", args: {}, id: "i" }] };
    const prompt = buildJudgePrompt([candidate], 8000);
    expect(prompt).toContain("### Candidate 0");
    expect(prompt).toContain("body");
    expect(prompt).toContain("Tool calls suggested: 1");
  });
});

// ===========================================================================
// Integration — max-mode checkpoint integration and max-mode chokidar migration together (maxCandidates + judgeDraftMaxChars)
// ===========================================================================

describe("max-mode checkpoint integration+max-mode chokidar migration integration — full MaxModeConfig surface", () => {
  it("YAML overrides both fields at once", async () => {
    writeMaxModeYaml([
      "maxCandidates: 30",
      "judgeDraftMaxChars: 16000",
      "",
    ].join("\n"));
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.maxCandidates).toBe(30);
    expect(cfg.judgeDraftMaxChars).toBe(16000);
  });

  it("YAML can override one field without disturbing the other", async () => {
    writeMaxModeYaml("maxCandidates: 25\n");
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.maxCandidates).toBe(25);
    // judgeDraftMaxChars untouched → default 8000.
    expect(cfg.judgeDraftMaxChars).toBe(8000);
  });

  it("Malformed YAML falls back to defaults (loadConfig never-throws)", async () => {
    writeMaxModeYaml("maxCandidates: not-a-number\n:bad-yaml");
    // loadConfig is never-throw — returns defaults for malformed YAML.
    const cfg = await loadConfig("max-mode", defaultConfig, { configHome });
    expect(cfg.maxCandidates).toBe(10);
    expect(cfg.judgeDraftMaxChars).toBe(8000);
  });
});
