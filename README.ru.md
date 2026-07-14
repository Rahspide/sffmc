<div align="center">

> **Языки:** [English](README.md) | [Русский](README.ru.md)

# SFFMC

**Набор плагинов OpenCode — 2 композитных + 3 автономных. Лицензия MIT. v0.16.0.**

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/%40sffmc%2Fsafety?label=%40sffmc%2Fsafety)](https://www.npmjs.com/package/@sffmc/safety)
[![npm version](https://img.shields.io/npm/v/%40sffmc%2Fmemory?label=%40sffmc%2Fmemory)](https://www.npmjs.com/package/@sffmc/memory)
[![npm version](https://img.shields.io/npm/v/%40sffmc%2Fruntime?label=%40sffmc%2Fruntime)](https://www.npmjs.com/package/@sffmc/runtime)
[![npm version](https://img.shields.io/npm/v/%40sffmc%2Fcognition?label=%40sffmc%2Fcognition)](https://www.npmjs.com/package/@sffmc/cognition)
[![npm version](https://img.shields.io/npm/v/%40sffmc%2Futilities?label=%40sffmc%2Futilities)](https://www.npmjs.com/package/@sffmc/utilities)

[**Релиз на GitHub**](https://github.com/Rahspide/sffmc/releases/tag/v0.16.0)
&nbsp;·&nbsp;
[**Начало работы**](./docs/getting-started.md) &nbsp;·&nbsp; [**Contributing**](./CONTRIBUTING.md) &nbsp;·&nbsp; [**Changelog**](./CHANGELOG.md)

</div>

---

## Что такое SFFMC?

SFFMC — это монорепозиторий плагинов OpenCode на базе Bun-workspace, который
переносит преимущества продуктивности из форка MiMo-Code от Xiaomi в чистый
OpenCode — без необходимости форка. Одна команда `sffmc init` (или несколько
строк в `opencode.json`) — и вы получаете восстановление после сбоев
инструментов, защитные шлюзы для деструктивных операций, кросс-сессионное
восстановление памяти, параллельное рассуждение с выбором победителя,
изолированный движок workflow на JavaScript и 18 markdown-скиллов для compose.

Репозиторий поставляется как **5 npm-пакетов** в скоупе `@sffmc/*`:

| Пакет | Тип | Описание |
|---|---|---|
| `@sffmc/safety`    | композит  | 5 governance-фич (rules, watchdog, auto-max, eos-stripper, log-whitelist) |
| `@sffmc/memory`    | композит  | FTS5-поиск + checkpoint / judge / dream опции |
| `@sffmc/runtime`   | автономный | Песочница workflow-оркестратора на JavaScript (quickjs-emscripten) |
| `@sffmc/cognition` | автономный | Параллельное рассуждение (max-mode) + 18 compose-скиллов + health-диагностика |
| `@sffmc/utilities` | **библиотека** | Общий SDK. **Не точка входа плагина** — используется только через `workspace:*` остальными 4 пакетами. |

Каждый композит — это тонкая обёртка, которая использует `mergeHooks()` из
`@sffmc/utilities` для объединения своих под-фич в одну точку входа.
Автономные пакеты регистрируются сами. Каждый плагин является
**композитным**: он свободно читает любой hook payload, но пишет только в
свой слот. Нет экспортов на уровне модуля, нет общего изменяемого состояния,
нет связности между плагинами. Загружайте любую комбинацию — они чисто
компонуются.

В предыдущих релизах `@sffmc/agentic` поставлялся как единый композитный
пакет. Начиная с v0.15.0 этот композит расформирован на `@sffmc/runtime` и
`@sffmc/cognition` — если вы использовали agentic, зарегистрируйте оба
явно.

## Зачем использовать?

- **Устанавливается через npm.** v0.15.0 — это первая версия, где `npm install
  @sffmc/safety` подтягивает публичный пакет из реестра.
- **Компонуемо.** Загрузите все 4 плагина или выберите отдельные автономные
  пакеты. `mergeHooks()` берёт на себя разрешение конфликтов хуков.
- **Нет общего состояния.** Каждый плагин композитный. Никаких побочных
  эффектов от порядка загрузки.
- **Лицензия MIT.** Портировано из MiMo-Code (Xiaomi) плюс оригиналы
  команды SFFMC. Свободное использование в коммерческих и частных проектах.

## Установка

> **v0.15.0** — первая версия, устанавливаемая из **npm**. Выберите один из
> трёх способов:

### Способ A — через CLI `sffmc` (рекомендуется, все платформы)

CLI `sffmc` сам прописывает нужные записи в `opencode.json` и подтягивает npm-пакеты
при первой загрузке — ничего копировать вручную не нужно:

```bash
# 1. установите CLI глобально (один раз)
npm install -g @sffmc/safety @sffmc/memory @sffmc/runtime @sffmc/cognition

# 2. зарегистрируйте всё в opencode.json
sffmc init
```

Готово. Перезапустите OpenCode — 4 плагина подгрузятся через npm при первом
импорте. Запустите `sffmc doctor` (или вызовите инструмент `sffmc_health`)
для проверки.

### Способ Б — ручное редактирование `opencode.json`

Если предпочитаете редактировать вручную (например, для воспроизводимых
dotfiles), вставьте это в **содержимое файла** `opencode.json`, а **не в
терминал**:

```json
{
  "plugins": {
    "@sffmc/safety":    "npm:@sffmc/safety@^0.16.0",
    "@sffmc/memory":    "npm:@sffmc/memory@^0.16.0",
    "@sffmc/runtime":   "npm:@sffmc/runtime@^0.16.0",
    "@sffmc/cognition": "npm:@sffmc/cognition@^0.16.0"
  }
}
```

> ⚠️ **Не вставляйте JSON в PowerShell** — он распарсит его как script-block.
> Редактируйте файл в редакторе, либо запишите через PowerShell так:
>
> ```powershell
> @"{\"plugins\":{\"@sffmc/safety\":\"npm:@sffmc/safety@^0.16.0\",...}}"@
> | Set-Content -Path "$HOME\.sffmc\opencode.json"
> ```
>
> Полная пошаговая инструкция для PowerShell:
> [`docs/install.md`](./docs/install.md#windows-powershell).

### Способ В — однострочный установщик (legacy `file://` режим)

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
```

Однострочник клонирует репозиторий в `~/.sffmc/plugins/sffmc` и запускает
`sffmc init`, чтобы добавить 4 записи `file://` в ваш `opencode.json`.
Перезапустите OpenCode, затем проверьте с помощью `sffmc doctor` или
инструмента `sffmc_health` в любой сессии чата.

```bash
# Из исходников
git clone https://github.com/Rahspide/sffmc.git ~/.sffmc/plugins/sffmc
cd ~/.sffmc/plugins/sffmc
./install.sh
```

### Краткая справка по CLI

| Команда | Эффект |
|---|---|
| `sffmc init` | Авто-определение конфига + добавление 2 композитных плагинов + 2 автономных (safety, memory, runtime, cognition) |
| `sffmc init --all` | Добавить все 5 пакетов (но utilities — это библиотека, а не плагин) |
| `sffmc init --only runtime,cognition,safety` | Выбрать конкретные пакеты |
| `sffmc update` | `git pull --ff-only` + повторная синхронизация конфига |
| `sffmc doctor` | Запуск 9-проверочной диагностики |
| `sffmc uninstall` | Удаление всех записей SFFMC из конфига |

См. [`docs/install.md`](./docs/install.md) для полного руководства (закреплённые
версии, настройка PATH, решение проблем).

## Что нового в v0.16.0

v0.16.0 декомпозирует 5 god-классов в 22 сфокусированных sub-модуля (без ломающих изменений, публичный API сохранён в точности во всех 5 пакетах):

- **Структурный рефактор.** `dream.ts` (1291 → 10 LOC баррель + 6 sub-модулей), `runtime.ts` (817 → 614), `judge.ts` (657 → 10 + 6), `mcp.ts` (335 → 26 + 3), `max-mode/index.ts` (328 → 31 + 3), `constants.ts` (345 → 17 + 2). У каждого sub-модуля одна зона ответственности; публичная поверхность и поведение не изменились.
- **Исправление pre-commit хука.** `bun run test` переключён с single-process на per-file loop (`cd package && bun test <file>`) — bun runner утекал handles и зависал после 30 файлов. Pre-commit теперь exits 0 (10 ok / 3 warn / 0 fail; warnings — pre-existing инфра).
- **Чистка мёртвого кода + дрейфа документации.** Удалены `getMaxInstructions` (export) и `MaxModeResult` (dead import); устаревшее упоминание `flushNow()` и формулировка «11 sub-component deps» в `packages/runtime/README.md` заменены; устаревший «LOC: ~1500» в `docs/dynamic-workflow.md` удалён.

См. [CHANGELOG.md](./CHANGELOG.md) — полная секция v0.16.0.

<details>
<summary>Хотите отдельные под-фичи вместо этого? (после `sffmc init --all`)</summary>

В v0.15.0 отдельные под-фичи стали подпапками композитов. Если вы
использовали `sffmc init --all` с `--only=<sub-feature>`, эти пути
больше не доступны напрямую — переключитесь на композитные пакеты:

| Старая под-фича (v0.14.x) | Теперь подпапка |
|---|---|
| watchdog | `@sffmc/safety/src/watchdog` |
| rules | `@sffmc/safety/src/rules` |
| auto-max | `@sffmc/safety/src/auto-max` |
| eos-stripper | `@sffmc/safety/src/eos-stripper` |
| log-whitelist | `@sffmc/safety/src/log-whitelist` |
| extra (checkpoint/judge/dream) | `@sffmc/memory/src/extra` |
| workflow | `@sffmc/runtime/src` |
| max-mode | `@sffmc/cognition/src/max-mode` |
| compose | `@sffmc/cognition/src/compose` |
| health | `@sffmc/cognition/src/health` |

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
- [Contributing](#contributing)
- [Благодарности](#благодарности)
- [Лицензия](#лицензия)

## Архитектура

Каждый композитный пакет (`@sffmc/safety`, `@sffmc/memory`) представляет собой
тонкую обёртку, которая импортирует свои под-фичи и передаёт их в `mergeHooks()`
из `@sffmc/utilities`. Слияние классифицирует хуки на TRANSFORM, GATE,
SIDE_EFFECT и tool — хуки мутации вывода выстраиваются в цепочку, шлюзы
разрешений агрегируются, а побочные эффекты выполняются независимо без
конфликтов. Результат — единый дефолтный экспорт, который ведёт себя точно
так же, как загрузка всех под-фич по отдельности, но с гарантированным
порядком хуков.

```
opencode.json (4 file:// или npm: записи)
                    |
            +-------+-------+
            |               |
       [safety]          [memory]              <- композитные пакеты
            |               |
   +--------+----+    +------+-----+
   |  rules,    |    |  extra/     |
   |  watchdog, |    |  (checkpt,  |
   |  auto-max, |    |  judge,     |
   |  eos-strip,|    |  dream)     |
   |  log-wl    |    +-------------+
   +-----------+
   5 governance-фич

       [runtime]   [cognition]                <- автономные пакеты

  +-----------------------------------------------------------+
  |             @sffmc/utilities (библиотека SDK)             |
  |  loadConfig  |  PluginContext  |  mergeHooks  |  EventBus  |
  +-----------------------------------------------------------+
```

Под-фичи композитны: каждая регистрирует свои хуки и пишет только в своё
пространство имён. Общий SDK (`@sffmc/utilities`) предоставляет типобезопасную
загрузку конфига из `~/.config/SFFMC/<name>.yaml`, минимальный тип контекста
плагина, типизированную шину событий и композер `mergeHooks`. Это
**библиотека** (consumed via `workspace:*`), не точка входа плагина.

## Пакеты

| Пакет | Тип | Роль | Статус |
|---|---|---|---|
| [`@sffmc/safety`](./packages/safety/README.md)    | композит     | 5 governance-фич (rules, watchdog, auto-max, eos-stripper, log-whitelist) | stable |
| [`@sffmc/memory`](./packages/memory/README.md)    | композит     | Кросс-сессионный FTS5-recall + opt-in checkpoint/judge/dream | stable |
| [`@sffmc/runtime`](./packages/runtime/README.md)  | автономный   | Песочница workflow-оркестратора на JavaScript (quickjs-emscripten WASM) | stable |
| [`@sffmc/cognition`](./packages/cognition/README.md) | автономный | Параллельное рассуждение (max-mode) + 18 compose-скиллов + health | stable |
| [`@sffmc/utilities`](./packages/utilities/README.md) | **библиотека** | SDK: loadConfig, PluginContext, EventBus, mergeHooks. **Не точка входа плагина.** | stable |

## Пример хука

Минимальный плагин OpenCode, который удаляет EOS-токены из вывода локальной
модели. Импортируйте `@sffmc/utilities`, объявите интерфейс конфига с
дефолтами, зарегистрируйтесь на хук `experimental.text.complete` и
измените вывод.

```ts
import { loadConfig, type PluginContext } from "@sffmc/utilities"

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

Зарегистрируйте его в `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": [
    "npm:@sffmc/safety@^0.16.0",
    "npm:@sffmc/memory@^0.16.0",
    "npm:@sffmc/runtime@^0.16.0",
    "npm:@sffmc/cognition@^0.16.0"
  ]
}
```

Перезапустите OpenCode. Плагин загружается, читает свой YAML-конфиг (откатываясь
к дефолтам, если файл отсутствует) и удаляет EOS-маркеры из каждого ответа
модели. Компонуйте с другими плагинами, добавляя дополнительные записи —
каждая из них пишет в свой слот.

## Конфигурация

Все плагины читают YAML-конфиг из `~/.config/SFFMC/`. Создайте нужные файлы;
отсутствующие файлы откатываются к безопасным дефолтам.

**`~/.config/SFFMC/safety.yaml`** — пороги сбоев и поведение восстановления
(под-ключ `watchdog`):

```yaml
watchdog:
  max_failures: 3
  recovery_prompt: "The last 3 tool calls failed. Pause and diagnose the root cause before continuing."
  auto_promote_model: true
```

**`~/.config/SFFMC/memory.yaml`** — opt-in продвинутые фичи памяти (все
выключены по умолчанию, под-ключи `checkpoint` / `judge` / `dream`):

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

См. README каждого пакета для полной справки по конфигу и дефолтам.

## Документация

- **[Начало работы](./docs/getting-started.md)** — установка, первый workflow, отладка
- **[Импорт из MiMo](./docs/import-from-mimo.md)** — руководство по миграции для пользователей MiMo-Code
- **[Справка по Workflow](./docs/dynamic-workflow.md)** — внутренности песочницы, бюджеты, модель ошибок
- **[Примеры Workflow](./docs/workflow-examples.md)** — пять готовых к копированию workflow
- **[Таблица миграции v0.15.0](./CHANGELOG.md#v0150)** — обновление со старых
  13 пакетов на 5 новых

## Contributing

Pull requests приветствуются. Каждая под-фича — это автономный TypeScript-модуль
в подпапке `src/<feature>/` одного из 5 пакетов. Композитные пакеты — это тонкие
обёртки в `packages/<name>/src/index.ts`, которые компонуют свои под-фичи
через `mergeHooks()`. Прочтите [CONTRIBUTING.md](./CONTRIBUTING.md) для полного
workflow: именование веток, требования к тестам, стиль кода, чек-лист PR.

## Благодарности

SFFMC портирует фичи из [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code).
Все портированные фичи сохраняют оригинальную атрибуцию апстрима в заголовках
файлов исходников. Команда SFFMC внесла слой композиции композитных пакетов
(`mergeHooks`), библиотеку SDK `@sffmc/utilities` и четыре оригинальные
под-фичи: auto-max, eos-stripper, log-whitelist и health.

| Возможность | Где в v0.15.0 |
|---|---|
| Watchdog | `@sffmc/safety/src/watchdog` |
| Rules | `@sffmc/safety/src/rules` |
| Auto-Max | `@sffmc/safety/src/auto-max` |
| EOS-Stripper | `@sffmc/safety/src/eos-stripper` |
| Log-Whitelist | `@sffmc/safety/src/log-whitelist` |
| Memory (FTS5) | `@sffmc/memory/src` |
| Checkpoint | `@sffmc/memory/src/extra/checkpoint` |
| Judge | `@sffmc/memory/src/extra/judge` |
| Dream | `@sffmc/memory/src/extra/dream` |
| Dynamic Workflow | `@sffmc/runtime` |
| Max-Mode | `@sffmc/cognition/src/max-mode` |
| Compose (18 скиллов) | `@sffmc/cognition/src/compose/skills` |
| Health | `@sffmc/cognition/src/health` |

## Лицензия

[MIT](./LICENSE) — см. [LICENSE](./LICENSE) для полного текста.
