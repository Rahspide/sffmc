// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Journal file IO, extracted from persistence.ts per the v0.16.0
// refactor plan (ora-9, Phase 8). Handles JSONL append/load/clear of
// the per-run journal file. The WorkflowPersistence class delegates
// to JournalRepository; the fsync coalescing is owned by the parent
// persistence (this class only enqueues via the passed-in scheduleFsync
// callback so the coalescer stays a per-instance concern).

import { createReadStream } from "node:fs"
import { writeFile, appendFile, mkdir, stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import path from "node:path"
import { safeRunID } from "@sffmc/utilities"
import { getWorkflowConfigSync } from "./constants.ts"
import { validateJournalEvent } from "./schema-journal.ts"
import type { JournalEvent } from "./types.ts"
import type { FsOps } from "@sffmc/utilities"
import { createLogger } from "@sffmc/utilities"

const log = createLogger("workflow:persistence")

export class JournalRepository {
  constructor(
    private readonly dir: string,
    private readonly fs: FsOps,
    private readonly scheduleFsync: (path: string) => void,
  ) {}

  private journalPath(runID: string): string {
    safeRunID(runID)
    return path.join(this.dir, `${runID}${getWorkflowConfigSync().journalExt}`)
  }

  /** Cheap pre-check: does the journal file exist and have at least one byte? */
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
   *  Writes a v1 header (`{"v":1}`) on the append to a new journal
   *  file. v0 journals (no header) remain backward-compatible — loadJournal
   *  distinguishes header lines by the absence of a `t` field. */
  appendSync(runID: string, event: JournalEvent): void {
    safeRunID(runID)
    this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const jpath = this.journalPath(runID)
    if (!this.fs.exists(jpath)) {
      // First append: write v1 header so future readers can detect format
      this.fs.appendFile(jpath, JSON.stringify({ v: 1 }) + "\n")
    }
    this.fs.appendFile(jpath, JSON.stringify(event) + "\n")
    this.scheduleFsync(jpath)
  }

  /** Async journal append — for log/phase events. */
  async append(runID: string, event: JournalEvent): Promise<void> {
    safeRunID(runID)
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await appendFile(this.journalPath(runID), JSON.stringify(event) + "\n")
  }

  async load(runID: string): Promise<{ results: Map<string, unknown>; pass: number }> {
    safeRunID(runID)
    const results = new Map<string, unknown>()
    let maxPass = 0
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
          if (!v.error.error.startsWith("v1 header line")) {
            log.debug(
              `loadJournal(${runID}): skipping malformed event at line ${v.error.line}: ${v.error.error}`,
            )
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
    return { results, pass: maxPass + 1 }
  }

  /** Clear the journal (truncate to v1 header). Used on sha-mismatch resume. */
  async clear(runID: string): Promise<void> {
    safeRunID(runID)
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const jpath = this.journalPath(runID)
    await writeFile(jpath, JSON.stringify({ v: 1 }) + "\n", "utf-8")
  }
}
