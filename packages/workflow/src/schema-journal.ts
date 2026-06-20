// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// M4 schema refactor Phase 1 (MVP) — journal event validation.
//
// Closes Manriel audit M4 ("Journal JSON parsed without schema validation").
// Every parsed JSONL line is now validated against the discriminated union
// below before being admitted to the in-memory journal map. This catches
// malformed events (corrupted on disk, unknown `t` from a future version,
// missing required fields) at load time rather than letting them silently
// poison downstream `journalResults.get(key)` calls.
//
// Design notes:
//   - Hand-rolled validator (no Zod / no ajv / no runtime schema lib). The
//     journal format is tiny (3 event types × ~5 fields each) and the cost
//     of a dep outweighs the value of a generic validator here.
//   - Forward-compatible: extra unknown fields are accepted (ignored, not
//     rejected). A v1.x reader must admit v1.0 journals silently.
//   - Errors are structured: `{ line, raw, error }` so callers can log
//     the exact line and the parser-reported reason.
//
// Limits (out of scope for Phase 1):
//   - No nested validation of `args` / `result` / `msg` content (those are
//     opaque from the journal's perspective; they're asserted on use, not
//     on store).
//   - No range checks on `pass`, `tokens`, etc. — journal is a replay log,
//     not a config surface.

/** Discriminator values accepted on the `t` field of a journal line. */
export type JournalEventType = "agent" | "log" | "phase"

/** An agent event: a completed agent() call result. */
export interface JournalEventAgent {
  t: "agent"
  /** Stable key used to dedupe agent() calls (e.g. the task string). */
  key: string
  /** Argument bag passed to the agent (opaque to the validator). */
  args: Record<string, unknown>
  /** Agent result — may be any JSON-serializable value. */
  result: unknown
  /** Pass number within the run lifecycle (1-indexed). */
  pass: number
  /** Optional token count for budget accounting. */
  tokens?: number
}

/** A log event: a `log(msg)` primitive call. */
export interface JournalEventLog {
  t: "log"
  msg: string
  pass: number
}

/** A phase event: a `phase(title)` primitive call. */
export interface JournalEventPhase {
  t: "phase"
  name: string
  pass: number
}

/** Discriminated union of every journal event type. */
export type JournalEvent = JournalEventAgent | JournalEventLog | JournalEventPhase

/** Structured error returned by `validateJournalEvent` when validation
 *  fails. `line` is the 1-indexed line number in the journal file (or any
 *  caller-supplied position), `raw` is the unparsed line, `error` is a
 *  human-readable description of why validation failed. */
export interface JournalValidationError {
  line: number
  raw: string
  error: string
}

const KNOWN_EVENT_TYPES: ReadonlySet<JournalEventType> = new Set(["agent", "log", "phase"])

/** Validate one journal line. Returns `{ok:true, event}` for valid events
 *  (including events with unknown extra fields — forward-compatibility) or
 *  `{ok:false, error}` for malformed JSON, unknown event types, or events
 *  missing required fields.
 *
 *  The validator does NOT mutate any module-level state. */
export function validateJournalEvent(
  raw: string,
  lineNo: number,
): { ok: true; event: JournalEvent } | { ok: false; error: JournalValidationError } {
  // ── Parse JSON ────────────────────────────────────────────────────────
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return {
      ok: false,
      error: {
        line: lineNo,
        raw,
        error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      },
    }
  }

  // Reject non-object payloads (null, arrays, primitives).
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: { line: lineNo, raw, error: "expected JSON object" },
    }
  }
  const obj = parsed as Record<string, unknown>

  // ── v1 header (`{"v":1}`) — not a journal event, leave it alone. ────
  // loadJournal handles headers itself; here we report them as "not an
  // event" so a stray header mid-file would be visible. Callers that want
  // to skip headers should check `obj.v` before calling this validator.
  // (Note: loadJournal currently short-circuits headers via its own check
  // and never calls validateJournalEvent on them — this branch is
  // defensive.)
  if (typeof obj.v === "number" && !("t" in obj)) {
    return {
      ok: false,
      error: { line: lineNo, raw, error: "v1 header line, not an event" },
    }
  }

  // ── Event-type discriminator ────────────────────────────────────────
  const t = obj.t
  if (typeof t !== "string") {
    return {
      ok: false,
      error: { line: lineNo, raw, error: "missing or non-string `t` field" },
    }
  }
  if (!KNOWN_EVENT_TYPES.has(t as JournalEventType)) {
    return {
      ok: false,
      error: { line: lineNo, raw, error: `unknown event type ${JSON.stringify(t)}` },
    }
  }

  // ── Per-type validation ─────────────────────────────────────────────
  // Every variant requires `pass: number`. Other fields are type-specific.
  if (typeof obj.pass !== "number") {
    return {
      ok: false,
      error: { line: lineNo, raw, error: "missing or non-number `pass` field" },
    }
  }

  if (t === "agent") {
    if (typeof obj.key !== "string" || obj.key.length === 0) {
      return {
        ok: false,
        error: { line: lineNo, raw, error: "agent event missing or empty `key`" },
      }
    }
    // `args` is optional for backward-compat with legacy v0 journals
    // written before args was a required field. When present, it must
    // be a non-null, non-array object.
    if (obj.args !== undefined) {
      if (typeof obj.args !== "object" || obj.args === null || Array.isArray(obj.args)) {
        return {
          ok: false,
          error: { line: lineNo, raw, error: "agent event `args` must be a plain object when present" },
        }
      }
    }
    if (obj.tokens !== undefined && typeof obj.tokens !== "number") {
      return {
        ok: false,
        error: { line: lineNo, raw, error: "agent event `tokens` must be number when present" },
      }
    }
    // Extra unknown fields are accepted (forward-compat) — ignored, not rejected.
    const event: JournalEventAgent = {
      t: "agent",
      key: obj.key,
      args: (obj.args as Record<string, unknown> | undefined) ?? {},
      result: obj.result,
      pass: obj.pass,
      ...(obj.tokens !== undefined ? { tokens: obj.tokens as number } : {}),
    }
    return { ok: true, event }
  }

  if (t === "log") {
    if (typeof obj.msg !== "string") {
      return {
        ok: false,
        error: { line: lineNo, raw, error: "log event missing or non-string `msg`" },
      }
    }
    const event: JournalEventLog = { t: "log", msg: obj.msg, pass: obj.pass }
    return { ok: true, event }
  }

  // t === "phase"
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    return {
      ok: false,
      error: { line: lineNo, raw, error: "phase event missing or empty `name`" },
    }
  }
  const event: JournalEventPhase = { t: "phase", name: obj.name, pass: obj.pass }
  return { ok: true, event }
}
