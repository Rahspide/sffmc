// SPDX-License-Identifier: MIT
// @sffmc/memory — see ../../LICENSE
//
// Memory sub-feature: Memory + Context Recon 8K. Stores memories in SQLite,
// extracts on watch, and injects a recon summary (top memories + AGENTS.md +
// recent chat tail) at the start of every new session via
// experimental.chat.messages.transform.
//
// Extracted from index.ts (Phase 2) so the MSP can compose it via runtime hook().

import { init, topByImportance, type MemoryDB } from "./memory"
import { buildRecon, tailFromMessages, RECON_AGENTS_BUDGET } from "./recon"
import { startWatcher } from "./watcher"
import {
  loadConfig,
  type PluginContext,
  createLogger,
  DEFAULT_MEMORY_DB_PATH,
  HOOK_CHAT_MESSAGES_TRANSFORM,
  SESSION_CREATED,
} from "@sffmc/shared";
import { readFileSync, existsSync, mkdirSync } from "fs"
import { resolve, dirname } from "path"
import { homedir } from "node:os"
import { AGENTS_FILE } from "./constants.ts";

interface MemoryConfig {
  storagePath: string
  tailChars: number
}

const log = createLogger("memory");

const defaultConfig: MemoryConfig = {
  storagePath: DEFAULT_MEMORY_DB_PATH(),
  tailChars: RECON_AGENTS_BUDGET,
}

interface PluginState {
  db: MemoryDB | null
  watcher: { stop: () => void } | null
  reconNeededThisSession: boolean
  reconInjectedThisSession: boolean
  config: MemoryConfig
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

export const id = "memory-core"
export const server = async (ctx: PluginContext) => {
  const config = await loadConfig<MemoryConfig>("memory", defaultConfig)

  const state: PluginState = {
    db: null,
    watcher: null,
    reconNeededThisSession: false,
    reconInjectedThisSession: false,
    config,
  }

  async function ensureDB(): Promise<MemoryDB> {
    if (!state.db) {
      ensureDir(state.config.storagePath)
      state.db = await init(state.config.storagePath)
    }
    return state.db
  }

  async function ensureWatcher(): Promise<void> {
    if (!state.watcher) {
      const db = await ensureDB()
      state.watcher = startWatcher(ctx.projectRoot, db)
    }
  }

  return {
    config: async (_cfg: Record<string, unknown>) => {
      await ensureDB()
      await ensureWatcher()
    },

    event: async (payload: { event: string; [key: string]: unknown }) => {
      if (payload.event === SESSION_CREATED) {
        state.reconNeededThisSession = true
        state.reconInjectedThisSession = false
      }
    },

    [HOOK_CHAT_MESSAGES_TRANSFORM]: async (
      _input: unknown,
      data: {
        messages: Array<{
          role: string
          content: string
          [key: string]: unknown
        }>
      },
    ) => {
      if (!state.reconNeededThisSession || state.reconInjectedThisSession)
        return data

      try {
        const db = await ensureDB()
        const memory = topByImportance(db, 20)

        const agentsPath = resolve(ctx.projectRoot, AGENTS_FILE)
        let agents = ""
        if (existsSync(agentsPath)) {
          agents = readFileSync(agentsPath, "utf-8")
        }

        const tail = tailFromMessages(
          data.messages.slice(-20),
          state.config.tailChars,
        )

        const recon = buildRecon(
          memory,
          null,
          "",
          tail,
          agents,
        )

        data.messages.unshift({
          role: "system",
          content: recon,
        })

        state.reconInjectedThisSession = true
        state.reconNeededThisSession = false
      } catch (err) {
        log.warn("recon injection failed:", err);
      }
      return data
    },
  }
}

export default { id, server }
