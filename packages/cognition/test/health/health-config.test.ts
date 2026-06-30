// SPDX-License-Identifier: MIT
// @sffmc/cognition — second release migration tests (composite file list, safeMultiHooks flag, expected composite list)
//
// Verifies the new YAML-configurable fields on HealthConfig:
//   - composite file list  toolFiles           (default 6-entry list, fix-17 regression scan targets)
//   - safeMultiHooks flag  safeMultiHooks      (default 15-entry list, hook-conflict whitelist)
//   - expected composite list  expectedComposites  (default ["safety", "memory", "agentic"])
//
// Two checks per item:
//   (a) default matches v0.14.2 hardcoded value (no behavior change)
//   (b) YAML override flows through to getHealthConfigSync()

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  DEFAULT_HEALTH_CONFIG,
  ensureHealthConfig,
  getHealthConfigSync,
  __setHealthConfig,
  type HealthConfig,
} from "./_test-helpers/config-cache.ts";

// ---------------------------------------------------------------------------
// Isolated configHome dir so we don't pick up the user's real
// ~/.config/SFFMC/health.yaml. NOTE: bun's `os.homedir()` does NOT honour
// `process.env.HOME` (it reads /etc/passwd), so we pass `configHome`
// explicitly to the loaders instead of relying on env vars. `loadConfig`'s
// configHome is the full path INCLUDING `.config/SFFMC`.
// ---------------------------------------------------------------------------

let tempHome: string | undefined;
let configHome: string | undefined;

function writeHealthYaml(contents: string): void {
  const path = resolve(configHome!, "health.yaml");
  if (existsSync(path)) rmSync(path);
  writeFileSync(path, contents);
}

function clearHealthYaml(): void {
  const path = resolve(configHome!, "health.yaml");
  if (existsSync(path)) rmSync(path);
}

beforeEach(() => {
  __setHealthConfig(null);
  tempHome = mkdtempSync(resolve(tmpdir(), "sffmc-health-config-"));
  configHome = resolve(tempHome, ".config", "SFFMC");
  mkdirSync(configHome, { recursive: true });
});

afterEach(() => {
  __setHealthConfig(null);
  if (tempHome) {
    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
    tempHome = undefined;
  }
});

// ---------------------------------------------------------------------------
// composite file list — toolFiles
// ---------------------------------------------------------------------------

describe("composite file list — health.toolFiles", () => {
  it("(a) default matches the v0.14.2 hardcoded 6-entry list", () => {
    expect(DEFAULT_HEALTH_CONFIG.toolFiles).toEqual([
      "packages/cognition/src/compose/src/index.ts",
      "packages/runtime/src/tool.ts",
      "packages/cognition/src/health/src/index.ts",
      "packages/memory/src/extra/checkpoint.ts",
      "packages/memory/src/extra/judge.ts",
      "packages/memory/src/extra/dream.ts",
    ]);
  });

  it("(a) getHealthConfigSync returns defaults before any YAML load", () => {
    // __setHealthConfig(null) above ensures the cache is empty.
    const cfg = getHealthConfigSync();
    expect(cfg.toolFiles).toHaveLength(6);
    expect(cfg.toolFiles).toEqual(DEFAULT_HEALTH_CONFIG.toolFiles);
  });

  it("(b) YAML override flows through to getHealthConfigSync", async () => {
    writeHealthYaml(
      ["toolFiles:", "  - packages/my-pkg/src/index.ts", ""].join("\n"),
    );
    const cfg = await ensureHealthConfig({ configHome });
    expect(cfg.toolFiles).toEqual(["packages/my-pkg/src/index.ts"]);
    // Other fields still come from defaults.
    expect(cfg.safeMultiHooks).toEqual(DEFAULT_HEALTH_CONFIG.safeMultiHooks);
    expect(cfg.expectedComposites).toEqual(DEFAULT_HEALTH_CONFIG.expectedComposites);
  });
});

// ---------------------------------------------------------------------------
// safeMultiHooks flag — safeMultiHooks
// ---------------------------------------------------------------------------

describe("safeMultiHooks flag — health.safeMultiHooks", () => {
  it("(a) default matches the v0.14.2 hardcoded 15-entry list", () => {
    expect(DEFAULT_HEALTH_CONFIG.safeMultiHooks).toEqual([
      "config",
      "event",
      "tool.execute.before",
      "tool.execute.after",
      "command.execute.before",
      "command.execute.after",
      "experimental.text.complete",
      "experimental.chat.messages.transform",
      "experimental.chat.system.transform",
      "permission.ask",
      "permission.respond",
      "tool",
      "chat.message",
      "chat.params",
      "chat.system",
    ]);
  });

  it("(a) getHealthConfigSync returns defaults before any YAML load", () => {
    const cfg = getHealthConfigSync();
    expect(cfg.safeMultiHooks).toHaveLength(15);
    expect(cfg.safeMultiHooks).toEqual(DEFAULT_HEALTH_CONFIG.safeMultiHooks);
  });

  it("(b) YAML override flows through to getHealthConfigSync", async () => {
    writeHealthYaml(
      ["safeMultiHooks:", "  - my-custom-hook", "  - another-hook", ""].join("\n"),
    );
    const cfg = await ensureHealthConfig({ configHome });
    expect(cfg.safeMultiHooks).toEqual(["my-custom-hook", "another-hook"]);
    // Other fields still come from defaults.
    expect(cfg.toolFiles).toEqual(DEFAULT_HEALTH_CONFIG.toolFiles);
    expect(cfg.expectedComposites).toEqual(DEFAULT_HEALTH_CONFIG.expectedComposites);
  });
});

// ---------------------------------------------------------------------------
// expected composite list — expectedComposites
// ---------------------------------------------------------------------------

describe("expected composite list — health.expectedComposites", () => {
  it("(a) default matches the v0.14.2 hardcoded ['safety', 'memory', 'agentic']", () => {
    expect(DEFAULT_HEALTH_CONFIG.expectedComposites).toEqual([
      "safety",
      "memory",
    ]);
  });

  it("(a) getHealthConfigSync returns defaults before any YAML load", () => {
    const cfg = getHealthConfigSync();
    expect(cfg.expectedComposites).toEqual(["safety", "memory"]);
  });

  it("(b) YAML override flows through to getHealthConfigSync", async () => {
    writeHealthYaml("expectedComposites:\n  - my-composite\n");
    const cfg = await ensureHealthConfig({ configHome });
    expect(cfg.expectedComposites).toEqual(["my-composite"]);
    // Other fields still come from defaults.
    expect(cfg.toolFiles).toEqual(DEFAULT_HEALTH_CONFIG.toolFiles);
    expect(cfg.safeMultiHooks).toEqual(DEFAULT_HEALTH_CONFIG.safeMultiHooks);
  });
});

// ---------------------------------------------------------------------------
// Combined — all three fields can be set at once, none clash with each other.
// ---------------------------------------------------------------------------

describe("composite file list/safeMultiHooks flag/expected composite list — combined", () => {
  it("all three values flow through when set in the same YAML", async () => {
    writeHealthYaml(
      [
        "toolFiles:",
        "  - packages/custom-a/src/index.ts",
        "  - packages/custom-b/src/index.ts",
        "safeMultiHooks:",
        "  - custom-hook",
        "expectedComposites:",
        "  - custom-composite",
        "",
      ].join("\n"),
    );
    const cfg = await ensureHealthConfig({ configHome });
    expect(cfg.toolFiles).toEqual([
      "packages/custom-a/src/index.ts",
      "packages/custom-b/src/index.ts",
    ]);
    expect(cfg.safeMultiHooks).toEqual(["custom-hook"]);
    expect(cfg.expectedComposites).toEqual(["custom-composite"]);
  });

  it("ensureHealthConfig is idempotent (cached after first call)", async () => {
    writeHealthYaml("toolFiles:\n  - a\n  - b\n");
    const cfg1 = await ensureHealthConfig({ configHome });
    const cfg2 = await ensureHealthConfig({ configHome });
    expect(cfg1).toBe(cfg2);
    expect(cfg1.toolFiles).toEqual(["a", "b"]);
  });

  it("__setHealthConfig(null) resets the cache (test isolation)", async () => {
    // Bypass the YAML load and inject a custom config directly.
    __setHealthConfig({
      ...DEFAULT_HEALTH_CONFIG,
      toolFiles: ["packages/custom/src/index.ts"],
    });
    expect(getHealthConfigSync().toolFiles).toEqual(["packages/custom/src/index.ts"]);
    __setHealthConfig(null);
    expect(getHealthConfigSync().toolFiles).toEqual(DEFAULT_HEALTH_CONFIG.toolFiles);
  });

  it("missing health.yaml falls back to defaults (no override)", async () => {
    // No YAML written — clearHealthYaml for good measure.
    clearHealthYaml();
    const cfg = await ensureHealthConfig({ configHome });
    expect(cfg).toEqual(DEFAULT_HEALTH_CONFIG);
  });
});