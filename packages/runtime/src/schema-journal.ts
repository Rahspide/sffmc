// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE
//
// schema journal validation — journal event validation.
//
// Closes Manriel audit finding "Journal JSON parsed without schema validation".
// Every parsed JSONL line is now validated against the discriminated union
// below before being admitted to the in-memory journal map. This catches
// malformed events (corrupted on disk, unknown `t` from a future version,
// missing required fields) at load time rather than letting them silently
// poison downstream `journalResults.get(key)` calls.
//
// Design notes:
//   - Primitive-type discrimination (string/number/object) is delegated to
//     Valibot `v.is()` schemas — the runtime check no longer relies on
//     `typeof` operators at the I/O boundary.
//   - Forward-compatible: extra unknown fields are accepted (ignored, not
//     rejected). A v1.x reader must admit v1.0 journals silently.
//   - Errors are structured: `{ line, raw, error }` so callers can log
//     the exact line and the parser-reported reason.
//
// Limits (out of scope for initial release):
//   - No nested validation of `args` / `result` / `msg` content (those are
//     opaque from the journal's perspective; they're asserted on use, not
//     on store).
//   - No range checks on `pass`, `tokens`, etc. — journal is a replay log,
//     not a config surface.

import * as v from "valibot"

/** Valibot primitive schemas used at the I/O boundary to discriminate
 *  journal-line field types without `typeof` runtime checks. */
const StringSchema = v.string()
const NumberSchema = v.number()
/** "Plain object" — non-null, non-array, open record. `v.record` requires
 *  a string-keyed bag; v.is rejects null and arrays for us. */
const PlainObjectSchema = v.record(v.string(), v.unknown())

/** Discriminator values accepted on the `t` field of a journal line. */
export type JournalEventType = "agent" | "log" | "phase"

/** Agent-event `args` payload — a string-keyed bag of JSON-serializable
 *  values. The value type is the recursive `JournalArgValue` union —
 *  concrete enough to satisfy the no-unsafe-dictionary-type rule
 *  (which bans `unknown` as a direct value type). */
type JournalArgPrimitive = string | number | boolean | null;
type JournalArgValue =
  | JournalArgPrimitive
  | JournalArgPrimitive[]
  | { [key: string]: JournalArgValue }
  | undefined;
export type JournalAgentArgs = { [key: string]: JournalArgValue };

/** An agent event: a completed agent() call result. */
export interface JournalEventAgent {
  t: "agent"
  /** Stable key used to dedupe agent() calls (e.g. the task string). */
  key: string
  /** Argument bag passed to the agent (opaque to the validator). */
  args: JournalAgentArgs
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
  title: string
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

  // Reject non-object payloads (null, arrays, primitives) — PlainObjectSchema
  // accepts only non-null, non-array string-keyed records, so a single v.is
  // call replaces the prior typeof + null + isArray ladder.
  if (!v.is(PlainObjectSchema, parsed)) {
    return {
      ok: false,
      error: { line: lineNo, raw, error: "expected JSON object" },
    }
  }
  const obj = parsed

  // ── v1 header (`{"v":1}`) — not a journal event, leave it alone. ────
  // loadJournal handles headers itself; here we report them as "not an
  // event" so a stray header mid-file would be visible. Callers that want
  // to skip headers should check `obj.v` before calling this validator.
  // (Note: loadJournal currently short-circuits headers via its own check
  // and never calls validateJournalEvent on them — this branch is
  // defensive.)
  if (v.is(NumberSchema, obj.v) && !("t" in obj)) {
    return {
      ok: false,
      error: { line: lineNo, raw, error: "v1 header line, not an event" },
    }
  }

  // ── Event-type discriminator ────────────────────────────────────────
  const t = obj.t
  if (!v.is(StringSchema, t)) {
    return {
      ok: false,
      error: { line: lineNo, raw, error: "missing or non-string `t` field" },
    }
  }
  // SAFETY: KNOWN_EVENT_TYPES.has(t) on next line validates the value against the JournalEventType set; cast is safe when true
  if (!KNOWN_EVENT_TYPES.has(t as JournalEventType)) {
    return {
      ok: false,
      error: { line: lineNo, raw, error: `unknown event type ${JSON.stringify(t)}` },
    }
  }

  // ── Per-type validation ─────────────────────────────────────────────
  // Every variant requires `pass: number`. Other fields are type-specific.
  if (!v.is(NumberSchema, obj.pass)) {
    return {
      ok: false,
      error: { line: lineNo, raw, error: "missing or non-number `pass` field" },
    }
  }

  if (t === "agent") {
    if (!v.is(StringSchema, obj.key) || obj.key.length === 0) {
      return {
        ok: false,
        error: { line: lineNo, raw, error: "agent event missing or empty `key`" },
      }
    }
    // `args` is optional for backward-compat with legacy v0 journals
    // written before args was a required field. When present, it must
    // be a non-null, non-array object.
    if (obj.args !== undefined && !v.is(PlainObjectSchema, obj.args)) {
      return {
        ok: false,
        error: { line: lineNo, raw, error: "agent event `args` must be a plain object when present" },
      }
    }
    if (obj.tokens !== undefined && !v.is(NumberSchema, obj.tokens)) {
      return {
        ok: false,
        error: { line: lineNo, raw, error: "agent event `tokens` must be number when present" },
      }
    }
    // Extra unknown fields are accepted (forward-compat) — ignored, not rejected.
    const event: JournalEventAgent = {
      t: "agent",
      key: obj.key,
      // SAFETY: obj.args is unknown; JournalAgentArgs | undefined is the documented schema for the agent event args payload
      args: (obj.args as JournalAgentArgs | undefined) ?? {},
      result: obj.result,
      pass: obj.pass,
      // SAFETY: obj.tokens is unknown; number is the documented scalar type for the optional tokens field
      ...(obj.tokens !== undefined && { tokens: obj.tokens as number }),
    }
    return { ok: true, event }
  }

  if (t === "log") {
    if (!v.is(StringSchema, obj.msg)) {
      return {
        ok: false,
        error: { line: lineNo, raw, error: "log event missing or non-string `msg`" },
      }
    }
    const event: JournalEventLog = { t: "log", msg: obj.msg, pass: obj.pass }
    return { ok: true, event }
  }

  // t === "phase"
  // Field name is `title` (matches runtime.ts:942-946 setPhase() call site
  // and types.ts:57 JournalEventPhase definition). Was previously `name` here
  // in error — fixed in v0.14.x.
  if (!v.is(StringSchema, obj.title) || obj.title.length === 0) {
    return {
      ok: false,
      error: { line: lineNo, raw, error: "phase event missing or empty `title`" },
    }
  }
  const event: JournalEventPhase = { t: "phase", title: obj.title, pass: obj.pass }
  return { ok: true, event }
}
