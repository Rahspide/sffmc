// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { Database } from "bun:sqlite"
import { randomBytes, createHash } from "node:crypto"
import { mkdirSync, appendFileSync, createReadStream, openSync, fsyncSync, closeSync, existsSync } from "node:fs"
import { readFile, writeFile, appendFile, mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { createInterface } from "node:readline"
import type { WorkflowRun, WorkflowStep, JournalEvent, WorkflowStatus } from "./types.ts"
import { applySchema } from "./schema.ts"
import { ensureWorkflowConfig, getWorkflowDataDir } from "./constants.ts"
import { validateJournalEvent } from "./schema-journal.ts"
import { createLogger } from "@sffmc/shared"

// ---------------------------------------------------------------------------
// RunID generation (base62)
// ---------------------------------------------------------------------------

export const RUN_ID_REGEX = /^wf_[0-9A-Za-z]{26}$/

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
// Security: runID validation
// ---------------------------------------------------------------------------

function safeRunID(runID: string): void {
  if (!RUN_ID_REGEX.test(runID)) {
    throw new Error(`invalid workflow runID: ${JSON.stringify(runID)}`)
  }
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
// Phase-1 HIGH migration (W20): the data directory can be overridden via
// `WorkflowConfig.dataDir`. The override (via `getWorkflowDataDir()`) wins
// over the XDG / `~/.local/share` default. The override is empty string by
// default — the empty case falls through to the original XDG lookup so
// behavior is unchanged when no YAML is provided.

function defaultDataDir(): string {
  // Phase-1 HIGH migration (W20): prefer the YAML-config override if set.
  const override = getWorkflowDataDir()
  if (override && override.trim().length > 0) return override
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) return path.join(xdg, "SFFMC", "workflow")
  return path.join(homedir(), ".local", "share", "SFFMC", "workflow")
}

/** Eagerly populate the workflow config cache at module-load time so
 *  `getWorkflowDataDir()` returns the YAML override (if any) on the
 *  first call to `defaultDataDir()`. Failure is non-fatal: the sync
 *  getter falls back to the hardcoded XDG default. */
void ensureWorkflowConfig().catch(() => {
  // Best-effort — the sync getter's fallback handles the failure case.
})

function dbPathForDir(dir: string): string {
  return path.join(dir, "state.sqlite")
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
// before returning (workflow end, recovery) must call flushJournalSync()
// explicitly.

let fsyncPendingPaths: Set<string> | null = null
let fsyncTimer: ReturnType<typeof setTimeout> | null = null
const FSYNC_COALESCE_MS = 50

function scheduleFsync(): void {
  if (fsyncTimer !== null) return
  fsyncTimer = setTimeout(flushFsync, FSYNC_COALESCE_MS)
  fsyncTimer.unref?.()
}

function flushFsync(): void {
  if (fsyncTimer !== null) {
    clearTimeout(fsyncTimer)
    fsyncTimer = null
  }
  if (!fsyncPendingPaths || fsyncPendingPaths.size === 0) return
  const paths = fsyncPendingPaths
  fsyncPendingPaths = null
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

/** Force fsync of all pending journal writes. Call before returning from a
 *  workflow lifecycle event (end, cancel, recovery) to guarantee durability. */
export function flushJournalSync(): void {
  flushFsync()
}

// ---------------------------------------------------------------------------
// WorkflowPersistence class
// ---------------------------------------------------------------------------

export class WorkflowPersistence {
  private db: Database
  private dir: string
  private _owned: boolean

  /**
   * Create a persistence instance.
   *
   * @param opts.db      Optional external Database (e.g. `:memory:` for tests).
   *                     When provided, the schema is NOT applied — caller is
   *                     responsible for calling `applySchema()` first.
   * @param opts.dataDir Optional data directory for file-based artifacts
   *                     (scripts, journals). Defaults to XDG_DATA_HOME or
   *                     ~/.local/share/SFFMC/workflow.
   */
  constructor(opts?: { db?: Database; dataDir?: string }) {
    this.dir = opts?.dataDir ?? defaultDataDir()
    if (opts?.db) {
      this.db = opts.db
      this._owned = false
    } else {
      mkdirSync(this.dir, { recursive: true })
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

  // ── Run CRUD ──────────────────────────────────────────────────────────

  createRun(file: string, label: string, scriptSha: string, parentId?: string, workspace?: string): string {
    const runID = generateRunID()
    const now = Math.floor(Date.now() / 1000)
    this.db.run(
      `INSERT INTO workflow_runs (id, name, status, running, succeeded, failed, script_sha, parent_run_id, workspace, time_created, time_updated)
       VALUES (?, ?, 'running', 0, 0, 0, ?, ?, ?, ?, ?)`,
      [runID, label, scriptSha, parentId ?? null, workspace ?? null, now, now],
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
    const now = Math.floor(Date.now() / 1000)
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
    return path.join(this.dir, `${runID}.js`)
  }

  async writeScript(runID: string, source: string): Promise<void> {
    safeRunID(runID)
    await mkdir(this.dir, { recursive: true })
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
    return path.join(this.dir, `${runID}.jsonl`)
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
   *  fsync is coalesced via a 50ms timer; call flushJournalSync() for explicit
   *  durability at workflow lifecycle boundaries.
   *  Writes a v1 header (`{"v":1}`) on the first append to a new journal
   *  file. v0 journals (no header) remain backward-compatible — loadJournal
   *  distinguishes header lines by the absence of a `t` field. */
  appendJournalSync(runID: string, event: JournalEvent): void {
    safeRunID(runID)
    mkdirSync(this.dir, { recursive: true })
    const jpath = this.journalPath(runID)
    if (!existsSync(jpath)) {
      // First append: write v1 header so future readers can detect format
      appendFileSync(jpath, JSON.stringify({ v: 1 }) + "\n")
    }
    appendFileSync(jpath, JSON.stringify(event) + "\n")
    if (fsyncPendingPaths === null) fsyncPendingPaths = new Set()
    fsyncPendingPaths.add(jpath)
    scheduleFsync()
  }

  /** Async journal append — for log/phase events. */
  async appendJournal(runID: string, event: JournalEvent): Promise<void> {
    safeRunID(runID)
    await mkdir(this.dir, { recursive: true })
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
        // v0.14.3 M4 Phase 1 — validate every parsed event against the
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
   *  first line of the file (which loadJournal would treat as a torn header
   *  and silently skip). See R3 in audit b27. */
  async clearJournal(runID: string): Promise<void> {
    safeRunID(runID)
    await mkdir(this.dir, { recursive: true })
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
        [Math.floor(Date.now() / 1000), runID],
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
