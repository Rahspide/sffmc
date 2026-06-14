# Workflow Examples

Пять готовых к копированию примеров для `@sffmc/workflow`.
Каждый можно сохранить как `.sffmc/workflows/<name>.ts` и запустить
через `workflow({ operation: "run", name: "<name>" })`.

---

## 1. Hello world

Самый простой workflow — один агент, один результат.

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

**Ожидаемое время**: 2-5 секунд, ~500 токенов.

**Что смотреть**: `outcome.result.answer` должен быть `"4"` (или `4`,
зависит от модели). Если `null` — проверьте что workflow-плагин
загружен.

**Частая ошибка**: забыли `export default async function main()` — без
`main()` скрипт исполнится, но результат не попадёт в `outcome.result`.

---

## 2. API migration (3-stage pipeline)

Миграция API: найти использования → заменить → проверить тесты.

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

**Ожидаемое время**: 3-8 минут, ~30-80k токенов (зависит от размера
кодовой базы).

**Что смотреть**: `outcome.result.filesAffected` — сколько найдено,
`filesChanged` — сколько успешно заменено.

**Частая ошибка**: не указали `tools: ["grep_app"]` — agent не сможет
искать по коду и вернёт `null` (no-deliverable).

---

## 3. Security audit (parallel per file)

Параллельный аудит безопасности — каждый файл проверяется отдельным
агентом, результаты агрегируются.

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

**Ожидаемое время**: 5-15 минут, ~50-150k токенов (зависит от количества
файлов).

**Что смотреть**: `outcome.result.issues` — массив находок, отсортирован
по severity. `outcome.result.summary` — текстовая сводка.

**Частая ошибка**: `glob("**/*.ts")` занимает ОЧЕНЬ много времени в
больших проектах (node_modules, dist). Используйте конкретный путь:
`glob("src/**/*.ts")`.

---

## 4. Daily report (read → summarize → write)

Сбор логов или метрик, параллельное суммирование, запись отчёта.

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

**Ожидаемое время**: 1-5 минут, ~10-30k токенов.

**Что смотреть**: `outcome.result.report` — путь к записанному файлу.
`emptySummaries` — сколько файлов не удалось просуммировать.

**Частая ошибка**: если лог-файлы большие (>100KB), agent не сможет
прочитать их целиком. Используйте `tools: ["bash"]` с `head`/`tail`
вместо `tools: ["read"]`.

---

## 5. Deep research (built-in, 6 phases)

Самый сложный встроенный workflow. Не нужно писать код — просто
запустите по имени:

```ts
workflow({
  operation: "run",
  name: "deep-research",
  args: { question: "What are the trade-offs between React Server Components and traditional SSR in 2026?" }
})
```

Что происходит внутри (280 строк песочницы):

1. **Plan** — вопрос разбивается на 3-7 поисковых линий
2. **Search** — параллельный поиск по каждой линии
3. **Extract** — дедупликация URL, чтение топ-источников, извлечение
   фактов
4. **Group** — группировка одинаковых фактов (чтобы не проверять дважды)
5. **Crosscheck** — adversarial jury: 3 "присяжных" голосуют
   accept/reject по каждому факту. 2 reject = факт выброшен
6. **Report** — финальный отчёт: summary, sections с цитатами, limits

**Константы** (можно изменить только в коде builtin):

| Параметр | Значение | Что делает |
|---|---|---|
| `JURY_SIZE` | 3 | Сколько присяжных на факт |
| `REJECT_QUORUM` | 2 | Сколько reject-голосов убивают факт |
| `SOURCE_BUDGET` | 15 | Максимум прочитанных источников |
| `FACT_CAP` | 25 | Максимум фактов, доходящих до crosscheck |

**Ожидаемое время**: 10-30 минут, ~200-500k токенов.

**Что смотреть**: `outcome.result.summary` — ответ на вопрос.
`outcome.result.sections` — структурированные findings с цитатами.
`outcome.result.stats` — метрики (сколько источников, фактов, upheld vs
dropped).

**Частая ошибка**: все факты rejected на crosscheck → ответ "inconclusive".
Значит источники слабые или вопрос слишком широкий. Сузьте вопрос или
увеличьте `SOURCE_BUDGET` в коде.

---

## Советы

1. **Начинайте с hello-world** — убедитесь что workflow engine работает,
   прежде чем писать сложные сценарии.
2. **Используйте structured output** — `schema` в `agent()` даёт
   предсказуемые результаты, которые легко обрабатывать дальше в коде.
3. **Проверяйте на null** — каждый `agent()` может вернуть `null`.
   Пишите fallback-логику.
4. **Не злоупотребляйте parallel** — 16 конкурентных агентов = 16×
   токенов одновременно. Для 200-шаговых задач это быстро сжигает бюджет.
5. **Логируйте ключевые моменты** — `log()` и `phase()` бесплатны и
   помогают отлаживать через `workflow status`.
6. **Тестируйте на маленьких данных** — перед запуском security-audit на
   всём проекте, запустите на одном файле.
