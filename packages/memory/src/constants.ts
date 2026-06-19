// SPDX-License-Identifier: MIT
// @sffmc/memory — see ../../LICENSE

/** Directory watched by the memory plugin for markdown sources.
 *  Single source of truth so watcher.ts and any tool that wants to
 *  write to memory-bank can agree on the directory name. */
export const MEMORY_BANK_DIR = "memory-bank"

/** Root agent-instructions file watched by the memory plugin. */
export const AGENTS_FILE = "AGENTS.md"

/** Character budget for the AGENTS.md section of the context recon. */
export const RECON_AGENTS_BUDGET = 8192

/** Character budget for the task-tree section of the context recon. */
export const RECON_TASKTREE_BUDGET = 4096
