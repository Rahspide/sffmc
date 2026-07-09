// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Check 5: tool_registration — scans tool-bearing files for the
// "tool-level name" bug from fix-17. A tool definition with `name: "X"`
// (string value) at the same indent as `description` and `execute`
// is a registration bug — the `name` field should be a parameter-schema
// object, not a top-level tool identifier.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createCheck } from "../check-factory.ts"
import { fileExists } from "../helpers.ts"
import { getHealthConfigSync } from "../config.ts"

export const checkToolRegistration = createCheck("tool_registration", async (repoRoot) => {
  const toolFiles = getHealthConfigSync().toolFiles
  const bugs: string[] = []

  for (const relPath of toolFiles) {
    const absPath = join(repoRoot, relPath)
    if (!(await fileExists(absPath))) {
      bugs.push(`${relPath}: file not found`)
      continue
    }

    try {
      const content = await readFile(absPath, "utf-8")
      const lines = content.split("\n")

      // Collect property keys per indent level.
      // A tool-level `name:` bug would be: `name: "something"` (string value)
      // at the same indent as `description:` and `execute:`.
      // Parameter-schema `name:` fields have object values (`name: {`) and deeper indent.

      const keysByIndent = new Map<number, Set<string>>()
      // Track which keys have string values (for distinguishing tool-level name vs parameter)
      const stringKeysByIndent = new Map<number, Set<string>>()

      // Lazy-init helper: returns the Set for a given indent, creating it if
      // absent. Avoids repeated `.has`/`.set`/`.get!` dance at every line.
      const getOrCreate = (m: Map<number, Set<string>>, indent: number): Set<string> => {
        let s = m.get(indent)
        if (!s) {
          s = new Set()
          m.set(indent, s)
        }
        return s
      }

      let inBlockComment = false
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith("/*")) { inBlockComment = true; continue }
        if (inBlockComment) { if (trimmed.includes("*/")) inBlockComment = false; continue }
        if (inBlockComment || trimmed.startsWith("//")) continue

        // Match property keys at their indent: `  keyName:` or `  "keyName":`
        const keyMatch = line.match(/^(\s+)([\w]+)\s*:\s*/)
        if (!keyMatch) continue

        const indent = keyMatch[1].length
        const key = keyMatch[2]

        // Only track known tool-structure keys + the potentially-buggy `name` key, plus `status` and
        // `detail` so we can distinguish CheckResult returns (which have those) from tool definitions
        // (which don't) when they appear at the same indent.
        const isToolKey = key === "description" || key === "execute" || key === "parameters" || key === "name" || key === "status" || key === "detail"
        if (!isToolKey) continue

        const afterColon = line.slice(keyMatch[0].length).trim()
        const isStringVal = /^["'`]/.test(afterColon)

        getOrCreate(keysByIndent, indent).add(key)

        if (isStringVal) {
          getOrCreate(stringKeysByIndent, indent).add(key)
        }
      }

      // For each indent level that has `description` + `parameters` + `execute`, check for `name` with string value.
      // Also require that the indent does NOT have `status` or `detail` — those indicate a CheckResult
      // return object (which legitimately has a `name` field), not a tool definition. This avoids false
      // positives when the file contains both tool definitions and CheckResult returns at the same indent.
      for (const [indent, keys] of keysByIndent) {
        if (!keys.has("description") || !keys.has("execute") || !keys.has("parameters")) continue
        if (keys.has("status") || keys.has("detail")) continue
        if (!keys.has("name")) continue

        const stringKeys = stringKeysByIndent.get(indent)
        if (stringKeys && stringKeys.has("name")) {
          bugs.push(`${relPath}: tool-level \`name\` field at indent ${indent} — registration bug (fix-17 regression)`)
        }
      }
    } catch (e) {
      bugs.push(`${relPath}: read error (${e instanceof Error ? e.message : String(e)})`)
    }
  }

  if (bugs.length === 0) {
    return {
      status: "ok",
      detail: `0 'name' field bugs across ${toolFiles.length} tool-bearing files`,
    }
  }

  return {
    status: "fail",
    detail: bugs.join("; "),
  }
})
