// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { createReadStream, openSync, fsyncSync, closeSync } from "node:fs"
import { readFile, writeFile, appendFile, mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { createInterface } from "node:readline"
import type { WorkflowRun, WorkflowStep, JournalEvent, WorkflowStatus } from "./types.ts"
import { applySchema } from "./schema.ts"
import { ensureWorkflowConfig, getDbFilename, getFsyncCoalesceMs, getWorkflowConfigSync, getWorkflowDataDir } from "./constants.ts"
import { validateJournalEvent } from "./schema-journal.ts"
import { createLogger, defaultFsOps, type FsOps, safeRunID, unixNow } from "@sffmc/utilities"
// Re-exported so existing test consumers (e.g. `foundation.test.ts`,
// `v0-14-3-schema-journal.test.ts`, `runtime-coverage.test.ts`) that
// imported `RUN_ID_REGEX` directly from `./persistence.ts` keep working.
// The canonical home is `@sffmc/utilities`'s `safe-run-id.ts`.
export { RUN_ID_REGEX } from "@sffmc/utilities"

// ---------------------------------------------------------------------------
// RunID generation (base62) — extracted to ./runid.ts (v0.16.0 Phase 1)
// ---------------------------------------------------------------------------

const log = createLogger("workflow:persistence")

export { generateRunID } from "./runid.ts"

// ---------------------------------------------------------------------------
// Compute script SHA — extracted to ./script-sha.ts (v0.16.0 Phase 2)
// ---------------------------------------------------------------------------

export { computeScriptSha } from "./script-sha.ts"

// ---------------------------------------------------------------------------
// Canonical key for journal dedup — extracted to ./journal-key.ts (v0.16.0 Phase 3)
// ---------------------------------------------------------------------------

export { journalKeyBase, journalKey } from "./journal-key.ts"

// ---------------------------------------------------------------------------
// Default paths (used when no explicit dataDir provided)
// Extracted to ./paths.ts (v0.16.0 Phase 4)
// ---------------------------------------------------------------------------

import { defaultDataDir, dbPathForDir, eagerlyPopulateWorkflowConfig } from "./paths.ts"
eagerlyPopulateWorkflowConfig()
export { defaultDataDir, dbPathForDir, eagerlyPopulateWorkflowConfig } from "./paths.ts"

// ---------------------------------------------------------------------------
// Helper: row → WorkflowRun — extracted to ./runs.ts (v0.16.0 Phase 5)
// ---------------------------------------------------------------------------

import { rowToRun, RunsRepository } from "./runs.ts"
import { StepsRepository } from "./steps.ts"
import { FSyncCoalescer } from "./fsync-coalescer.ts"
import { JournalRepository } from "./journal.ts"
import { ScriptsRepository } from "./scripts.ts"
export { rowToRun, RunsRepository } from "./runs.ts"

// ---------------------------------------------------------------------------
// Journal fsync coalescing
// ---------------------------------------------------------------------------
// High-frequency appendJournalSync callers (e.g. 100+ events per workflow)
// would otherwise fsync per append, costing O(n) syscalls. Coalesce fsync
// calls within a small window: each append schedules a deferred fsync that
// fires once per window across all tracked paths. Callers needing durability
// before returning (workflow end, recovery) must call
// `persistence.flushJournalSync()` explicitly.
//
// L-3 (Task 2.7): fsync state was previously module-level (one shared Set +
// one shared timer across the process). This caused two problems for
// testability: (1) tests for unrelated appendJournalSync paths polluted the
// shared Set, (2) `flushJournalSync()` at module scope was a process-wide
// force-flush — calling it from one test would fsync another test's pending
// paths, hiding regressions. Promoted to per-instance fields on
// `WorkflowPersistence` so each instance tracks and flushes its own pending
// paths. `fsyncCoalesceMs` now reads from `getFsyncCoalesceMs()` so user
// YAML overrides take effect (closes the deferred wiring contract in
// `phase2-batch-c-w22-fsync.test.ts`).

// ---------------------------------------------------------------------------
// WorkflowPersistence class
// ---------------------------------------------------------------------------

export class WorkflowPersistence {
  private db: Database
  private dir: string
  private _owned: boolean
  /** Sync filesystem layer for mkdir/exists/appendFile in the sync code
   *  paths (constructor, `appendJournalSync`). Defaults to `defaultFsOps`;
   *  tests can inject `createMockFsOps()` to keep the entire persistence
   *  instance off the real disk. The async paths (writeScript,
   *  readScript, appendJournal, loadJournal) keep using `node:fs/promises`
   *  directly — abstracting those into an FsOpsAsync would require a
   *  separate async interface and broader refactor (see audit report
   *  §Easy-Win: constructor-inject WorkflowPersistence). */
  private fs: FsOps
  /** v0.16.0 refactor (Phase 7): fsync coalescing extracted to `FSyncCoalescer`. */
  private fsyncCoalescer: FSyncCoalescer
  /** v0.16.0 refactor (Phase 5): run CRUD repository extracted to `./runs.ts`. */
  private runsRepo: RunsRepository
  /** v0.16.0 refactor (Phase 6): step CRUD repository extracted to `./steps.ts`. */
  private stepsRepo: StepsRepository

  /**
   * Create a persistence instance.
   *
   * @param opts.db      Optional external Database (e.g. `:memory:` for tests).
   *                     When provided, the schema is NOT applied — caller is
   *                     responsible for calling `applySchema()` .
   * @param opts.dataDir Optional data directory for file-based artifacts
   *                     (scripts, journals). Defaults to XDG_DATA_HOME or
   *                     ~/.local/share/SFFMC/workflow.
   * @param opts.fs      Sync filesystem layer (mkdir/exists/appendFile).
   *                     Defaults to `defaultFsOps`. Tests can pass
   *                     `createMockFsOps()` for in-memory journaling.
   */
  constructor(opts?: { db?: Database; dataDir?: string; fs?: FsOps }) {
    this.dir = opts?.dataDir ?? defaultDataDir()
    this.fs = opts?.fs ?? defaultFsOps
    if (opts?.db) {
      this.db = opts.db
      this._owned = false
    } else {
      this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
      this.db = new Database(dbPathForDir(this.dir))
      applySchema(this.db)
      this._owned = true
    }
    this.runsRepo = new RunsRepository(this.db)
    this.stepsRepo = new StepsRepository(this.db)
    this.fsyncCoalescer = new FSyncCoalescer(getFsyncCoalesceMs)
    this.scriptsRepo = new ScriptsRepository(this.dir)
    this.journalRepo = new JournalRepository(
      this.dir,
      this.fs,
      (jpath: string) => this.fsyncCoalescer.add(jpath),
    )
  }

  /** Data directory used for file artifacts. */
  get dataDir(): string {
    return this.dir
  }

  /** Path to the SQLite database file. */
  get dbPath(): string {
    return dbPathForDir(this.dir)
  }

  /** Raw Database handle — for low-level DB access. */
  getDB(): Database {
    return this.db
  }

  /** Close the database connection (only if internally owned). */
  close(): void {
    if (this._owned) {
      try {
        this.db.close()
      } catch {
        // best-effort
      }
    }
  }

  // ── Journal fsync coalescing — delegated to FSyncCoalescer (v0.16.0 Phase 7) ──

  /** Arm a coalesced fsync if one isn't already pending. Delegates to
   *  FSyncCoalescer (L-3, Task 2.7). */
  private scheduleFsync(path: string): void {
    this.fsyncCoalescer.add(path)
  }

  /** Drain this instance's pending fsync set. */
  private flushFsync(): void {
    this.fsyncCoalescer.flush()
  }

  /** Force fsync of all pending journal writes for THIS instance. Call
   *  before returning from a workflow lifecycle event (end, cancel,
   *  recovery) to guarantee durability. Per-instance so callers never
   *  trigger a process-wide flush (L-3, Task 2.7). */
  flushJournalSync(): void {
    this.fsyncCoalescer.flush()
  }

  /** Test escape hatch (L-3 invariant): the per-instance fsync pending
   *  paths set. Kept for `journal-race.test.ts` which checks that two
   *  WorkflowPersistence instances have independent pending sets
   *  (i.e. B.flushJournalSync() does not drain A's set). Delegates to
   *  the FSyncCoalescer — the field is owned there now but the test
   *  contract is unchanged. */
  get fsyncPendingPaths(): Set<string> | null {
    return this.fsyncCoalescer.paths()
  }

  // ── Run CRUD — delegated to RunsRepository (v0.16.0 Phase 5) ──────────

  createRun(
    file: string,
    label: string,
    scriptSha: string,
    parentId?: string,
    workspace?: string,
    args?: unknown,
  ): string {
    return this.runsRepo.createRun(file, label, scriptSha, parentId, workspace, args)
  }

  loadRun(runID: string): WorkflowRun | null {
    return this.runsRepo.loadRun(runID)
  }

  updateRunStatus(runID: string, status: WorkflowStatus, error?: string): void {
    this.runsRepo.updateRunStatus(runID, status, error)
  }

  listRuns(): WorkflowRun[] {
    return this.runsRepo.listRuns()
  }

  listRunningRuns(): WorkflowRun[] {
    return this.runsRepo.listRunningRuns()
  }

  // ── Script file IO — delegated to ScriptsRepository (v0.16.0 Phase 9) ───

  private scriptsRepo: ScriptsRepository

  async writeScript(runID: string, source: string): Promise<void> {
    return this.scriptsRepo.write(runID, source)
  }

  async readScript(runID: string): Promise<string | null> {
    return this.scriptsRepo.read(runID)
  }

  // ── Journal IO — delegated to JournalRepository (v0.16.0 Phase 8) ──────

  private journalRepo: JournalRepository

  async hasJournalEvents(runID: string): Promise<boolean> {
    return this.journalRepo.hasJournalEvents(runID)
  }

  appendJournalSync(runID: string, event: JournalEvent): void {
    this.journalRepo.appendSync(runID, event)
  }

  async appendJournal(runID: string, event: JournalEvent): Promise<void> {
    return this.journalRepo.append(runID, event)
  }

  async loadJournal(
    runID: string,
  ): Promise<{ results: Map<string, unknown>; pass: number }> {
    return this.journalRepo.load(runID)
  }

  async clearJournal(runID: string): Promise<void> {
    return this.journalRepo.clear(runID)
  }

  // ── Step CRUD — delegated to StepsRepository (v0.16.0 Phase 6) ─────────

  private stepsRepo: StepsRepository

  checkpointStep(runID: string, step: WorkflowStep): void {
    this.stepsRepo.checkpointStep(runID, step)
  }

  loadCompletedSteps(runID: string): WorkflowStep[] {
    return this.stepsRepo.loadCompletedSteps(runID)
  }
}
