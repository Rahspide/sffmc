// SPDX-License-Identifier: MIT
// @sffmc/memory — Phase-2 MEDIUM migration tests (M4, M5a, M5b)
//
// Verifies the new YAML-configurable fields on MemoryConfig:
//   - M4  reconTopN          (default 20, topByImportance limit)
//   - M5a watchStabilityMs   (default 300, chokidar stabilityThreshold)
//   - M5b watchPollIntervalMs (default 100, chokidar pollInterval)
//
// Two checks per item:
//   (a) default matches v0.14.2 hardcoded value (no behavior change)
//   (b) YAML override flows through the getter

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getMemoryReconTopN,
  getWatchStabilityMs,
  getWatchPollIntervalMs,
  __resetMemoryConfig,
} from "./index";
import { DEFAULT_WATCHER_CONFIG, type WatcherConfig } from "./watcher";

// ---------------------------------------------------------------------------
// Isolated configHome dir so we don't pick up the user's real
// ~/.config/SFFMC/memory.yaml. NOTE: bun's `os.homedir()` does NOT
// honour `process.env.HOME` (it reads /etc/passwd), so we pass
// `configHome` explicitly to the getters instead of relying on env vars.
// `loadConfig`'s configHome is the full path INCLUDING `.config/SFFMC`.
// ---------------------------------------------------------------------------

let tempHome: string | undefined;
let configHome: string | undefined;

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), "sffmc-memory-config-"));
  configHome = join(tempHome!, ".config", "SFFMC");
  mkdirSync(configHome!, { recursive: true });
});

afterAll(() => {
  if (tempHome) {
    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
  }
});

function writeMemoryYaml(contents: string): void {
  const path = join(configHome!, "memory.yaml");
  if (existsSync(path)) rmSync(path);
  writeFileSync(path, contents);
}

function clearMemoryYaml(): void {
  const path = join(configHome!, "memory.yaml");
  if (existsSync(path)) rmSync(path);
}

// ---------------------------------------------------------------------------
// M4 — reconTopN
// ---------------------------------------------------------------------------

describe("M4 — memory.reconTopN", () => {
  it("(a) default returns 20 (matches v0.14.2 hardcoded value)", async () => {
    __resetMemoryConfig();
    clearMemoryYaml();
    expect(await getMemoryReconTopN(configHome)).toBe(20);
  });

  it("(b) YAML override changes the value", async () => {
    __resetMemoryConfig();
    writeMemoryYaml("reconTopN: 7\n");
    expect(await getMemoryReconTopN(configHome)).toBe(7);
  });

  it("(b) YAML override to a large value flows through unchanged", async () => {
    __resetMemoryConfig();
    writeMemoryYaml("reconTopN: 50\n");
    expect(await getMemoryReconTopN(configHome)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// M5a — watchStabilityMs
// ---------------------------------------------------------------------------

describe("M5a — memory.watchStabilityMs", () => {
  it("(a) default returns 300 (matches v0.14.2 hardcoded value)", async () => {
    __resetMemoryConfig();
    clearMemoryYaml();
    expect(await getWatchStabilityMs(configHome)).toBe(300);
  });

  it("(b) YAML override changes the value", async () => {
    __resetMemoryConfig();
    writeMemoryYaml("watchStabilityMs: 750\n");
    expect(await getWatchStabilityMs(configHome)).toBe(750);
  });

  it("watcher DEFAULT_WATCHER_CONFIG preserves 300 (regression guard)", () => {
    // The exported fallback constant must match the v0.14.2 behaviour so
    // direct callers of startWatcher(rootDir, db) (no WatcherConfig arg)
    // still see the same chokidar timings.
    expect(DEFAULT_WATCHER_CONFIG.stabilityMs).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// M5b — watchPollIntervalMs
// ---------------------------------------------------------------------------

describe("M5b — memory.watchPollIntervalMs", () => {
  it("(a) default returns 100 (matches v0.14.2 hardcoded value)", async () => {
    __resetMemoryConfig();
    clearMemoryYaml();
    expect(await getWatchPollIntervalMs(configHome)).toBe(100);
  });

  it("(b) YAML override changes the value", async () => {
    __resetMemoryConfig();
    writeMemoryYaml("watchPollIntervalMs: 250\n");
    expect(await getWatchPollIntervalMs(configHome)).toBe(250);
  });

  it("watcher DEFAULT_WATCHER_CONFIG preserves 100 (regression guard)", () => {
    expect(DEFAULT_WATCHER_CONFIG.pollIntervalMs).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Combined — all three fields can be set at once, none clash with each other.
// ---------------------------------------------------------------------------

describe("M4/M5a/M5b — combined", () => {
  it("all three values flow through when set in the same YAML", async () => {
    __resetMemoryConfig();
    writeMemoryYaml(
      ["reconTopN: 12", "watchStabilityMs: 600", "watchPollIntervalMs: 200"].join("\n"),
    );
    expect(await getMemoryReconTopN(configHome)).toBe(12);
    expect(await getWatchStabilityMs(configHome)).toBe(600);
    expect(await getWatchPollIntervalMs(configHome)).toBe(200);
  });

  it("DEFAULT_WATCHER_CONFIG matches the v0.14.2 baseline shape", () => {
    // Compile-time type assertion via the runtime cast.
    const cfg: WatcherConfig = DEFAULT_WATCHER_CONFIG;
    expect(Object.keys(cfg).sort()).toEqual(["pollIntervalMs", "stabilityMs"]);
  });
});
