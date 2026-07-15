// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// WorkflowPersistence class, extracted from persistence.ts per the
// v0.16.0 refactor plan (ora-9, Phase 10). The class composes the
// 8 extracted units (runid, script-sha, journal-key, paths, runs,
// steps, fsync-coalescer, journal, scripts) into the public API that
// runtime.ts and tests consume. persistence.ts becomes a thin barrel
// re-export so existing import sites (`from "./persistence.ts"`) keep
// working unchanged.

import { Database } from "bun:sqlite"
import { defaultFsOps, type FsOps, createLogger } from "@sffmc/utilities"
import { applySchema } from "./schema.ts"
import { getFsyncCoalesceMs } from "./constants.ts"
import { defaultDataDir, dbPathForDir } from "./paths.ts"
import { RunsRepository } from "./runs.ts"
import { StepsRepository } from "./steps.ts"
import { FSyncCoalescer } from "./fsync-coalescer.ts"
import { JournalRepository } from "./journal.ts"
import { ScriptsRepository } from "./scripts.ts"
import type { WorkflowRun, WorkflowStep, JournalEvent, WorkflowStatus } from "./types.ts"

const log = createLogger("workflow:persistence")

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
  /** v0.16.0 refactor (Phase 9): script file IO extracted to `./scripts.ts`. */
  private scriptsRepo: ScriptsRepository
  /** v0.16.0 refactor (Phase 8): journal IO extracted to `./journal.ts`. */
  private journalRepo: JournalRepository

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
      } catch (e) {
        log.debug({ err: e }, "workflow-persistence: db.close failed (best-effort)")
        // best-effort
      }
    }
  }

  // ── Journal fsync coalescing — delegated to FSyncCoalescer (v0.16.0 Phase 7) ──

  flushJournalSync(): void {
    this.fsyncCoalescer.flush()
  }

  /** Test escape hatch (L-3 invariant): the per-instance fsync pending
   *  paths set. Kept for `journal-race.test.ts` which checks that two
   *  WorkflowPersistence instances have independent pending sets. */
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

  async writeScript(runID: string, source: string): Promise<void> {
    return this.scriptsRepo.write(runID, source)
  }

  async readScript(runID: string): Promise<string | null> {
    return this.scriptsRepo.read(runID)
  }

  // ── Journal IO — delegated to JournalRepository (v0.16.0 Phase 8) ──────

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

  checkpointStep(runID: string, step: WorkflowStep): void {
    this.stepsRepo.checkpointStep(runID, step)
  }

  loadCompletedSteps(runID: string): WorkflowStep[] {
    return this.stepsRepo.loadCompletedSteps(runID)
  }
}
