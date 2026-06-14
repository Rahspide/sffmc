import { init, topByImportance, type MemoryDB } from "./memory";
import { buildRecon, parseAgentsMd, tailFromMessages } from "./recon";
import { startWatcher } from "./watcher";
import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";

interface PluginState {
  db: MemoryDB | null;
  watcher: { stop: () => void } | null;
  reconNeededThisSession: boolean;
  reconInjectedThisSession: boolean;
  config: ReturnType<typeof loadConfig>;
}

interface PluginContext {
  projectRoot: string;
  config: Record<string, unknown>;
  [key: string]: unknown;
}

const defaultConfig = {
  storagePath: resolve(
    homedir(),
    ".local/share/SFFMC/memory/index.sqlite",
  ),
  reconBudgets: {
    memory: 6144,
    checkpoint: 6144,
    taskTree: 4096,
    tail: 8192,
    agents: 8192,
  },
  memoryPaths: ["memory-bank/", "AGENTS.md", "*.md"],
  defaultImportance: 0.5,
};

function loadConfig() {
  const configPath = resolve(homedir(), ".config/SFFMC/memory.yaml");
  if (!existsSync(configPath)) return { ...defaultConfig };
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Partial<typeof defaultConfig>;
    return { ...defaultConfig, ...parsed };
  } catch {
    return { ...defaultConfig };
  }
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const server = async (ctx: PluginContext) => {
  const state: PluginState = {
    db: null,
    watcher: null,
    reconNeededThisSession: false,
    reconInjectedThisSession: false,
    config: loadConfig(),
  };

  async function ensureDB(): Promise<MemoryDB> {
    if (!state.db) {
      ensureDir(state.config.storagePath);
      state.db = await init(state.config.storagePath);
    }
    return state.db;
  }

  async function ensureWatcher(): Promise<void> {
    if (!state.watcher) {
      const db = await ensureDB();
      state.watcher = startWatcher(ctx.projectRoot, db);
    }
  }

  return {
    config: async (_cfg: Record<string, unknown>) => {
      await ensureDB();
      await ensureWatcher();
    },

    event: async (payload: { event: string; [key: string]: unknown }) => {
      if (payload.event === "session.created") {
        state.reconNeededThisSession = true;
        state.reconInjectedThisSession = false;
      }
    },

    "experimental.chat.messages.transform": async (
      _input: unknown,
      data: {
        messages: Array<{
          role: string;
          content: string;
          [key: string]: unknown;
        }>;
      },
    ) => {
      if (!state.reconNeededThisSession || state.reconInjectedThisSession)
        return;

      try {
        const db = await ensureDB();
        const memory = topByImportance(db, 20);

        const agentsPath = resolve(ctx.projectRoot, "AGENTS.md");
        let agents = "";
        if (existsSync(agentsPath)) {
          agents = parseAgentsMd(readFileSync(agentsPath, "utf-8"));
        }

        const tail = tailFromMessages(
          data.messages.slice(-20),
          state.config.reconBudgets.tail,
        );

        const recon = buildRecon(
          memory,
          null,
          "",
          tail,
          agents,
        );

        data.messages.unshift({
          role: "system",
          content: recon,
        });

        state.reconInjectedThisSession = true;
        state.reconNeededThisSession = false;
      } catch {
        // recon is best-effort; silently skip on failure
      }
    },
  };
};

export default {
  id: "@sffmc/memory",
  server,
};
