# shared/src/

## Responsibility

Implementation of `@sffmc/shared` — the opt-in SDK package. Contains the config loader (YAML → typed merge), the `PluginContext` interface, the typed event bus, and the barrel `index.ts` re-export.

## Design Patterns

- **Module-level state** — `listeners` is a `Map<string, Array<{ fn: Listener; key: string }>>` at module scope. Single process means no cross-plugin leakage; tests call `clearAll()` in `beforeEach`.
- **Incrementing listener keys** — `listenerIdCounter` ensures unique keys per listener registration, used only internally (the `key` field on the stored object). The `on` return value (`string`) uses this counter indirectly through the key field, though the actual return is the stored key string.
- **Handler identity removal** — `off()` uses `===` on the handler function reference, not the key. The `key` field is stored but not used for removal — it exists for future introspection.
- **Copy-then-iterate** — `emit` iterates `[...list]` so handlers can call `off()` during emission without mutating the array being iterated.
- **Sync file I/O in async wrapper** — `loadConfig` is `async` but uses `readFileSync`/`existsSync`. This is intentional: the function signature is async to allow future async backends (e.g., reading from URL), but today's implementation is synchronous under the hood.
- **Shallow merge** — spread operator `{ ...defaults, ...parsed }`. No deep merge. User YAML must specify full keys to override.

## Data & Control Flow

```
index.ts (barrel)
  ├── config.ts → loadConfig<T>(name, defaults, opts?)
  │     uses: yaml (parse), fs (readFileSync, existsSync), path (resolve), os (homedir)
  ├── context.ts → interface PluginContext
  └── events.ts → on, off, emit, clearAll
        uses: Map<string, Array<{ fn, key }>> (module-level state)
```

`loadConfig` flow:
1. Resolve base path: `opts.configHome ?? resolve(homedir(), ".config/SFFMC")`
2. Resolve file path: `resolve(base, `${pluginName}.yaml`)`
3. `existsSync` → false → `return { ...defaults }`
4. `readFileSync` + `parseYaml` → catch → `console.warn` + `return { ...defaults }`
5. Success → `return { ...defaults, ...parsed }`

`emit` flow:
1. `listeners.get(event)` → undefined → return (no-op)
2. Shallow copy `[...list]`
3. For each `{ fn }`: `try fn(payload) catch {}` (silent)

## Files

| Path | Purpose |
|---|---|
| `src/index.ts` | Barrel re-export: `loadConfig`, `PluginContext` type, `on`/`off`/`emit`/`clearAll` |
| `src/config.ts` | `loadConfig<T>(pluginName, defaults, opts?)` — YAML config loader with never-throw semantics |
| `src/context.ts` | `PluginContext` interface — minimal OpenCode plugin context shape |
| `src/events.ts` | Typed event bus: `on`, `off`, `emit`, `clearAll` — module-level Map-based, silent error containment |
| `src/config.test.ts` | 4 tests: missing file, valid YAML merge, malformed YAML (no throw), empty file |
| `src/events.test.ts` | 4 tests: on→emit, off removal, handler order, clearAll |

## Public API

| Export | Kind | Signature | Defined in |
|---|---|---|---|
| `loadConfig` | async function | `<T extends object>(pluginName: string, defaults: T, opts?: { configHome?: string }): Promise<T>` | `config.ts` |
| `PluginContext` | interface | `{ projectRoot: string; config: Record<string, unknown>; [key: string]: unknown }` | `context.ts` |
| `on` | function | `<T>(event: string, handler: (payload: T) => void): string` | `events.ts` |
| `off` | function | `<T>(event: string, handler: (payload: T) => void): void` | `events.ts` |
| `emit` | function | `<T>(event: string, payload: T): void` | `events.ts` |
| `clearAll` | function | `(): void` | `events.ts` |

## Integration Points

- **8 SFFMC plugins** import from `@sffmc/shared` via workspace resolution (`"workspaces": ["packages/*", "shared"]` in root `package.json`).
- **Tests** import directly from `./config.ts` / `./events.ts` (not through `index.ts`) — bun test with no TypeScript compilation step.
- **`yaml` v2** is the sole runtime dependency.
- **`configHome` option** enables test isolation — tests pass `resolve(tmpdir(), "sffmc-shared-test-config")` to avoid touching real `~/.config/SFFMC/`.

## Type Safety

- Generic `<T extends object>` on `loadConfig` — consumer defines full config shape.
- `PluginContext.[key: string]: unknown` — extensible without narrowing; callers cast as needed.
- `emit<T>` / `on<T>` — handler payload type flows from emit to handler via generic.
- `off` uses handler reference equality (`===`), not string key or symbol — no accidental collisions.
