// SPDX-License-Identifier: MIT
// @sffmc/memory — see ../../LICENSE
//
// Memory + Context Recon 8K. Stores memories in SQLite, extracts on watch,
// and injects a recon summary (top memories + AGENTS.md + recent chat tail)
// at the start of every new session via experimental.chat.messages.transform.

import { init, topByImportance, type MemoryDB } from "./memory"
import { buildRecon, parseAgentsMd, tailFromMessages } from "./recon"
import { startWatcher } from "./watcher"
import { loadConfig, type PluginContext } from "@sffmc/shared"
import { readFileSync, existsSync, mkdirSync } from "fs"
import { resolve, dirname } from "path"

interface MemoryConfig {
  storagePath: string
  reconBudgets: {
    memory: number
    checkpoint: number
    taskTree: number
    tail: number
    agents: number
  }
  memoryPaths: string[]
  defaultImportance: number
}

const defaultConfig: MemoryConfig = {
  storagePath: resolve(
    require("os").homedir(),
    ".local/share/SFFMC/memory/index.sqlite",
  ),
  reconBudgets: {
    memory: 6144,
    checkpoint: 6144,
    taskTree: 4096,
    tail: 8192,
    agents: 8192,
  },
  memoryPaths: ["memory-bank/", "AGENTS.md", "*.md"],
  defaultImportance: 0.5,
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
    mkdirSync(dir, { recursive: true })
  }
}

const server = async (ctx: PluginContext) => {
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
      if (payload.event === "session.created") {
        state.reconNeededThisSession = true
        state.reconInjectedThisSession = false
      }
    },

    "experimental.chat.messages.transform": async (
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
        return

      try {
        const db = await ensureDB()
        const memory = topByImportance(db, 20)

        const agentsPath = resolve(ctx.projectRoot, "AGENTS.md")
        let agents = ""
        if (existsSync(agentsPath)) {
          agents = parseAgentsMd(readFileSync(agentsPath, "utf-8"))
        }

        const tail = tailFromMessages(
          data.messages.slice(-20),
          state.config.reconBudgets.tail,
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
      } catch {
        // recon is best-effort; silently skip on failure
      }
    },
  }
}

export default {
  id: "@sffmc/memory",
  server,
}
