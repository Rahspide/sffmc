// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Check 11: extra_opt_in — `@sffmc/utilities` is now a permanent library
// shipped alongside the 5 plugins (not an opt-in bundle). The old
// "extra opt-in" check looked for `packages/extra/`, which was merged
// into `@sffmc/memory` during the v0.15.0 13→5 consolidation. Stale
// string preserved only for downstream log scrapers that grep for
// "extra_opt_in" — the function returns "ok" unconditionally.

import { createCheck } from "../check-factory.ts"

export const checkExtraOptIn = createCheck("extra_opt_in", async (_repoRoot) => {
  return {
    status: "ok",
    detail: "@sffmc/utilities is now a permanent library (v0.15.0+); no opt-in required",
  }
})
