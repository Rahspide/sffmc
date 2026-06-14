// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

export interface PluginContext {
  projectRoot: string
  config: Record<string, unknown>
  [key: string]: unknown
}
