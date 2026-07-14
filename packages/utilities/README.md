# @sffmc/utilities

**Shared SDK library for the other SFFMC packages.** Not a plugin - install only if you author user plugins that import its primitives.

This package provides the four primitives every SFFMC plugin needs:

- **`loadConfig<T>(name, defaults)`** - type-safe YAML loader. Reads `~/.config/sffmc/<name>.yaml`, merges with the provided defaults, validates against a JSON-schema if you pass one. Missing file → defaults (no exception). Type errors → typed `Result<err>`.
- **`PluginContext`** - minimal interface every plugin `server(ctx)` receives. Carries `projectRoot`, `config`, and the typed event bus.
- **`mergeHooks(plugins)`** - composes N plugin `{id, server}` results into one. Hook payloads are classified into `transform` (chainable), `gate` (veto-able), `side-effect` (fire-and-forget), or `tool`. Conflict resolution is per-class; the merger never crashes.
- **`EventBus`** - typed pub/sub over plugin-internal events. Used by `@sffmc/memory` for cross-feature memory writes, by `@sffmc/safety` for cross-feature gate propagation, etc.

Plus smaller helpers you might need:
- `unixNow()`, `__setClock()`, `__resetClock()` - deterministic time for tests
- `isSafeRunID(s)`, `safeRunID()`, `RUN_ID_REGEX` - validate `wf_<24-char base36>` run IDs
- `FsOps` interface + `defaultFsOps` + `createMockFsOps()` - swap out real filesystem for testing
- `redactSecrets(s)` - strip API keys / PEM blocks / `~/.env` content from any string before logging
- 15+ typed error classes (`ConfigError`, `GitHubTokenMissingError`, …) with stable names

## Install (as library)

If you're authoring your own plugin and want `loadConfig` / `mergeHooks` / event typing:

```bash
npm install --save-peer @sffmc/utilities@^0.15.4
```

You do **not** add `@sffmc/utilities` to `opencode.json` `plugins[]`. It has no plugin entry - only TypeScript exports.

## Why this is a library, not a plugin

The other four SFFMC packages depend on `@sffmc/utilities` for shared infrastructure. If it were a plugin entry, every `npm install` of any SFFMC plugin would also register it as a plugin - which would double-register and crash the `id`-uniqueness check in `mergeHooks`. By making it a library consumed via `workspace:*` (internally) or `npm:` peer-dependency (for users), it stays installable from npm without polluting `plugins[]`.

## Versioning

This package follows semver strictly. A breaking change in any export (renamed, removed, signature-shifted) is a major version bump. All other SFFMC packages depend on it via `^x.y.z` in their own `package.json`.

## License

[MIT](../../LICENSE)
</content>