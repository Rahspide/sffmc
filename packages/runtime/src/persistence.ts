// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { Database } from "bun:sqlite"
import { randomBytes, createHash } from "node:crypto"
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
// RunID generation (base62)
// ---------------------------------------------------------------------------

const log = createLogger("workflow:persistence")

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function base62Encode(bytes: Uint8Array): string {
  let num = 0n
  for (const b of bytes) {
    num = (num << 8n) | BigInt(b)
  }
  if (num === 0n) return BASE62[0]
  let result = ""
  while (num > 0n) {
    result = BASE62[Number(num % 62n)] + result
    num /= 62n
  }
  return result
}

export function generateRunID(): string {
  // 19 bytes → up to 26 base62 chars; pad with leading zeros if needed
  const bytes = randomBytes(19)
  let id = base62Encode(bytes)
  while (id.length < 26) id = "0" + id
  return "wf_" + id.slice(0, 26)
}

// ---------------------------------------------------------------------------
// Compute script SHA
// ---------------------------------------------------------------------------

export function computeScriptSha(source: string): string {
  return createHash("sha256").update(source).digest("hex")
}

// ---------------------------------------------------------------------------
// Canonical key for journal dedup
// ---------------------------------------------------------------------------

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonical)
  const rec = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(rec)
      .sort()
      .map((k) => [k, canonical(rec[k])]),
  )
}

export function journalKeyBase(
  prompt: string,
  opts: { agentType?: string; model?: unknown; schema?: unknown; phase?: string; [k: string]: unknown },
): string {
  const material = canonical({
    prompt,
    agentType: opts.agentType ?? null,
    model: opts.model ?? null,
    schema: opts.schema ?? null,
    phase: opts.phase ?? null,
  })
  return createHash("sha256").update(JSON.stringify(material)).digest("hex")
}

export function journalKey(
  prompt: string,
  opts: { agentType?: string; model?: unknown; schema?: unknown; phase?: string; [k: string]: unknown },
  occ: number,
): string {
  return journalKeyBase(prompt, opts) + ":" + occ
}

// ---------------------------------------------------------------------------
// Default paths (used when no explicit dataDir provided)
// ---------------------------------------------------------------------------
//
// `WorkflowConfig.dataDir`. The override (via `getWorkflowDataDir()`) wins
// over the XDG / `~/.local/share` default. The override is empty string by
// default — the empty case falls through to the original XDG lookup so
// behavior is unchanged when no YAML is provided.

function defaultDataDir(): string {
    const override = getWorkflowDataDir()
  if (override && override.trim().length > 0) return override
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) return path.join(xdg, "SFFMC", "workflow")
  return path.join(homedir(), ".local", "share", "SFFMC", "workflow")
}

/** Eagerly populate the workflow config cache at module-load time so
 *  `getWorkflowDataDir()` returns the YAML override (if any) on the
 *   call to `defaultDataDir()`. Failure is non-fatal: the sync
 *  getter falls back to the hardcoded XDG default. */
void ensureWorkflowConfig().catch(() => {
  // Best-effort — the sync getter's fallback handles the failure case.
})

function dbPathForDir(dir: string): string {
  return path.join(dir, getDbFilename())
}

// ---------------------------------------------------------------------------
// Helper: row → WorkflowRun
// ---------------------------------------------------------------------------

function rowToRun(row: Record<string, unknown>): WorkflowRun {
  return {
    runID: row.id as string,
    name: row.name as string,
    status: row.status as WorkflowStatus,
    running: row.running as number,
    succeeded: row.succeeded as number,
    failed: row.failed as number,
    currentPhase: (row.current_phase as string) || undefined,
    parentRunID: (row.parent_run_id as string) || undefined,
    args: (() => { try { return row.args ? JSON.parse(row.args as string) : undefined } catch { return undefined } })(),
    scriptSha: (row.script_sha as string) || undefined,
    agentTimeoutMs: (row.agent_timeout_ms as number) || undefined,
    error: (row.error as string) || undefined,
    workspace: (row.workspace as string) || undefined,
    createdAt: row.time_created as number,
    updatedAt: row.time_updated as number,
  }
}

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
  /** Per-instance journal paths awaiting fsync (L-3, Task 2.7). Replaces the
   *  module-level `fsyncPendingPaths` Set that previously leaked state
   *  between tests and across multi-instance scenarios. Initialised lazily
   *  in `appendJournalSync()` so the common no-append path costs zero
   *  memory. */
  private fsyncPendingPaths: Set<string> | null = null
  /** Per-instance coalesce timer for the fsync window (L-3, Task 2.7). Null
   *  when no fsync is pending; `setTimeout` handle while the 50ms window is
   *  open. Per-instance so concurrent persistence instances don't share or
   *  cancel each other's timers. */
  private fsyncTimer: ReturnType<typeof setTimeout> | null = null

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

  // ── Journal fsync coalescing (per-instance, L-3) ──────────────────────

  /** Arm a coalesced fsync if one isn't already pending. Idempotent —
   *  multiple `appendJournalSync()` calls within the 50ms window collapse
   *  to a single fsync that drains all pending paths. The `unref()` call
   *  lets the process exit even if a coalesce window is open. */
  private scheduleFsync(): void {
    if (this.fsyncTimer !== null) return
    this.fsyncTimer = setTimeout(() => this.flushFsync(), getFsyncCoalesceMs())
    this.fsyncTimer.unref?.()
  }

  /** Drain this instance's pending fsync set. Each path is opened RDONLY,
   *  fsync'd, and closed — the RDONLY open is sufficient because fsync
   *  flushes the kernel's page cache for that inode, which is the durable
   *  surface that subsequent reads will see. Failures (file removed
   *  mid-coalesce, EACCES) are best-effort and silently dropped; the
   *  in-memory journal data is already durable from the perspective of a
   *  reader who re-opens the file. */
  private flushFsync(): void {
    if (this.fsyncTimer !== null) {
      clearTimeout(this.fsyncTimer)
      this.fsyncTimer = null
    }
    if (!this.fsyncPendingPaths || this.fsyncPendingPaths.size === 0) return
    const paths = this.fsyncPendingPaths
    this.fsyncPendingPaths = null
    for (const p of paths) {
      let fd: number
      try {
        fd = openSync(p, "r")
      } catch {
        continue // best-effort: file may have been removed
      }
      try {
        fsyncSync(fd)
      } catch {
        // best-effort: surface in debug only
      } finally {
        try { closeSync(fd) } catch { /* ignore */ }
      }
    }
  }

  /** Force fsync of all pending journal writes for THIS instance. Call
   *  before returning from a workflow lifecycle event (end, cancel,
   *  recovery) to guarantee durability. Per-instance so callers never
   *  trigger a process-wide flush (L-3, Task 2.7). */
  flushJournalSync(): void {
    this.flushFsync()
  }

  // ── Run CRUD ──────────────────────────────────────────────────────────

  createRun(
    file: string,
    label: string,
    scriptSha: string,
    parentId?: string,
    workspace?: string,
    args?: unknown,
  ): string {
    const runID = generateRunID()
    const now = unixNow()
    // JSON-stringify args before insert so undefined → NULL (column is TEXT).
    // Anything else (object/array/primitive) round-trips through rowToRun's
    // JSON.parse. NULL means "no args" — resume() will pass null to the
    // guest, which is the historical pre-fix behavior.
    const argsJson = args === undefined ? null : JSON.stringify(args)
    this.db.run(
      `INSERT INTO workflow_runs (id, name, status, running, succeeded, failed, script_sha, parent_run_id, workspace, args, time_created, time_updated)
       VALUES (?, ?, 'running', 0, 0, 0, ?, ?, ?, ?, ?, ?)`,
      [runID, label, scriptSha, parentId ?? null, workspace ?? null, argsJson, now, now],
    )
    return runID
  }

  loadRun(runID: string): WorkflowRun | null {
    safeRunID(runID)
    const row = this.db.query("SELECT * FROM workflow_runs WHERE id = ?").get(runID) as Record<string, unknown> | undefined
    return row ? rowToRun(row) : null
  }

  updateRunStatus(runID: string, status: WorkflowStatus, error?: string): void {
    safeRunID(runID)
    const now = unixNow()
    this.db.run(
      `UPDATE workflow_runs SET status = ?, error = ?, time_updated = ? WHERE id = ?`,
      [status, error ?? null, now, runID],
    )
  }

  listRuns(): WorkflowRun[] {
    const rows = this.db.query("SELECT * FROM workflow_runs ORDER BY time_created DESC").all() as Record<string, unknown>[]
    return rows.map(rowToRun)
  }

  /** Return only runs with status='running'. Used by recoverOrphanedWorkflows()
   *  on startup to find orphaned workflows that need to be marked as
   *  'paused' (journal replay possible) or 'crashed' (no journal). */
  listRunningRuns(): WorkflowRun[] {
    const rows = this.db
      .query("SELECT * FROM workflow_runs WHERE status = 'running' ORDER BY time_created DESC")
      .all() as Record<string, unknown>[]
    return rows.map(rowToRun)
  }

  // ── Script file IO ─────────────────────────────────────────────────────

  private scriptPath(runID: string): string {
    safeRunID(runID)
    return path.join(this.dir, `${runID}${getWorkflowConfigSync().scriptExt}`)
  }

  async writeScript(runID: string, source: string): Promise<void> {
    safeRunID(runID)
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await writeFile(this.scriptPath(runID), source, "utf-8")
  }

  async readScript(runID: string): Promise<string | null> {
    safeRunID(runID)
    try {
      return await readFile(this.scriptPath(runID), "utf-8")
    } catch {
      return null
    }
  }

  // ── Journal IO (JSONL appended) ────────────────────────────────────────

  private journalPath(runID: string): string {
    safeRunID(runID)
    return path.join(this.dir, `${runID}${getWorkflowConfigSync().journalExt}`)
  }

  /** Cheap pre-check: does the journal file exist and have at least one byte?
   *  Used by recoverOrphanedWorkflows() to decide 'paused' vs 'crashed'. */
  async hasJournalEvents(runID: string): Promise<boolean> {
    safeRunID(runID)
    try {
      const s = await stat(this.journalPath(runID))
      return s.size > 0
    } catch {
      return false // file doesn't exist
    }
  }

  /** Synchronous journal append — durable before the sandbox pump can be starved.
   *  fsync is coalesced via a 50ms timer; call `this.flushJournalSync()`
   *  for explicit durability at workflow lifecycle boundaries.
   *  Writes a v1 header (`{"v":1}`) on the  append to a new journal
   *  file. v0 journals (no header) remain backward-compatible — loadJournal
   *  distinguishes header lines by the absence of a `t` field.
   *
   *  L-3 (Task 2.7): pending-fsync state lives on the instance, not at
   *  module scope — appends only enqueue fsync on THIS persistence's set. */
  appendJournalSync(runID: string, event: JournalEvent): void {
    safeRunID(runID)
    this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const jpath = this.journalPath(runID)
    if (!this.fs.exists(jpath)) {
      //  append: write v1 header so future readers can detect format
      this.fs.appendFile(jpath, JSON.stringify({ v: 1 }) + "\n")
    }
    this.fs.appendFile(jpath, JSON.stringify(event) + "\n")
    if (this.fsyncPendingPaths === null) this.fsyncPendingPaths = new Set()
    this.fsyncPendingPaths.add(jpath)
    this.scheduleFsync()
  }

  /** Async journal append — for log/phase events. */
  async appendJournal(runID: string, event: JournalEvent): Promise<void> {
    safeRunID(runID)
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await appendFile(this.journalPath(runID), JSON.stringify(event) + "\n")
  }

  async loadJournal(
    runID: string,
  ): Promise<{ results: Map<string, unknown>; pass: number }> {
    safeRunID(runID)
    const results = new Map<string, unknown>()
    let maxPass = 0
    let headerSeen = false
    let lineNo = 0
    try {
      const stream = createReadStream(this.journalPath(runID), { encoding: "utf-8" })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of rl) {
        lineNo++
        if (!line) continue
        // v0.14.x — validate every parsed event against the
        // JournalEvent discriminated union. Torn JSON lines (truncated by
        // a crash mid-append), unknown event types, and missing required
        // fields are all skipped silently with a structured debug log,
        // matching the existing torn-line skip behavior but with explicit
        // reason capture.
        const v = validateJournalEvent(line, lineNo)
        if (!v.ok) {
          // `v.error.error === "v1 header line, not an event"` is a
          // non-error case (intentional format marker) — skip silently.
          // Everything else (malformed JSON, unknown `t`, missing fields)
          // gets a debug log.
          if (!v.error.error.startsWith("v1 header line")) {
            log.debug(
              `loadJournal(${runID}): skipping malformed event at line ${v.error.line}: ${v.error.error}`,
            )
          } else {
            headerSeen = true
          }
          continue
        }
        const je = v.event
        if (je.pass > maxPass) maxPass = je.pass
        if (je.t === "agent") results.set(je.key, je.result)
      }
    } catch {
      // file doesn't exist — empty results
    }
    void headerSeen // reserved for future v0→v1 migration diagnostics
    return { results, pass: maxPass + 1 }
  }

  /** Clear the journal (truncate to v1 header). Used on sha-mismatch resume.
   *  Writes `{"v":1}\n` instead of "" so that a concurrent appendJournalSync
   *  within the 50ms fsync coalesce window does not land a raw event as the
   *   line of the file (which loadJournal would treat as a torn header
   *  and silently skip). See journal audit. */
  async clearJournal(runID: string): Promise<void> {
    safeRunID(runID)
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const jpath = this.journalPath(runID)
    await writeFile(jpath, JSON.stringify({ v: 1 }) + "\n", "utf-8")
  }

  // ── Step checkpoint IO (atomic BEGIN EXCLUSIVE/COMMIT) ─────────────────

  checkpointStep(runID: string, step: WorkflowStep): void {
    safeRunID(runID)
    this.db.run("BEGIN EXCLUSIVE")
    try {
      this.db.run(
        `INSERT INTO workflow_steps (run_id, step_index, kind, input_prompt, output_result, cost_tokens, duration_ms, error, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, step_index) DO UPDATE SET
           output_result = excluded.output_result,
           cost_tokens = excluded.cost_tokens,
           duration_ms = excluded.duration_ms,
           error = excluded.error`,
        [
          runID,
          step.stepIndex,
          step.kind,
          step.input ?? null,
          step.output ?? null,
          step.costTokens,
          step.durationMs,
          step.error ?? null,
          step.timestamp,
        ],
      )
      this.db.run(
        `UPDATE workflow_runs SET time_updated = ? WHERE id = ?`,
        [unixNow(), runID],
      )
      this.db.run("COMMIT")
    } catch (e) {
      this.db.run("ROLLBACK")
      throw e
    }
  }

  loadCompletedSteps(runID: string): WorkflowStep[] {
    safeRunID(runID)
    const rows = this.db
      .query("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY step_index")
      .all(runID) as Record<string, unknown>[]
    return rows.map((row) => ({
      runID: row.run_id as string,
      stepIndex: row.step_index as number,
      kind: row.kind as WorkflowStep["kind"],
      input: (row.input_prompt as string) || undefined,
      output: (row.output_result as string) || undefined,
      costTokens: row.cost_tokens as number,
      durationMs: row.duration_ms as number,
      error: (row.error as string) || undefined,
      timestamp: row.timestamp as number,
    }))
  }
}
