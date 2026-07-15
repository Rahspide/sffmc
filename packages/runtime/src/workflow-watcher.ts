// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { watch, type FSWatcher } from "node:fs"
import path from "node:path"
import { createLogger, emit, ensureRedactionRules } from "@sffmc/utilities"
import { getWorkflowSearchDirs } from "./constants.ts"

const log = createLogger("workflow:watcher")

/** Event emitted by `startWorkflowWatcher` whenever a file under a watched
 *  workflow directory is added, changed, or removed. Listeners receive
 *  `{ event, path }` where `path` is relative to the workspace root.
 *
 *  Subscribers can use this to invalidate cached workflow content or
 *  abort affected runs. Currently no built-in subscriber — exposed so
 *  downstream tooling (or the runtime in a future release) can hook in
 *  without changes to the watcher itself. */
export interface WorkflowFileChangedEvent {
  event: "add" | "change" | "unlink"
  path: string
}

const WORKFLOW_FILE_GLOB = /\.(ts|js|mjs|cjs)$/i

/** Watch the configured workflow subdirectories for file changes. Uses
 *  Node's built-in `fs.watch` (no new dependencies — `chokidar` is owned
 *  by `@sffmc/memory`, intentionally not shared). On Linux, `fs.watch`
 *  is non-recursive per directory; that's fine for the typical workflow
 *  layout (single-file workflows in `~/.sffmc/workflows/<name>.ts`).
 *  Subdirectory changes are not detected; a future release could swap in
 *  a recursive watcher without changing the consumer API.
 *
 *  The returned handle's `stop()` closes all watchers. Safe to call
 *  multiple times. */
export function startWorkflowWatcher(workspace: string): { stop: () => void } {
  const subdirs = getWorkflowSearchDirs()
  // Walk up the directory tree to find every existing workflow subdir.
  // The runtime mounts the watcher once per workspace; chokidar-style
  // recursive walking is left for callers that need it.
  const dirs: string[] = []
  let current = path.resolve(workspace)
  while (true) {
    for (const sub of subdirs) {
      dirs.push(path.join(current, sub))
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  // Best-effort: ensure redaction rules are loaded so filename-sensitive
  // log lines don't trigger an async load on first event.
  void ensureRedactionRules().catch((e) => {
    log.debug({ err: e }, "workflow-watcher: ensureRedactionRules failed (using built-in defaults)")
    /* fall back to defaults on failure — same as resolveWorkflow() */
  })

  const watchers: FSWatcher[] = []
  for (const dir of dirs) {
    let watcher: FSWatcher
    try {
      watcher = watch(dir, { persistent: false }, (eventType, filename) => {
        if (!filename) return
        const basename = path.basename(filename)
        if (!WORKFLOW_FILE_GLOB.test(basename)) return
        const absolute = path.join(dir, filename)
        log.info(`workflow file ${eventType}: ${path.relative(workspace, absolute)}`)
        emit<WorkflowFileChangedEvent>("workflow:file-changed", {
          event: eventType === "rename" ? "add" : "change",
          path: path.relative(workspace, absolute),
        })
      })
    } catch (e) {
      // Directory may not exist yet (fresh project) — that's fine, skip.
      log.debug(`workflow dir not watchable: ${dir}:`, e)
      continue
    }
    watcher.on("error", (e) => {
      log.debug(`watcher error for ${dir}:`, e)
    })
    watchers.push(watcher)
  }

  let stopped = false
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      for (const w of watchers) {
        try {
          w.close()
        } catch (e) {
          log.debug({ err: e }, "workflow-watcher: watcher.close failed (already closed?)")
          /* ignore — already closed */
        }
      }
    },
  }
}