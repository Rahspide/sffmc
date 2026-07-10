// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

import { createLogger, loadConfig, type RichPluginContext } from "@sffmc/utilities";
import { createRestoreState } from "./restore";
import { defaultConfig, type PluginState } from "./max-mode-config";
import { redactInjectionInWinner } from "./max-mode-winner";
import { createMaxModeHooks } from "./max-mode-hooks";

const log = createLogger("max-mode");

export { defaultConfig, redactInjectionInWinner };

export const id = "@sffmc/cognition";
export const server = async (ctx: RichPluginContext) => {
  const config = await loadConfig<typeof defaultConfig>("max-mode", defaultConfig);
  const state: PluginState = {
    config,
    restore: createRestoreState(),
    maxUsedThisSession: false,
    pendingResults: new Map(),
  };

  if (config.dry_run) {
    log.warn("dry_run=true — Max Mode will only estimate costs");
  }

  return createMaxModeHooks(state, ctx);
};

export default { id, server };
