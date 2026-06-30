// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE

/** OpenCode event name for "new session started". Single source of truth
 *  so memory/plugin.ts, watchdog/index.ts, and auto-max/index.ts can't
 *  drift to a typo'd event string. */
export const SESSION_CREATED = "session.created"
