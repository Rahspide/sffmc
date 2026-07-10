// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

import type { Candidate } from "./candidates";
import type { Verdict } from "./judge";
import type { createRestoreState } from "./restore";

/**
 * Tunable knobs for the max-mode plugin. All fields are user-overridable
 * via `~/.config/SFFMC/max-mode.yaml`. Defaults match the prior hardcoded
 * values — see CHANGELOG.md v0.14.5 for the migration history.
 */
export interface MaxModeConfig {
  n_candidates: number;
  candidate_models: string[];
  candidate_temperature: number;
  judge_model: string;
  budget_cap_multiplier: number;
  dry_run: boolean;
    // the v0.14.x hardcode migration plan (file not in git; see CHANGELOG.md v0.14.5) §2.6
  /** max-mode checkpoint integration — hard cap on the number of parallel LLM candidates. Safety
   *  limit: prevents accidental bursts (e.g. `n_candidates: 100` firing
   *  100 parallel API calls). Enforced at runtime as
   *  `Math.min(config.n, maxCandidates)`. Default 10 matches the prior
   *  module-level const. Validation: 1 ≤ x ≤ 50. */
  maxCandidates: number;
    // the v0.14.x hardcode migration plan (file not in git; see CHANGELOG.md v0.14.5) §2.6
  /** max-mode chokidar migration — max chars of each candidate draft sent to the judge. Truncates
   *  long drafts before they enter the judge prompt so a 50-candidate
   *  batch × 8k draft stays under the model's context window. Default
   *  8000 matches the prior literal. Validation: 500 ≤ x ≤ 32000. */
  judgeDraftMaxChars: number;
    // the v0.14.x hardcode migration plan (file not in git; see CHANGELOG.md v0.14.5) §3.max-mode dream integration
  /** max-mode dream integration — confidence value stamped on the verdict whenever the judge path
   *  falls back (SDK offline, parse error, or empty/invalid response).
   *  Semantically distinct from a judge-reported confidence: a verdict
   *  produced under fallback tells downstream consumers "we have no real
   *  judge opinion" rather than "the judge rated this X%". Default 0.3
   *  matches the prior literal in fallbackVerdict(). Validation:
   *  0 ≤ x ≤ 1 (finite, not NaN/Infinity). */
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
  maxCandidates: 10,        // max-mode checkpoint integration (was `export const MAX_CANDIDATES = 10`)
  judgeDraftMaxChars: 8000, // max-mode chokidar migration (was `c.draft.slice(0, 8000)` literal)
  fallbackConfidence: 0.3,  // max-mode dream integration (was hardcoded `confidence: 0.3` in fallbackVerdict)
};

export interface MaxModeResult {
  winner: Candidate;
  verdict: Verdict;
  message: string;
}

export interface PluginState {
  config: MaxModeConfig;
  restore: ReturnType<typeof createRestoreState>;
  maxUsedThisSession: boolean;
  /** Pending one-shot verdict per session. Consumed (and deleted) by whichever
   *  chat transform fires  (system or messages) for that session.
   *  Per-instance — was previously stashed on ctx (`pendingResults`), which
   *  leaked across sessions in long-running processes. */
  pendingResults: Map<string, MaxModeResult>;
}

export function estimateCost(candidates: Candidate[]): number {
  return candidates.reduce((sum, c) => sum + c.tokens, 0);
}
