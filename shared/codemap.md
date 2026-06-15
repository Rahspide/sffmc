# shared/

## Responsibility

Opt-in shared SDK for SFFMC plugin authors. Provides three things every SFFMC plugin otherwise re-implements: typed YAML config loading from `~/.config/SFFMC/<name>.yaml`, a minimal `PluginContext` type matching OpenCode's plugin context shape, and a module-level event bus with `on`/`off`/`emit`.

## Design Patterns

- **Single canonical contract** — one `loadConfig`, one `PluginContext` type, one event bus. No plugin-specific variants.
- **Opt-in adoption** — plugins import what they need; no mandatory migration. 8/10 plugins use it; `max-mode` and `workflow` keep their own types due to complex type requirements.
- **Never-throw semantics** — `loadConfig` returns defaults on missing file, empty file, or malformed YAML. Only `console.warn` for parse errors. No throwing.
- **Shallow merge** — `{ ...defaults, ...parsed }`. User YAML values override defaults; undefined keys stay as defaults.
- **Silent error containment** — `emit` iterates a copy of listeners so handlers can call `off()` mid-emit, and catches/hides listener throws.

## Data & Control Flow

```
loadConfig("my-plugin", defaults)
  → resolve(~/.config/SFFMC/my-plugin.yaml)
  → existsSync? no → return { ...defaults }
  → readFileSync → parseYaml → catch? warn + return { ...defaults }
  → return { ...defaults, ...parsed }
```

```
emit("event", payload)
  → copy listeners array
  → for each: try fn(payload) catch ignore
  → listeners can off() themselves safely (copy iteration)
```

## Public API

| Export | Kind | Signature |
|---|---|---|
| `loadConfig` | async function | `<T extends object>(pluginName: string, defaults: T, opts?: { configHome?: string }): Promise<T>` |
| `PluginContext` | interface | `{ projectRoot: string; config: Record<string, unknown>; [key: string]: unknown }` |
| `on` | function | `<T>(event: string, handler: (payload: T) => void): string` — returns a listener key |
| `off` | function | `<T>(event: string, handler: (payload: T) => void): void` — removes by handler reference equality |
| `emit` | function | `<T>(event: string, payload: T): void` — fires all handlers; errors are silently caught |
| `clearAll` | function | `(): void` — removes all listeners for all events (for test teardown) |

## Integration Points

Used by 8 of 10 SFFMC plugins: `eos-stripper`, `log-whitelist`, `health`, `memory`, `rules`, `auto-max`, `watchdog`, `compose`.

Not used by: `max-mode` (complex generic types beyond `Record<string, unknown>`), `workflow` (owns its own config type hierarchy).

## Type Safety

- `loadConfig<T>` is generic — consumers define their config shape via `T extends object`.
- `PluginContext` uses `[key: string]: unknown` index signature to allow accessing any OpenCode-injected context property without narrowing.
- `configHome` option is `string | undefined` — allows pointing to a test temp directory.
- `emit<T>` / `on<T>` preserve payload type through the handler signature.
