// SPDX-License-Identifier: MIT
// @sffmc/max-mode — see ../../LICENSE

/** Tool with only its schema definition, execution stripped.
 *  Used by schema-only (dry-run) mode for max-mode candidates. */
export interface SchemaOnlyTool {
  definition: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  execute?: (...args: unknown[]) => unknown;
}
