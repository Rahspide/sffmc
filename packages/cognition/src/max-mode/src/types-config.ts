// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

/**
 * Shared types, config and per-plugin state for the max-mode plugin.
 * Kept in its own module so sub-modules (message-builder, plugin, injection-guard)
 * can import types without dragging in the SDK hook surface.
 */

export interface MaxModeConfig {
  n_candidates: number;
  candidate_models: string[];
  candidate_temperature: number;
  judge_model: string;
  budget_cap_multiplier: number;
  dry_run: boolean;
  /** max-mode checkpoint integration — hard cap on parallel LLM candidates.
   *  Safety limit (e.g. `n_candidates: 100` ⇒ 100 parallel API calls). Enforced
   *  at runtime as `Math.min(config.n, maxCandidates)`. Default 10 matches
   *  the prior module-level const. Validation: 1 ≤ x ≤ 50. */
  maxCandidates: number;
  /** max-mode chokidar migration — max chars of each candidate draft sent to
   *  the judge. Truncates long drafts so a 50-candidate batch × 8k draft
   *  stays under the model's context window. Default 8000. Validation:
   *  500 ≤ x ≤ 32000. */
  judgeDraftMaxChars: number;
  /** max-mode dream integration — confidence stamped on fallback verdicts
   *  (SDK offline, parse error, empty/invalid response). Semantically distinct
   *  from judge-reported confidence: fallback tells consumers "we have no
   *  real judge opinion". Default 0.3. Validation: 0 ≤ x ≤ 1 (finite). */
  fallbackConfidence: number;
}

export const defaultConfig: MaxModeConfig = {
  n_candidates: 3,
  candidate_models: [],
  candidate_temperature: 1.0,
  judge_model: "",
  budget_cap_multiplier: 5,
  dry_run: false,
  // Defaults match the prior hardcoded values — behavior unchanged
  // when no ~/.config/SFFMC/max-mode.yaml is present.
  maxCandidates: 10,        // (was `export const MAX_CANDIDATES = 10`)
  judgeDraftMaxChars: 8000, // (was `c.draft.slice(0, 8000)` literal)
  fallbackConfidence: 0.3,  // (was hardcoded `confidence: 0.3` in fallbackVerdict)
};

export interface MaxModeResult {
  winner: Candidate;
  verdict: Verdict;
  message: string;
}

/** Pending one-shot verdict per session. Consumed (and deleted) by whichever
 *  chat transform fires (system or messages) for that session.
 *  Per-instance — was previously stashed on ctx (`pendingResults`), which
 *  leaked across sessions in long-running processes. */
export interface PluginState {
  config: MaxModeConfig;
  restore: ReturnType<typeof import("./restore").createRestoreState>;
  maxUsedThisSession: boolean;
  pendingResults: Map<string, MaxModeResult>;
}

// Local type-only imports to keep this file dependency-free for callers
// that just want MaxModeConfig / defaultConfig.
import type { Candidate } from "./candidates";
import type { Verdict } from "./judge";