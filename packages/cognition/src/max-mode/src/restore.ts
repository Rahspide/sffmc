import { type SchemaOnlyTool } from "./types"

interface RestoreState {
  tools: Map<string, SchemaOnlyTool>;
  stripped: boolean;
}

export function createRestoreState(): RestoreState {
  return {
    tools: new Map(),
    stripped: false,
  };
}

export function stripToolExecutes(
  tools: SchemaOnlyTool[],
  state: RestoreState,
): SchemaOnlyTool[] {
  if (state.stripped) return tools;

  for (const tool of tools) {
    if (tool.execute) {
      state.tools.set(tool.definition.name, { ...tool });
      if ("execute" in tool) delete (tool as SchemaOnlyTool).execute;
    }
  }

  state.stripped = true;
  return tools;
}

export function restoreToolExecutes(
  tools: SchemaOnlyTool[],
  state: RestoreState,
): void {
  if (!state.stripped) return;

  for (const tool of tools) {
    const saved = state.tools.get(tool.definition.name);
    if (saved?.execute) {
      tool.execute = saved.execute;
    }
  }

  state.tools.clear();
  state.stripped = false;
}

/** Reset restore state without restoring any tools. Used by `/max execute`
 *  to clear the schema-only flag when the user re-arms the toolset.
 *  No-op: restore state is per-session (lives on the plugin instance), so a
 *  global reset would have no effect. Kept as an exported symbol for callers
 *  that still pass through it; the body intentionally does nothing. */
export function resetRestoreState(): void {
  /* intentional no-op: state is per-session */
}
