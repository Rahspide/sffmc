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
      delete (tool as { execute?: unknown }).execute;
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
