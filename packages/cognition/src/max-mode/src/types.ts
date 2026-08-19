// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

/** Tool with only its schema definition, execution stripped.
 *  Used by schema-only (dry-run) mode for max-mode candidates. */
export interface SchemaOnlyTool {
  definition: {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
  execute?: (...args: unknown[]) => ToolResult;
}

/** OpenCode tool parameters shape — JSON Schema-like object describing
 *  the shape of a tool's input. Keys are arbitrary (e.g. "type",
 *  "properties", "required") and values are strings/nested objects. */
export type ToolParameters = {
  type?: string;
  properties?: Record<string, { type: string; description?: string }>;
  required?: readonly string[];
};

/** Result of an OpenCode tool execute — the SDK accepts a string or a
 *  structured object (rendered to the model). Most plugins return a
 *  plain string; the structured variant exists for tools that want
 *  richer tool-call metadata. */
export type ToolResult = string | { output: string; metadata?: Record<string, string> };
