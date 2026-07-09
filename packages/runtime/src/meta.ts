// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Parses the mandatory `export const meta = { ... }` literal from a workflow
// script WITHOUT executing the script body or the literal.
// v0.16.0 refactor (ora-11, File 2): the 10 pure parser helpers
// (findBalancedClose, parseDataLiteral, skipTrivia, readValue,
// readObject, readArray, readKey, readString, readNumber, matchKeyword)
// live in `./meta-parser.ts`. This file keeps the public `parseMeta`
// surface unchanged.

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

const META_START_RE = /export\s+const\s+meta\s*=\s*/

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
  const meta = parsed.value
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return { ok: false, error: "meta must be an object" }
  }
  const m = meta as Record<string, unknown>
  if (typeof m.name !== "string" || !m.name) {
    return { ok: false, error: "meta.name (non-empty string) is required" }
  }
  if (typeof m.description !== "string" || !m.description) {
    return { ok: false, error: "meta.description (non-empty string) is required" }
  }
  const endIndex = close + 1 + (script[close + 1] === ";" ? 1 : 0)
  const matched = script.slice(start.index, endIndex)
  const body = script.slice(0, start.index) + matched.replace(/[^\n]/g, " ") + script.slice(endIndex)
  return { ok: true, meta: m as unknown as Meta, body }
}
