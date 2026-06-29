// SPDX-License-Identifier: MIT
// @sffmc/memory — see ../../LICENSE
//
// Memory sub-feature: Memory + Context Recon 8K. Stores memories in SQLite,
// extracts on watch, and injects a recon summary (top memories + AGENTS.md +
// recent chat tail) at the start of every new session via
// experimental.chat.messages.transform.
//
// Extracted from index.ts ( release split) so the MSP can compose it via runtime hook().

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
import { readFileSync, existsSync, mkdirSync, statSync } from "fs"
import { resolve, dirname } from "path"
import { homedir } from "node:os"
import { AGENTS_FILE } from "./constants.ts";

export interface MemoryConfig {
  storagePath: string
  tailChars: number
    // .slim/deepwork/hardcode-audit-2026-06.md
  /** Character budget for the memory section in recon injection.
   *  Defaults to 6144 (matches the prior hardcoded value). */
  reconMemoryBudget: number
  /** Character budget for the checkpoint section in recon injection.
   *  Defaults to 6144 (matches the prior hardcoded value). */
  reconCheckpointBudget: number
  /** Safety cap for AGENTS.md size in bytes. Files larger than this
   *  are skipped (with a warn log) to prevent OOM from large crafted
   *  AGENTS.md files. Defaults to 100 KiB. */
  agentsMaxSize: number
    // .slim/deepwork/phase-2-3-hardcode-migration-plan.md §2.2
  /** Max memories to include in recon injection (defaults to 20,
   *  the prior hardcoded value). Raising this directly increases LLM
   *  context consumption. */
  reconTopN: number
  /** Chokidar `awaitWriteFinish.stabilityThreshold` in ms. Defaults
   *  to 300 (the prior hardcoded value). */
  watchStabilityMs: number
  /** Chokidar `awaitWriteFinish.pollInterval` in ms. Defaults to
   *  100 (the prior hardcoded value). */
  watchPollIntervalMs: number
}

const log = createLogger("memory");

export const defaultConfig: MemoryConfig = {
  storagePath: DEFAULT_MEMORY_DB_PATH(),
  tailChars: RECON_AGENTS_BUDGET,
  // Defaults match the prior hardcoded values — behavior unchanged.
  reconMemoryBudget: 6144,
  reconCheckpointBudget: 6144,
  agentsMaxSize: 100 * 1024,  // 100 KiB
  reconTopN: 20,
  watchStabilityMs: 300,
  watchPollIntervalMs: 100,
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

/**
 * Strip common prompt-injection patterns from project-controlled content
 * (AGENTS.md, etc.) before it is injected into the LLM as part of the
 * context-recon block. Project files are writable by anyone with
 * repo-write access, so any "IGNORE PREVIOUS INSTRUCTIONS" text in AGENTS.md
 * would otherwise be relayed verbatim as a system message every session.
 *
 * This is a heuristic, not a complete defense — focused on the most
 * commonly-cited injection framings. Each match is replaced with a
 * `[REDACTED:injection]` marker so (a) the LLM can ignore it and
 * (b) humans reading the recon can notice and investigate.
 *
 * Exported for unit tests; not part of the public API.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /IGNORE (?:ALL )?PREVIOUS INSTRUCTIONS/gi,
  /DISREGARD (?:ALL )?(?:PREVIOUS )?(?:INSTRUCTIONS|CONTEXT)/gi,
  /YOU ARE NOW [^.\n]{1,200}/gi,
  /SYSTEM: [^.\n]{1,200}/gi,
  /FORGET (?:ALL )?(?:PREVIOUS )?(?:INSTRUCTIONS|CONTEXT)/gi,
  /NEW INSTRUCTIONS?: [^.\n]{1,200}/gi,
]

export function redactInjection(content: string): string {
  let redacted = content
  for (const pat of INJECTION_PATTERNS) {
    redacted = redacted.replace(pat, "[REDACTED:injection]")
  }
  return redacted
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
      state.watcher = startWatcher(ctx.projectRoot, db, {
        stabilityMs: state.config.watchStabilityMs,
        pollIntervalMs: state.config.watchPollIntervalMs,
      })
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
        const memory = topByImportance(db, state.config.reconTopN)

        const agentsPath = resolve(ctx.projectRoot, AGENTS_FILE)
        let agents = ""
        if (existsSync(agentsPath)) {
          try {
            const st = statSync(agentsPath)
            if (st.size <= state.config.agentsMaxSize) {
              const raw = readFileSync(agentsPath, "utf-8")
              const redacted = redactInjection(raw)
              if (redacted !== raw) {
                log.warn(
                  `AGENTS.md at ${agentsPath} contained prompt-injection patterns; redacted before LLM injection`,
                )
              }
              agents = redacted
            } else {
              log.warn(`AGENTS.md too large (${(st.size / 1024).toFixed(0)}KB > ${(state.config.agentsMaxSize / 1024).toFixed(0)}KB), skipping`)
            }
          } catch {
            // stat failed, skip
          }
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
          state.config.reconMemoryBudget,
          state.config.reconCheckpointBudget,
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
