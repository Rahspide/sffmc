// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

import { parse as parseYaml } from "yaml"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"
import { homedir } from "os"
import { createLogger } from "./logger.ts"


/**
 * Load plugin config by merging user YAML over defaults.
 *
 * - Reads `~/.config/SFFMC/<pluginName>.yaml` (or `opts.configHome/<pluginName>.yaml`)
 * - Missing file → returns `{ ...defaults }`
 * - Malformed YAML → returns `{ ...defaults }` (warns via console.warn, does NOT throw)
 * - Valid YAML → returns `{ ...defaults, ...parsed }` (user values win)
 */
export async function loadConfig<T extends object>(
  pluginName: string,
  defaults: T,
  opts?: { configHome?: string },
): Promise<T> {
  const base = opts?.configHome ?? resolve(homedir(), ".config/SFFMC")
  const configPath = resolve(base, `${pluginName}.yaml`)
  if (!existsSync(configPath)) return { ...defaults }
  try {
    const raw = readFileSync(configPath, "utf-8")
    const parsed = parseYaml(raw) as Partial<T>
    return { ...defaults, ...parsed }
  } catch (err) {
    createLogger("sffmc/shared").warn(` failed to parse ${configPath}:`, err)
    return { ...defaults }
  }
}
