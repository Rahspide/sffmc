<div align="center">

> **Языки:** [English](README.md) | [Русский](README.ru.md)

# SFFMC

**Набор плагинов для OpenCode — 3 композитных пакета, 10 под-фич, лицензия MIT.**

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version 0.14.8](https://img.shields.io/badge/version-0.14.8-success)](https://github.com/Rahspide/sffmc/releases)
[![Tests](https://img.shields.io/badge/tests-903%20passing-brightgreen)](./packages/health)

[**Пакеты**](./packages) &nbsp;·&nbsp; [**Начало работы**](./docs/getting-started.md) &nbsp;·&nbsp; [**Contributing**](./CONTRIBUTING.md) &nbsp;·&nbsp; [**Changelog**](./CHANGELOG.md)

</div>

---

## Что такое SFFMC?

SFFMC — это монорепозиторий плагинов OpenCode на базе Bun-workspace, который
переносит преимущества продуктивности из форка MiMo-Code от Xiaomi в чистый
OpenCode — без необходимости форка. Одна команда curl — и вы получаете
восстановление после сбоев инструментов, защитные шлюзы для деструктивных
операций, кросс-сессионное восстановление памяти, параллельное рассуждение
с выбором победителя, изолированный движок workflow на JavaScript и
18 markdown-скиллов для compose.

Репозиторий поставляется как 14 npm-пакетов в скоупе `@sffmc/*`. Три из них —
**композитные пакеты** — `@sffmc/safety`, `@sffmc/memory` и `@sffmc/agentic` —
каждый из которых представляет собой тонкую обёртку, объединяющую несколько
под-фич в один дефолтный экспорт с помощью `mergeHooks()` из `@sffmc/shared`.
Оставшиеся 10 пакетов — это отдельные под-фичи; они по-прежнему работают
автономно для обратной совместимости.

Каждый плагин является **композитным**: он свободно читает любой hook payload,
но пишет только в свой слот. Нет экспортов на уровне модуля, нет общего
изменяемого состояния, нет связности между плагинами. Загружайте любую
комбинацию — все три композитных пакета, отдельные под-фичи или их микс —
и они чисто компонуются.

## Зачем использовать?

- **Компонуемо.** Загрузите один композитный пакет или все три, либо выберите
  отдельные под-фичи. `mergeHooks()` берёт на себя разрешение конфликтов хуков.
- **Нет общего состояния.** Каждый плагин композитный. Никаких побочных
  эффектов от порядка загрузки.
- **Drop-in.** `curl ... | sh`, затем перезапустите OpenCode. Никаких шагов
  сборки, никаких `npm install`, никакой конфигурации для старта.
- **Проверено в бою.** 903 юнит-теста в 50 файлах. Длительный агентский тест:
  96% прохождение на 121 ходу, покрывающий 41 паттерн и 12 блоков покрытия
  плагинов.
- **Лицензия MIT.** Портировано из MiMo-Code (Xiaomi) плюс оригиналы команды
  SFFMC. Свободное использование в коммерческих и частных проектах.

## Установка

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
```

Однострочник клонирует репозиторий в `~/.sffmc/plugins/sffmc` и запускает
`sffmc init`, чтобы добавить 3 записи `file://` в ваш `opencode.json`.
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
| `sffmc init` | Авто-определение конфига + добавление 3 композитных плагинов (safety, memory, agentic) |
| `sffmc init --all` | Добавить все 13 пакетов |
| `sffmc init --only workflow,compose` | Выбрать конкретные пакеты |
| `sffmc update` | `git pull --ff-only` + повторная синхронизация конфига |
| `sffmc doctor` | Запуск 13-проверочной диагностики |
| `sffmc uninstall` | Удаление всех записей SFFMC из конфига |

См. [`docs/install.md`](./docs/install.md) для полного руководства (закреплённые
версии, настройка PATH, решение проблем).

## Что нового в v0.14.8

- **Документация разделена на английский + русский.** `README.md` теперь только
  на английском; переключатель языка в начале ссылается на `README.ru.md`.
  `CHANGELOG.md` теперь только на английском; русские переводы находятся в
  `CHANGELOG.ru.md`. Оба новых файла содержат то же содержимое, что и оригинал
  в билингвальном inline-формате, просто разделены для более удобной навигации
  по языкам. Изменений в коде нет — те же 14 пакетов, то же поведение.

Тесты: 903 pass + 1 skip + 0 fail (без изменений с v0.14.6).

<details>
<summary>Хотите отдельные под-фичи вместо этого? (после `sffmc init --all`)</summary>

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
- [Contributing](#contributing)
- [Благодарности](#благодарности)
- [Лицензия](#лицензия)

## Архитектура

Каждый композитный пакет представляет собой тонкую обёртку, которая импортирует
свои под-фичи и передаёт их в `mergeHooks()` из `@sffmc/shared`. Слияние
классифицирует хуки на TRANSFORM, GATE, SIDE_EFFECT и tool — так хуки
мутации вывода выстраиваются в цепочку, шлюзы разрешений агрегируются, а
побочные эффекты выполняются независимо без конфликтов. Результат — единый
дефолтный экспорт, который ведёт себя точно так же, как загрузка всех
под-фич по отдельности, но с гарантированным порядком хуков.

```
opencode.json (3 file:// записи)
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
    safety под-фичи (5)

  +--+--+ +--+--+ +--+--+ +--+--+
  |mem- | |extra| |max- | |work-|
  |core | |     | |mode | |flow |
  +-----+ +-----+ +-----+ +-----+
    memory под-фичи (2)       agentic под-фичи (4)

                   +--+--+ +--+--+
                   |comp-| |heal-|
                   |ose  | |th   |
                   +-----+ +-----+

  +---------------------------------------------------+
  |                @sffmc/shared (SDK)                 |
  |  loadConfig  |  PluginContext  |  mergeHooks  |  EventBus  |
  +---------------------------------------------------+
```

Под-фичи композитны: каждая регистрирует свои хуки и пишет только в своё
пространство имён. Общий SDK предоставляет типобезопасную загрузку конфига из
`~/.config/SFFMC/<name>.yaml`, минимальный тип контекста плагина, типизированную
шину событий и композер `mergeHooks`.

## Пакеты

| Пакет | Композит | Роль | Статус |
|---|---|---|---|
| [`@sffmc/safety`](./packages/safety/README.md) | safety | Восстановление после сбоев инструментов + шлюзы деструктивных операций + гигиена логов | stable |
| [`@sffmc/memory`](./packages/memory/README.md) | memory | Кросс-сессионный FTS5-recall + opt-in checkpoint/judge/dream | stable |
| [`@sffmc/agentic`](./packages/agentic/README.md) | agentic | Параллельное рассуждение + изолированный workflow + compose-скиллы + health | stable |
| [`@sffmc/watchdog`](./packages/watchdog/README.md) | safety | Скользящий счётчик на 3 сбоя + автовосстановление | stable |
| [`@sffmc/rules`](./packages/rules/README.md) | safety | YAML-шлюз allow/deny для деструктивных команд | stable |
| [`@sffmc/auto-max`](./packages/auto-max/README.md) | safety | Авто-эскалация в max-mode, управляемая watchdog | stable |
| [`@sffmc/eos-stripper`](./packages/eos-stripper/README.md) | safety | Удаление EOS-токенов из вывода локальной модели | stable |
| [`@sffmc/log-whitelist`](./packages/log-whitelist/README.md) | safety | Защита permission-лога от спама при долгих запусках демона | stable |
| [`@sffmc/extra`](./packages/extra/README.md) | memory | Opt-in бандл: checkpoint, judge, dream | stable |
| [`@sffmc/max-mode`](./packages/max-mode/README.md) | agentic | Параллельные черновики + выбор победителя | stable |
| [`@sffmc/workflow`](./packages/workflow/README.md) | agentic | Изолированный JS-оркестратор (quickjs-emscripten WASM) | stable |
| [`@sffmc/compose`](./packages/compose/README.md) | agentic | 18 markdown-скиллов для типовых workflow (планирование, TDD, верификация, делегирование задач и т.д.) | stable |
| [`@sffmc/health`](./packages/health/README.md) | agentic | Диагностика плагинов с выводом в JSON | stable |
| [`@sffmc/shared`](./shared/README.md) | — | SDK: loadConfig, PluginContext, EventBus, mergeHooks | stable |

## Пример хука

Минимальный плагин OpenCode, который удаляет EOS-токены из вывода локальной
модели. Импортируйте `@sffmc/shared`, объявите интерфейс конфига с дефолтами,
зарегистрируйтесь на хук `experimental.text.complete` и измените вывод.

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

Перезапустите OpenCode. Плагин загружается, читает свой YAML-конфиг (откатываясь
к дефолтам, если файл отсутствует) и удаляет EOS-маркеры из каждого ответа
модели. Компонуйте с другими плагинами, добавляя дополнительные записи `file://`
— каждая из них пишет в свой слот.

## Конфигурация

Все плагины читают YAML-конфиг из `~/.config/SFFMC/`. Создайте нужные файлы;
отсутствующие файлы откатываются к безопасным дефолтам.

**`~/.config/SFFMC/watchdog.yaml`** — пороги сбоев и поведение восстановления:

```yaml
max_failures: 3
recovery_prompt: "The last 3 tool calls failed. Pause and diagnose the root cause before continuing."
auto_promote_model: true
promote_model: null  # inherits session primary model
```

**`~/.config/SFFMC/extra.yaml`** — opt-in продвинутые фичи памяти (все выключены по умолчанию):

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
- **[Аудит порядка загрузки](./docs/load-order-audit.md)** — порядок регистрации хуков и обоснование
- **[Справка по Workflow](./docs/dynamic-workflow.md)** — внутренности песочницы, бюджеты, модель ошибок
- **[Примеры Workflow](./docs/workflow-examples.md)** — пять готовых к копированию workflow
- **[Решение о реструктуризации v0.9.0](./CHANGELOG.md)** — см. запись v0.9.0,
  чтобы узнать, почему паттерн композиции из 3 композитных пакетов заменил
  установку по под-фичам

## Contributing

Pull requests приветствуются. Каждая под-фича — это автономный TypeScript-модуль
в `packages/<name>/src/`. Композитные пакеты — это тонкие обёртки в
`packages/<name>/src/index.ts`, которые компонуют под-фичи через `mergeHooks()`.
Прочтите [CONTRIBUTING.md](./CONTRIBUTING.md) для полного workflow: именование
веток, требования к тестам, стиль кода, чек-лист PR.

## Благодарности

SFFMC портирует фичи из [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code).
Все портированные фичи сохраняют оригинальную атрибуцию апстрима в заголовках
файлов исходников. Команда SFFMC внесла слой композиции композитных пакетов
(`mergeHooks`), SDK `@sffmc/shared` и четыре оригинальные под-фичи:
auto-max, eos-stripper, log-whitelist и health.

| Возможность | Пакет SFFMC | Описание |
|---|---|---|
| Watchdog | `@sffmc/watchdog` | Скользящий счётчик на 3 сбоя + вердикт восстановления |
| Rules | `@sffmc/rules` | YAML-шлюз allow/deny для деструктивных команд |
| Memory | `@sffmc/memory` | FTS5 SQLite + восстановление контекста в начале сессии |
| Checkpoint | `@sffmc/extra` | Возобновление с 200K + миграция схемы |
| Judge | `@sffmc/extra` | Вердикт по множеству критериев с потоковым режимом |
| Max Mode | `@sffmc/max-mode` | Параллельные черновики + выбор победителя |
| Dream | `@sffmc/extra` | Именование кластеров + очистка памяти |
| Compose | `@sffmc/compose` | 18 markdown-скиллов |
| Dynamic Workflow | `@sffmc/workflow` | Изолированный JS-оркестратор |

## Лицензия

[MIT](./LICENSE) — см. [LICENSE](./LICENSE) для полного текста.
