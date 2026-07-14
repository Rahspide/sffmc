<div align="center">

<img src="docs/assets/logo.svg" alt="SFFMC" width="200" />

# SFFMC

Плагины OpenCode, портированные из MiMo-Code. 5 пакетов, MIT, на Bun.

[![GitHub release](https://img.shields.io/github/v/release/Rahspide/sffmc?color=amber&label=release)](https://github.com/Rahspide/sffmc/releases/latest)
[![npm](https://img.shields.io/npm/v/@sffmc/runtime?label=%40sffmc&color=amber)](https://www.npmjs.com/~Rahspide)
[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/Runtime-Bun-1.3.14-f472b6.svg)](https://bun.sh)

[Установка](#install) · [Документация](#docs) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [English](./README.md)

</div>

---

## Что такое SFFMC?

SFFMC - это Bun-workspace монорепо плагинов OpenCode, которые переносят продуктивные идеи из [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) от Xiaomi в чистый OpenCode, без форка. Добавь несколько строк в `opencode.json` и получишь sandboxed workflow engine, memory recall между сессиями, max-mode параллельные рассуждения, safety gates и health-check toolchain.

## Install

Плагины SFFMC загружаются OpenCode через `file://` пути в `~/.config/opencode/opencode.json`. Однострочник ниже клонирует репо и запускает `sffmc init`, который автоматически добавляет пути плагинов.

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
```

`install.sh` клонирует репо в `~/.sffmc/plugins/sffmc` и запускает `sffmc init`, который добавляет 4 дефолтных плагина (safety, memory, runtime, cognition) в твой OpenCode config. Чтобы добавить все 5 (включая библиотеку `utilities`):

```bash
sffmc init --all
```

Перезапусти OpenCode после изменений. Проверь установку:

```bash
sffmc doctor
```

### Для программного использования (npm)

Если хочешь использовать пакеты SFFMC как TypeScript-библиотеки (не как плагины OpenCode):

```bash
npm install @sffmc/runtime @sffmc/cognition @sffmc/memory @sffmc/safety @sffmc/utilities
```

Например, чтобы встроить `mergeHooks` из `@sffmc/utilities` в свой плагин, или использовать `WorkflowRuntime` из `@sffmc/runtime` программно. npm-пакеты отделены от OpenCode plugin loader - они поставляются как standalone-библиотеки для любого TypeScript-проекта.

Для всех опций установки (пиннинг версии, кастомная директория, ручной конфиг, troubleshooting), см. [docs/install.md](./docs/install.md).

## Пакеты

| Пакет | Роль | Категория |
|-------|------|-----------|
| `@sffmc/runtime` | Workflow engine, sandbox, MCP bridge | Порт MiMo |
| `@sffmc/cognition` | Max-mode рассуждения, health checks | Порт MiMo |
| `@sffmc/memory` | Межсессионная память, judge, dream, checkpoint | Композит |
| `@sffmc/safety` | Watchdog, safety gates, auto-max | Композит |
| `@sffmc/utilities` | Общая lib: config, event-bus, merge-hooks, paths | Оригинал |

## Возможности

- **Sandboxed workflow engine** - JS скрипты с бюджетами, resume, child workflows, 7 встроенных workflow (deep-research, security-audit, refactor, plan, tdd, doc-gen, lib-migrate)
- **Safety gates** - защита от деструктивных операций, recovery при сбое tools, auto-max escalation
- **Memory recall** - FTS5 поиск, checkpoint журналирование, dream consolidation
- **Max-mode** - параллельная генерация кандидатов с LLM-as-judge отбором
- **Health checks** - 13 диагностических проверок monorepo (hook conflicts, tests, version sync, type-check, public-content, ReDoS, cleanroom)

## Документация

| Док | О чём |
|-----|-------|
| [Начало работы](./docs/getting-started.md) | Установка, первый workflow, отладка |
| [Dynamic workflow](./docs/dynamic-workflow.md) | Внутренности sandbox, бюджеты, модель ошибок |
| [Примеры workflow](./docs/workflow-examples.md) | 5 готовых к копированию workflow |
| [Гайд по установке](./docs/install.md) | Ручная установка, платформенные заметки |
| [Гайд по миграции v0.16.0](./docs/v0.16.0-decomposition.md) | Миграция god-class на sub-module |
| [Импорт из MiMo](./docs/import-from-mimo.md) | Гайд для пользователей MiMo-Code |
| [Drone CI](./docs/drone-ci.md) | Референс CI pipeline |
| [Возможности MiMo](./docs/mimo-code-features.md) | Что портировано, что нет |

## Архитектура

SFFMC следует **composite pattern**: каждый плагин свободно читает state других плагинов, но пишет только в свой slot. Нет shared state между плагинами. Hot-pluggable: добавляй или убирай пакет без влияния на остальные.

```
runtime (engine)  cognition (reasoning)  utilities (shared lib)
       \                 |                    /
        \                |                   /
    safety (composite)     memory (composite)
```

См. [codemap.md](./codemap.md) для полного атласа репо и [CONTRIBUTING.md](./CONTRIBUTING.md) для референса plugin SDK.

## License

[MIT](./LICENSE). Часть функциональности адаптирована из [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) под upstream license.
