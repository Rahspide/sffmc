// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE

// Workflow runID validation, exported as both a predicate and a
// throwing guard so production paths keep the throwing variant and
// tests can assert with the non-throwing boolean.
//
// Format: `wf_` prefix + 26 base62 chars (matches
// `packages/workflow/src/persistence.ts:generateRunID`'s output, which
// encodes 19 random bytes via base62 and zero-pads to 26 characters).

/** Workflow runID format: `wf_` + 26 base62 characters. */
export const RUN_ID_REGEX = /^wf_[0-9A-Za-z]{26}$/

/** Returns true iff `runID` matches the workflow runID format. Non-throwing
 *  predicate for tests and conditional code paths. */
export function isSafeRunID(runID: string): boolean {
  return RUN_ID_REGEX.test(runID)
}

/** Throws `Error("invalid workflow runID: <json>")` if `runID` does not
 *  match the workflow runID format. Used by `WorkflowPersistence` to
 *  guard path traversal at every `loadRun` / `writeScript` /
 *  `appendJournalSync` boundary. */
export function safeRunID(runID: string): void {
  if (!RUN_ID_REGEX.test(runID)) {
    throw new Error(`invalid workflow runID: ${JSON.stringify(runID)}`)
  }
}
