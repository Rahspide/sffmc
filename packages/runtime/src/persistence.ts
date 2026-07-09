// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Barrel re-export for the persistence layer. v0.16.0 refactor decomposed
// the 543-LOC `persistence.ts` into 10 focused modules (runid, script-sha,
// journal-key, paths, runs, steps, fsync-coalescer, journal, scripts,
// workflow-persistence). This file preserves the original import surface
// (`from "./persistence.ts"`) for the 8+ call sites in runtime.ts and
// the test suite.

export { RUN_ID_REGEX } from "@sffmc/utilities"
export { generateRunID } from "./runid.ts"
export { computeScriptSha } from "./script-sha.ts"
export { journalKeyBase, journalKey } from "./journal-key.ts"
export { defaultDataDir, dbPathForDir, eagerlyPopulateWorkflowConfig } from "./paths.ts"
export { rowToRun, RunsRepository } from "./runs.ts"
export { StepsRepository } from "./steps.ts"
export { FSyncCoalescer } from "./fsync-coalescer.ts"
export { JournalRepository } from "./journal.ts"
export { ScriptsRepository } from "./scripts.ts"
export { WorkflowPersistence } from "./workflow-persistence.ts"
import { eagerlyPopulateWorkflowConfig } from "./paths.ts"
eagerlyPopulateWorkflowConfig()
