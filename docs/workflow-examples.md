# Workflow Examples

Five ready-to-copy examples for `@sffmc/runtime`.
Each can be saved as `.sffmc/workflows/<name>.ts` and run
via `workflow({ operation: "run", name: "<name>" })`.

---

## 1. Hello world

The simplest workflow — one agent, one result.

```ts
export const meta = {
  name: "hello-world",
  description: "Single-agent demo — asks a question and returns the answer",
  whenToUse: "Demo / test that the workflow engine works",
  phases: [{ title: "Ask" }],
}

export default async function main() {
  phase("Ask")
  log("Asking the agent a simple question...")
  const answer = await agent("What is 2 + 2? Reply with just the number.")
  return { answer }
}
```

**Expected time**: 2-5 seconds, ~500 tokens.

**What to check**: `outcome.result.answer` should be `"4"` (or `4`,
depending on the model). If `null` — check that the workflow plugin
is loaded.

**Common mistake**: forgot `export default async function main()` — without
`main()` the script runs, but the result won't end up in `outcome.result`.

---

## 2. API migration (3-stage pipeline)

API migration: find usages → replace → verify tests.

```ts
export const meta = {
  name: "api-migration",
  description: "Find, replace, and verify API call migrations",
  whenToUse: "Use when renaming or restructuring API endpoints across a codebase",
  phases: [
    { title: "Find", detail: "Locate all call sites of the old API" },
    { title: "Replace", detail: "Rewrite each call site to the new API" },
    { title: "Verify", detail: "Run tests and lint to confirm nothing broke" },
  ],
}

export default async function main(args) {
  // args = { oldAPI: "fetchUser", newAPI: "getUser", srcDir: "src/" }

  phase("Find")
  const usages = await agent(
    `Find all call sites of ${args.oldAPI} in ${args.srcDir}. Return JSON: { files: string[], count: number }`,
    {
      tools: ["grep_app", "read"],
      schema: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" } },
          count: { type: "number" },
        },
      },
    }
  )
  if (!usages) return { error: "Find phase failed" }
  log(`Found ${usages.count} usages in ${usages.files.length} files`)

  phase("Replace")
  const changes = await parallel(
    usages.files.map(f => () =>
      agent(
        `In file ${f}, replace all calls to ${args.oldAPI}(...) with ${args.newAPI}(...). ` +
        `Keep the arguments unchanged. Use the edit tool.`,
        { tools: ["read", "edit"], label: "replace:" + f }
      )
    )
  )

  phase("Verify")
  const testResult = await agent(
    `Run the test suite and lint. Report any failures. Use bash tool.`,
    { tools: ["bash"], label: "verify" }
  )

  return {
    filesAffected: usages.count,
    filesChanged: changes.filter(Boolean).length,
    testOutput: testResult,
  }
}
```

**Expected time**: 3-8 minutes, ~30-80k tokens (depends on codebase
size).

**What to check**: `outcome.result.filesAffected` — how many were found,
`filesChanged` — how many were successfully replaced.

**Common mistake**: didn't specify `tools: ["grep_app"]` — agent won't be
able to search code and will return `null` (no-deliverable).

---

## 3. Security audit (parallel per file)

> **Note:** `security-audit` is shipped as a built-in workflow in
> `packages/runtime/builtin/`. You can just call it by name — no need
> to write your own. The pattern below shows what a custom security
> audit workflow WOULD look like.

Parallel security audit — each file is checked by a separate
agent, results are aggregated.

```ts
export const meta = {
  name: "security-audit",
  description: "Scan all source files for common security issues in parallel",
  whenToUse: "Use before release or after merging untrusted code",
  phases: [
    { title: "Discover", detail: "List all source files" },
    { title: "Audit", detail: "Scan each file in parallel" },
    { title: "Report", detail: "Aggregate findings into a report" },
  ],
}

const ISSUE_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line: { type: "number" },
          severity: { enum: ["critical", "high", "medium", "low"] },
          category: { type: "string" },
          description: { type: "string" },
        },
      },
    },
  },
}

export default async function main(args) {
  const pattern = args?.pattern ?? "**/*.ts"
  const checks = args?.checks ?? [
    "SQL injection (string concatenation in queries)",
    "XSS (unsafe innerHTML, document.write)",
    "Hardcoded secrets (API keys, passwords, tokens)",
    "Unsafe eval / new Function",
    "Path traversal (unsanitized file paths)",
  ]

  phase("Discover")
  const files = await glob(pattern)
  log(`Found ${files.length} files matching "${pattern}"`)

  phase("Audit")
  const findings = await parallel(
    files.map(f => () =>
      agent(
        `Audit file ${f} for these issues:\n` +
        checks.map((c, i) => `${i + 1}. ${c}`).join("\n") +
        `\n\nReturn structured output with any issues found.`,
        {
          tools: ["read"],
          schema: ISSUE_SCHEMA,
          label: "audit:" + f,
        }
      )
    )
  )

  phase("Report")
  const allIssues = findings
    .flatMap((f, i) => (f?.issues ?? []).map(issue => ({ ...issue, file: files[i] })))
    .sort((a, b) => {
      const sev = { critical: 0, high: 1, medium: 2, low: 3 }
      return sev[a.severity] - sev[b.severity]
    })

  const summary = await agent(
    `Summarize these ${allIssues.length} security findings. Group by severity. ` +
    `Highlight the top 5 most critical.`,
    { label: "summary" }
  )

  await writeFile("security-audit.json", JSON.stringify({ files: files.length, issues: allIssues }, null, 2))

  return { files: files.length, issues: allIssues.length, summary }
}
```

**Expected time**: 5-15 minutes, ~50-150k tokens (depends on the number of
files).

**What to check**: `outcome.result.issues` — array of findings, sorted
by severity. `outcome.result.summary` — text summary.

**Common mistake**: `glob("**/*.ts")` takes VERY long in
large projects (node_modules, dist). Use a specific path:
`glob("src/**/*.ts")`.

---

## 4. Daily report (read → summarize → write)

Collect logs or metrics, parallel summarization, write a report.

```ts
export const meta = {
  name: "daily-report",
  description: "Read log files, summarize each, write a combined report",
  whenToUse: "Use at end of day to summarize what happened across services",
  phases: [
    { title: "Collect", detail: "Find and read log files" },
    { title: "Summarize", detail: "Summarize each log in parallel" },
    { title: "Write", detail: "Combine summaries into a report file" },
  ],
}

export default async function main(args) {
  const logPattern = args?.logPattern ?? "logs/**/*.log"
  const reportPath = args?.reportPath ?? "daily-report.md"

  phase("Collect")
  const logFiles = await glob(logPattern)
  if (logFiles.length === 0) {
    return { error: `No log files found matching "${logPattern}"` }
  }
  log(`Found ${logFiles.length} log files`)

  phase("Summarize")
  const summaries = await parallel(
    logFiles.map(f => () =>
      agent(
        `Read ${f} and summarize: count errors, warnings, unique messages, top 3 issues. Keep it brief.`,
        { tools: ["read"], label: "summarize:" + f }
      )
    )
  )

  phase("Write")
  const report = summaries
    .map((s, i) => `## ${logFiles[i]}\n\n${s ?? "(no summary available)"}\n`)
    .join("\n---\n\n")

  const header = `# Daily Report — ${new Date().toISOString().slice(0, 10)}\n\n`
  await writeFile(reportPath, header + report)

  return {
    files: logFiles.length,
    report: reportPath,
    emptySummaries: summaries.filter(s => s === null).length,
  }
}
```

**Expected time**: 1-5 minutes, ~10-30k tokens.

**What to check**: `outcome.result.report` — path to the written file.
`emptySummaries` — how many files couldn't be summarized.

**Common mistake**: if log files are large (>100KB), agent won't be able
to read them in full. Use `tools: ["bash"]` with `head`/`tail`
instead of `tools: ["read"]`.

---

## 5. Deep research (built-in, 6 phases)

> **Note:** `deep-research` is shipped as a built-in workflow in
> `packages/runtime/builtin/deep-research.ts`. You can just call it
> by name — the example below shows the call shape, not a workflow
> you need to write.

The most complex built-in workflow. No code needed — just
run by name:

```ts
workflow({
  operation: "run",
  name: "deep-research",
  args: { question: "What are the trade-offs between React Server Components and traditional SSR in 2026?" }
})
```

What happens inside (280 lines of sandbox code):

1. **Plan** — question is broken into 3-7 search lines
2. **Search** — parallel search along each line
3. **Extract** — URL deduplication, read top sources, extract
   facts
4. **Group** — group identical facts (so they aren't verified twice)
5. **Crosscheck** — adversarial jury: 3 "jurors" vote
   accept/reject on each fact. 2 rejects = fact discarded
6. **Report** — final report: summary, sections with citations, limits

**Constants** (only changeable in the builtin code):

| Parameter | Value | What it does |
|---|---|---|
| `JURY_SIZE` | 3 | How many jurors per fact |
| `REJECT_QUORUM` | 2 | How many reject votes kill a fact |
| `SOURCE_BUDGET` | 15 | Maximum sources read |
| `FACT_CAP` | 25 | Maximum facts reaching crosscheck |

**Expected time**: 10-30 minutes, ~200-500k tokens.

**What to check**: `outcome.result.summary` — answer to the question.
`outcome.result.sections` — structured findings with citations.
`outcome.result.stats` — metrics (how many sources, facts, upheld vs
dropped).

**Common mistake**: all facts rejected at crosscheck → answer "inconclusive".
This means sources are weak or the question is too broad. Narrow the
question or increase `SOURCE_BUDGET` in the code.

---

## Tips

1. **Start with hello-world** — make sure the workflow engine works
   before writing complex scenarios.
2. **Use structured output** — `schema` in `agent()` gives
   predictable results that are easy to process further in code.
3. **Check for null** — every `agent()` can return `null`.
   Write fallback logic.
4. **Don't overuse parallel** — 16 concurrent agents = 16×
   tokens simultaneously. For 200-step tasks this burns budget fast.
5. **Log key moments** — `log()` and `phase()` are free and
   help debugging via `workflow status`.
6. **Test on small data** — before running security-audit on the
   whole project, run it on one file first.
