// SPDX-License-Identifier: MIT
// @sffmc/safety — see ../../LICENSE
//
// v0.14.1 regression test for Bug 1: watchdog "loaded" log line was
// reporting `model=` (empty) instead of the configured fallback model.
// Root cause: the 3-tier fallback chain
//   config.promote_model → ctx.config.model → ""
// produced an empty value when both upstream sources were unset, making it
// impossible to distinguish "no fallback configured" from "config didn't
// load". Fix adds "(default)" as the terminal fallback so the field is
// never empty.

import { describe, it, expect, jest, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

const testConfigDir = resolve(homedir(), ".config/SFFMC");
const testConfigPath = resolve(testConfigDir, "watchdog.yaml");

/**
 * Import the watchdog module with a cache-busting query string so the
 * module-level `loadedLogged` flag starts at `false`. Without this,
 * a previous test file's server() call would have already set the flag
 * to true and the load log would never fire.
 */
async function importFresh(suffix: string): Promise<typeof import("../src/watchdog/index")> {
  return await import(`../../src/watchdog/index.ts?cachebust=${Date.now()}-${suffix}`);
}

describe("Bug 1 fix — watchdog 'loaded' log shows configured model", () => {
  let warnSpy: ReturnType<typeof jest.spyOn>;
  const collectedWarnings: string[] = [];

  beforeAll(() => {
    mkdirSync(testConfigDir, { recursive: true });
    if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
    warnSpy = jest.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      collectedWarnings.push(args.map(a => typeof a === "string" ? a : "").join(" "));
    });
  });

  afterAll(() => {
    if (warnSpy) warnSpy.mockRestore();
    if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
  });

  it("emits 'loaded' log with the configured promote_model value (not empty)", async () => {
    collectedWarnings.length = 0;

    // Write a watchdog.yaml that explicitly sets promote_model
    writeFileSync(
      testConfigPath,
      [
        "threshold: 3",
        "rolling_window: 10",
        'promote_model: "gpt-5-mini"',
        "error_class_filter:",
        '  - "fetch_429"',
        "log_failures: true",
      ].join("\n"),
    );

    const mod = await importFresh("configured");
    expect(mod.default.id).toBe("@sffmc/safety");

    // Trigger server() — this is where the load log fires
    await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const loadedLog = collectedWarnings.find(
      (w) => w.includes("[watchdog]") && w.includes("loaded, threshold="),
    );
    expect(loadedLog).toBeDefined();
    expect(loadedLog).toContain("threshold=3");
    // Bug fix: the model field must NOT be empty when promote_model is set
    expect(loadedLog).not.toMatch(/model=$/);
    expect(loadedLog).toContain("model=gpt-5-mini");
  });

  it("emits 'loaded' log with '(default)' marker when no model is configured", async () => {
    collectedWarnings.length = 0;

    // Write a watchdog.yaml that does NOT set promote_model
    writeFileSync(
      testConfigPath,
      [
        "threshold: 3",
        "rolling_window: 10",
        "promote_model: null",
        "error_class_filter:",
        '  - "fetch_429"',
        "log_failures: true",
      ].join("\n"),
    );

    const mod = await importFresh("unset");
    await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const loadedLog = collectedWarnings.find(
      (w) => w.includes("[watchdog]") && w.includes("loaded, threshold="),
    );
    expect(loadedLog).toBeDefined();
    // Bug fix: when neither config.promote_model nor ctx.config.model is set,
    // the field must show a visible marker rather than an empty string.
    expect(loadedLog).not.toMatch(/model=$/);
    expect(loadedLog).toContain("model=(default)");
  });
});
