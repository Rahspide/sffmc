// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { Database } from "bun:sqlite"
import { randomBytes, createHash } from "node:crypto"
import { mkdirSync, appendFileSync, createReadStream } from "node:fs"
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { createInterface } from "node:readline"
import type { WorkflowRun, WorkflowStep, JournalEvent, WorkflowStatus } from "./types.ts"
import { applySchema } from "./schema.ts"

// ---------------------------------------------------------------------------
// RunID generation (base62)
// ---------------------------------------------------------------------------

export const RUN_ID_REGEX = /^wf_[0-9A-Za-z]{26}$/

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

function defaultDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) return path.join(xdg, "SFFMC", "workflow")
  return path.join(homedir(), ".local", "share", "SFFMC", "workflow")
}

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
    args: row.args ? JSON.parse(row.args as string) : undefined,
    scriptSha: (row.script_sha as string) || undefined,
    agentTimeoutMs: (row.agent_timeout_ms as number) || undefined,
    error: (row.error as string) || undefined,
    createdAt: row.time_created as number,
    updatedAt: row.time_updated as number,
  }
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

  createRun(file: string, label: string, scriptSha: string, parentId?: string): string {
    const runID = generateRunID()
    const now = Math.floor(Date.now() / 1000)
    this.db.run(
      `INSERT INTO workflow_runs (id, name, status, running, succeeded, failed, script_sha, parent_run_id, time_created, time_updated)
       VALUES (?, ?, 'running', 0, 0, 0, ?, ?, ?, ?)`,
      [runID, label, scriptSha, parentId ?? null, now, now],
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

  /** Synchronous journal append — durable before the sandbox pump can be starved. */
  appendJournalSync(runID: string, event: JournalEvent): void {
    safeRunID(runID)
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(this.journalPath(runID), JSON.stringify(event) + "\n")
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
    try {
      const stream = createReadStream(this.journalPath(runID), { encoding: "utf-8" })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of rl) {
        if (!line) continue
        let ev: JournalEvent
        try {
          ev = JSON.parse(line) as JournalEvent
        } catch {
          continue // skip torn lines from crash mid-append
        }
        if (typeof ev.pass === "number" && ev.pass > maxPass) maxPass = ev.pass
        if (ev.t === "agent") results.set(ev.key, ev.result)
      }
    } catch {
      // file doesn't exist — empty results
    }
    return { results, pass: maxPass + 1 }
  }

  /** Clear the journal (truncate to empty). Used on sha-mismatch resume. */
  async clearJournal(runID: string): Promise<void> {
    safeRunID(runID)
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.journalPath(runID), "", "utf-8")
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
