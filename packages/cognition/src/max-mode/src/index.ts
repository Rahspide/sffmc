// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

/**
 * Barrel re-export for the max-mode plugin. Logic is decomposed into:
 *   - types-config.ts : MaxModeConfig, defaultConfig, PluginState
 *   - injection.ts    : redactInjectionInWinner (Bug #7)
 *   - message.ts      : estimateCost, buildWinnerMessage, consumeWinnerResult
 *   - plugin.ts       : id, server (SDK hook surface)
 *
 * Public API preserved exactly — see phase2/phase3/phase4 tests.
 */

import { defaultConfig as _defaultConfig } from "./types-config";
import type { MaxModeConfig } from "./types-config";
import { redactInjectionInWinner as _redactInjectionInWinner } from "./injection";
import { id as _id, server as _server } from "./plugin";

export const defaultConfig = _defaultConfig;
export type { MaxModeConfig };
export const redactInjectionInWinner = _redactInjectionInWinner;
export const id = _id;
export const server = _server;

export default { id, server };