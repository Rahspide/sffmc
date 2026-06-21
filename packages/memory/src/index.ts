// SPDX-License-Identifier: MIT
// @sffmc/memory — see ../../LICENSE
//
// SFFMC memory MSP — composes memory + checkpoint + judge + dream.
// second release: replaces prior standalone memory impl with mergeHooks() of 4 sub-features.

import { server as memoryServer, defaultConfig as memoryDefaultConfig, type MemoryConfig } from "./plugin.ts"
import { checkpointServer, judgeServer, dreamServer } from "../../extra/src/index.ts"
import { loadConfig, mergeHooks, type PluginContext, type PluginServer } from "@sffmc/shared";

export const id = "@sffmc/memory"

export const server = async (ctx: PluginContext): Promise<PluginServer> => {
  const merged = mergeHooks([
    await memoryServer(ctx),
    await checkpointServer(ctx),
    await judgeServer(ctx),
    await dreamServer(ctx),
  ])
  return { ...merged, id }
}

// ---------------------------------------------------------------------------
// second release migration (schema journal validation, chokidar awaitWriteFinish.stabilityThreshold, chokidar awaitWriteFinish.pollInterval) — config getters.
// Exported so callers (other plugins, tests, tooling) can read the active
// value without bootstrapping a full plugin instance. Internally the plugin
// loads the same config into state.config during server().
// ---------------------------------------------------------------------------

/** Lazy config cache so repeated getter calls don't re-read the YAML. */
let _memoryConfigPromise: Promise<MemoryConfig> | null = null

function ensureMemoryConfig(configHome?: string): Promise<MemoryConfig> {
  if (!_memoryConfigPromise) {
    _memoryConfigPromise = loadConfig<MemoryConfig>(
      "memory",
      memoryDefaultConfig,
      configHome ? { configHome } : undefined,
    )
  }
  return _memoryConfigPromise
}

/** schema journal validation — max memories to include in recon injection (default 20). */
export async function getMemoryReconTopN(configHome?: string): Promise<number> {
  const cfg = await ensureMemoryConfig(configHome)
  return cfg.reconTopN
}

/** chokidar awaitWriteFinish.stabilityThreshold — chokidar awaitWriteFinish.stabilityThreshold in ms (default 300). */
export async function getWatchStabilityMs(configHome?: string): Promise<number> {
  const cfg = await ensureMemoryConfig(configHome)
  return cfg.watchStabilityMs
}

/** chokidar awaitWriteFinish.pollInterval — chokidar awaitWriteFinish.pollInterval in ms (default 100). */
export async function getWatchPollIntervalMs(configHome?: string): Promise<number> {
  const cfg = await ensureMemoryConfig(configHome)
  return cfg.watchPollIntervalMs
}

/** Test helper — reset the lazy cache so the next getter call reloads the
 *  YAML. Not part of the public API; tests reach it via the Symbol registry
 *  in `@sffmc/memory.__resetMemoryConfig`. */
export function __resetMemoryConfig(): void {
  _memoryConfigPromise = null
}

export default { id, server }
