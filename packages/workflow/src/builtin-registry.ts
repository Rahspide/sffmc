// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import type { Meta } from "./meta.ts"
import * as deepResearchMod from "../builtin/deep-research.ts"
import * as planMod from "../builtin/plan.ts"
import * as tddMod from "../builtin/tdd.ts"
import * as refactorMod from "../builtin/refactor.ts"
import * as securityAuditMod from "../builtin/security-audit.ts"
import * as docGenMod from "../builtin/doc-gen.ts"
import * as libMigrateMod from "../builtin/lib-migrate.ts"

export interface BuiltinEntry {
  name: string
  description: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string }>
  script: string
}

type Loader = () => Promise<{ source: string; meta: Meta }>

function loadDeepResearch(): Promise<{ source: string; meta: Meta }> {
  return Promise.resolve({ source: deepResearchMod.source, meta: deepResearchMod.meta })
}

function loadPlan(): Promise<{ source: string; meta: Meta }> {
  return Promise.resolve({ source: planMod.source, meta: planMod.meta })
}

function loadTdd(): Promise<{ source: string; meta: Meta }> {
  return Promise.resolve({ source: tddMod.source, meta: tddMod.meta })
}

function loadRefactor(): Promise<{ source: string; meta: Meta }> {
  return Promise.resolve({ source: refactorMod.source, meta: refactorMod.meta })
}

function loadSecurityAudit(): Promise<{ source: string; meta: Meta }> {
  return Promise.resolve({ source: securityAuditMod.source, meta: securityAuditMod.meta })
}

function loadDocGen(): Promise<{ source: string; meta: Meta }> {
  return Promise.resolve({ source: docGenMod.source, meta: docGenMod.meta })
}

function loadLibMigrate(): Promise<{ source: string; meta: Meta }> {
  return Promise.resolve({ source: libMigrateMod.source, meta: libMigrateMod.meta })
}

/**
 * Registry of built-in workflows. Lookups use null-prototype to avoid inherited
 * Object.prototype members (e.g. "constructor") being returned accidentally.
 */
const REGISTRY: Record<string, Loader> = Object.create(null)

export function registerBuiltin(name: string, loader: Loader): void {
  REGISTRY[name] = loader
}

export function getBuiltin(name: string): Loader | undefined {
  return REGISTRY[name]
}

export function listBuiltins(): string[] {
  return Object.keys(REGISTRY).sort()
}

export async function loadBuiltin(name: string): Promise<BuiltinEntry> {
  const loader = REGISTRY[name]
  if (!loader) throw new Error(`Unknown built-in workflow: ${JSON.stringify(name)}`)
  const { source, meta } = await loader()
  return {
    name: meta.name,
    description: meta.description,
    whenToUse: meta.whenToUse,
    phases: meta.phases,
    script: source,
  }
}

// ── Register builtins ──────────────────────────────────────────────────────

registerBuiltin("deep-research", loadDeepResearch)
registerBuiltin("plan", loadPlan)
registerBuiltin("tdd", loadTdd)
registerBuiltin("refactor", loadRefactor)
registerBuiltin("security-audit", loadSecurityAudit)
registerBuiltin("doc-gen", loadDocGen)
registerBuiltin("lib-migrate", loadLibMigrate)
