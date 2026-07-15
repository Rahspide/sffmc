// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Check 10: changelog_currency — CHANGELOG.md's most recent version must
// match the root package.json version. Also verifies CHANGELOG.ru.md is
// in sync (bilingual promise, v0.15.0+).

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createLogger } from "@sffmc/utilities"
import { createCheck } from "../check-factory.ts"

const log = createLogger("health:changelog-currency")

export const checkChangelogCurrency = createCheck("changelog_currency", async (repoRoot) => {
  // Read root version
  let rootVersion: string
  try {
    const rootPkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf-8"))
    rootVersion = rootPkg.version || "unknown"
  } catch (e) {
    log.warn({ err: e, repoRoot }, "changelog-currency: root package.json read/parse failed")
    return {
      status: "fail",
      detail: "Could not read root package.json",
    }
  }

  // Read CHANGELOG.md
  const changelogPath = join(repoRoot, "CHANGELOG.md")
  let changelogText: string
  try {
    changelogText = await readFile(changelogPath, "utf-8")
  } catch (e) {
    log.warn({ err: e, changelogPath }, "changelog-currency: CHANGELOG.md read failed")
    return {
      status: "fail",
      detail: "CHANGELOG.md not found",
    }
  }

  // Read CHANGELOG.ru.md (v0.15.0+ bilingual promise). Warn (not fail)
  // if it's missing or out of sync — the bilingual docs are aspirational,
  // not a hard contract, so we don't block CI on it.
  const changelogRuPath = join(repoRoot, "CHANGELOG.ru.md")
  let changelogRuText: string | null = null
  let changelogRuMissing = false
  try {
    changelogRuText = await readFile(changelogRuPath, "utf-8")
  } catch (e) {
    log.debug({ err: e, changelogRuPath }, "changelog-currency: CHANGELOG.ru.md missing/unreadable (bilingual gap)")
    changelogRuMissing = true
  }

  // Extract the most recent version entry
  const versionMatch = changelogText.match(/^##\s+v(\d+\.\d+\.\d+)/m)
  if (!versionMatch) {
    return {
      status: "fail",
      detail: "CHANGELOG.md has no recognizable version section",
    }
  }

  const changelogVersion = versionMatch[1]

  // v0.15.3: also verify CHANGELOG.ru.md (bilingual) is in sync. Treat
  // missing RU file or missing top version as warn — not a hard fail
  // because RU translations can lag a release by a session.
  const ruDetails: string[] = []
  if (changelogRuMissing) {
    ruDetails.push("CHANGELOG.ru.md missing (bilingual gap)")
  } else if (changelogRuText) {
    const ruVersionMatch = changelogRuText.match(/^##\s+v(\d+\.\d+\.\d+)/m)
    if (!ruVersionMatch) {
      ruDetails.push("CHANGELOG.ru.md has no version section")
    } else if (ruVersionMatch[1] !== changelogVersion) {
      ruDetails.push(`CHANGELOG.ru.md v${ruVersionMatch[1]} lags CHANGELOG.md v${changelogVersion}`)
    }
  }

  if (changelogVersion !== rootVersion) {
    return {
      status: "warn",
      detail: `CHANGELOG v${changelogVersion} does not match root package.json (${rootVersion})` +
        (ruDetails.length ? `; ${ruDetails.join("; ")}` : ""),
    }
  }

  if (ruDetails.length) {
    return {
      status: "warn",
      detail: `CHANGELOG v${changelogVersion} matches root package.json; ${ruDetails.join("; ")}`,
    }
  }

  return {
    status: "ok",
    detail: `CHANGELOG v${changelogVersion} matches root package.json (${rootVersion})`,
  }
})
