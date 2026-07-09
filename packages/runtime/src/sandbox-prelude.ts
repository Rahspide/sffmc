// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Sandbox prelude + host-hook builder, extracted from sandbox.ts per
// the v0.16.0 refactor plan (ora-11, File 3). The guest-side PRELUDE
// is a single multi-line JS string that defines parallel/pipeline/URL/
// mcp globals in the QuickJS context. The buildHostHooks helper
// derives a filtered key map from the primitives object (used to
// inject the host bridge). Lowest-risk sandbox extraction: pure
// string + pure map filter, no handle lifecycle.

import type { SandboxPrimitives } from "./sandbox.ts"

const PRELUDE = `
globalThis.parallel = (thunks) =>
  Promise.all(thunks.map((t) => Promise.resolve().then(t)));
globalThis.pipeline = (items, ...stages) =>
  Promise.all(items.map((item, index) =>
    stages.reduce((acc, stage) => acc.then((prev) => stage(prev, item, index)), Promise.resolve(item))));
// Minimal, deterministic URL for dedup/host-extraction in workflow scripts.
// The bare QuickJS guest has no Web URL. Covers protocol/hostname/pathname/
// search/hash — enough for normURL-style dedup — and THROWS on inputs without
// a scheme+host, so scripts' try/catch fallbacks behave like the real URL.
globalThis.URL = class URL {
  constructor(input) {
    const str = String(input);
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\\/\\/([^/?#]*)([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(str);
    if (!m) throw new TypeError("Invalid URL: " + str);
    this.protocol = m[1].toLowerCase();
    this.hostname = m[2];
    this.pathname = m[3] || "/";
    this.search = m[4] || "";
    this.hash = m[5] || "";
    this.host = m[2];
  }
  toString() { return this.protocol + "//" + this.host + this.pathname + this.search + this.hash; }
};
// MCP bridge — bound to host-injected mcpList / mcpCall (see injectHooks).
// When the runtime does not wire MCP support, both globals are set to no-ops
// (mcpList returns []; mcpCall rejects with a clear error). Scripts can
// therefore use mcp.list() and mcp.call(name, args) unconditionally.
//
// mcp.bind(name) and mcp.bindAll() are also exposed so guest scripts can
// pull typed handles once (e.g. const search = mcp.bind("github_search"))
// and invoke them like local functions. bindAll() returns a record of
// every tool currently registered with the parent.
globalThis.mcp = {
  list: (...args) => globalThis.mcpList(...args),
  call: (...args) => globalThis.mcpCall(...args),
  bind: (name) => (args) => globalThis.mcpCall(name, args),
  bindAll: async () => {
    const names = await globalThis.mcpList();
    const out = {};
    for (const n of names) out[n] = (args) => globalThis.mcpCall(n, args);
    return out;
  },
};
`

/** Keys that the guest-side PRELUDE wires up directly — host primitives
 *  bearing these names are filtered out of the hooks map so the PRELUDE
 *  versions (parallel / pipeline / args binding) cannot be shadowed. */
const PRELUDE_KEYS = new Set<string>(["parallel", "pipeline", "args"])

/** Build a filtered key map for host hook injection. The PRELUDE owns
 *  parallel/pipeline/URL/mcp — any caller-supplied primitive with one
 *  of those keys is silently dropped (a warning would be nice but the
 *  current behavior is silent-by-design to keep the prelude stable
 *  across primitive-set changes). */
export function buildHostHooks(primitives: Partial<SandboxPrimitives>): Record<string, unknown> {
  const hooks: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(primitives)) {
    if (PRELUDE_KEYS.has(key)) continue
    if (typeof value !== "function") continue
    hooks[key] = value
  }
  return hooks
}

export { PRELUDE }
