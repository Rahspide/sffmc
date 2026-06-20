<div align="center">

# SFFMC

**OpenCode plugin suite — 3 composite packages, 10 sub-features, MIT licensed.**

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Bun >= 1.0](https://img.shields.io/badge/Bun-%E2%89%A51.0-f9f1e1?logo=bun)](https://bun.sh)
[![Version 0.14.3](https://img.shields.io/badge/version-0.14.3-success)](https://github.com/Rahspide/sffmc/releases)
[![Tests](https://img.shields.io/badge/tests-811%20passing-brightgreen)](./packages/health)

[**Packages**](./packages) &nbsp;·&nbsp; [**Getting started**](./docs/getting-started.md) &nbsp;·&nbsp; [**Contributing**](./CONTRIBUTING.md) &nbsp;·&nbsp; [**Changelog**](./CHANGELOG.md)

</div>

---

## What is SFFMC?

SFFMC is a Bun-workspace monorepo of OpenCode plugins that port the productivity
wins from Xiaomi's MiMo-Code fork into vanilla OpenCode — no fork required.
One curl command and you get tool-failure recovery,
destructive-op safety gates, cross-session memory recall, parallel reasoning
with judge selection, a sandboxed JavaScript workflow engine, and 18 markdown
compose skills.

The repo ships as 14 npm packages under the `@sffmc/*` scope. Three of them are
**composite packages** — `@sffmc/safety`, `@sffmc/memory`, and `@sffmc/agentic` —
each of which is a thin wrapper that composes several sub-features into one
default export using `mergeHooks()` from `@sffmc/shared`. The remaining 10
packages are the individual sub-features; they still work standalone for
backward compatibility.

Every plugin is a **composite**: it reads any hook payload
freely but writes only to its own slot. No module-level exports, no shared
mutable state, no cross-plugin coupling. Load any combination — all three
composite packages, individual sub-features, or a mix — and they compose cleanly.

## Why use it?

- **Composable.** Load one composite package or all three, or pick individual
  sub-features. `mergeHooks()` handles hook collision for you.
- **Zero shared state.** Every plugin is composite. No side effects from load order.
- **Drop-in.** `curl ... | sh` then restart OpenCode. No build step, no npm
  install, no configuration required to start.
- **Battle-tested.** 811 unit tests across 50 files. Long-form agent test:
  96% pass rate on 121 turns covering 41 patterns and 12 plugin-coverage
  blocks.
- **MIT licensed.** Ported from MiMo-Code (Xiaomi) plus SFFMC team originals.
  Use freely in commercial and private projects.

## Install

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
```

The one-liner clones the repo to `~/.sffmc/plugins/sffmc` and runs
`sffmc init` to add 3 `file://` entries to your `opencode.json`.
Restart OpenCode, then verify with `sffmc doctor` or the `sffmc_health`
tool in any chat session.

```bash
# From source
git clone https://github.com/Rahspide/sffmc.git ~/.sffmc/plugins/sffmc
cd ~/.sffmc/plugins/sffmc
./install.sh
```

### CLI quick reference

| Command | Effect |
|---|---|
| `sffmc init` | Auto-detect config + add 3 composite plugins (safety, memory, agentic) |
| `sffmc init --all` | Add all 13 packages |
| `sffmc init --only workflow,compose` | Pick specific packages |
| `sffmc update` | `git pull --ff-only` + re-sync config |
| `sffmc doctor` | Run 13-check diagnostic |
| `sffmc uninstall` | Remove all SFFMC entries from config |

See [`docs/install.md`](./docs/install.md) for the full guide (pinned versions, PATH setup, troubleshooting).

## What's new in v0.14.2

- **Manriel security audit — all 30 items closed.** Real LRU eviction in checkpoint session buffer (`C2`), typed `CheckpointTooLargeError` for oversize checkpoint files (`C3`), module-level mutable state in dream.ts documented with migration path (`M9`), sandbox deadline rationale documented (`H5`), parallel candidates cap retained at 10 with explicit trade-off doc (`H6`). See [`pr-review-manriel-security-audit.md`](./pr-review-manriel-security-audit.md).
- **Workflow hardcode migration Phase 1** — 10 high-severity hardcoded constants moved from `runtime.ts` to `WorkflowConfig` YAML schema, overrideable via `~/.config/sffmc/workflow.yaml`. 17 new tests + W11 race fix.
- **`flushNow` NOT NULL regression fix** — defensive `?? 0` coercion at the persistence boundary plus test-side fixes for two fake `InternalRunEntry` objects missing counter fields. New regression test `flushNow coerces undefined counters to 0`.

Tests: 722 pass + 1 skip + 0 fail (was 710 in v0.14.0). 13 commits since v0.14.0.

<details>
<summary>Want individual sub-features instead? (after `sffmc init --all`)</summary>

All 10 sub-feature packages still work standalone for backward compatibility:

| Sub-feature | Standalone path |
|---|---|
| watchdog | `file:///path/to/SFFMC/packages/watchdog/src/index.ts` |
| rules | `file:///path/to/SFFMC/packages/rules/src/index.ts` |
| auto-max | `file:///path/to/SFFMC/packages/auto-max/src/index.ts` |
| eos-stripper | `file:///path/to/SFFMC/packages/eos-stripper/src/index.ts` |
| log-whitelist | `file:///path/to/SFFMC/packages/log-whitelist/src/index.ts` |
| extra | `file:///path/to/SFFMC/packages/extra/src/index.ts` |
| max-mode | `file:///path/to/SFFMC/packages/max-mode/src/index.ts` |
| workflow | `file:///path/to/SFFMC/packages/workflow/src/index.ts` |
| compose | `file:///path/to/SFFMC/packages/compose/src/index.ts` |
| health | `file:///path/to/SFFMC/packages/health/src/index.ts` |

</details>

## Contents

- [What is SFFMC?](#what-is-sffmc)
- [Why use it?](#why-use-it)
- [Install](#install)
- [Architecture](#architecture)
- [Packages](#packages)
- [Hook example](#hook-example)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Credits](#credits)
- [License](#license)

## Architecture

Each composite package is a thin wrapper that imports its sub-features and
passes them to `mergeHooks()` from `@sffmc/shared`. The merger categorizes
hooks into TRANSFORM, GATE, SIDE_EFFECT, and tool — so output-mutation hooks
chain, permission gates aggregate, and side-effects run independently with no
collision. The result is a single default export that behaves exactly like
loading all sub-features individually, but with guaranteed hook ordering.

```
opencode.json (3 file:// entries)
         |
    +----+----+
    |         |
[safety]  [memory]  [agentic]        <- composite packages (thin wrappers)
    |         |         |
    |    +----+----+    |
    |    |    |    |    |
    v    v    v    v    v
 +--+--+ +--+--+ +--+--+ +--+--+ +--+--+
 |watch| |rules| |auto| |eos- | |log- |
 |dog  | |     | |max | |strip| |white|
 +-----+ +-----+ +----+ +-----+ +-----+
   safety sub-features (5)

 +--+--+ +--+--+ +--+--+ +--+--+
 |mem- | |extra| |max- | |work-|
 |core | |     | |mode | |flow |
 +-----+ +-----+ +-----+ +-----+
   memory sub-features (2)       agentic sub-features (4)

                   +--+--+ +--+--+
                   |comp-| |heal-|
                   |ose  | |th   |
                   +-----+ +-----+

 +---------------------------------------------------+
 |                @sffmc/shared (SDK)                 |
 |  loadConfig  |  PluginContext  |  mergeHooks  |  EventBus  |
 +---------------------------------------------------+
```

Sub-features are composite: each registers its own hooks and writes only to its own
namespace. The shared SDK provides type-safe config loading from
`~/.config/SFFMC/<name>.yaml`, a minimal plugin context type, a typed event
bus, and the `mergeHooks` composer.

## Packages

| Package | Composite | Role | Status |
|---|---|---|---|
| [`@sffmc/safety`](./packages/safety/README.md) | safety | Tool-failure recovery + destructive-op gates + log hygiene | stable |
| [`@sffmc/memory`](./packages/memory/README.md) | memory | Cross-session FTS5 recall + opt-in checkpoint/judge/dream | stable |
| [`@sffmc/agentic`](./packages/agentic/README.md) | agentic | Parallel reasoning + sandboxed workflow + compose skills + health | stable |
| [`@sffmc/watchdog`](./packages/watchdog/README.md) | safety | 3-failure rolling counter + auto-recovery | stable |
| [`@sffmc/rules`](./packages/rules/README.md) | safety | YAML gate-based allow/deny for destructive commands | stable |
| [`@sffmc/auto-max`](./packages/auto-max/README.md) | safety | Watchdog-driven auto-escalation to max-mode | stable |
| [`@sffmc/eos-stripper`](./packages/eos-stripper/README.md) | safety | Strip EOS tokens from local model outputs | stable |
| [`@sffmc/log-whitelist`](./packages/log-whitelist/README.md) | safety | Prevent permission-log spam on long daemon runs | stable |
| [`@sffmc/extra`](./packages/extra/README.md) | memory | Opt-in bundle: checkpoint, judge, dream | stable |
| [`@sffmc/max-mode`](./packages/max-mode/README.md) | agentic | Parallel drafts + judge selection | stable |
| [`@sffmc/workflow`](./packages/workflow/README.md) | agentic | Sandboxed JS orchestrator (quickjs-emscripten WASM) | stable |
| [`@sffmc/compose`](./packages/compose/README.md) | agentic | 18 markdown skills (plan, tdd, verify, subagent, etc.) | stable |
| [`@sffmc/health`](./packages/health/README.md) | agentic | Plugin diagnostic with JSON output | stable |
| [`@sffmc/shared`](./shared/README.md) | — | SDK: loadConfig, PluginContext, EventBus, mergeHooks | stable |

## Hook example

A minimal OpenCode plugin that strips EOS tokens from local model output.
Import `@sffmc/shared`, declare a config interface with defaults, register
on the `experimental.text.complete` hook, and mutate the output.

```ts
import { loadConfig, type PluginContext } from "@sffmc/shared"

interface EosConfig { markers: string[] }
const defaults: EosConfig = { markers: ["<|im_end|>", "<|endoftext|>"] }

export default {
  id: "@sffmc/my-plugin",
  server: async (ctx: PluginContext) => {
    const config = await loadConfig<EosConfig>("my-plugin", defaults)
    return {
      "experimental.text.complete": async (_ctx, text: string) => {
        for (const m of config.markers) text = text.replaceAll(m, "")
        return text
      },
    }
  },
}
```

Register it in `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": [
    "file:///path/to/SFFMC/packages/safety/src/index.ts",
    "file:///path/to/SFFMC/packages/memory/src/index.ts",
    "file:///path/to/SFFMC/packages/agentic/src/index.ts"
  ]
}
```

Restart OpenCode. The plugin loads, reads its YAML config (falling back to
defaults if the file is missing), and strips EOS markers from every model
response. Compose with other plugins by adding more `file://` entries — each
one writes to its own slot.

## Configuration

All plugins read YAML config from `~/.config/SFFMC/`. Create the files you
need; missing files fall back to safe defaults.

**`~/.config/SFFMC/watchdog.yaml`** — failure thresholds and recovery behavior:

```yaml
max_failures: 3
recovery_prompt: "The last 3 tool calls failed. Pause and diagnose the root cause before continuing."
auto_promote_model: true
promote_model: null  # inherits session primary model
```

**`~/.config/SFFMC/extra.yaml`** — opt-in advanced memory features (all disabled by default):

```yaml
checkpoint:
  enabled: false
  max_snapshots: 5
judge:
  enabled: false
  criteria: [completeness, correctness, conciseness]
dream:
  enabled: false
```

See each package's README for its full config reference and defaults.

## Documentation

- **[Getting started](./docs/getting-started.md)** — install, first workflow, debugging
- **[Import from MiMo](./docs/import-from-mimo.md)** — migration guide for MiMo-Code users
- **[Load order audit](./docs/load-order-audit.md)** — hook registration order and rationale
- **[Workflow reference](./docs/dynamic-workflow.md)** — sandbox internals, budgets, error model
- **[Workflow examples](./docs/workflow-examples.md)** — five ready-to-copy workflows
- **[Long agent test report](./docs/long-agent-test-v090-report.md)** — v0.9.0 benchmark results
- **[v0.9.0 restructure decision](./CHANGELOG.md)** — see the v0.9.0 entry
  for why the 3-composite composition pattern replaced the per-feature
  install

## Contributing

Pull requests welcome. Each sub-feature is a standalone TypeScript module in
`packages/<name>/src/`. Composite packages are thin wrappers in
`packages/<name>/src/index.ts` that compose sub-features via `mergeHooks()`.
Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow: branch naming,
test requirements, code style, and PR checklist.

## Credits

SFFMC ports features from [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code).
All ported features retain their original upstream attribution in source-file
headers. The SFFMC team contributed the composite-package composition layer
(`mergeHooks`), the `@sffmc/shared` SDK, and four original sub-features:
auto-max, eos-stripper, log-whitelist, and health.

| Capability | SFFMC package | Description |
|---|---|---|
| Watchdog | `@sffmc/watchdog` | 3-failure rolling counter + recovery verdict |
| Rules | `@sffmc/rules` | YAML gate-based allow/deny for destructive commands |
| Memory | `@sffmc/memory` | FTS5 SQLite + context recon at session start |
| Checkpoint | `@sffmc/extra` | 200K resume with schema migration |
| Judge | `@sffmc/extra` | Multi-criteria verdict with streaming mode |
| Max Mode | `@sffmc/max-mode` | Parallel drafts + judge selection |
| Dream | `@sffmc/extra` | LLM cluster naming + memory cleaning |
| Compose | `@sffmc/compose` | 18 markdown skills |
| Dynamic Workflow | `@sffmc/workflow` | Sandboxed JS orchestrator |

## License

[MIT](./LICENSE) — see [LICENSE](./LICENSE) for full text.

---

## Русская версия / Russian Version

<!-- Everything below is a Russian translation of the English content above. -->

<div align="center">

# SFFMC

**Набор плагинов для OpenCode — 3 композитных пакета, 10 под-фич, лицензия MIT.**

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Bun >= 1.0](https://img.shields.io/badge/Bun-%E2%89%A51.0-f9f1e1?logo=bun)](https://bun.sh)
[![Version 0.14.3](https://img.shields.io/badge/version-0.14.3-success)](https://github.com/Rahspide/sffmc/releases)
[![Tests](https://img.shields.io/badge/tests-811%20passing-brightgreen)](./packages/health)

[**Пакеты**](./packages) &nbsp;·&nbsp; [**Начало работы**](./docs/getting-started.md) &nbsp;·&nbsp; [**Участие в разработке**](./CONTRIBUTING.md) &nbsp;·&nbsp; [**История изменений**](./CHANGELOG.md)

</div>

---

## Что такое SFFMC?

SFFMC — это монорепозиторий на основе Bun-workspace, содержащий плагины для OpenCode, которые переносят продуктивные решения из форка Xiaomi MiMo-Code в vanilla OpenCode — без необходимости в форке. Одной командой `curl` вы получаете восстановление после сбоев инструментов, защитные шлюзы для опасных операций, межсессионное извлечение памяти, параллельное рассуждение с выбором через judge, песочницу для JS-workflow и 18 markdown compose-навыков.

Репозиторий поставляется как 14 npm-пакетов в области имён `@sffmc/*`. Три из них — это **композитные пакеты** — `@sffmc/safety`, `@sffmc/memory` и `@sffmc/agentic` — каждый из которых представляет собой тонкую обёртку, объединяющую несколько под-фич в один дефолтный экспорт с помощью `mergeHooks()` из `@sffmc/shared`. Оставшиеся 10 пакетов — это отдельные под-фичи; они по-прежнему работают автономно для обратной совместимости.

Каждый плагин является **композитным**: он свободно читает payload любого хука, но записывает только в свой собственный слот. Никаких экспортов на уровне модуля, никакого общего изменяемого состояния, никакой связи между плагинами. Загружайте любую комбинацию — все три композитных пакета, отдельные под-фичи или их микс — и они чисто компонуются.

## Зачем использовать?

- **Компонуемость.** Загрузите один композитный пакет или все три, либо выберите отдельные под-фичи. `mergeHooks()` сама обрабатывает коллизии хуков.
- **Нулевое общее состояние.** Каждый плагин композитный. Никаких побочных эффектов от порядка загрузки.
- **Drop-in.** `curl ... | sh`, затем перезапустите OpenCode. Никаких шагов сборки, никакого `npm install`, никакой конфигурации для старта не требуется.
- **Проверено в бою.** 811 модульных тестов в 50 файлах. Долгий тест агента: 96% прохождение на 121 ходу, охватывающем 41 паттерн и 12 блоков покрытия плагинов.
- **Лицензия MIT.** Портировано из MiMo-Code (Xiaomi) плюс оригиналы команды SFFMC. Свободно используйте в коммерческих и частных проектах.

## Установка

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
```

Однострочник клонирует репозиторий в `~/.sffmc/plugins/sffmc` и выполняет `sffmc init`, чтобы добавить 3 записи `file://` в ваш `opencode.json`. Перезапустите OpenCode, затем проверьте с помощью `sffmc doctor` или инструмента `sffmc_health` в любой сессии чата.

```bash
# Из исходников
git clone https://github.com/Rahspide/sffmc.git ~/.sffmc/plugins/sffmc
cd ~/.sffmc/plugins/sffmc
./install.sh
```

### Краткая справка по CLI

| Команда | Эффект |
|---|---|
| `sffmc init` | Авто-определение конфига + добавление 3 композитных плагинов (safety, memory, agentic) |
| `sffmc init --all` | Добавление всех 13 пакетов |
| `sffmc init --only workflow,compose` | Выбор конкретных пакетов |
| `sffmc update` | `git pull --ff-only` + повторная синхронизация конфига |
| `sffmc doctor` | Запуск диагностики из 13 проверок |
| `sffmc uninstall` | Удаление всех записей SFFMC из конфига |

См. [`docs/install.md`](./docs/install.md) для полного руководства (закреплённые версии, настройка PATH, устранение неполадок).

## Что нового в v0.14.2

- **Аудит безопасности от Manriel — все 30 пунктов закрыты.** Реальное LRU-вытеснение в буфере сессий checkpoint (`C2`), типизированный `CheckpointTooLargeError` для слишком больших файлов checkpoint (`C3`), изменяемое состояние на уровне модуля в `dream.ts` документировано с путём миграции (`M9`), обоснование deadline песочницы задокументировано (`H5`), лимит параллельных кандидатов сохранён на уровне 10 с явным описанием компромисса (`H6`). См. [`pr-review-manriel-security-audit.md`](./pr-review-manriel-security-audit.md).
- **Миграция hardcode в Workflow, фаза 1** — 10 hardcoded констант высокой степени серьёзности (жёстко заданные значения в коде) перенесены из `runtime.ts` в YAML-схему `WorkflowConfig`, доступны для переопределения через `~/.config/sffmc/workflow.yaml`. 17 новых тестов + исправление гонки W11.
- **Исправление регрессии `flushNow` NOT NULL** — защитное приведение `?? 0` на границе сохранения плюс исправления на стороне тестов для двух фейковых объектов `InternalRunEntry` с отсутствующими полями счётчиков. Новый регрессионный тест `flushNow coerces undefined counters to 0`.

Тесты: 722 проходят + 1 пропущен + 0 упали (было 710 в v0.14.0). 13 коммитов с v0.14.0.

<details>
<summary>Хотите отдельные под-фичи вместо этого? (после <code>sffmc init --all</code>)</summary>

Все 10 пакетов под-фич по-прежнему работают автономно для обратной совместимости:

| Под-фича | Автономный путь |
|---|---|
| watchdog | `file:///path/to/SFFMC/packages/watchdog/src/index.ts` |
| rules | `file:///path/to/SFFMC/packages/rules/src/index.ts` |
| auto-max | `file:///path/to/SFFMC/packages/auto-max/src/index.ts` |
| eos-stripper | `file:///path/to/SFFMC/packages/eos-stripper/src/index.ts` |
| log-whitelist | `file:///path/to/SFFMC/packages/log-whitelist/src/index.ts` |
| extra | `file:///path/to/SFFMC/packages/extra/src/index.ts` |
| max-mode | `file:///path/to/SFFMC/packages/max-mode/src/index.ts` |
| workflow | `file:///path/to/SFFMC/packages/workflow/src/index.ts` |
| compose | `file:///path/to/SFFMC/packages/compose/src/index.ts` |
| health | `file:///path/to/SFFMC/packages/health/src/index.ts` |

</details>

## Содержание

- [Что такое SFFMC?](#что-такое-sffmc)
- [Зачем использовать?](#зачем-использовать)
- [Установка](#установка)
- [Архитектура](#архитектура)
- [Пакеты](#пакеты)
- [Пример хука](#пример-хука)
- [Конфигурация](#конфигурация)
- [Документация](#документация)
- [Участие в разработке](#участие-в-разработке)
- [Авторы и благодарности](#авторы-и-благодарности)
- [Лицензия](#лицензия)

## Архитектура

Каждый композитный пакет — это тонкая обёртка, которая импортирует свои под-фичи и передаёт их в `mergeHooks()` из `@sffmc/shared`. Мерджер распределяет хуки по категориям TRANSFORM, GATE, SIDE_EFFECT и tool — так что хуки мутации вывода выстраиваются в цепочку, шлюзы разрешений агрегируются, а побочные эффекты выполняются независимо без коллизий. Результат — единый дефолтный экспорт, который ведёт себя точно так же, как загрузка всех под-фич по отдельности, но с гарантированным порядком хуков.

```
opencode.json (3 записи file://)
          |
     +----+----+
     |         |
[safety]  [memory]  [agentic]        <- композитные пакеты (тонкие обёртки)
     |         |         |
     |    +----+----+    |
     |    |    |    |    |
     v    v    v    v    v
 +--+--+ +--+--+ +--+--+ +--+--+ +--+--+
 |watch| |rules| |auto| |eos- | |log- |
 |dog  | |     | |max | |strip| |white|
 +-----+ +-----+ +----+ +-----+ +-----+
   под-фичи safety (5)

 +--+--+ +--+--+ +--+--+ +--+--+
 |mem- | |extra| |max- | |work-|
 |core | |     | |mode | |flow |
 +-----+ +-----+ +-----+ +-----+
   под-фичи memory (2)       под-фичи agentic (4)

                   +--+--+ +--+--+
                   |comp-| |heal-|
                   |ose  | |th   |
                   +-----+ +-----+

 +---------------------------------------------------+
 |                @sffmc/shared (SDK)                 |
 |  loadConfig  |  PluginContext  |  mergeHooks  |  EventBus  |
 +---------------------------------------------------+
```

Под-фичи композитные: каждая регистрирует свои собственные хуки и пишет только в своё пространство имён. Общий SDK предоставляет типобезопасную загрузку конфигурации из `~/.config/SFFMC/<name>.yaml`, минимальный тип контекста плагина, типизированную шину событий и композер `mergeHooks`.

## Пакеты

| Пакет | Композит | Роль | Статус |
|---|---|---|---|
| [`@sffmc/safety`](./packages/safety/README.md) | safety | Восстановление после сбоев инструментов + шлюзы для опасных операций + гигиена логов | стабильный |
| [`@sffmc/memory`](./packages/memory/README.md) | memory | Межсессионное извлечение FTS5 + опциональные checkpoint/judge/dream | стабильный |
| [`@sffmc/agentic`](./packages/agentic/README.md) | agentic | Параллельное рассуждение + sandboxed workflow + compose-навыки + health | стабильный |
| [`@sffmc/watchdog`](./packages/watchdog/README.md) | safety | Скользящий счётчик на 3 сбоя + авто-восстановление | стабильный |
| [`@sffmc/rules`](./packages/rules/README.md) | safety | Разрешение/запрет на основе YAML-шлюзов для опасных команд | стабильный |
| [`@sffmc/auto-max`](./packages/auto-max/README.md) | safety | Управляемое watchdog автоматическое повышение до max-mode | стабильный |
| [`@sffmc/eos-stripper`](./packages/eos-stripper/README.md) | safety | Удаление EOS-токенов из вывода локальной модели | стабильный |
| [`@sffmc/log-whitelist`](./packages/log-whitelist/README.md) | safety | Предотвращение спама логов разрешений при долгих запусках демона | стабильный |
| [`@sffmc/extra`](./packages/extra/README.md) | memory | Опциональный набор: checkpoint, judge, dream | стабильный |
| [`@sffmc/max-mode`](./packages/max-mode/README.md) | agentic | Параллельные черновики + выбор через judge | стабильный |
| [`@sffmc/workflow`](./packages/workflow/README.md) | agentic | Песочный JS-оркестратор (quickjs-emscripten WASM) | стабильный |
| [`@sffmc/compose`](./packages/compose/README.md) | agentic | 18 markdown-навыков (plan, tdd, verify, subagent и др.) | стабильный |
| [`@sffmc/health`](./packages/health/README.md) | agentic | Диагностика плагинов с выводом в JSON | стабильный |
| [`@sffmc/shared`](./shared/README.md) | — | SDK: loadConfig, PluginContext, EventBus, mergeHooks | стабильный |

## Пример хука

Минимальный плагин OpenCode, который удаляет EOS-токены из вывода локальной модели. Импортируйте `@sffmc/shared`, объявите интерфейс конфигурации со значениями по умолчанию, зарегистрируйтесь на хук `experimental.text.complete` и модифицируйте вывод.

```ts
import { loadConfig, type PluginContext } from "@sffmc/shared"

interface EosConfig { markers: string[] }
const defaults: EosConfig = { markers: ["", ""] }

export default {
  id: "@sffmc/my-plugin",
  server: async (ctx: PluginContext) => {
    const config = await loadConfig<EosConfig>("my-plugin", defaults)
    return {
      "experimental.text.complete": async (_ctx, text: string) => {
        for (const m of config.markers) text = text.replaceAll(m, "")
        return text
      },
    }
  },
}
```

Зарегистрируйте его в `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": [
    "file:///path/to/SFFMC/packages/safety/src/index.ts",
    "file:///path/to/SFFMC/packages/memory/src/index.ts",
    "file:///path/to/SFFMC/packages/agentic/src/index.ts"
  ]
}
```

Перезапустите OpenCode. Плагин загружается, читает свой YAML-конфиг (возвращаясь к значениям по умолчанию, если файл отсутствует), и удаляет EOS-маркеры из каждого ответа модели. Компонуйте с другими плагинами, добавляя больше записей `file://` — каждая пишет в свой собственный слот.

## Конфигурация

Все плагины читают YAML-конфиг из `~/.config/SFFMC/`. Создайте нужные вам файлы; отсутствующие файлы возвращаются к безопасным значениям по умолчанию.

**`~/.config/SFFMC/watchdog.yaml`** — пороги сбоев и поведение восстановления:

```yaml
max_failures: 3
recovery_prompt: "The last 3 tool calls failed. Pause and diagnose the root cause before continuing."
auto_promote_model: true
promote_model: null  # наследует основную модель сессии
```

**`~/.config/SFFMC/extra.yaml`** — опциональные продвинутые функции памяти (все отключены по умолчанию):

```yaml
checkpoint:
  enabled: false
  max_snapshots: 5
judge:
  enabled: false
  criteria: [completeness, correctness, conciseness]
dream:
  enabled: false
```

См. README каждого пакета для полного справочника по конфигурации и значениям по умолчанию.

## Документация

- **[Начало работы](./docs/getting-started.md)** — установка, первый workflow, отладка
- **[Импорт из MiMo](./docs/import-from-mimo.md)** — руководство по миграции для пользователей MiMo-Code
- **[Аудит порядка загрузки](./docs/load-order-audit.md)** — порядок регистрации хуков и его обоснование
- **[Справочник по Workflow](./docs/dynamic-workflow.md)** — внутренности песочницы, бюджеты, модель ошибок
- **[Примеры Workflow](./docs/workflow-examples.md)** — пять готовых к копированию workflow
- **[Отчёт о долгом тесте агента](./docs/long-agent-test-v090-report.md)** — результаты бенчмарка v0.9.0
- **[Решение о реструктуризации v0.9.0](./CHANGELOG.md)** — см. запись v0.9.0
  о том, почему паттерн компоновки из 3 композитных пакетов заменил
  установку по каждой фиче

## Участие в разработке

Pull requests приветствуются. Каждая под-фича — это отдельный модуль TypeScript в `packages/<name>/src/`. Композитные пакеты — это тонкие обёртки в `packages/<name>/src/index.ts`, которые компонуют под-фичи через `mergeHooks()`. Прочтите [CONTRIBUTING.md](./CONTRIBUTING.md) для полного рабочего процесса: именование веток, требования к тестам, стиль кода и чек-лист PR.

## Авторы и благодарности

SFFMC портирует функции из [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code). Все портированные функции сохраняют оригинальное указание авторства upstream в заголовках файлов исходного кода. Команда SFFMC внесла слой компоновки композитных пакетов (`mergeHooks`), SDK `@sffmc/shared` и четыре оригинальные под-фичи: auto-max, eos-stripper, log-whitelist и health.

| Возможность | Пакет SFFMC | Описание |
|---|---|---|
| Watchdog | `@sffmc/watchdog` | Скользящий счётчик на 3 сбоя + вердикт о восстановлении |
| Rules | `@sffmc/rules` | Разрешение/запрет на основе YAML-шлюзов для опасных команд |
| Memory | `@sffmc/memory` | FTS5 по SQLite + восстановление контекста в начале сессии |
| Checkpoint | `@sffmc/extra` | Возобновление с 200K с миграцией схемы |
| Judge | `@sffmc/extra` | Многокритериальный вердикт с потоковым режимом |
| Max Mode | `@sffmc/max-mode` | Параллельные черновики + выбор через judge |
| Dream | `@sffmc/extra` | Именование кластеров LLM + очистка памяти |
| Compose | `@sffmc/compose` | 18 markdown-навыков |
| Dynamic Workflow | `@sffmc/workflow` | Песочный JS-оркестратор |

## Лицензия

[MIT](./LICENSE) — см. [LICENSE](./LICENSE) для полного текста.
