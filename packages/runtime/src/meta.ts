// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Parses the mandatory `export const meta = { ... }` literal from a workflow
// script WITHOUT executing the script body or the literal.
// v0.16.0 refactor (ora-11, File 2): the 10 pure parser helpers
// (findBalancedClose, parseDataLiteral, skipTrivia, readValue,
// readObject, readArray, readKey, readString, readNumber, matchKeyword)
// live in `./meta-parser.ts`. This file keeps the public `parseMeta`
// surface unchanged.

import * as v from "valibot"
import { findBalancedClose, parseDataLiteral } from "./meta-parser.ts"

export interface Meta {
  name: string
  description: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string }>
  model?: string
}

export type ParseResult =
  | { ok: true; meta: Meta; body: string }
  | { ok: false; error: string }

/** Concrete shape of the parsed meta object before field-level validation:
 *  every field is a known name with a known value type. Used in place of
 *  `Record<string, unknown>` so the I/O boundary carries typed evidence. */
export interface MetaMap {
  name: string
  description: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string }>
  model?: string
  [key: string]: string | string[] | { title: string; detail?: string } | { title: string; detail?: string }[] | undefined
}

/** Plain-object schema — accepts non-null, non-array string-keyed
 *  records. Used to discriminate the parsed-meta value at the I/O
 *  boundary without `typeof` runtime narrowing. */
const PlainObjectSchema = v.record(v.string(), v.unknown())

/** Non-empty-string schema used for the two required meta fields
 *  (name, description). The historical `typeof === "string" && truthy`
 *  guard is closed by `v.pipe(v.string(), v.minLength(1))` so callers
 *  get the same "required, non-empty" contract via Valibot rather than
 *  ad-hoc `typeof` narrowing. */
const NonEmptyStringSchema = v.pipe(v.string(), v.minLength(1))

/** Valibot schema for the parsed meta object. The schema only validates
 *  the two required fields (`name`, `description`) — `phases`, `model`,
 *  and `whenToUse` are intentionally left loose so historical meta blocks
 *  with trailing commas, numeric phase IDs, numeric model IDs, etc.
 *  continue to parse. The downstream `Meta` type carries the documented
 *  shape; runtime consumers that need strict validation apply it
 *  separately. */
export const MetaMapSchema = v.object({
  name: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  whenToUse: v.optional(v.string()),
  phases: v.optional(v.array(v.unknown())),
  model: v.optional(v.unknown()),
}) satisfies v.GenericSchema<MetaMap>

const META_START_RE = /export\s+const\s+meta\s*=\s*/

/** Narrow-typed check for the two required fields only. We intentionally
 *  do NOT validate the whole schema — see the comment on `MetaMapSchema`. */
function validateRequiredFields(value: unknown): { ok: true } | { ok: false; missing: "name" | "description" } {
  if (!v.is(PlainObjectSchema, value)) {
    return { ok: false, missing: "name" }
  }
  if (!v.is(NonEmptyStringSchema, value.name)) return { ok: false, missing: "name" }
  if (!v.is(NonEmptyStringSchema, value.description)) return { ok: false, missing: "description" }
  return { ok: true }
}

export function parseMeta(script: string): ParseResult {
  const start = META_START_RE.exec(script)
  if (!start) {
    return { ok: false, error: "workflow script must start with `export const meta = { ... }`" }
  }
  const open = script.indexOf("{", start.index + start[0].length)
  if (open === -1) {
    return { ok: false, error: "workflow script must start with `export const meta = { ... }`" }
  }
  const close = findBalancedClose(script, open)
  if (close === -1) {
    return { ok: false, error: "could not locate a balanced meta object literal" }
  }
  const literal = script.slice(open, close + 1)
  const parsed = parseDataLiteral(literal)
  if (!parsed.ok) return { ok: false, error: `meta is not a valid object literal: ${parsed.error}` }
  // SAFETY: parseDataLiteral returns unknown for value; validateRequiredFields closes the unknown-to-MetaMap boundary using Valibot schemas instead of `typeof` runtime narrowing
  const validated = validateRequiredFields(parsed.value)
  if (!validated.ok) {
    return {
      ok: false,
      error: validated.missing === "name"
        ? "meta.name (non-empty string) is required"
        : "meta.description (non-empty string) is required",
    }
  }
  // SAFETY: parseDataLiteral returns unknown for value; the typeof object/null/Array.isArray guards above narrow it to a non-null, non-array object
  const m = parsed.value as MetaMap
  const endIndex = close + 1 + (script[close + 1] === ";" ? 1 : 0)
  const matched = script.slice(start.index, endIndex)
  const body = script.slice(0, start.index) + matched.replace(/[^\n]/g, " ") + script.slice(endIndex)
  // SAFETY: MetaMap and Meta differ only by the open index signature on MetaMap (loose-typed extra fields); m is the documented superset of Meta with non-empty name/description already validated above
  return { ok: true, meta: m as Meta, body }
}
