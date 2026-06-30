// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE
//
// Aggregator index for @sffmc/cognition (replaces dissolved @sffmc/agentic
// composite's aggregation role). Re-exports hooks, tools, and other
// public symbols from the 3 sub-packages: max-mode, compose, health.
//
// This file is the public entry point for `@sffmc/cognition`. Consumers
// that previously did `import { ... } from "@sffmc/agentic"` should
// switch to `import { ... } from "@sffmc/cognition"`. Hook event names
// and tool names are preserved exactly so plugin consumer code does
// not change.

export * as maxMode from "./max-mode/src/index.ts"
export * as compose from "./compose/src/index.ts"
export * as health from "./health/src/index.ts"