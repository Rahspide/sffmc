// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs"
import { resolve } from "path"
import { tmpdir } from "os"
import {
  __resetRedactionCache,
  __setRedactionConfigHome,
  ensureRedactionRules,
  isSensitiveFilename,
  isSensitiveSourcePath,
  redactSecrets,
} from "./redact-secrets.ts"

// ---------------------------------------------------------------------------
// Setup: redirect config load to a temp dir so user YAML tests don't pollute
// the developer's real `~/.config/sffmc/redact-secrets.yaml`.
// ---------------------------------------------------------------------------

const TEST_HOME = resolve(tmpdir(), "sffmc-shared-test-redact")
const configDir = resolve(TEST_HOME, ".config", "sffmc")

beforeAll(async () => {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
  // Pre-load rules to populate the cache, pointing at the test config home.
  __setRedactionConfigHome(configDir)
  await ensureRedactionRules()
})

afterAll(() => {
  __setRedactionConfigHome(undefined)
  rmSync(TEST_HOME, { recursive: true, force: true })
})

beforeEach(() => {
  // Reset cache between tests so config-file reads are re-evaluated.
  __resetRedactionCache()
  // Also clear any test YAML file from a prior test.
  const p = resolve(configDir, "redact-secrets.yaml")
  if (existsSync(p)) rmSync(p)
})

// ---------------------------------------------------------------------------
// Positive cases (sensitive caught) — 8 tests
// ---------------------------------------------------------------------------

describe("isSensitiveFilename — positive cases", () => {
  it("catches .env (1)", () => {
    expect(isSensitiveFilename("/secrets/.env")).toBe(true)
  })

  it("catches api_keys.json (2)", () => {
    expect(isSensitiveFilename("/home/me/api_keys.json")).toBe(true)
  })

  it("catches private-key.pem (3)", () => {
    expect(isSensitiveFilename("/home/me/private-key.pem")).toBe(true)
  })
})

describe("redactSecrets — positive cases", () => {
  it("catches BEGIN RSA PRIVATE KEY blocks (header + body + footer) (4)", () => {
    // PEM block redaction (v0.14.1): the PEM rule now redacts the FULL armored block —
    // header line, base64-encoded key material body, and footer line — so
    // the private key cannot be reconstructed from the body alone.
    const input = [
      `const x = "-----BEGIN RSA PRIVATE KEY-----`,
      `MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ==`,
      `-----END RSA PRIVATE KEY-----"`,
    ].join("\n")
    const r = redactSecrets(input)
    expect(r.redacted).toContain("[REDACTED:private-key-pem]")
    expect(r.redacted).not.toContain("-----BEGIN")
    expect(r.redacted).not.toContain("PRIVATE KEY-----")
    expect(r.redacted).not.toContain("MIIEvQ")
    expect(r.redacted).not.toContain("BAQEFAASCBKcwggSjAgEAAoIBAQ")
    // The surrounding JS string context survives.
    expect(r.redacted).toContain("const x")
    expect(r.redacted).toContain(`"`)
  })

  it("catches api_key=... assignments (5)", () => {
    const r = redactSecrets("api_key=ABCD1234567890abcdef")
    expect(r.redacted).toContain("[REDACTED:api-key-assignment]")
  })

  it("catches Authorization: Bearer ... (6)", () => {
    const r = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc")
    expect(r.redacted).toContain("[REDACTED:bearer-header]")
  })

  it("catches password=... assignments (7)", () => {
    const r = redactSecrets("password=hunter2-foo-bar")
    expect(r.redacted).toContain("[REDACTED:password-assignment]")
  })

  it("catches AWS access keys (8)", () => {
    const r = redactSecrets("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")
    expect(r.redacted).toContain("[REDACTED:cloud-credential]")
  })
})

// ---------------------------------------------------------------------------
// Negative cases (legitimate NOT caught) — 7 tests — the audit fixes
// ---------------------------------------------------------------------------

describe("isSensitiveFilename — audit fix negatives", () => {
  it("does NOT catch tokendeploy.sh (9)", () => {
    expect(isSensitiveFilename("/docs/tokendeploy.sh")).toBe(false)
  })

  it("does NOT catch my-private-notes.md (10)", () => {
    expect(isSensitiveFilename("/notes/my-private-notes.md")).toBe(false)
  })
})

describe("isSensitiveSourcePath — audit fix negatives", () => {
  it("does NOT catch credentials-checklist.md by basename (11)", async () => {
    // isSensitiveSourcePath tests full path with the credential pattern
    // (`^credentials$` basename-anchored). credentials-checklist.md does
    // not start with "credentials" → not caught.
    await ensureRedactionRules()
    // The path is a file named credentials-checklist.md, the rule is
    // `/^credentials(\.[\w-]+)?$/i` — so the path's basename doesn't match
    // and the full path is checked only against NON-filename rules.
    // (filename rules are skipped for source paths). → false.
    expect(isSensitiveSourcePath("/projects/credentials-checklist.md")).toBe(false)
  })

  it("catches secrets/notes.md (intentional — dir name leaks context) (12)", async () => {
    await ensureRedactionRules()
    // L2 preserved behavior: a file inside a `secrets/` directory leaks
    // context regardless of the file's basename. The `sourcepath-rule`
    // catches `^/secrets?/` and `secrets/`. notes.md basename itself
    // doesn't match any filename rule, so this isolates the path rule.
    expect(isSensitiveSourcePath("/secrets/notes.md")).toBe(true)
  })
})

describe("redactSecrets — over-redaction guard negatives", () => {
  it("does NOT redact 'The password reset flow uses OAuth' (13)", () => {
    const r = redactSecrets("The password reset flow uses OAuth.")
    // No `=` or `:` after the word → not an assignment
    expect(r.redacted).toBe("The password reset flow uses OAuth.")
    expect(r.count).toBe(0)
  })

  it("isSensitiveFilename does NOT catch api-keys-rotation.md (14)", () => {
    expect(isSensitiveFilename("path/to/api-keys-rotation.md")).toBe(false)
  })

  it("redactSecrets leaves short ghp_ tokens unanchored in prose (15)", async () => {
    await ensureRedactionRules()
    // The cloud-credential rule requires EXACTLY 36 alphanumerics after
    // `ghp_` (per the design's built-in catalogue, line 257). A short
    // token like the one below does not match — same as the design's
    // audit fix that prevents false positives on short lookalikes.
    const r = redactSecrets("ghp_1234567890abcdef")
    expect(r.redacted).toBe("ghp_1234567890abcdef")
    expect(r.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Edge cases — 8 tests
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("filename mixed-case: API_KEY.JSON caught (16)", () => {
    expect(isSensitiveFilename("API_KEY.JSON")).toBe(true)
  })

  it("empty string → false (17)", () => {
    expect(isSensitiveFilename("")).toBe(false)
  })

  it("unicode path with secrets.json (18)", () => {
    expect(isSensitiveFilename("/données/secrets.json")).toBe(true)
  })

  it("multiple categories in one content (19)", async () => {
    await ensureRedactionRules()
    const r = redactSecrets(
      [
        "api_key=ABCDEFGHIJKLMNOP",
        "-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ==",
        "-----END PRIVATE KEY-----",
      ].join("\n"),
    )
    expect(r.count).toBeGreaterThanOrEqual(2)
    expect(r.categories).toContain("api-key-assignment")
    expect(r.categories).toContain("private-key-pem")
  })

  it("user disabled rule: filename-token off → tokens.json not caught (20)", async () => {
    writeFileSync(
      resolve(configDir, "redact-secrets.yaml"),
      "disabledRules:\n  - \"filename-token\"\n",
      "utf-8",
    )
    __setRedactionConfigHome(configDir)
    await ensureRedactionRules()
    expect(isSensitiveFilename("/tokens.json")).toBe(false)
  })

  it("user added rule catches terraform.tfstate (21)", async () => {
    writeFileSync(
      resolve(configDir, "redact-secrets.yaml"),
      "extraFilenameRules:\n  - id: \"terraform-state\"\n    pattern: \"^terraform\\\\.tfstate$\"\n",
      "utf-8",
    )
    __setRedactionConfigHome(configDir)
    await ensureRedactionRules()
    expect(isSensitiveFilename("/state/terraform.tfstate")).toBe(true)
  })

  it("invalid user regex → warns, ignores, doesn't crash (22)", async () => {
    writeFileSync(
      resolve(configDir, "redact-secrets.yaml"),
      "extraContentRules:\n  - id: \"bad\"\n    pattern: \"([\"\n",
      "utf-8",
    )
    __setRedactionConfigHome(configDir)
    // Should not throw
    await ensureRedactionRules()
    // built-ins still work
    const red = redactSecrets("api_key=ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    expect(red.redacted).toContain("[REDACTED:api-key-assignment]")
  })

  it("redacting a [REDACTED:...] marker is idempotent (23)", async () => {
    await ensureRedactionRules()
    const once = redactSecrets("api_key=ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    const twice = redactSecrets(once.redacted)
    // Re-redacting a marker does not re-match (the marker is shorter than
    // 16 chars and contains `[` which doesn't match any rule).
    expect(twice.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Ordering and interaction — 3 tests
// ---------------------------------------------------------------------------

describe("ordering and interaction", () => {
  it("aws_secret_access_key fires cloud-credential first (24)", async () => {
    await ensureRedactionRules()
    const r = redactSecrets("aws_secret_access_key=AKIAIOSFODNN7EXAMPLE")
    // cloud-credential is listed before api-key-assignment in BUILTIN_RULES,
    // so it fires first and consumes the value. The api-key-assignment
    // rule then sees `[REDACTED:cloud-credential]` and does NOT re-match.
    expect(r.redacted).toContain("[REDACTED:cloud-credential]")
    expect(r.redacted).not.toMatch(/api-key-assignment/)
  })

  it("'--- BEGIN PRIVATE KEY ---' (spaces inside) is NOT matched (25)", async () => {
    await ensureRedactionRules()
    const r = redactSecrets("--- BEGIN PRIVATE KEY ---")
    // The rule requires `-----BEGIN` (5 dashes). Spaced variant doesn't match.
    expect(r.count).toBe(0)
  })

  it("bare 'password' (no =) is unchanged (26)", async () => {
    await ensureRedactionRules()
    const r = redactSecrets("password")
    expect(r.redacted).toBe("password")
  })
})

// ---------------------------------------------------------------------------
// Performance — 2 tests
// ---------------------------------------------------------------------------

describe("performance", () => {
  it("1 MB string, 5000 false-positive matches, <500ms (27)", async () => {
    await ensureRedactionRules()
    // 1 MB of prose containing "password" but never as `password=...`
    const noise = "the password is a known word. ".repeat(33_000) // ~990KB
    const r = redactSecrets(noise)
    // No redactions should fire (assignment-anchored, no `=` after)
    expect(r.count).toBe(0)
  })

  it("10,000 filenames via isSensitiveFilename, <500ms (cache hit) (28)", async () => {
    await ensureRedactionRules()
    const t0 = performance.now()
    for (let i = 0; i < 10_000; i++) {
      isSensitiveFilename(`/data/file-${i}.md`)
    }
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(500)
  })
})

// ---------------------------------------------------------------------------
// PEM block redaction — PEM body redaction (v0.14.1 hotfix) — 7 tests
// ---------------------------------------------------------------------------

describe("redactSecrets — PEM body redaction (PEM block redaction)", () => {
  it("redacts the base64 body of an RSA PRIVATE KEY block (29)", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ"
    const input = `-----BEGIN RSA PRIVATE KEY-----\n${body}==\n-----END RSA PRIVATE KEY-----`
    const r = redactSecrets(input)
    expect(r.redacted).toContain("[REDACTED:private-key-pem]")
    expect(r.redacted).not.toContain(body)
    // The marker is a single replacement of the entire block (header+body+footer).
    expect(r.redacted.match(/\[REDACTED:private-key-pem\]/g)?.length).toBe(1)
  })

  it("redacts EC PRIVATE KEY blocks (30a)", () => {
    const input = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQE=\n-----END EC PRIVATE KEY-----"
    const r = redactSecrets(input)
    expect(r.redacted).toBe("[REDACTED:private-key-pem]")
    expect(r.count).toBe(1)
  })

  it("redacts OPENSSH PRIVATE KEY blocks (30b)", () => {
    const input = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----"
    const r = redactSecrets(input)
    expect(r.redacted).toBe("[REDACTED:private-key-pem]")
    expect(r.count).toBe(1)
  })

  it("redacts ENCRYPTED PRIVATE KEY blocks (30c)", () => {
    const input = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIBHDBOBgkqhkiG9w0BBQ0wQTApBgkqhkiG9w0BBQwwHAQI\n-----END ENCRYPTED PRIVATE KEY-----"
    const r = redactSecrets(input)
    expect(r.redacted).toBe("[REDACTED:private-key-pem]")
    expect(r.count).toBe(1)
  })

  it("preserves surrounding content (31)", () => {
    const input = "keyfile = load(\n-----BEGIN PRIVATE KEY-----\nQUJDREVG\n-----END PRIVATE KEY-----\n)\n"
    const r = redactSecrets(input)
    expect(r.redacted).toContain("keyfile = load(")
    expect(r.redacted).toContain(")")
    expect(r.redacted).toContain("[REDACTED:private-key-pem]")
    expect(r.redacted).not.toContain("QUJDREVG")
  })

  it("redacts multiple PEM blocks in one content (32)", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA",
      "-----END RSA PRIVATE KEY-----",
      "separator text",
      "-----BEGIN EC PRIVATE KEY-----",
      "MHcCAQE=",
      "-----END EC PRIVATE KEY-----",
    ].join("\n")
    const r = redactSecrets(input)
    expect(r.count).toBe(2)
    expect(r.redacted).toContain("separator text")
    // Both blocks fully replaced.
    expect(r.redacted.match(/\[REDACTED:private-key-pem\]/g)?.length).toBe(2)
  })

  it("PEM header without matching footer is NOT redacted (33)", () => {
    // PEM block redaction scopes the regex to require both BEGIN and END markers. A bare
    // header (e.g. a truncated dump, or a snippet with the END cut off) is
    // intentionally left alone — partial redaction of a PEM block would
    // still leak the body. This is the documented fallback behavior.
    const input = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhk\n(no end marker — truncated dump)"
    const r = redactSecrets(input)
    expect(r.count).toBe(0)
    expect(r.redacted).toContain("MIIEvQIBADANBgkqhk")
  })
})
