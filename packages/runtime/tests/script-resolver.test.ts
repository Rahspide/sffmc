// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Direct unit tests for `resolveWorkflowScript` in `script-resolver.ts`.
// `packages/runtime/tests/resolve-script.test.ts` covers the dispatcher in
// `runtime.ts:429-454`, but `resolveWorkflowScript` has its own branches:
//   - name + no script → builtin lookup, then saved-workflow fallback
//   - script (inline) → isInlineScript check
//   - file → path.resolve + workspace jail check
//   - none of the three → "requires name, script, or file" error
// These tests exercise each branch in isolation, with the filesystem and
// builtin registry controlled by the test (no live OpenCode runtime).

import { describe, test, expect, afterAll } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-script-resolver-"))

import { resolveWorkflowScript } from "../src/script-resolver.ts"
import { registerBuiltin } from "../src/builtin-registry.ts"

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

describe("resolveWorkflowScript", () => {
  describe("name branch (no input.script)", () => {
    test("resolves to a shipped builtin", async () => {
      // "deep-research" is one of the 7 shipped builtins
      const source = await resolveWorkflowScript({
        name: "deep-research",
        workspace: tmpDir,
      })
      expect(typeof source).toBe("string")
      expect(source).toContain("export const meta")
    })

    test("falls back to saved workflow under .sffmc/workflows/ when no builtin matches", async () => {
      mkdirSync(path.join(tmpDir, ".sffmc", "workflows"), { recursive: true })
      writeFileSync(
        path.join(tmpDir, ".sffmc", "workflows", "my_saved.ts"),
        "export const meta = { name: 'my_saved', description: 'from disk' }\n",
      )
      const source = await resolveWorkflowScript({
        name: "my_saved",
        workspace: tmpDir,
      })
      expect(source).toContain("from disk")
    })

    test("prefers builtin over saved workflow of the same name", async () => {
      // Set up a saved workflow with the same name as a builtin
      mkdirSync(path.join(tmpDir, ".sffmc", "workflows"), { recursive: true })
      writeFileSync(
        path.join(tmpDir, ".sffmc", "workflows", "deep-research.ts"),
        "export const meta = { name: 'shadow', description: 'from disk' }\n",
      )
      const source = await resolveWorkflowScript({
        name: "deep-research",
        workspace: tmpDir,
      })
      // Builtin wins → no "from disk" content
      expect(source).not.toContain("from disk")
      expect(source).toContain("export const meta")
    })

    test("custom registered builtin is returned", async () => {
      // Use a unique name unlikely to collide with other test files.
      const unique = "script-resolver-test-custom-builtin"
      registerBuiltin(unique, async () => ({
        source: "export const meta = { name: 'custom-builtin', description: 'custom override' }\n",
        meta: { name: unique, description: "custom override" },
      }))
      const source = await resolveWorkflowScript({
        name: unique,
        workspace: tmpDir,
      })
      expect(source).toContain("custom override")
    })

    test("throws when name not found in builtin or saved", async () => {
      await expect(
        resolveWorkflowScript({ name: "nonexistent-workflow-xyz", workspace: tmpDir }),
      ).rejects.toThrow(/Workflow not found/)
    })
  })

  describe("script branch (inline)", () => {
    test("returns inline script verbatim when it starts with export const meta", async () => {
      const inline = "export const meta = { name: 'inline', description: 'inline' }\nconsole.log('hi')"
      const source = await resolveWorkflowScript({ script: inline })
      expect(source).toBe(inline)
    })

    test("rejects inline script that does not start with meta", async () => {
      // No "export const meta" prefix → fails isInlineScript check, then
      // the function falls through to the "requires name, script, or file"
      // error since script was provided.
      await expect(
        resolveWorkflowScript({ script: "console.log('not inline')" }),
      ).rejects.toThrow(/requires name, script, or file/)
    })
  })

  describe("file branch", () => {
    test("resolves an absolute file path inside the workspace", async () => {
      writeFileSync(
        path.join(tmpDir, "abs.ts"),
        "export const meta = { name: 'abs', description: 'abs' }\n",
      )
      const source = await resolveWorkflowScript({
        file: path.join(tmpDir, "abs.ts"),
        workspace: tmpDir,
      })
      expect(source).toContain("description: 'abs'")
    })

    test("resolves a workspace-relative file path", async () => {
      writeFileSync(
        path.join(tmpDir, "rel.ts"),
        "export const meta = { name: 'rel', description: 'rel' }\n",
      )
      const source = await resolveWorkflowScript({
        file: "rel.ts",
        workspace: tmpDir,
      })
      expect(source).toContain("description: 'rel'")
    })

    test("rejects file path that escapes workspace (../)", async () => {
      await expect(
        resolveWorkflowScript({
          file: "../outside.ts",
          workspace: tmpDir,
        }),
      ).rejects.toThrow(/escapes workspace/)
    })

    test("rejects absolute file path outside workspace", async () => {
      await expect(
        resolveWorkflowScript({
          file: "/etc/passwd",
          workspace: tmpDir,
        }),
      ).rejects.toThrow(/escapes workspace/)
    })

    test("workspace root path (file = '.') does not trigger escape error", async () => {
      // path.resolve(workspace, '.') === workspace itself, which the jail
      // allows (the check uses `!== workspace` as an equality exemption).
      // The function then tries readFile on a directory, which throws
      // EISDIR. We only verify the jail doesn't reject it.
      await expect(
        resolveWorkflowScript({ file: ".", workspace: tmpDir }),
      ).rejects.not.toThrow(/escapes workspace/)
    })
  })

  describe("error case", () => {
    test("throws when none of name/script/file is provided", async () => {
      await expect(resolveWorkflowScript({ workspace: tmpDir })).rejects.toThrow(
        /requires name, script, or file/,
      )
    })

    test("throws when name + script both present (script branch wins, but no valid script)", async () => {
      // When name AND script are both set, the code enters the "name branch
      // guard" only if !input.script. With script set, it falls through to
      // the script branch. A non-inline script fails the isInlineScript
      // check and produces the "requires" error.
      await expect(
        resolveWorkflowScript({
          name: "deep-research",
          script: "not an inline script",
          workspace: tmpDir,
        }),
      ).rejects.toThrow(/requires name, script, or file/)
    })
  })
})
