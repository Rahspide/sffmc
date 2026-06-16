#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Validates all 12 new v0.9.0 skills. Checks for: YAML frontmatter,
// "The Rule" section, examples, non-trivial body length. Catches
// regressions where a skill is added but missing required sections.
//
// Usage: bun run scripts/validate-skills.ts
// Exit 0 = all 12 skills pass.
// Exit 1 = at least one skill is malformed.

import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")

interface SkillExpect {
  readonly msp: string
  readonly file: string
}

const SKILLS: readonly SkillExpect[] = [
  { msp: "safety", file: "diagnose-tool-failure.md" },
  { msp: "safety", file: "manage-auto-max.md" },
  { msp: "safety", file: "write-rule.md" },
  { msp: "memory", file: "checkpoint-save.md" },
  { msp: "memory", file: "dream-cleanup.md" },
  { msp: "memory", file: "judge-output.md" },
  { msp: "memory", file: "recall.md" },
  { msp: "agentic", file: "compose-skill.md" },
  { msp: "agentic", file: "health-check.md" },
  { msp: "agentic", file: "resolve-hook-conflict.md" },
  { msp: "agentic", file: "run-max-mode.md" },
  { msp: "agentic", file: "run-workflow.md" },
]

let pass = 0
let fail = 0
const issues: string[] = []

for (const s of SKILLS) {
  const path = join(REPO_ROOT, "packages", s.msp, "skills", s.file)
  let content: string
  try {
    content = await readFile(path, "utf-8")
  } catch (err) {
    issues.push(`✗ ${s.msp}/${s.file}: read failed (${(err as Error).message})`)
    fail++
    continue
  }

  const errs: string[] = []

  // 1. YAML frontmatter
  if (!content.startsWith("---\n")) {
    errs.push("missing YAML frontmatter (must start with ---)")
  } else {
    const end = content.indexOf("\n---\n", 4)
    if (end < 0) {
      errs.push("unterminated YAML frontmatter (no closing ---)")
    } else {
      const fm = content.slice(4, end)
      if (!/^name:\s*\S/m.test(fm)) errs.push("YAML missing 'name:'")
      if (!/^description:\s*\S/m.test(fm)) errs.push("YAML missing 'description:'")
    }
  }

  // 2. "The Rule" section (skill template requirement)
  if (!/^#+\s*The Rule\b/im.test(content)) {
    errs.push('missing "The Rule" section')
  }

  // 3. Demonstrates by example — either a fenced code block OR a "## Examples" section.
  //    Some skills use code blocks (YAML config, tool call samples) without a
  //    dedicated "## Examples" header. Both forms are valid.
  const hasCodeBlock = /```/m.test(content)
  const hasExamplesHeader = /^#+\s*Examples\b/im.test(content)
  if (!hasCodeBlock && !hasExamplesHeader) {
    errs.push('no examples found (need a fenced code block OR a "## Examples" section)')
  }

  // 4. Body length sanity (skill is non-trivial)
  if (content.length < 500) {
    errs.push(`too short (${content.length} chars, want ≥500)`)
  }

  if (errs.length > 0) {
    issues.push(`✗ ${s.msp}/${s.file}: ${errs.join("; ")}`)
    fail++
  } else {
    issues.push(`✓ ${s.msp}/${s.file} (${content.length} chars)`)
    pass++
  }
}

console.log("[validate-skills] 12 v0.9.0 skills\n")
for (const i of issues) console.log(`  ${i}`)
console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
