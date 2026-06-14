// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import type { Meta } from "./meta.ts"

export interface BuiltinEntry {
  name: string
  description: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string }>
  script: string
}

type Loader = () => Promise<{ source: string; meta: Meta }>

/**
 * Registry of built-in workflows. Lane D will register `deep-research` here.
 * Initially empty. Lookups use null-prototype to avoid inherited Object.prototype
 * members (e.g. "constructor") being returned accidentally.
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
