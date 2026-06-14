import { describe, it, expect } from "bun:test";
import { shouldKeep, shouldDrop, filterLines } from "./filter";

describe("shouldKeep", () => {
  const whitelist = [/error/i, /warn/i, /fail/i, /ENOENT/];

  it("matches lines containing whitelisted patterns", () => {
    expect(shouldKeep("ERROR: something broke", whitelist)).toBe(true);
    expect(shouldKeep("warning: deprecated", whitelist)).toBe(true);
    expect(shouldKeep("operation failed", whitelist)).toBe(true);
    expect(shouldKeep("ENOENT: no such file", whitelist)).toBe(true);
  });

  it("rejects lines without whitelist matches", () => {
    expect(shouldKeep("info: all ok", whitelist)).toBe(false);
    expect(shouldKeep("debug: processing", whitelist)).toBe(false);
    expect(shouldKeep("", whitelist)).toBe(false);
  });
});

describe("shouldDrop", () => {
  const blacklist = [/deprecat/i];

  it("drops blacklisted lines", () => {
    expect(shouldDrop("DeprecationWarning: use new API", blacklist)).toBe(true);
    expect(shouldDrop("info: deprecated function", blacklist)).toBe(true);
  });

  it("keeps non-blacklisted lines", () => {
    expect(shouldDrop("ERROR: critical", blacklist)).toBe(false);
  });
});

describe("filterLines", () => {
  const whitelist = [/error/i, /warn/i];
  const blacklist: RegExp[] = [];
  const marker = "... [N more lines]";

  it("keeps only whitelisted lines", () => {
    const lines = [
      "info: starting",
      "ERROR: something broke",
      "debug: processing",
      "WARN: low memory",
      "info: done",
    ];
    const result = filterLines(lines, whitelist, blacklist, 50, marker);
    expect(result.kept).toEqual([
      "ERROR: something broke",
      "WARN: low memory",
    ]);
    expect(result.dropped).toBe(3);
  });

  it("drops blacklisted lines even if they match whitelist", () => {
    const bl = [/deprecat/i];
    const lines = [
      "ERROR: deprecated function",
      "WARN: low memory",
    ];
    const result = filterLines(lines, whitelist, bl, 50, marker);
    expect(result.kept).toEqual(["WARN: low memory"]);
    expect(result.dropped).toBe(1);
  });

  it("caps output at maxKeptLines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `ERROR: line ${i}`);
    const result = filterLines(lines, whitelist, blacklist, 3, marker);
    expect(result.kept.length).toBe(4); // 3 kept + truncation marker
    expect(result.kept[3]).toContain("97 more lines");
  });

  it("returns empty when nothing matches", () => {
    const lines = ["info: ok", "debug: trace"];
    const result = filterLines(lines, whitelist, blacklist, 50, marker);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toBe(2);
  });

  it("handles empty input", () => {
    const result = filterLines([], whitelist, blacklist, 50, marker);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toBe(0);
  });
});

describe("Plugin entry", () => {
  it("exports default object with id and server function", async () => {
    const mod = await import("./index");
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("@sffmc/log-whitelist");
    expect(typeof mod.default.server).toBe("function");
  });

  it("server returns expected hooks", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    expect(typeof hooks.config).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
    expect(typeof hooks["experimental.text.complete"]).toBe("function");
  });

  it("tool.execute.after is a no-op when whitelist is empty", async () => {
    // Default config has empty whitelist — so nothing should be filtered
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const result = { output: "ERROR: something\ninfo: nothing" };
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "s1", callID: "c1" },
      result,
    );
    // Output unchanged since whitelist is empty
    expect(result.output).toBe("ERROR: something\ninfo: nothing");
  });

  it("tool.execute.after skips non-string output", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const result = { output: { structured: true } };
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "s1", callID: "c1" },
      result,
    );
    // Structured output passed through
    expect(result.output).toEqual({ structured: true });
  });

  it("text.complete is a no-op when whitelist is empty", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const data = { text: "ERROR: something\ninfo: nothing" };
    await hooks["experimental.text.complete"]!(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      data,
    );
    expect(data.text).toBe("ERROR: something\ninfo: nothing");
  });
});
