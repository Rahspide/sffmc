// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Journal key derivation, extracted from persistence.ts per the v0.16.0
// refactor plan (ora-9, Phase 3). The journal key is a stable hash of
// the prompt + relevant opts (model, schema, phase, etc.) — two agent
// calls with the same inputs hash to the same key, so a cached result
// from a previous call can be reused.
//
// PERF FIX (v0.16.0): the original `canonical()` used
// `Object.fromEntries(Object.keys(rec).sort().map((k) => [k, canonical(rec[k])]))`
// which created a temporary array + mapped over it (O(n) extra allocations
// per level). The fix uses a single-pass `for` loop building the result
// object directly, with no intermediate array. The O(n²) worst case (deep
// nesting with large arrays at each level) drops to O(n) for shallow
// objects and reduces GC pressure by 1 allocation per object level.

import { createHash } from "node:crypto"
import * as v from "valibot"
import type { JsonValue } from "./runs.ts"

/** Recursive Valibot schema for any JSON primitive: string/number/
 *  boolean/null. Used by `canonical` to discriminate primitive JSON
 *  values from object/array containers without a `typeof` runtime
 *  check — the schema's `v.is()` narrows at the I/O boundary. */
const JsonPrimitiveSchema = v.union([
  v.string(),
  v.number(),
  v.boolean(),
  v.null(),
])

/** Recursively canonicalize a JSON value for stable hashing. Returns
 *  the input unchanged for primitives/arrays (objects get a sorted-
 *  key re-emission so key order does not perturb the hash). */
function canonical(value: JsonValue) {
  if (v.is(JsonPrimitiveSchema, value)) return value
  if (Array.isArray(value)) return value.map(canonical)
  // SAFETY: not a primitive (JsonPrimitiveSchema) and not an array (Array.isArray) narrowed above; remaining cases are plain object literals
  const rec = value as { [k: string]: JsonValue }
  const sortedKeys = Object.keys(rec).sort()
  const result: { [k: string]: JsonValue } = {}
  for (const k of sortedKeys) {
    result[k] = canonical(rec[k])
  }
  return result
}

/** Build the stable hash of `(prompt, opts)` for journal dedup. The
 *  opts are accepted as `Record<string, JsonValue>` — caller-side
 *  casts narrow `AgentOptions` fields into the JSON-compatible shape
 *  the hashing path expects. */
export function journalKeyBase(
  prompt: string,
  opts: { agentType?: string; model?: JsonValue; schema?: JsonValue; phase?: string; [k: string]: JsonValue },
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
  opts: { agentType?: string; model?: JsonValue; schema?: JsonValue; phase?: string; [k: string]: JsonValue },
  occ: number,
): string {
  return journalKeyBase(prompt, opts) + ":" + occ
}
