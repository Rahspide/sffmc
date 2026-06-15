# @sffmc/shared

Shared SDK for SFFMC plugin authors — opt-in facade over the boilerplate that
every SFFMC plugin re-implements: YAML config loading, OpenCode plugin context
types, and a tiny event bus.

## What it exports

| Export | Type | Purpose |
|---|---|---|
| `loadConfig` | function | Read `~/.config/SFFMC/<name>.yaml`, fall back to defaults. |
| `PluginContext` | type | The minimum-viable shape of OpenCode's plugin context. |
| `on` / `off` / `emit` / `clearAll` | functions | A minimal typed event bus. |

## Install

This package is part of the SFFMC monorepo at `shared/`. To use it from a SFFMC plugin, the root `package.json` already lists `shared` in `workspaces`:

```json
// package.json (root)
{
  "workspaces": ["packages/*", "shared"]
}
```

From any SFFMC plugin:

```ts
import { loadConfig, type PluginContext, on, emit } from "@sffmc/shared"

const config = await loadConfig<MyConfig>("my-plugin", defaultConfig)
```

## Usage example

```ts
// SPDX-License-Identifier: MIT
import { loadConfig, type PluginContext, on, emit } from "@sffmc/shared"

interface MyConfig { threshold: number; }
const defaultConfig: MyConfig = { threshold: 3 }

export default {
  id: "@sffmc/my-plugin",
  server: async (ctx: PluginContext) => {
    const config = await loadConfig<MyConfig>("my-plugin", defaultConfig)

    // Subscribe to your own events
    on("my-plugin:ready", () => console.log("ready"))

    return {
      config: async () => emit("my-plugin:ready"),
      "tool.execute.before": async (_ctx, args) => {
        // ... use config.threshold ...
      },
    }
  },
}
```

## Migration: existing plugins

`eos-stripper` and `log-whitelist` already use `@sffmc/shared`. Other plugins
keep their own `loadConfig` for now — migration is opt-in to avoid churn.

To migrate a plugin:

```diff
- import { readFileSync, existsSync } from "fs"
- import { resolve } from "path"
- import { homedir } from "os"
- import { parse as parseYaml } from "yaml"
-
- function loadConfig(): MyConfig {
-   const configPath = resolve(homedir(), ".config/SFFMC/my-plugin.yaml")
-   if (!existsSync(configPath)) return { ...defaultConfig }
-   try { return { ...defaultConfig, ...parseYaml(readFileSync(configPath, "utf-8")) } }
-   catch { return { ...defaultConfig } }
- }
+ import { loadConfig } from "@sffmc/shared"
+
+ const config = await loadConfig<MyConfig>("my-plugin", defaultConfig)
```

## API reference

### `loadConfig<T>(name: string, defaults: T): Promise<T>`

Reads `~/.config/SFFMC/<name>.yaml`, parses it as YAML, and shallow-merges over `defaults`. On missing file, parse error, or non-object YAML, returns `defaults` unchanged.

### `PluginContext`

```ts
export interface PluginContext {
  projectRoot: string
  config: Record<string, unknown>
  [key: string]: unknown
}
```

A subset of OpenCode's full context — covers what every existing SFFMC plugin uses.

### Event bus

```ts
on<T>(event: string, handler: (data: T) => void): void
off(event: string, handler: Function): void
emit(event: string, data?: unknown): void
clearAll(): void   // for tests
```

Handlers are stored in module-level state. In production, a single process means
no leakage across plugins. In tests, call `clearAll()` in `beforeEach`.

## Tests

```bash
bun test shared/
```

8 tests in `src/config.test.ts` and `src/events.test.ts`.

## License

MIT
