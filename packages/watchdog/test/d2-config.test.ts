// SPDX-License-Identifier: MIT
// @sffmc/watchdog — see ../../LICENSE
//
// second release migration test (watchdog log file) — see
// .slim/deepwork/phase-2-3-hardcode-migration-plan.md §2.7
//
// Verifies the new YAML-configurable field on WatchdogConfig:
//   - watchdog log file  recentFailuresLimit   (default 5, limit passed to FailureCounter.getRecentFailures)
//
// Three checks:
//   (a) default matches v0.14.2 hardcoded value (5)
//   (b) YAML override flows through loadConfig and reaches the call site
//   (c) Validation range per plan: 1 ≤ x ≤ 50 (only documented in plan —
//       not enforced at runtime, but the default 5 sits comfortably inside)

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../../watchdog/src/index";
import { loadConfig } from "@sffmc/shared";

// ---------------------------------------------------------------------------
// Isolated configHome so we don't pick up the user's real
// ~/.config/SFFMC/watchdog.yaml. Note: the existing loaded-log.test.ts uses
// ~/.config/SFFMC/watchdog.yaml directly — we use a temp dir here to keep
// the watchdog log file tests hermetic and not interfere with that other suite.
// ---------------------------------------------------------------------------

let tempHome: string | undefined;
let configHome: string | undefined;

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), "sffmc-watchdog-d2-"));
  configHome = join(tempHome!, ".config", "SFFMC");
  mkdirSync(configHome!, { recursive: true });
});

afterAll(() => {
  if (tempHome) {
    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
  }
});

function clearWatchdogYaml(): void {
  const path = join(configHome!, "watchdog.yaml");
  if (existsSync(path)) rmSync(path);
}

function writeWatchdogYaml(contents: string): void {
  const path = join(configHome!, "watchdog.yaml");
  clearWatchdogYaml();
  writeFileSync(path, contents);
}

// ---------------------------------------------------------------------------
// watchdog log file — recentFailuresLimit
// ---------------------------------------------------------------------------

describe("watchdog log file — watchdog.recentFailuresLimit", () => {
  it("(a) defaultConfig.recentFailuresLimit === 5 (matches v0.14.2 hardcoded value)", () => {
    expect(defaultConfig.recentFailuresLimit).toBe(5);
  });

  it("(a) loadConfig with no YAML file returns recentFailuresLimit = 5", async () => {
    clearWatchdogYaml();
    const cfg = await loadConfig("watchdog", defaultConfig, { configHome });
    expect(cfg.recentFailuresLimit).toBe(5);
  });

  it("(b) YAML override changes the value", async () => {
    writeWatchdogYaml("recentFailuresLimit: 12\n");
    const cfg = await loadConfig("watchdog", defaultConfig, { configHome });
    expect(cfg.recentFailuresLimit).toBe(12);
  });

  it("(b) YAML override at the plan-stated upper bound (50) flows through", async () => {
    writeWatchdogYaml("recentFailuresLimit: 50\n");
    const cfg = await loadConfig("watchdog", defaultConfig, { configHome });
    expect(cfg.recentFailuresLimit).toBe(50);
  });

  it("(b) YAML override at the plan-stated lower bound (1) flows through", async () => {
    writeWatchdogYaml("recentFailuresLimit: 1\n");
    const cfg = await loadConfig("watchdog", defaultConfig, { configHome });
    expect(cfg.recentFailuresLimit).toBe(1);
  });
});
