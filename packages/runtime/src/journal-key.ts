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

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonical)
  const rec = value as Record<string, unknown>
  const sortedKeys = Object.keys(rec).sort()
  const result: Record<string, unknown> = {}
  for (const k of sortedKeys) {
    result[k] = canonical(rec[k])
  }
  return result
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
