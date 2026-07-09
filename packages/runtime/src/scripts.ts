// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Script file IO, extracted from persistence.ts per the v0.16.0
// refactor plan (ora-9, Phase 9). The script is the original .ts / .js /
// .sffmc file that started a run; it's stored on disk so `resume()`
// can re-read it after a process restart. The WorkflowPersistence
// class delegates to ScriptsRepository.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { safeRunID } from "@sffmc/utilities"
import { getWorkflowConfigSync } from "./constants.ts"

export class ScriptsRepository {
  constructor(private readonly dir: string) {}

  private scriptPath(runID: string): string {
    safeRunID(runID)
    return path.join(this.dir, `${runID}${getWorkflowConfigSync().scriptExt}`)
  }

  async write(runID: string, source: string): Promise<void> {
    safeRunID(runID)
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await writeFile(this.scriptPath(runID), source, "utf-8")
  }

  async read(runID: string): Promise<string | null> {
    safeRunID(runID)
    try {
      return await readFile(this.scriptPath(runID), "utf-8")
    } catch {
      return null
    }
  }
}
