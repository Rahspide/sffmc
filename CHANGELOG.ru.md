## v0.15.3 (2026-07-03)

> Maintenance-релиз. **Ломающих изменений нет.** 25+ исправлений: конфигурационные разрывы, безопасность, health-проверки, дрейф документации, устаревшие ссылки. Рекомендуем обновиться всем, особенно на многопользовательских системах (фикс `mkdir` mode) и пользователям v0.14.5/v0.14.7/v0.14.8.

### Исправлено

#### Конфигурационные разрывы (v0.14.5 завышал «21 значение настраивается»)

- **Sandbox pump cadence теперь читает `WorkflowExtendedConfig`** — `packages/runtime/src/sandbox.ts:336-338` использовал inline `const SLOW_MS = 50; const FAST_WINDOW = 50` вместо существующих геттеров `getSandboxSlowMs()` / `getSandboxFastWindow()`. Теперь YAML-переопределения (`sandboxSlowMs`, `sandboxFastWindow`, `sandboxFastMs`) пользователя вступают в силу.
- **Дебаунс `FlushManager` теперь читает `getFlushDebounceMs()`** — `packages/runtime/src/flush-manager.ts:44` имел `private static readonly DEBOUNCE_MS = 250`, затеняющий геттер. Конструктор принимает необязательный параметр `debounceMs`; `runtime.ts` передаёт `getFlushDebounceMs()`.
- **Fsync coalesce в `WorkflowPersistence` теперь читает `getFsyncCoalesceMs()`** — `persistence.ts:172` имел `const FSYNC_COALESCE_MS = 50`, затеняющий геттер. `scheduleFsync()` в строке 261 теперь вызывает `getFsyncCoalesceMs()`.
- **`SAFE_REPETITION_LIMIT` экспортирован из utilities** — `packages/safety/src/rules/rules.ts:16` имел `const SAFE_REGEX_LIMIT = 25`, дублирующий `packages/utilities/src/config.ts:17`. Теперь экспортируется как `SAFE_REPETITION_LIMIT` из `@sffmc/utilities` и импортируется в `safety/rules`. Единый источник истины для ReDoS-порога.

#### Безопасность

- **Все 5 вызовов `mkdir` в runtime persistence теперь используют `mode: 0o700`** — `persistence.ts:220,369,412,427,484` ранее вызывали `mkdir(this.dir, { recursive: true })` без `mode`, оставляя runtime data-каталог читаемым для других пользователей в многопользовательских системах. Приводит runtime в соответствие с memory/dream/checkpoint, использующими `mode: 0o700` с v0.12.1.
- **`migrateLegacyDataPaths()` удалена** — экспортировалась, но никогда не подключалась к bootstrap-пути, поэтому никогда не могла сработать. Функция якобы мигрировала `~/.config/SFFMC` → `~/.config/sffmc` при первом запуске; на практике её никто не вызывал. Канонический путь остаётся uppercase `SFFMC/` для обратной совместимости. Если будущая миграция в lowercase желательна, она должна быть подключена в `activation.ts` и отгружена как плановое breaking-изменение.
- **5 новых паттернов редактирования** — `packages/utilities/src/redact-secrets.ts:118` правило `cloud-credential` расширено для покрытия: GitHub fine-grained PAT (`github_pat_*`), GitHub OAuth/user/scope токенов (`gho_*`/`ghu_*`/`ghs_*`/`ghr_*`), GitLab PAT (`glpat-*`), Discord bot-токенов (префикс `d_*`), Stripe live-ключей (`sk_live_*`, `rk_live_*`) и JWT (три base64url-сегмента, разделённые точками).
- **Защита `redactSecrets()` по `MAX_CONTENT_BYTES`** — экспортируется новый `MAX_CONTENT_BYTES = 1_048_576` (1 МиБ). Входы больше этого возвращаются неизменёнными с `{ oversize: true, categories: ["oversize"] }`, чтобы вызывающий код мог разделить на чанки или предупредить.

#### Health-плагин

- **`checkCompositeStructure` больше не хардкодит «3 композита»** — сообщение теперь использует `expectedComposites.length` и объединяет фактический список (`safety + memory`). Было устаревшим с v0.15.0, когда `@sffmc/agentic` был расформирован.
- **`checkExtraOptIn` рефакторен** — искал удалённый каталог `packages/extra/` и читал `~/.config/SFFMC/extra.yaml`. Оба пути исчезли с v0.15.0 (extra переехал в `@sffmc/memory`, utilities стал постоянной библиотекой). Функция сохранена для совместимости с log-scraper'ами, но возвращает `ok` с деталью «постоянная библиотека, opt-in не требуется».
- **`checkChangelogCurrency` теперь проверяет и `CHANGELOG.ru.md`** — promise билинговой документации — мягкий контракт (warn, не fail). Сообщает об отсутствии RU-файла или рассинхронизированной верхней версии.

#### Audit-скрипты

- **`scripts/audit-load-order.py` — сообщение об ошибке исправлено** — утверждало `expected 14` пакетов, но фактически проверяет `== 5`. Обновлено до `expected 5`.
- **`scripts/check-cleanroom.sh` очищен** — удалены мёртвые EXCLUDE_PATTERNS для удалённых `packages/compose/`, `packages/agentic/` (расформированы в v0.15.0 P-1). Убран `shared/` из grep-областей (каталог больше не существует после консолидации).

#### Дрейф документации

- **`docs/dynamic-workflow.md`** — «12 hours wall-clock» → «1 hour wall-clock» (×3 ссылки; было снижение Manriel v0.12.1, не дошедшее до доков). «Direct MCP bindings planned» → «available since v0.14.0» (было ложью, mcp.list()/mcp.call() отгружены в v0.14.0).
- **`bin/sffmc` (bash) help-текст обновлён** — «13 packages / 13-check diagnostic» → «5 packages / 9-check diagnostic» (v0.15.1 фиксил только PowerShell). Описание `--minimal`: «3 composite packages» → «4 packages (2 composites + 2 most-used standalones)».
- **`CONTRIBUTING.md`** — «v0.15.1 is the current release» → «v0.15.3 is the current release».
- **`docs/install.md`** — `SFFMC_VERSION=v0.15.0` (×2) → `SFFMC_VERSION=v0.15.3`.
- **`CHANGELOG.md`** — устаревшие ссылки «v0.14.7» (×2) → «v0.14.9» (v0.14.7 никогда не выходил; auto-миграция отгружена в v0.14.9).

#### Внутренняя гигиена

- Устаревшие ссылки на внутренние плановые файлы зачищены в исходниках и одной утилите. Изменений в поведении нет.

# SFFMC Журнал изменений (Russian)

## v0.15.2 (2026-07-02)

### Что изменилось

**Maintenance-релиз. Ломающих изменений нет.**

### Исправлено

- **Пустые страницы npm-пакетов** — `packages/utilities`, `packages/cognition`, `packages/runtime` опубликованы в v0.15.0/v0.15.1 без полей `description`, `keywords`, `bugs`, `homepage` в `package.json`. Страница на npmjs.com отображалась как «описание отсутствует», несмотря на корректный tarball. Добавлены человекочитаемые описания, массивы ключевых слов и ссылки на homepage/bugs (по образцу `@sffmc/safety` и `@sffmc/memory`).

### Добавлено

- **Записи CHANGELOG.ru.md для v0.15.0 и v0.15.1** — закрыт разрыв билинговой документации.

## v0.15.1 (2026-07-02)

### Что изменилось

**Maintenance-релиз. Ломающих изменений нет.**

### Критично

- **`bin/sffmc.ps1`** — PowerShell CLI с v0.15.0 был сломан: `PLUGIN_DIRS` содержал 13 путей к удалённым пакетам. `sffmc init --minimal` тихо пропускал `agentic` warning'ом и регистрировал только 2 из 4 валидных плагинов. PLUGIN_DIRS сокращён до 4 валидных плагинов, PKG_MAP обновлён, help text исправлен (5 packages / 9-check diagnostic).

### Исправлено

- **Stale refs в 8 EN-source файлах** — `docs/install.md`, `docs/getting-started.md`, `docs/drone-ci.md`, `docs/import-from-mimo.md`, `docs/migration-from-opencode.md`, `CONTRIBUTING.md`, `AGENTS.md`, `install.sh`, `.github/ISSUE_TEMPLATE/*`, `packages/{memory,safety}/*` обновлены под актуальный 5-пакетный лейаут. Сломанный параграф в `getting-started.md:7` (4 повтора `@sffmc/safety`) переписан.
- **Сломанные ссылки** в `packages/memory/README.md` (`../extra/`) и `packages/safety/README.md` (5 ссылок на удалённые sub-package'и).

### Добавлено

- **Реальные README** для `packages/runtime`, `packages/cognition`, `packages/utilities` (заменили 3-строчные placeholder'ы).

### Версия

- `package.json` (root) + 5× `packages/*/package.json`: 0.15.0 → 0.15.1
- `bun.lock` регенерирован

## v0.15.0 (2026-06-30)

### Что изменилось (консолидация 13 → 5 пакетов)

- **Консолидация пакетов** — 14 workspace-членов (13 пакетов + `shared/`) сведены в 5 пакетов:
  - `@sffmc/runtime` (был `@sffmc/workflow`)
  - `@sffmc/cognition` (был `@sffmc/max-mode` + `@sffmc/compose` + `@sffmc/health`; заменяет расформированный `@sffmc/agentic`)
  - `@sffmc/utilities` (был `shared/`)
  - `@sffmc/safety` и `@sffmc/memory` остаются композитами; их `composes[]` теперь пуст
- **Композит `@sffmc/agentic` расформирован** — пользователи должны явно зарегистрировать `@sffmc/runtime` и `@sffmc/cognition` в массиве `plugins[]` файла `opencode.json`
- **Импорты обновлены по всему коду** — `@sffmc/{workflow,max-mode,compose,health,rules,watchdog,auto-max,eos-stripper,log-whitelist,extra,agentic,shared}` → `@sffmc/{runtime,cognition,safety,memory,utilities}` соответственно

### Добавлено

- **Первый публичный релиз на npm** — все 4 устанавливаемых пакета (safety, memory, runtime, cognition) теперь публично доступны в реестре. `@sffmc/utilities` публикуется как библиотека.
## v0.14.9 (2026-06-28)

### Изменено

- **Документация разделена на английский + русский** — `README.md` теперь только на английском; переключатель языка в начале ссылается на `README.ru.md`. `CHANGELOG.md` теперь только на английском; русские переводы находятся в `CHANGELOG.ru.md`. Оба новых файла содержат то же содержимое, что и оригинал в билингвальном inline-формате, просто разделены для более удобной навигации по языкам.

## v0.14.6 (2026-06-21)

### Изменено

- **Формат файла checkpoint v2** — добавляет индексированный произвольный доступ и контроль целостности CRC32 к дисковой компоновке JSONL. Файлы v2 содержат побайтовые смещения каждой строки в заголовке и CRC32 байтов тела; каждая строка тела также несёт собственный CRC. Файлы v1 остаются читаемыми; существующие данные v1 мигрируются в v2 через `migrateV1ToV2(sessionID, dir?)` (явный вызов в v0.14.6; авто-миграция при первой записи v2 запланирована на v0.14.7).

### Добавлено

- **`migrateV1ToV2(sessionID, dir?)`** — явная миграция с формата v1 на v2. Читает v1, записывает v2, резервирует v1 как `<sessionID>.jsonl.v1.bak`. Возвращает `MigrationResult { ok, sourceVersion, targetVersion, lines, error? }`.
- **`crc32(data)`** — экспортируемый помощник CRC32 (полином IEEE 802.3) для вызывающего кода, которому нужно пересчитать значения целостности.
- **`packages/extra/tests/checkpoint-v2.test.ts`** — покрывает обратную совместимость с v1, запись/чтение v2, точность смещений, корректность CRC32, миграцию и стресс-тест на 100 вызовов.

### Миграция

v1 в v2 — односторонняя. После того как файл стал v2, reader не перезаписывает его обратно в v1. Reader'ы v1 продолжают работать с файлами v1. Авто-миграция при первой записи v2 запланирована на v0.14.7, в этом релизе поддержка чтения v1 будет удалена.

## v0.14.5 (2026-06-21)

### Изменено

- **Батчинг записи в checkpoint** — `_flushSession` теперь записывает все буферизованные `ToolCall` за один вызов `appendFileSync` вместо N отдельных вызовов. Формат файла на диске побайтно идентичен предыдущим релизам (по одному JSON-сериализованному `ToolCall` на строку, оканчивающемуся `\n`); существующие reader'ы (`readToolCalls`, `readHeader`) не затронуты.

### Добавлено

- **`packages/extra/bench/checkpoint-flush.bench.ts`** — синтетический микробенчмарк для пропускной способности `_flushSession`. Прогоняет `tool.execute.after` hook на 10/100/1000 вызовов и сообщает ops/sec и размер файла. Запуск: `bun run packages/extra/bench/checkpoint-flush.bench.ts`.

### Производительность

Бенчмарки (bun 1.3.14, `flushThreshold = 50` по умолчанию):

| Размер буфера | Пропускная способность | Размер файла |
|---|---|---|
| 10 вызовов | ~10k ops/sec | 1062 Б |
| 100 вызовов | ~130k ops/sec | 9882 Б |
| 1000 вызовов | ~350k ops/sec | 100782 Б |

Измерения в субмиллисекундном диапазоне зашумлены; размеры файлов побайтно идентичны между прогонами, что подтверждает: батчированная запись даёт тот же контент, что и старый цикл.

## v0.14.3 (2026-06-20)

### Исправлено

- **Утечка памяти в map `this.runs`** — `WorkflowRuntime.close()` теперь очищает `this.runs`; при завершении прогона (complete/fail/cancel) соответствующая запись удаляется. Ранее mcpBridge, journalResults и AbortController накапливались на протяжении всего времени жизни экземпляра runtime. **Исключение из политики**: этот коммит модифицирует `runtime.ts` (запрещено согласно политике hotfix v0.14.1) для исправления известной утечки памяти в долгоживущих runtime. Исправление хорошо покрыто тестами (5 новых тестов в `v0-14-3-this-runs-cleanup.test.ts`); альтернатива (отложить до v0.15) привела бы к отгрузке известной регрессии.
- **Перемещена тестовая лазейка `__setWorkflowConfig`** — перенесена в `tests/_test-helpers/config-cache.ts` за гейт `NODE_ENV === "test"`. Больше недоступна для импорта из production-сборок.
- **Чистка документации и комментариев** — номер строки в JSDoc для `recoverOrphanedWorkflows`, описание восстановления workflow в `codemap.md`, тестовый комментарий в `w10-w14-hardcode-runtime.test.ts:142`.
- **Несоответствие имени поля phase-события** — `schema-journal.ts` валидировал поле `name` у phase-событий, тогда как `runtime.ts:942-946` записывает поле `title` (а `types.ts:57` определяет его как `title`). Каждое phase-событие, записанное runtime, молча отбрасывалось валидатором и пропускалось в `loadJournal`. Валидатор и тип `JournalEventPhase` приведены к использованию `title`. Добавлен регрессионный тест в `v0-14-3-schema-journal.test.ts:160` (phase-событие с pass=3 → maxPass=3 → journal.pass=4).

### Добавлено

- **Валидация схемы журнала** — события, записываемые runtime workflow, теперь валидируются по объявленной схеме в `persistence.ts:357-390`. Некорректные события логируются на уровне debug и пропускаются — соответствует существующему поведению для «битых» строк. Дальнейшие улучшения запланированы в будущих релизах.
- **Конфигурация на пакет** — 21 хардкод (интервалы debounce, пороги песочницы, настройки журнала, параметры checkpoint) теперь настраивается через `~/.config/sffmc/{package}.yaml` для каждого пакета. Значения по умолчанию точно соответствуют поведению v0.14.2.

### Обслуживание

- **Исправлен дрейф версий между пакетами** — все 14 подпакетов подняты до `0.14.3` (было `0.14.1`).
- **Композитное поле `category: "msp"`** — добавлено в пакеты `agentic`, `memory`, `safety`.
- **Исправление `check_version_consistency` в `release.sh`** — динамическое сравнение с версией корня вместо захардкоженного `"0.12.0"`.

## Благодарность контрибьюторам

Спасибо внешнему аудиту безопасности, который помог выявить многие hardening-пункты, закрытые в линейке v0.12.1–v0.14.x.

## v0.14.2 (2026-06-20)

Закрытие внешнего аудита безопасности (все 30 пунктов) + исправление flushNow NOT NULL. См. [`README.md`](./README.md) для подробностей. 2 коммита с v0.14.1.

## v0.14.1 (2026-06-19)

Hotfix: наблюдаемость автоматического cap'а + редактирование тела PEM + ReDoS-шлюз CI + исправление ссылки на документацию dynamic-workflow. 4 коммита с v0.14.0.

### Добавлено

- **ReDoS-шлюз CI** (`scripts/check-redos.ts`, `tests/registry/redos.test.ts`) — pre-commit проверка на базе `safe-regex@^2.1.1`. Ловит катастрофический backtracking в любом правиле, зарегистрированном через `BUILTIN_RULES`. Цепочка precommit теперь содержит 6 шлюзов (typecheck, test, audit-load-order, audit:public, audit:redos, health).
- **Рефакторинг filename-правил для безопасности по ReDoS** (`shared/src/redact-secrets.ts`) — 7 паттернов имён файлов переписаны с `^X(\.[\w-]+)?$` на `^(?:X|X\.[\w-]+)$`, чтобы пройти проверку star-height-1 в safe-regex. Идентичность множества совпадений подтверждена тестом на эквивалентность.

### Изменено

- **Наблюдаемость auto-max cap** (`packages/auto-max/src/index.ts`) — `handleTrigger` теперь явно пишет в лог строку `cap reached (N/M): skipping trigger for ... in session ...`, когда блокировка срабатывает из-за `state.maxCallsThisSession >= config.costCapPerSession`. Ранее операторы считали устаревшие строки `TRIGGERED:` и ошибочно полагали, что cap не сработал.
- **Поле модели в логе загрузки watchdog** (`packages/watchdog/src/index.ts`) — терминальный fallback теперь `"(default)"` вместо пустой строки. Это различает «fallback не настроен» и «конфиг не загрузился».
- **Экспорт `__listBuiltinRedactionRules`** (`shared/src/index.ts`) — для интроспекции встроенных правил из инструментов.

### Исправлено

- **Редактирование тела PEM-ключа** (`shared/src/redact-secrets.ts`) — регулярное выражение для PEM расширено до полного блока (заголовок + тело + окончание). Ранее редактировался только заголовок `-----BEGIN ... PRIVATE KEY-----`; теперь редактируется и base64-кодированное тело ключа. 7 новых тестов (#29–35).
- **Устаревшая ссылка на документацию dynamic-workflow** (`README.md`) — исправлена битая ссылка из v0.14.0.

### Не изменялось (уже в порядке)

- Файлы `**/codemap.md` — остаются в `.gitignore` (codemap — внутренний/генерируемый документ, не источник истины). Локальные правки из cleanup-прохода сохранены на диске как артефакты.

## v0.14.0 (2026-06-19)

Хелпер редактирования секретов + grace-период + MCP-интеграция + повторный полировщик документации. 5 коммитов с v0.12.1.

### Добавлено

- **Общий хелпер редактирования секретов** (`shared/src/redact-secrets.ts`, 240 LOC) — три чистые функции (`isSensitiveFilename`, `isSensitiveSourcePath`, `redactSecrets`) + 15 встроенных правил в 4 категориях (env-файлы, имена файлов с секретами, PEM-ключи, инлайн-присваивания). Настраивается через `~/.config/sffmc/redact-secrets.yaml`. Исправляет проблему чрезмерно широких регулярных выражений из внешнего аудита безопасности (например, `token` срабатывал на `tokendeploy.sh`, `private` — на `private-blog.md`).
- **MCP INHERIT-интеграция** (`packages/workflow/src/mcp.ts`, 298 LOC) — скрипты workflow могут вызывать MCP-инструменты, унаследованные от родительской сессии. Два интерфейса: `agent({task, tools: "INHERIT"})` резолвит MCP-инструменты родителя и передаёт их ИИ-модели как конкретный массив; гостевые глобалы `mcp.list()` и `mcp.call(name, args)` для прямого вызова MCP. Per-run `McpBridge` с бюджетом (`DEFAULT_MAX_MCP_CALLS=500`) + защитой от рекурсии (`RECURSION_DEPTH_LIMIT=8`).
- **Повторный полировщик документации** (`коммит 312039f`) — восстановлены потерянные правки удаления внутреннего жаргона из потерянного коммита `f9a42be`. Применено выборочно к 13 README пакетов + `docs/install.md` + `packages/memory/skills/recall.md`.

### Изменено

- **Хук grace-периода** (`packages/workflow/src/constants.ts`, `runtime.ts`, `types.ts`) — при перезапуске OpenCode workflow в состоянии `running` с возрастом ≤ `gracePeriodMs` помечаются как `paused` (возобновляемые); более старые проходят проверку наличия записи в журнале. Значение по умолчанию `gracePeriodMs = 5 минут`, потолок `MAX_GRACE_PERIOD_MS = 24 часа`. Настраивается через `~/.config/sffmc/workflow.yaml`. Поле в `WorkflowConfig`.
- **Сужение регулярных выражений для чувствительных путей** — `packages/memory/src/watcher.ts` и `recon.ts` теперь вызывают общие хелперы из `redact-secrets.ts` вместо дублирующихся deny-листов на 7 регулярок. Чувствительные имена файлов привязаны к `basename()`; чувствительные source-пути используют и basename-, и path-уровневые правила.
- **Справочник возможностей MiMo-Code** (`docs/mimo-code-features.md`, 2 198 строк, 209 ссылок) — чисто внешний справочный документ для мейнтейнеров SFFMC. Ноль ссылок на SFFMC. Документирует реальный API MiMo в его исходном виде.
- **Исключение в скрипте `audit:public`** (`scripts/audit-public-content.sh`) — `docs/mimo-code-features.md` добавлен в `EXCLUDE_FILES`, так как он по делу ссылается на собственное состояние MiMo-Code (например, «15 compose skills» — это количество MiMo, а не SFFMC).

### Производительность

- Хелпер редактирования использует ленивый кеш `getCachedRulesSync`; плагины вызывают `void ensureRedactionRules()` для предзагрузки.

### Безопасность

- MCP-мост обходит хуки `tool.execute.before/after` по построению (защита от рекурсии).
- Логика grace-периода сохраняет существующую ветку проверки журнала как тай-брейкер (нет изменения поведения для workflow за пределами grace с записями в журнале).

### Количество тестов

665 → 664 pass / 1 skip / 0 fail (один grace-period тест пропущен из-за специфического асинхронного тайминга окружения). +95 тестов всего с v0.12.0 (570 → 664).

### Отложено в v0.15

> **Заметка о статусе (аудит post-v0.15.2, 2026-07-03):** исходный план «к v0.15» сдвинулся из-за консолидации пакетов в v0.15.0 (13 → 5). 2 из 5 пунктов молча закрыты в v0.14.1 — см. секции «Добавлено» / «Исправлено» того релиза выше. Остальные 3 ссылаются на файлы-фантомы (990-строчный дизайн-док и markdown аудита хардкодов отсутствуют в git-истории) и требуют чистого re-spec перед любой будущей реализацией.

- **Изменение формата checkpoint** (отложено с v0.12.1, не перепланировано) — *не сделано*
- **Рефакторинг схемы** (файл дизайна `docs/v0-14-m4-schema-design.md` отсутствует в git; нужен re-spec от текущего `schema.ts` 68 LOC + `schema-journal.ts` 207 LOC) — *не сделано*
- Результаты аудита хардкодов (файл аудита `.slim/deepwork/hardcode-audit-2026-06.md` отсутствует в репо; v0.14.5 уже отгрузил миграцию 21 значения в `~/.config/sffmc/{package}.yaml`, остаются ~151 числовых литерала — нужен re-scan) — *частично сделано*
- **Редактирование тела PEM-ключа** (вне scope v0.14) — ✅ отгружено в [v0.14.1](#v0141-2026-06-19) «Исправлено»
- **Продвижение ReDoS-чекера в шлюз CI** — ✅ отгружено в [v0.14.1](#v0141-2026-06-19) «Добавлено»

## v0.12.1 (2026-06-19)

Усиление безопасности — 30 hardening-фиксов по итогам внешнего аудита безопасности.

### Исправлено

- **Защита файлов workflow от path traversal** (`packages/workflow/src/runtime.ts`): `resolveWorkflow()` теперь отклоняет пути, выходящие за пределы корня рабочего каталога. Тесты покрывают `../`, `/etc/passwd` и смешанные случаи `./dir/../../etc`.
- **Защита поля `input.file` от path traversal** (`packages/workflow/src/runtime.ts:450-458`): та же защита для поля workflow `input.file`.
- **Утечка Git-токена через URL** (`packages/workflow/src/resolve.ts`): токены перенесены из URL в `http.extraHeader`.
- **Проверка GPG-подписи** после clone/pull; строгий GPG-режим.
- **Дедлайн песочницы сокращён** с 12 часов до 1 часа wall-clock.
- **Параллельные кандидаты-ответы ограничены** 10, чтобы предотвратить злоупотребление API.
- **`JSON.parse` обёрнут в try/catch** для повреждённых данных БД.
- **Дедуп-записи Dream ограничены** для предотвращения квадратичного роста.
- **LRU буфер сессий checkpoint** (`packages/extra/src/checkpoint.ts`): настоящее LRU-вытеснение через `delete + re-set` на каждом попадании (был FIFO).
- **Единообразные предупреждения oversize**: `readHeader` и `readToolCalls` теперь логируют идентичные сообщения `checkpoint: skipping … exceeds limit`.
- **Слишком большой AGENTS.md отклоняется** до чтения в память.
- **YAML-парсинг использует безопасную схему** (`Schema.JSON`) в пакете rules.
- **Резолвинг дочернего workflow привязан к рабочему каталогу родителя**.
- **Ограничительные права доступа к каталогам данных**.
- **Восстановленные из checkpoint сообщения ограничены 50**.
- **Чувствительные имена файлов пропускаются** при индексировании памяти.
- **Чувствительные source-пути фильтруются** из recon-инъекции.
- **Event bus логирует только сообщение об ошибке**, а не весь объект ошибки.
- **Архитектурная проблема `panicMode` задокументирована** + добавлен `resetPanicMode()`.
- **TOCTOU-гонка в `WorkspaceJail` задокументирована**.
- **`WORKFLOW_LIMITS` валидируются** до SQL DDL-интерполяции.
- **Ошибки legacy-миграции логируются как warning** вместо молчаливого проглатывания.

### Безопасность

- Усиление цепочки поставок: Actions прикреплены к SHA, `Invoke-Expression` удалён, строгий GPG-режим.

### Документация

- AGENTS.md: политика контейнеризованного тестирования.

### Отложено в v0.14

- Сужение регулярных выражений для чувствительных путей (слишком широкий scope).
- Изменение формата checkpoint.
- Рефакторинг схемы, объединённый хелпер редактирования.
- Дедлайн песочницы grace-период 12 часов → 1 час (риск регрессии; требует хука в AGENTS.md).

---

## v0.12.0 (2026-06-18)

Workflow Resume Passthrough + 6 приоритетных покрывающих тестов + производительность journal/checkpoint + изоляция состояния per-session.

### Добавлено

- **Workflow Resume Passthrough** — когда OpenCode перезапускается посреди workflow, выполняющиеся запуски теперь помечаются как «paused» (восстанавливаемые из журнала) вместо «crashed». Используйте `runtime.resume({ runID })` для продолжения.
- **Фабрика health-check'ов** — 13 health-check'ов объединены за единым паттерном фабрики, что убрало дублирующийся boilerplate.
- **Формат Journal v1** — журналы теперь содержат заголовок версии для прямой совместимости. Существующие v0-журналы по-прежнему парсятся корректно.
- **Событие `workflow:resumed`** — эмитится, когда приостановленный workflow возобновляется через `runtime.resume({ runID })`.
- **6 приоритетных покрывающих тестов** — гонки в захвате блокировки, прерывание агента на семафоре, принудительное ограничение глубины, обнаружение превышения бюджета, debounced flush счётчика, структурное распространение ошибок.

### Изменено

- **Производительность**: файлы журналов теперь читаются стримом при загрузке (раньше — полное чтение в память). (пакет workflow)
- **Производительность**: `readToolCalls` читает файл checkpoint один раз вместо двух. (пакет extra)
- **Производительность**: `appendJournalSync` коалесцирует вызовы `fsync` в окне 50 мс; явный API `flushJournalSync()` для гарантии долговечности. (пакет workflow)

### Исправлено

- **Утечка состояния между сессиями в `auto-max` и `max-mode`**: per-session состояние, ранее хранившееся на разделяемом объекте `ctx`, могло утекать между сессиями в долгоиграющих процессах. Перенесено в per-instance `Map<sessionID, …>` в состоянии плагина.
- **Непоследовательное использование логгера**: 10 вызовов `console.*` в `extra/checkpoint.ts` и `extra/judge.ts` переведены на общий хелпер `createLogger`.

### Удалено

- 4 мёртвых поля `MemoryConfig` (`reconBudgets.memory`, `.checkpoint`, `.taskTree`, `.agents`) — реально читалось только `reconBudgets.tail`.
- Неиспользуемый импорт `MAX_COMMAND` и мёртвое поле `triggeredLog` в `auto-max`.
- Дублирующиеся переопределения `RichPluginContext` в `extra/dream.ts` и `extra/judge.ts` (теперь импортируются из `@sffmc/shared`).

### Гигиена кода

- `@types/bun` и `bun-types` закреплены с `"latest"` на `"1.3.14"`. Удалены осиротевшие `node_modules` (устаревший `better-sqlite3@11.10.0`).
- **Количество тестов**: 570 проходят (было 546).

## v0.11.1 (2026-06-17)

Пост-релизная чистка v0.11.0. Без изменений API.

### Изменено

- **Канонизация путей**: `~/.local/share/SFFMC` и `~/.config/SFFMC` автоматически переименовываются в нижний регистр `sffmc` при следующей загрузке плагина (одноразово, идемпотентно). Обновлены все 11 пакетов.
- **Общий логгер**: 40+ вызовов `console.warn`/`console.log` заменены на общий хелпер `createLogger(prefix)` в 8 пакетах (auto-max, eos-stripper, extra, log-whitelist, max-mode, safety, watchdog, workflow).
- **Импорты композитного workspace**: композитные пакеты safety, agentic и memory теперь используют workspace-импорты `@sffmc/<name>` вместо относительных путей.
- **Тестовые утилиты**: 4 тестовых хелпера добавлены в `@sffmc/workflow` (`makeMockCtx`, `makeSlowMockCtx`, `makeCountingMockCtx`, `makeRuntimeWithMockCtx`) в `tests/test-utils.ts`.

## v0.11.0 (2026-06-16)

max-mode и workflow переведены в `@sffmc/shared`. Без изменений API для публичной поверхности `@sffmc/workflow` (breaking-интерфейс v0.10.0 сохранён).

### Добавлено

- **`extractErrorType(output)` и `isToolError(output)`** в `@sffmc/shared` — унифицированное распознавание ошибок между пакетами. Заменяет слабое regex в auto-max на строгий pattern matching.
- **`MAX_COMMAND`, `MAX_SUBCOMMANDS`, `MAX_PATTERN`, `MaxSubcommand`** в `@sffmc/shared` — общая обработка команды `/max` в max-mode, auto-max и watchdog. Исправляет баг, при котором watchdog пропускал `/max reset` и `/max clear`.
- **Тип `RichPluginContext`** в `@sffmc/shared` — расширяет `PluginContext` опциональными `client.session.message()` и `usage.totalTokens`. Заменяет отдельные интерфейсы в max-mode и workflow.

### Исправлено

- **auto-max**: ложноположительное распознавание ошибок для строк, содержащих «failsafe» или «errorless»
- **watchdog**: команды `/max reset` и `/max clear` не распознавались

### Изменено

- 3 вызова `require()` преобразованы в ES-модульный `import` (memory, workflow runtime, workflow persistence)
- Удалены избыточные зависимости `yaml` из 4 пакетов (watchdog, auto-max, eos-stripper, log-whitelist)
- Гигиена таймеров: `.unref()` добавлен к 2 таймерам, чтобы не блокировать завершение event loop
- 5 разделяемых состояний в `@sffmc/extra` (буферы checkpoint, dream-лок, таймеры) преобразованы в on-demand фабрики — обратно совместимо, существующие импорты сохранены
- max-mode и workflow теперь используют `@sffmc/shared` для общих типов

## v0.10.1 (2026-06-16)

Пост-релизная чистка v0.10.0. Без изменений API — вся работа сохраняет breaking-интерфейс v0.10.0.

### Изменено

- **builtin-registry**: 7 повторяющихся функций загрузчика свёрнуты в единый хелпер `makeLoader<T>()` (90 → 67 строк).
- **workflow runtime** (6 упрощений):
  - `resolveConfig(perStepTimeoutMsOverride?)` — унифицированный резолвинг конфига для `start()` и `resume()`
  - `settleEntry` — объединены 3 идентичных блока `.then().catch()`
  - Удалён мёртвый код: неиспользуемый блок `writeFile` в `start()`, рудиментарная null-проверка в spawnAgent
  - `makeEntry(opts)` — унифицировано троекратное конструирование `InternalRunEntry`. Исправляет дрейф 1–2 мс от дублирующихся вызовов `Date.now()`
  - `outcomeFor(entry, status, extras?)` — унифицировано троекратное конструирование `WorkflowOutcome`

### Исправлено

- Путь импорта `PluginContext` в интеграционных тестах workflow (указывал на неправильный файл)

## v0.10.0 (2026-06-16)

### Изменено (BREAKING)

**`@sffmc/workflow`**: Синглтон-цепочка заменена на инжектируемые классы.
- `WorkflowPersistence` теперь класс с опциональной инжекцией `db`/`dataDir`
- `EventBus` — фабрика `createEventBus()`, принадлежащая `WorkflowRuntime`
- `WorkspaceJail` — класс
- `runtime-ref.ts` удалён
- Добавлен `WorkflowRuntime.close()` для управления жизненным циклом

### Производительность

- `@sffmc/workflow`: импорты builtin-registry и `node:fs/promises` преобразованы с динамических на статические

### Исправлено

- `@sffmc/workflow`: в catch-блоках `events.ts` добавлено логирование ошибок (раньше было безмолвным)
- В 6 файлах исходников имена моделей-примеров заменены на пустые дефолты (watchdog, max-mode, extra, auto-max)
- Путь `.slim/deepwork/load-order-audit.json` переименован в `.sffmc/load-order-audit.json` в загрузчике и health-чекере
- Из 3 файлов исходников вычищены ссылки на `.slim/`; `bunfig.toml` больше не игнорирует `.slim/**`
- Два файла-примера конфигов, проскочивших v0.9.0-аудит, теперь используют generic плейсхолдер модели

### Добавлено

- **Установка одной строкой**: `curl -fsSL .../install.sh | sh` (Linux/macOS) и `irm .../install.ps1 | iex` (Windows). Клонирует в `~/.sffmc/plugins/sffmc` и автоматически запускает init.
- **CLI `sffmc`**: 6 подкоманд — `init` (авто-правка `opencode.json` с `--minimal|--all|--only`), `update`, `uninstall`, `doctor` (13-check диагностика), `path`, `help`.
- `docs/install.md`: полное руководство по установке с troubleshooting.
- README Quick start заменён на одно-строчную установку.

### Документация

- 8 файлов обновлено под breaking-API v0.10.0 (удалены ссылки на `setRuntime`/`setJail`/`runtime-ref`)
- Codemap'ы для `@sffmc/workflow` переписаны под class-based архитектуру
- Два пропущенных примера моделей в `run-max-mode.md` и `judge-output.md` вычищены

### Руководство по миграции

Если вы используете `@sffmc/workflow`:
- `WorkflowPersistence.createRun(...)` → `new WorkflowPersistence({ db?: Database, dataDir?: string })` затем `.createRun(...)`
- `setRuntime(runtime)` → используйте `createWorkflowTool(runtime)` напрямую
- `setJail(root)` → `new WorkflowRuntime(ctx, { workspace: root })`
- Все потребители (agentic, memory, safety) обновлены в этом релизе.

### Установка

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex

# Затем
sffmc init              # 3 композита (по умолчанию)
sffmc init --all        # все 13 пакетов
sffmc doctor            # 13-check диагностика
```

## v0.9.1 — Пост-релизная чистка + исправления багов (2026-06-16)

### Исправлено

- **`@sffmc/workflow`**: гонка cancel/fail в `completeRun` — строка БД и `entry.status` могли быть перезаписаны на «completed», если всё ещё висящий `.then()` из песочницы гнался с вызовом `cancel()`.
- **`@sffmc/workflow`**: `events.ts off(key)` был сломан для имён событий, содержащих `_` (все события workflow). Исправлен поиск ключа.
- **`@sffmc/rules`**: `gate.ts isInside()` возвращал `true` для относительных путей вроде `../etc/passwd`, обходя проверки безопасности. Исправлено: относительные пути резолвятся относительно корня проекта.

### Исправления в документации

- `docs/getting-started.md`, `docs/migration-from-opencode.md`: количество пакетов и навыков обновлено до актуальных (14 пакетов / 18 навыков); добавлено пояснение про композитные пакеты
- `packages/workflow/README.md`: исправлено количество тестов и убраны ссылки на несуществующие файлы
- `docs/migration-from-opencode.md`: исправлены имя хука и количество паттернов
- `docs/w5-6-dynamic-workflow.md`: внутренние ссылки заменены на generic-описания
- `docs/load-order-audit.md`: внутренние ссылки на плагины заменены на таблицу только-SFFMC
- Несколько файлов исходников и документации: имена моделей-примеров заменены на generic `your-model-id`; пути `.slim/` заменены на `.sffmc/`

### Производительность

- `@sffmc/extra` (dream): цикл кластерной экспансии ограничен 5 итерациями для ограничения worst-case на больших БД памяти

## v0.9.0 — Реструктуризация в 3 композита: safety, memory, agentic (2026-06-15)

### Что нового в v0.9.0

- **3 композитных пакета** (safety, memory, agentic) заменили 14 standalone-импортов — каждый композит объединяет несколько подфункций
- **10 подфункций** по-прежнему можно использовать независимо как standalone-плагины (обратно совместимо)
- **Drone CI pipeline** с автоматическим npm-паблишем по тегам
- **Публичный релиз** под `@sffmc/*` на npm

### Обратно несовместимые изменения

- Конфиги, использующие 10 подфункций: рекомендуется мигрировать на 3 композита ради новых возможностей, но **standalone по-прежнему работает** — принудительной миграции нет
- Формат localStorage seed до v0.9.0: всё ещё совместим (миграция не требуется)

> Портировано из [MiMo-Code v8.0](https://github.com/XiaomiMiMo/MiMo-Code) от Xiaomi. См. README для атрибуции по фичам.

### Структура из 3 композитных пакетов

10 подфункций теперь скомпонованы в 3 композитных пакета.
3 композита используют новую утилиту `mergeHooks()` из `@sffmc/shared`, чтобы скомпоновать
свои подфункции в единую точку входа OpenCode-плагина.

| Композит | Подфункции | Хуки | Инструменты | Новые навыки |
|---|---|---|---|---|
| `@sffmc/safety` | watchdog, rules, auto-max, eos-stripper, log-whitelist | 9 ключей | 0 | 3 |
| `@sffmc/memory` | memory-core, checkpoint, judge, dream | 5 ключей | 3 (extra_*) | 4 |
| `@sffmc/agentic` | max-mode, workflow, compose, health | 5 ключей | 3 | 5 |

### Новое: `@sffmc/shared` экспортирует `mergeHooks()`

`mergeHooks()` компонует N возвращаемых значений `server()` в одно.
4 категории хуков с разной семантикой слияния:

- **TRANSFORM** (цепочка): каждый обработчик получает выход предыдущего
- **GATE** (первый-truthy-побеждает): первый обработчик, вернувший truthy, прерывает цепочку
- **SIDE_EFFECT** (последовательно): все обработчики выполняются, возвращаемое значение не используется
- **tool** (глубокое слияние с приоритетом последнего + warn при коллизии)

### Аудит хуков TRANSFORM

7 обработчиков в 5 пакетах возвращали `void` вместо `data`, что
сломало бы TRANSFORM-чейнинг в `mergeHooks`. Исправлено в auto-max, eos-stripper,
log-whitelist, max-mode и watchdog.

### Рефакторинг extra (фабрика → 3 именованных сервера)

`@sffmc/extra` ранее объединял 3 подфункции (checkpoint, judge, dream)
через фабрику, возвращавшую один сервер. Теперь экспортирует 3 именованных сервера:

- `export const checkpointServer` — checkpoint как композит
- `export const judgeServer` — judge как композит
- `export const dreamServer` — dream как композит
- `export const server` — объединённый (вызывает все 3 + `mergeHooks()`) для standalone
- `export default { id: "extra", server }` — обратная совместимость

### memory выделен в `plugin.ts` (id="memory-core")

Исходная 150-строчная реализация memory перенесена в `packages/memory/src/plugin.ts`
с `id = "memory-core"`. Новый `packages/memory/src/index.ts` компонует
memory-core + 3 именованных сервера из extra через `mergeHooks()`.

### 12 новых навыков (3 + 4 + 5)

**Safety (3):**
- `safety:diagnose-tool-failure` — прочитать вердикт watchdog по 3-кратному отказу
- `safety:write-rule` — добавить правила безопасности в `~/.config/SFFMC/rules.yaml`
- `safety:manage-auto-max` — auto-max против ручного `/max`, когда предлагать

**Memory (4):**
- `memory:recall` — прочитать авто-инжектируемый recon, 5 категорий бюджета
- `memory:checkpoint-save` — точка возобновления 200K токенов, версионирование схемы
- `memory:judge-output` — мульти-критериальный вердикт (корректность / читаемость / производительность)
- `memory:dream-cleanup` — 3 фазы (cluster / score / archive), восстановление

**Agentic (5):**
- `agentic:run-workflow` — 7 встроенных, лимиты песочницы QuickJS
- `agentic:run-max-mode` — 3 параллельных кандидата + 1 judge, учёт стоимости
- `agentic:compose-skill` — индекс из 18 compose-навыков
- `agentic:health-check` — 12 sffmc_health-проверок
- `agentic:resolve-hook-conflict` — семантика TRANSFORM / GATE / SIDE_EFFECT

### Миграция с v0.8.2

Конфиги v0.8.2 работают без изменений — все 10 пакетов подфункций по-прежнему
загружаются как standalone-плагины. Чтобы использовать новые композитные пакеты (рекомендуется):

```diff
- "plugin": [ ..., "memory", "watchdog", "rules", "max-mode", "compose", ... ]
+ "plugin": [ ..., "safety", "memory", "agentic" ]
```

3 композита собирают все 10 подфункций через `mergeHooks()` и не имеют
видимых пользователю изменений поведения. Те же хуки, те же инструменты, те же YAML-конфиги.

## v0.8.2 — Категории пакетов (mimo-port vs sffmc-original) (2026-06-15)

## Категории пакетов
Каждый из 11 пакетов SFFMC теперь имеет явные метаданные `category` в
`package.json`, чтобы чётко отделить фичи, портированные из MiMo-Code v8.0,
от добавленных командой SFFMC.
### mimo-port (7 пакетов — портировано из MiMo-Code v8.0)
- @sffmc/memory (Memory + Context Recon)
- @sffmc/rules (Safety Rules)
- @sffmc/watchdog (Auto-recovery)
- @sffmc/max-mode (Parallel drafts)
- @sffmc/auto-max (Auto-escalation)
- @sffmc/compose (15 MiMo compose-навыков)
- @sffmc/workflow (Dynamic Workflow)
### sffmc-original (4 пакета — добавлено командой SFFMC)
- @sffmc/eos-stripper (выживание EOS-токенов локальной модели)
- @sffmc/log-whitelist (предотвращение 12GB лог-файлов)
- @sffmc/health (диагностика для авторов плагинов)
- @sffmc/extra (opt-in набор)
## Новая проверка sffmc_health
12-я проверка `category_split` сообщает разделение и предупреждает, если какой-либо пакет
некатегоризирован. Сейчас 7 mimo-port + 4 sffmc-original, 0 некатегоризированных.
Полный sffmc_health: 12 ok, 0 warn, 0 fail (было 11 ok 1 warn в v0.8.1
из-за несоответствия changelog_currency — исправлено бампом версии).
## Документация
- README.md: новая секция «Категории пакетов» с полной таблицей
- Каждый package.json: поле `category` + `portSource` (mimo-port) или
  `rationale` (sffmc-original)
## Синхронизация версий
Все 13 пакетов (11 SFFMC + shared + root) подняты с 0.8.0 → 0.8.1 для
выравнивания с CHANGELOG v0.8.1 (были несостыковки в релизе v0.8.1).

## v0.8.1 — Известные пробелы исправлены + улучшения opt-in набора + 6 новых навыков/встроенных (2026-06-15)

### Исправлено

- **compose**: корректная ошибка при повреждённом/отсутствующем файле навыка
- **auto-max**: 3 улучшения
  - конфиг `dry_run: boolean` — считает отказы, но фактически не запускает max-mode
  - хук-лазейка `/max` (regex матчит `/max`, `/max reset`, `/max clear`, `/max reset <id>`)
  - распознавание ошибок в object-выводе — поля `{ error }` или `{ code }` теперь считаются как отказы

### Добавлено

**Улучшения opt-in набора:**
- **Checkpoint**: миграция схемы — `CURRENT_VERSION=1`, `migrateCheckpoint(raw, fromVersion)`, forward-compat restore
- **Judge**: потоковый режим — `callJudgeStream` с колбэком `onChunk` для чанков `scores`/`winner`/`reasoning`/`complete`/`error`
- **Dream**: именование кластеров через ИИ — `nameClusterViaLLM` генерирует 3–5-словную фразу-тему

**Новые встроенные workflow (3):**
- `security-audit` (4 фазы): Scope → Scan (4 параллельных агента) → Triage → Report
- `doc-gen` (3 фазы): Inventory → Generate (параллельные пачки) → Assemble
- `lib-migrate` (5 фаз): Detect → Map → Transform → Verify → Report
- Всего 7 встроенных (было 4)

**Новые навыки compose (3):**
- `code-review` (6.7KB): структурированный обзор с находками, тегированными по severity
- `benchmark` (7.2KB): замеры производительности + сравнение с baseline
- `audit-deps` (8.7KB): аудит устаревших / уязвимых / неиспользуемых / по лицензиям
- Всего 18 навыков (было 15)

### Изменено

- auto-max, watchdog: переведены на общий загрузчик конфига (`loadConfig`)

## v0.8.0 — плагин @sffmc/extra (opt-in набор) (2026-06-15)

### Добавлено

Новый плагин `@sffmc/extra`: opt-in набор из 3 продвинутых фич.
Все фичи выключены по умолчанию — переключаются индивидуально через флаги конфига.

**Checkpoint** (инструмент `extra_checkpoint`):
- Захватывает каждый вызов `tool.execute.after` в per-session JSONL по пути
  `~/.local/share/sffmc/extra/checkpoints/<sessionID>.jsonl` (настраивается через `checkpoint_dir`)
- Версионирование схемы: заголовок `version: 1`, restore отклоняет неизвестные версии
- Действия: `list` (показать сессии), `restore` (восстановить сообщения), `delete` (удалить)
- Авто-restore через маркер `<!-- EXTRA_RESTORE: <sessionID> -->` в сообщениях
- Append-only JSONL для crash-safety

**Judge** (инструмент `extra_judge`):
- ИИ-judge скорит 2–8 кандидатов-выходов
- Мульти-критериальный рубрикатор: корректность, полнота, краткость (0–10 каждое)
- Возвращает `{ scores, winner, reasoning, model, latencyMs }`
- Настраиваемая модель (по умолчанию `your-model-id`) + рубрикатор
- Флаг `judge_auto`: авто-judge кандидатов, помеченных `<!-- EXTRA_JUDGE_CANDIDATES: [...] -->`
- ИИ-вызов с температурой 0.2 для детерминизма
- JSON-парсинг с валидацией (отклоняет некорректные ответы)

**Dream** (инструмент `extra_dream`):
- 3 триггер-пути: счётчик > порога (по умолчанию 50), cron-интервал (по умолчанию 24 ч), вручную
- Дедуп: Jaccard-схожесть > 0.9, оставлять более новую запись по `last_accessed`
- Удаление устаревших: `last_accessed > 30 дней` → архивируется в `dream-archive.jsonl`
- Кластерная суммаризация: Jaccard > 0.3 кластера, 5+ записей → ИИ-резюме
- Конкурентность: Promise-лок предотвращает перекрывающиеся запуски
- ИИ-суммаризация с корректным фоллбэком на конкатенацию при ошибке

### Миграция с v0.7.5

Обратно несовместимых изменений нет. Чтобы включить opt-in набор extra, добавьте в `~/.config/SFFMC/extra.yaml`:
```yaml
checkpoint: true      # capture + restore
judge: true           # мульти-критериальный ИИ-скоринг
dream: true           # фоновый чистильщик памяти
checkpoint_dir: ""    # по умолчанию ~/.local/share/sffmc/extra/checkpoints/
dream_threshold: 50   # count > N запускает dream
dream_interval_hours: 24
judge_model: "your-model-id"
judge_auto: false     # авто-judge по маркерам в сообщениях
```

## v0.7.5 — Полная codemap репозитория (2026-06-15)

### Добавлено

- **Codemap репозитория**: 24 файла `codemap.md` (~11 000 слов всего), покрывающих каждый пакет и каталог исходников
- `codemap.md` (root) — мастер-точка входа с картой каталогов
- `packages/codemap.md` (umbrella) — обзор 10 плагинов + shared SDK
- 10 × `packages/<plugin>/codemap.md` — архитектура на уровне пакета
- 10 × `packages/<plugin>/src/codemap.md` — разбор файл за файлом
- `shared/codemap.md` + `shared/src/codemap.md` — архитектура SDK
- `AGENTS.md` — точка автозагрузки с секцией «Repository Map»

### Объём документации по плагинам (в словах)

| Плагин | Пакет | src | Итого |
|---|---|---|---|
| memory | 954 | 1187 | 2141 |
| rules | 585 | 730 | 1315 |
| watchdog | 535 | 714 | 1249 |
| eos-stripper | 501 | 547 | 1048 |
| log-whitelist | 475 | 415 | 890 |
| max-mode | 888 | 929 | 1817 |
| auto-max | 802 | 546 | 1348 |
| compose | 755 | 652 | 1407 |
| workflow | 1604 | 2266 | 3870 |
| health | 766 | 516 | 1282 |
| shared | 426 | 653 | 1079 |

## v0.7.4 — Миграция на shared SDK + чистка тестового вывода (2026-06-15)

### Изменено

- 3 дополнительных плагина переведены на `@sffmc/shared` (`PluginContext` + `loadConfig`): `@sffmc/rules`, `@sffmc/auto-max`, `@sffmc/watchdog`
- `@sffmc/compose` и `@sffmc/memory` также обновлены
- Тестовый вывод: шумные логи `[watchdog] loaded` / `[auto-max] loaded` сокращены с 8 строк до 2 за прогон

## v0.7.3 — Усиление тестовой инфраструктуры (2026-06-15)

### Добавлено

- **Pre-commit хук** (`.git/hooks/pre-commit`): запускает `bun test` + typecheck + аудит load-order + health-чек. Обход: `git commit --no-verify`.
- **`bun run test:watch`**: перезапускает все тесты на каждое сохранение `.ts`
- **`scripts/run-health.ts`**: CLI-скрипт для вызова `@sffmc/health`
- **`bun run typecheck`**: теперь использует `bun build --no-bundle` (нативно для Bun, без внешнего `tsc`)

### Изменено

- `@sffmc/health` теперь загружается в dev-песочнице — ИИ может вызывать инструмент `sffmc_health` в сессиях песочницы
- `.sffmc/` добавлен в `.gitignore` (артефакты runtime workflow)

### Исправлено

- Pre-commit хук: исправлена обработка exit code (раньше пайпился через `tail`, что маскировало ошибки)

### Документация

- `docs/examples/migrate-7-plugins-to-shared.json` — пример планового артефакта

## v0.7.2 — Плагин Health (2026-06-15)

Health возрождён как настоящий диагностический инструмент. Авторы плагинов теперь могут вызывать `sffmc_health` для проверки здоровья monorepo за <1 с.

### Новый пакет: `@sffmc/health`

- Экспонирует один вызываемый из ИИ инструмент `sffmc_health`, возвращающий JSON.
- 7 диагностических проверок:
  1. `hook_conflicts` — 0 реальных конфликтов в 9 плагинах
  2. `test_presence` — в каждом пакете должен быть `*.test.ts`
  3. `readme_presence` — в каждом пакете должен быть `README.md`
  4. `type_check` — `bun build --no-bundle` по плагинам
  5. `tool_registration` — предотвращает известную регрессию регистрации инструмента
  6. `version_consistency` — версия root совпадает со всеми плагинами
  7. `license` — LICENSE присутствует + каждый README ссылается на него
- Каждая проверка возвращает `ok | warn | fail` с человекочитаемой детализацией.
- Верхнеуровневый `ok` — `false`, если любая проверка падает.

### Прочие изменения

- `shared/README.md` — создан (пойман первым запуском `sffmc_health`)
- `bun run test:watch` — перезапускает тесты на каждое сохранение `.ts`

## v0.7.0 — Встроенные workflow + shared SDK + документация (2026-06-15)

4 пользовательских фичи, ~1500 LOC, 102 теста проходят.

### Новые встроенные workflow (`@sffmc/workflow`)

- `plan` — 4-фазное структурированное планирование (Scope → Decompose → Estimate → Output). Принимает `args.goal`, возвращает уточнение scope, критерии успеха, упорядоченные шаги с зависимостями, est_minutes, parallel_group. Делает self-retry при недостаточной декомпозиции.
- `tdd` — 5-фазная генерация TDD-артефактов (Spec → Red → Green → Refactor → Verify). Принимает `args.feature`, возвращает тестовый файл + файл реализации + заметки по рефакторингу как артефакты. Генерирует, НЕ выполняет (только ИИ).
- `refactor` — 4-фазный proposer рефакторинга (Scan → Diagnose → Propose → Output). Читает файлы через workspace-примитивы, перечисляет 3–7 «запахов», возвращает 1–5 before/after-патчей с уровнями риска. НЕ применяет автоматически (рекомендательный режим).

Встроенный `deep-research` всё ещё поставляется (теперь всего 4 встроенных).

### Новый пакет: `@sffmc/shared`

- `loadConfig<T>(pluginName, defaults, opts?)` — YAML-загрузчик конфига, мерджит `~/.config/SFFMC/<name>.yaml` поверх дефолтов. Никогда не бросает.
- Интерфейс `PluginContext` — единый канонический тип для всех плагинов.
- `on` / `off` / `emit` / `clearAll` — generic type-safe EventBus (извлечён из events workflow).

**Отрефакторено**: `eos-stripper`, `log-whitelist` теперь используют `@sffmc/shared`.

### README для каждого плагина (9 пакетов)

Каждый `packages/<pkg>/README.md` теперь содержит: заголовок, one-line purpose, install-снипет, выдержку YAML-конфига, таблицу хуков, команду запуска тестов, MIT-футер.

### Руководство по началу работы

`docs/getting-started.md` (7 секций): Что такое SFFMC → Предусловия → Установка → Ваш первый workflow (deep-research) → Сохранить кастомный workflow → Отладка → Следующие шаги.

## v0.6.1 — Аудит порядка загрузки (2026-06-15)

Пост-релизный патч:
- `docs/load-order-audit.md` — полный аудит 9 SFFMC плагин-хуков, 0 конфликтов найдено
- `scripts/audit-load-order.py` — переиспользуемый AST-аудитор хуков
- Все критические последовательности проверены: /max reset→activate, watchdog→log-whitelist→auto-max output-цепочка, eos-stripper→log-whitelist text-цепочка
- Имена инструментов: только `compose_skill` (compose) и `workflow` (workflow) — без конфликтов

Без изменений кода. Без бампов версий плагинов. Только документация и инструменты.

## v0.6.0 — Движок Dynamic Workflow (2026-06-14)

9 плагинов SFFMC отгружены:
- @sffmc/memory — FTS5 + ICM-извлечение
- @sffmc/rules — YAML gate-based allow/deny
- @sffmc/watchdog — 3-failure счётчик, auto-recovery
- @sffmc/eos-stripper — EOS-токен cleanup
- @sffmc/log-whitelist — фильтр логов агента
- @sffmc/max-mode — параллельные драфты + judge
- @sffmc/auto-max — auto-escalation в max-mode
- @sffmc/compose — 15 compose-навыков
- @sffmc/workflow — НОВЫЙ

Движок Workflow:
- Песочница JavaScript через quickjs-emscripten WASM
- 3 примитива: agent(), parallel(), pipeline()
- 5-слойный бюджет: lifecycle 1000, concurrent 16, depth 8, wall-clock 12 часов, token 2M
- 3-слойное состояние: строка SQLite + per-run script + JSONL-журнал
- Возобновление после сбоя (SHA-256 edit detection)
- Канонический пример: deep-research (6 фаз, adversarial jury)
- 96+ тестов проходят

## v0.5.0 — Compose-навыки (2026-06-14)

- @sffmc/compose: инструмент compose_skill, 15 навыков из MiMo-Code
- Plan, TDD, verify, task delegation и ещё 11 структурированных workflow

## v0.4.0 — Max Mode + Auto-max (2026-06-14)

- @sffmc/max-mode: schema-only tools приём, 3 кандидата + judge
- @sffmc/auto-max: авто-эскалация по триггерам watchdog

## v0.3.0 — Watchdog + Strippers (2026-06-14)

- @sffmc/watchdog: 3-failure счётчик, auto-max триггер, вердикт recovery
- @sffmc/eos-stripper: удаление EOS-токенов
- @sffmc/log-whitelist: настраиваемый фильтр логов

## v0.2.0 — Фундамент (2026-06-14)

- @sffmc/memory: FTS5 полнотекстовый поиск, ICM-извлечение
- @sffmc/rules: YAML hot-reload, gate-based фильтрация инструментов

## v0.1.0 — Каркас (2026-06-14)

- Устройство monorepo: bun workspace, tsconfig, .gitignore, LICENSE
- README, docs/ (import-from-mimo.md, migration-from-opencode.md, v8-decision.md)
