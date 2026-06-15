// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

import { loadConfig, type PluginContext } from "@sffmc/shared";
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
// Plugin entry
// ---------------------------------------------------------------------------

const server = async (ctx: PluginContext) => {
  const config = await loadConfig<ExtraConfig>("extra", defaultConfig);

  // Resolve checkpoint_dir: empty → default (homedir/.local/share/sffmc/extra/checkpoints)
  const resolvedCheckpointDir =
    config.checkpoint_dir || DEFAULT_CHECKPOINT_DIR;

  console.log(
    `[extra] loaded — checkpoint=${config.checkpoint}, judge=${config.judge}, dream=${config.dream}`,
  );

  const checkpoint = createCheckpointTool({
    enabled: config.checkpoint,
    dir: resolvedCheckpointDir,
  });
  const judge = createJudgeTool({
    enabled: config.judge,
    model: config.judge_model,
    rubric: config.judge_rubric,
    judge_auto: config.judge_auto,
    ctx,
  });
  const dream = createDreamTool({
    enabled: config.dream,
    threshold: config.dream_threshold,
    intervalHours: config.dream_interval_hours,
    ctx,
  });

  // Each factory returns { tool, hooks }. We spread hooks into the top-level
  // return so OpenCode registers them. Tools are nested under "tool".
  return {
    ...checkpoint.hooks,
    ...judge.hooks,
    ...dream.hooks,
    tool: {
      extra_checkpoint: checkpoint.tool,
      extra_judge: judge.tool,
      extra_dream: dream.tool,
    },
  };
};

export default {
  id: "@sffmc/extra",
  server,
};
