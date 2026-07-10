// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Shared runtime constants used by both `types.ts` and `runtime.ts`.
// Extracted into a dedicated module to break the original
//   types.ts  <->  runtime.ts
// circular import, which caused a TDZ ReferenceError on
// `SCRIPT_DEADLINE_MS` in user environments (5 tests failing in
// `bun test` whenever runtime.ts happened to load ).
//
// Barrel — the public API surface is the union of the re-exports
// below. Implementation lives in two focused sub-modules:
//   - ./constants-defaults.ts : pure data (constants + interface + DEFAULT_*)
//   - ./constants-config.ts   : cache + getters + Symbol registry

export * from "./constants-defaults.ts"
export * from "./constants-config.ts"
