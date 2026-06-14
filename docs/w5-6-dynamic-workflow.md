# W5-6: Dynamic Workflow Engine

**Shipped**: 2026-06-14 · **Version**: v0.6.0 · **Package**: `@sffmc/workflow` · **LOC**: ~1500

## What it is

Sandboxed JavaScript execution for orchestrating long-running, multi-step
LLM tasks — 200+ steps, with budget caps, crash recovery, and a journal
that replays completed work after restart.

Три примитива внутри песочницы:
- `agent(task, opts?)` — запустить одного LLM-агента и дождаться ответа
- `parallel(thunks)` — параллельный запуск N агентов
- `pipeline(items, ...stages)` — последовательная цепочка стадий для
  каждого элемента

Пример: исследовательский workflow на 6 фаз (Plan → Search → Extract →
Group → Crosscheck → Report) запускается одной командой:

```bash
workflow run --name deep-research --args.question "What is the best Rust web framework for 2026?"
```

Под капотом: ~30 агентов (планировщик + поисковики + чтецы + жюри +
автор отчёта), каждый изолирован, каждый с дедлайном, результат
сохраняется даже при падении процесса.

## Why we built it

В одном LLM-сеансе для задачи на 200+ шагов контекстное окно раздувается,
внимание теряется, модель начинает галлюцинировать или зацикливаться.
Подход "один сеанс = одна задача" работает до ~30 шагов, дальше —
деградация.

Workflow engine решает это иначе:
- Каждый шаг (agent) — изолированный LLM-вызов, без накопления истории
- Состояние живёт вне контекстного окна — в SQLite + JSONL-журнале
- При краше процесса workflow поднимается с последнего чекпоинта
- Жёсткие капы не дают разойтись бюджету (1000 шагов lifecycle,
  2M токенов, 16 конкурентных, 12 часов wall-clock)

Итог: один workflow заменяет 5-10 ручных сеансов, а стоит столько же
токенов, сколько эти сеансы стоили бы по отдельности (часто меньше,
потому что нет повторных запросов).

## Quick start

```ts
// .sffmc/workflows/my-task.ts
export const meta = {
  name: "my-task",
  description: "Does something useful",
  whenToUse: "Use when you need to …",
  phases: [{ title: "Setup" }, { title: "Run" }, { title: "Cleanup" }],
}

export default async function main(args) {
  const plan = await agent("Plan: " + args.goal)
  const results = await parallel(
    plan.items.map(item => () => agent("Process: " + item))
  )
  return { plan, results }
}
```

Запуск:

```bash
# В любом чате OpenCode:
workflow({ operation: "run", name: "my-task", args: { goal: "migrate to Bun" } })
```

## The 3 primitives

### `agent(task, opts?)`

```ts
agent(task: string, opts?: {
  model?: string          // override модель (e.g. "deepseek-v4-pro")
  tools?: string[]        // какие инструменты доступны (default: все)
  schema?: object         // JSON Schema для structured output
  label?: string          // человекочитаемая метка для логов
  phase?: string          // к какой фазе относится (для журнала)
  timeoutMs?: number      // per-agent дедлайн (default: 120s)
}): Promise<AgentResult>  // null | string | object
```

**Контракт**: `agent()` **никогда не бросает исключение**. Если что-то
пошло не так — возвращает `null`. 5 причин почему:

| Причина | Когда | Что делать в workflow |
|---|---|---|
| `over-cap` | Шаги/токены/время превысили лимит | Вернуть промежуточный результат |
| `spawn-reject` | LLM-вызов выбросил исключение | Повторить с fallback-промптом |
| `timeout` | Агент не ответил за `timeoutMs` | Увеличить таймаут или упростить задачу |
| `actor-error` | Агент вернул ответ без структуры | Проверить schema в opts |
| `no-deliverable` | Ответ есть, но structured/finalText пустые | Проверить промпт |

**Пример с structured output**:

```ts
const SCHEMA = {
  type: "object", required: ["items"],
  properties: { items: { type: "array", items: { type: "string" } } }
}

const result = await agent("List all .ts files in src/", {
  tools: ["bash"],
  schema: SCHEMA,
  label: "file-lister",
})
// result = { items: ["src/index.ts", "src/runtime.ts", ...] }
// или null если агент не справился
```

### `parallel(thunks)`

```ts
parallel(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>
```

Запускает все thunk-функции одновременно. Каждая функция возвращает
Promise — они исполняются конкурентно (до 16 одновременно, регулируется
глобальной семафорой). Результат — массив той же длины.

Thunk, который упал с исключением, роняет ВЕСЬ parallel (в отличие от
agent(), который never-throw). Если нужна изоляция — оборачивайте:

```ts
const results = await parallel(
  items.map(item => () =>
    agent("process: " + item)  // never-throw — безопасно
  )
)
// results[i] = результат или null
```

### `pipeline(items, ...stages)`

```ts
pipeline<T>(
  items: T[],
  ...stages: Array<(acc: unknown, item: T, index: number) => Promise<unknown>>
): Promise<Array<unknown>>
```

Каждый элемент проходит через ВСЕ стадии последовательно, а элементы
обрабатываются параллельно. Stage получает на вход: результат предыдущей
стадии, оригинальный элемент, индекс.

```ts
const perLine = await pipeline(
  ["rust", "bun", "zig"],
  // Stage 1: search
  (topic) => agent("search: " + topic, { schema: HITS_SHAPE }),
  // Stage 2: read top hit
  (found) => agent("read: " + found.hits[0].url, { schema: READ_SHAPE }),
)
// perLine[i] = результат второго stage для каждого элемента
```

## Workflow files

### Где хранить

- `packages/workflow/builtin/` — встроенные (deep-research)
- `.sffmc/workflows/*.ts` — проектные
- `.claude/workflows/*.ts` — legacy (совместимость с Claude Code)

### Структура

```ts
// Обязательный meta-блок (парсится без исполнения кода)
export const meta = {
  name: "unique-name",           // обязательное, непустое
  description: "What it does",   // обязательное, непустое
  whenToUse: "When to pick it",  // опционально, подсказка LLM
  phases: [                      // опционально, для прогресс-бара
    { title: "Phase 1", detail: "What happens in phase 1" },
    { title: "Phase 2", detail: "What happens in phase 2" },
  ],
  model: "deepseek-v4-pro",      // опционально, модель по умолчанию
}

// Основная функция (вызывается автоматически)
export default async function main(args) {
  // args — что передали в workflow({ operation: "run", args: {...} })

  phase("Setup")        // отметить начало фазы
  log("Starting...")    // записать в журнал

  const result = await agent("Do the thing")

  return result         // вернуть итог (попадёт в outcome.result)
}
```

Или без `main()` — код на верхнем уровне тоже исполнится:

```ts
export const meta = { name: "inline", ... }

phase("One shot")
const answer = await agent("What is 2+2?")
// answer попадёт в результат
```

## Side-channel primitives

Помимо `agent`/`parallel`/`pipeline`, внутри workflow доступны:

| Примитив | Сигнатура | Что делает |
|---|---|---|
| `phase(title)` | `(title: string) => void` | Устанавливает текущую фазу (отражается в `workflow status`) |
| `log(msg)` | `(msg: string) => void` | Пишет в JSONL-журнал (видно в `workflow status`) |
| `args` | `unknown` | Аргументы, переданные при запуске |
| `readFile(path)` | `(path: string) => Promise<string \| null>` | Читает файл внутри jailed workspace |
| `writeFile(path, content)` | `(path: string, content: string) => Promise<void>` | Пишет файл |
| `glob(pattern)` | `(pattern: string) => Promise<string[]>` | Glob внутри workspace |
| `exists(path)` | `(path: string) => Promise<boolean>` | Проверяет существование |
| `workflow(name, args?)` | `(name: string, args?: unknown) => Promise<unknown>` | Запускает дочерний workflow |

**Jail**: все файловые операции заперты внутри workspace (директория,
переданная при запуске). `readFile("/etc/passwd")` вернёт `null`.

## Error handling

Главное правило: `agent()` **никогда не бросает**. Это означает:

```ts
// ПРАВИЛЬНО — проверять на null
const res = await agent("risky task")
if (res === null) {
  log("agent failed, trying fallback")
  return await agent("simpler task")
}

// НЕПРАВИЛЬНО — надеяться что res всегда объект
const items = res.items  // TypeError если res === null
```

`parallel()` и `pipeline()` — наоборот, бросают. Если thunk упал с
исключением — весь batch падает. Исключение из песочницы = статус
`failed` для всего run'а.

**Детектить причину отказа** можно через события (на хосте):

```ts
import { on } from "@sffmc/workflow"

on("workflow:agent_failed", (e) => {
  console.log(`Agent ${e.agentKey} failed: ${e.reason}`)
})
```

## Budgets

5 уровней капов, все настраиваются:

| Кап | По умолчанию | Переопределение |
|---|---|---|
| **Lifecycle agents** | 1000 | `config.maxLifecycleAgents` |
| **Steps per run** | 200 | `config.maxSteps` |
| **Concurrent agents** | 16 | Глобальная семафора (auto = 2×CPU) |
| **Wall-clock** | 12 часов | `config.maxWallClockMs` |
| **Tokens** | 2 000 000 | `config.maxTokens` |

При достижении любого капа — agent() начинает возвращать `null` (reason:
`over-cap`). Workflow-скрипт должен сам решить, что делать — вернуть
промежуточный результат или закончить с ошибкой.

## Resume

Workflow автоматически восстанавливается после краша процесса:

1. При старте OpenCode вызывает `recoverOrphanedWorkflows()` — все run'ы
   со статусом `running` переводятся в `crashed`
2. Команда `workflow({ operation: "resume", run_id: "wf_..." })` —
   поднимает workflow с последнего чекпоинта
3. SHA-256 тела скрипта сравнивается с сохранённым — если скрипт
   изменился, журнал сбрасывается (edit detection)
4. Каждый успешный agent() пишется в JSONL-журнал — при повторе
   результат достаётся из кеша, агент не перезапускается

## MCP integration

Workflow НЕ имеет прямого доступа к MCP-серверам. Вместо этого
используйте `agent()` с указанием `tools`:

```ts
// Поиск через 9router (работает внутри agent)
const hits = await agent("search: Rust web frameworks", {
  tools: ["bash"],  // agent может вызвать bash, а bash — curl к 9router
})

// Или прямо через внешний инструмент если он зарегистрирован
const page = await agent("fetch: " + url, {
  tools: ["webfetch"],
})
```

Прямые MCP-биндинги запланированы на W7.

## Sandbox isolation

Workflow-скрипты исполняются внутри **quickjs-emscripten** WASM-песочницы:

- **Нет доступа** к Node.js API, файловой системе, сети, process.env
- **Нет Date** (заменён, чтобы избежать недетерминизма при replay)
- **Math.random** заменён на seeded PRNG (mulberry32) — replay
  воспроизводим
- **URL** — минимальная реализация для парсинга (protocol, hostname,
  pathname)
- **Memory limit**: 64 MB
- **Instruction limit**: 5 000 000 (прерывает бесконечные циклы)
- **Wall-clock deadline**: 12 часов на скрипт

Попытка `require("fs")`, `process.exit()`, или `fetch()` упадёт с
ReferenceError.

## Examples

### Hello world

```ts
export const meta = { name: "hello", description: "Hello world workflow", whenToUse: "demo", phases: [] }

export default async function main() {
  log("Hello from sandbox!")
  const answer = await agent("What is 1+1? Reply with just the number.")
  return { answer }
}
```

### API migration

```ts
export const meta = {
  name: "api-migration",
  description: "Migrate API calls from v1 to v2",
  phases: [{ title: "Find" }, { title: "Replace" }, { title: "Verify" }],
}

export default async function main(args) {
  phase("Find")
  const usages = await agent(`Find all ${args.oldAPI} calls in src/`, { tools: ["grep_app"] })

  phase("Replace")
  const changes = await parallel(
    usages.files.map(f => () =>
      agent(`Replace ${args.oldAPI} with ${args.newAPI} in ${f}`, { tools: ["edit"] })
    )
  )

  phase("Verify")
  const ok = await agent("Run tests and lint", { tools: ["bash"] })
  return { usages: usages.count, changed: changes.filter(Boolean).length, verified: ok !== null }
}
```

### Security audit

```ts
const files = await glob("**/*.ts")
const findings = await parallel(
  files.map(f => () => agent(`Audit ${f} for: sql injection, xss, hardcoded secrets, unsafe eval`, {
    tools: ["read"],
    schema: { type: "object", properties: { issues: { type: "array" } } },
  }))
)
return { files: files.length, issues: findings.flatMap(f => f?.issues ?? []) }
```

### Daily report

```ts
const logs = await glob("logs/*.log")
const summaries = await parallel(
  logs.map(f => () => agent(`Summarize ${f}: count errors, warnings, unique messages`, {
    tools: ["read"],
  }))
)
await writeFile("report.md", summaries.map((s, i) => `## ${logs[i]}\n${s}`).join("\n"))
return { files: logs.length, report: "report.md" }
```

### Deep research

Самый большой встроенный workflow — 6 фаз, adversarial jury:

```ts
workflow({ operation: "run", name: "deep-research", args: { question: "What is the best Rust web framework for 2026?" } })
```

[Подробнее в коде →](../packages/workflow/builtin/deep-research.ts)

## Comparison to MiMo-Code

| Аспект | MiMo-Code | SFFMC Workflow |
|---|---|---|
| **Sandbox** | `vm.createContext` (Node-only) | quickjs-emscripten WASM (Bun/Node/browser) |
| **Примитивы** | agent, parallel, pipeline | agent, parallel, pipeline (те же сигнатуры) |
| **Состояние** | 3-layer (SQLite + script + JSONL) | То же + WAL-расширение |
| **Бюджеты** | 2 caps (lifecycle, concurrent) | 5 caps (добавлены: depth, token, wall-clock) |
| **LLM-интерфейс** | 5 tool operations | Те же 5 (run/status/wait/cancel/resume) |
| **Deep research** | 391 строк JS, JURY_SIZE=3 | Портирован в TS, 280 строк, те же параметры |
| **MCP** | Прямые биндинги | Нет (W7) — через agent({ tools }) |
| **Streaming** | Есть (SSE через событие) | Нет (W7) |

Что мы изменили и почему:
- **Добавили token cap (2M)** — MiMo не считал токены, можно было сжечь
  бюджет
- **Добавили depth cap (8)** — предотвращает рекурсивные взрывы
- **Заменили vm на QuickJS** — песочница работает в Bun (MiMo был только
  Node)
- **Убрали model: "lite"** — в 9Router нет концепции "lite", используем
  модель по умолчанию
- **Добавили seeded PRNG** — replay стал полностью детерминированным

## Known limitations

1. **Cross-process resume** — работает только в рамках одного процесса.
   После рестарта OpenCode нужно явно вызвать `resume`. Автоматического
   поднятия нет (W7).
2. **No direct MCP** — agent() не может напрямую дёргать MCP-сервера.
   Только через `tools: ["bash"]` и curl к 9router (W7).
3. **No streaming** — результат workflow виден только после завершения.
   Нельзя наблюдать за прогрессом в реальном времени (W7).
4. **QuickJS performance** — маршалинг JSON между хостом и гостем стоит
   ~0.5-2ms на вызов. Для 200 шагов это ~100-400ms — незаметно. Для 2000
   шагов — ~1-4s оверхеда.
5. **Однопоточная песочница** — parallel() внутри QuickJS использует
   microtasks (Promise.all), не настоящие потоки. Конкурентность
   достигается на стороне хоста.
6. **Максимум 1000 lifecycle agents** — жёсткий предел на один экземпляр
   runtime. При превышении agent() молча возвращает null.

## Roadmap

| Wave | Что | Когда |
|---|---|---|
| **W7** | Streaming прогресса (SSE события per agent) | После v0.6.0 |
| **W7** | Multi-server resume (Redis/pubsub для cross-process) | После v0.6.0 |
| **W7** | MCP bindings (agent может дёргать mcp__* tools напрямую) | После v0.6.0 |
| **W8** | Web UI дашборд для мониторинга запущенных workflow | TBD |
| **W8** | Интеграция с slim v2 scheduler (workflow как subagent) | TBD |
| **W8** | Шаблоны workflow (pre-built: code-review, release-checklist, etc) | TBD |
