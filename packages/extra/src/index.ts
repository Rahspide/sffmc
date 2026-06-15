// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE
//
// Houses three opt-in sub-features: checkpoint, judge, dream.
// Each can be composed individually by @sffmc/memory MSP, or all
// three can be loaded together via this package's default export
// (standalone usage).
//
// Phase 2 (v0.9.0): factory pattern replaced with named server
// exports so the memory MSP can compose them via mergeHooks().

import { loadConfig, mergeHooks, type PluginContext, type PluginServer } from "@sffmc/shared";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCheckpointTool } from "./checkpoint";
import { createJudgeTool } from "./judge";
import { createDreamTool } from "./dream";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ExtraConfig {
  checkpoint: boolean;
  judge: boolean;
  dream: boolean;
  dream_threshold: number;
  dream_interval_hours: number;
  judge_model: string;
  judge_rubric: string;
  judge_auto: boolean;
  checkpoint_dir: string;
}

const defaultConfig: ExtraConfig = {
  checkpoint: false,
  judge: false,
  dream: false,
  dream_threshold: 50,
  dream_interval_hours: 24,
  judge_model: "ocg/deepseek-v4-flash",
  judge_rubric:
    "Score each candidate 0-10 on correctness, completeness, and conciseness. Pick the winner with brief reasoning.",
  judge_auto: false,
  checkpoint_dir: "", // resolved at server time if empty
};

const DEFAULT_CHECKPOINT_DIR = join(
  homedir(),
  ".local",
  "share",
  "sffmc",
  "extra",
  "checkpoints",
);

// ---------------------------------------------------------------------------
// Named servers (for composition by @sffmc/memory MSP)
// ---------------------------------------------------------------------------

export const id = "@sffmc/extra";

export const checkpointServer = async (ctx: PluginContext): Promise<PluginServer> => {
  const config = await loadConfig<ExtraConfig>("extra", defaultConfig);
  const resolvedCheckpointDir = config.checkpoint_dir || DEFAULT_CHECKPOINT_DIR;
  console.log(
    `[extra] checkpoint: ${config.checkpoint ? "enabled" : "disabled"}`,
  );
  const cp = createCheckpointTool({ enabled: config.checkpoint, dir: resolvedCheckpointDir });
  return { id: "extra-checkpoint", tool: { extra_checkpoint: cp.tool }, ...cp.hooks };
};

export const judgeServer = async (ctx: PluginContext): Promise<PluginServer> => {
  const config = await loadConfig<ExtraConfig>("extra", defaultConfig);
  console.log(
    `[extra] judge: ${config.judge ? "enabled" : "disabled"}`,
  );
  const j = createJudgeTool({
    enabled: config.judge,
    model: config.judge_model,
    rubric: config.judge_rubric,
    judge_auto: config.judge_auto,
    ctx,
  });
  return { id: "extra-judge", tool: { extra_judge: j.tool }, ...j.hooks };
};

export const dreamServer = async (ctx: PluginContext): Promise<PluginServer> => {
  const config = await loadConfig<ExtraConfig>("extra", defaultConfig);
  console.log(
    `[extra] dream: ${config.dream ? "enabled" : "disabled"}`,
  );
  const d = createDreamTool({
    enabled: config.dream,
    threshold: config.dream_threshold,
    intervalHours: config.dream_interval_hours,
    ctx,
  });
  return { id: "extra-dream", tool: { extra_dream: d.tool }, ...d.hooks };
};

// ---------------------------------------------------------------------------
// Merged server for standalone use (backward compat)
// ---------------------------------------------------------------------------

export const server = async (ctx: PluginContext): Promise<PluginServer> => {
  const merged = mergeHooks([
    await checkpointServer(ctx),
    await judgeServer(ctx),
    await dreamServer(ctx),
  ]);
  return { ...merged, id };
};

export default { id, server };
