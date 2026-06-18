# @sffmc/health

> **Part of `@sffmc/agentic` composite.** This package is a sub-feature of the agentic bundle. Load via `@sffmc/agentic` for the full set (health + max-mode + workflow + compose), or standalone if you only need sffmc_health.



F3+ Health — diagnostic for SFFMC plugin authors. Runs 7 checks on the monorepo and returns a JSON health report.

## What it does

A single LLM-callable tool (`sffmc_health`) that runs:
1. **Hook conflict audit** — invokes `scripts/audit-load-order.py`, reports 0 conflicts
2. **Test presence** — every `packages/*` + `shared/` must have `*.test.ts`
3. **README presence** — every package must have `README.md`
4. **Type check** — `bun build --no-bundle` per package
5. **Tool registration sanity** — scans for `name:` field bug (fix-17 regression)
6. **Version consistency** — root vs plugin `package.json` versions
7. **License** — root `LICENSE` exists, referenced from all READMEs

Returns JSON with `ok`, `checks[]`, and `summary`.

## Install

This plugin is loaded by the SFFMC monorepo's sandbox config. To use standalone:

```ts
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "file:///path/to/SFFMC/packages/health/src/index.ts"
  ]
}
```

## Usage

Call the tool from an LLM:

```
sffmc_health()
```

Returns:

```json
{
  "ok": true,
  "checks": [
    { "name": "hook_conflicts", "status": "ok", "detail": "9/9 plugins, 0 conflicts" },
    ...
  ],
  "summary": "7 ok, 0 warn, 0 fail"
}
```

## Tests

```bash
bun test packages/health/
```

## License

MIT
