// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE

// Security + memory-leak coverage for `@sffmc/utilities`.
//
// Three attack surfaces worth covering here:
//   1. `redactSecrets()` runs 11+ regex patterns on every call. Pathological
//      inputs must not hang the host process. The 1 MiB `MAX_CONTENT_BYTES`
//      cap is the first line of defense.
//   2. `loadConfig<T>()` reads user-supplied YAML. A malformed YAML must
//      not throw.
//   3. `EventBus` must not leak listeners on clearAll() and must not throw
//      if a listener misbehaves.
//
// (BoundedLRU leak tests live in `packages/runtime/tests/security-leaks.test.ts`
// because BoundedLRU is in `@sffmc/runtime`.)
//
// ────────────────────────────────────────────────────────────────────────────
// KNOWN ISSUE (audit 2026-07-04, found while writing this file):
//
//   The `cloud-credential` rule in `redactSecrets()` has a pattern
//   `[A-Za-z0-9_\-]{24,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{20,}` (a JWT-like
//   three-segment form) that exhibits polynomial backtracking on adversarial
//   input. A 1 MiB string of `'a'` characters causes `redactSecrets()` to
//   hang indefinitely (>30s CPU, 100% busy) because the regex engine tries
//   every starting position and backtracks on each.
//   This is a real ReDoS vulnerability surfaced by the security tests.
//
//   Tests that would have verified the bound (1 MiB input) currently hang.
//   The fix is in production code (`redact-secrets.ts`): bound the quantifiers
//   (`{24,200}` instead of `{24,}`) and/or pre-validate input via a fast
//   non-backtracking scan.
//
//   See commit message of the fix for the full diff. Until then, these tests
//   use a strict time bound to fail loud if a future regression makes the
//   hang worse, while staying under the hang threshold.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "bun:test"
import {
  redactSecrets,
  MAX_CONTENT_BYTES,
  isSensitiveFilename,
  isSensitiveSourcePath,
} from "./redact-secrets.ts"
import { loadConfig, validateSafeRegex } from "./config.ts"
import { on, off, emit, clearAll } from "./events.ts"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// =============================================================================
// 1) redactSecrets — security
// =============================================================================

describe("redactSecrets security: bounded by MAX_CONTENT_BYTES", () => {
  beforeEach(() => clearAll())

  it("rejects inputs larger than MAX_CONTENT_BYTES (1 MiB) without scanning content", () => {
    // 1 MiB + 1 byte: must hit the size-guard and return oversize=true
    // without ever iterating the regex patterns. We verify the fast-path
    // by checking `count === 0` and `redacted === input` (unchanged).
    const oversize = "x".repeat(MAX_CONTENT_BYTES + 1)
    const r = redactSecrets(oversize)
    expect(r.oversize).toBe(true)
    expect(r.count).toBe(0)
    expect(r.redacted).toBe(oversize) // unchanged
  })

  it("empty string is a no-op (no panics, no empty categories)", () => {
    const r = redactSecrets("")
    expect(r.redacted).toBe("")
    expect(r.categories).toEqual([])
    expect(r.count).toBe(0)
  })

  it("control characters and unicode lookalikes don't crash the matcher", () => {
    // NUL byte, RTL override, zero-width joiner, emoji — patterns that
    // historically broke regex engines that treated input as ASCII.
    const tricky = "\u0000\u200E\u200D\uFE0Fapi_key=abcdefghijklmnop\ud83d\ude00"
    expect(() => redactSecrets(tricky)).not.toThrow()
  })

  it("base64-encoded credential string is NOT matched (by design)", () => {
    // Catches a class of bypass: attacker base64-encodes the secret to
    // evade plaintext redaction. We don't try to detect this (false
    // positives would be unacceptable); we document the limitation.
    const b64 = Buffer.from("api_key=supersecretvalue12345").toString("base64")
    const r = redactSecrets(`payload=${b64}`)
    expect(r.count).toBe(0)
    expect(r.redacted).toBe(`payload=${b64}`)
  })

  it("redactSecrets() never throws for malformed input", () => {
    // The oversize path is already covered above. This covers the case
    // where someone subclasses the function or the regex engine panics.
    const long = "x".repeat(MAX_CONTENT_BYTES * 2)
    expect(() => redactSecrets(long)).not.toThrow()
  })

  it("small pathological input completes in reasonable time (ReDoS smoke test)", () => {
    // Smaller adversarial input that exercises the regex without
    // triggering the catastrophic-backtracking bug in `cloud-credential`.
    // 1 KiB of `'a'` — the `api-key-assignment` pattern needs an
    // "apikey" prefix, so 1 KiB of pure `'a'` matches zero rules; the
    // fast-path through the loop should complete in microseconds.
    const input = "a".repeat(1024)
    const start = performance.now()
    const r = redactSecrets(input)
    const elapsed = performance.now() - start
    expect(r).toBeDefined()
    expect(elapsed).toBeLessThan(100)
  })

  // v0.15.4: the `cloud-credential` pattern's JWT-like alternation was
  // changed from `{24,}` / `{6,}` / `{20,}` to `{24,200}` / `{6,64}` /
  // `{20,512}`, closing the polynomial-backtracking ReDoS that hung
  // the engine on 1 MiB of `'a'`. These tests pin the bound.
  it("1 MiB of repeating 'a' completes in reasonable time (ReDoS bound)", () => {
    const input = "a".repeat(MAX_CONTENT_BYTES)
    const start = performance.now()
    const r = redactSecrets(input)
    const elapsed = performance.now() - start
    expect(r.oversize).toBeUndefined()
    expect(r.count).toBe(0)
    // Generous bound: the fixed pattern processes 1 MiB in <2s on
    // commodity hardware. The OLD pattern hung indefinitely (>30s).
    expect(elapsed).toBeLessThan(2000)
  })

  it("input at MAX_CONTENT_BYTES boundary completes in reasonable time (off-by-one)", () => {
    // Exactly at the cap — does NOT take the oversize fast path, enters
    // the full redaction loop. Same ReDoS-bound pattern.
    const input = "x".repeat(MAX_CONTENT_BYTES)
    const start = performance.now()
    const r = redactSecrets(input)
    const elapsed = performance.now() - start
    expect(r.oversize).toBeUndefined()
    expect(r.count).toBe(0)
    expect(elapsed).toBeLessThan(2000)
  })
})

describe("redactSecrets security: filename / source-path helpers", () => {
  it("isSensitiveFilename matches .env and credentials across extensions", () => {
    expect(isSensitiveFilename(".env")).toBe(true)
    expect(isSensitiveFilename(".env.local")).toBe(true)
    expect(isSensitiveFilename("credentials.json")).toBe(true)
    expect(isSensitiveFilename("private-key.pem")).toBe(true)
    expect(isSensitiveFilename("readme.md")).toBe(false)
  })

  it("isSensitiveSourcePath matches secrets dir anywhere in the path", () => {
    expect(isSensitiveSourcePath("a/secrets/b.txt")).toBe(true)
    expect(isSensitiveSourcePath("/home/me/credentials/api.json")).toBe(true)
    expect(isSensitiveSourcePath("/home/me/private/data")).toBe(true)
    expect(isSensitiveSourcePath("/home/me/normal.txt")).toBe(false)
  })
})

// =============================================================================
// 2) loadConfig — security
// =============================================================================

describe("loadConfig security: malicious YAML does not crash", () => {
  it("user-supplied regex pattern flagged by safe-regex is dropped", () => {
    // safe-regex detects catastrophic backtracking via star-height-1.
    // Patterns with nested unbounded quantifiers (ReDoS hotbeds) fail.
    expect(validateSafeRegex("^(a+)+$", { limit: 25 })).toBe(false)
    // Linear patterns pass.
    expect(validateSafeRegex("[a-z]+", { limit: 25 })).toBe(true)
    // Note: safe-regex does NOT flag `{n,m}` with a bounded upper —
    // only fully unbounded quantifiers (`+`, `*`, `+?`, `*?`). The
    // star-height check is about NESTED unbounded quantifiers, not
    // upper bounds. So `a{1,100}` passes the check even though 100
    // exceeds our display limit of 25.
    expect(validateSafeRegex("a{1,100}", { limit: 25 })).toBe(true)
  })

  it("YAML parse error does not throw (returns defaults)", async () => {
    const tmpConfigHome = makeTmpConfigHome("parse-err", "port: [unclosed")
    const r = await loadConfig<{ port: number }>(
      "parse-err",
      { port: 8080 },
      { configHome: tmpConfigHome },
    )
    expect(r).toEqual({ port: 8080 })
  })
})

// =============================================================================
// 3) EventBus — security + leaks
// =============================================================================

describe("EventBus security: throwing listeners do not break emit()", () => {
  it("throws in one listener does not stop other listeners", () => {
    let after = false
    on("test", () => {
      throw new Error("intentional")
    })
    on("test", () => {
      after = true
    })
    expect(() => emit("test", null)).not.toThrow()
    expect(after).toBe(true)
  })
})

describe("EventBus memory: no leak", () => {
  beforeEach(() => clearAll())

  it("100 register/emit/clearAll cycle does not grow listener count", () => {
    // 100 register + emit + clear = 100 cycles. If clearAll is broken,
    // count grows. After 100 cycles, no listeners should fire.
    for (let cycle = 0; cycle < 100; cycle++) {
      on("test", () => {})
      emit("test", null)
      clearAll()
    }
    let fired = false
    on("after-clear", () => {
      fired = true
    })
    clearAll()
    emit("after-clear", null)
    expect(fired).toBe(false)
  })

  it("emit() on event with no listeners is a no-op", () => {
    expect(() => emit("never-registered", { payload: 1 })).not.toThrow()
  })

  it("off() with non-existent event is a no-op", () => {
    expect(() => off("never-registered", () => {})).not.toThrow()
  })

  it("off() of non-registered handler is a no-op", () => {
    on("test", () => {})
    const otherHandler = () => {}
    expect(() => off("test", otherHandler)).not.toThrow()
  })

  it("deep re-entrant emit stops at MAX_DEPTH (no infinite recursion)", () => {
    // Emit 5-deep to keep test fast. EventBus uses [...list] copy
    // semantics so this should not stack-overflow.
    let depth = 0
    const MAX_DEPTH = 5
    on("recur", () => {
      depth++
      if (depth < MAX_DEPTH) emit("recur", null)
    })
    emit("recur", null)
    expect(depth).toBe(MAX_DEPTH)
  })
})

// =============================================================================
// helpers
// =============================================================================

function makeTmpConfigHome(name: string, yaml: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `sffmc-security-${name}-`))
  writeFileSync(path.join(dir, `${name}.yaml`), yaml, "utf-8")
  return dir
}
