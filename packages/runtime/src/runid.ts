// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// RunID generation, extracted from persistence.ts per the v0.16.0
// refactor plan (ora-9, Phase 1). WorkflowPersistence delegates to
// `generateRunID()` for new runIDs; tests and call sites that imported
// `generateRunID` from `./persistence.ts` keep working via the barrel
// re-export.

import { randomBytes } from "node:crypto"

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
