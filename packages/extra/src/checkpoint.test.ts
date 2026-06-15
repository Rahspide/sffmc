// SPDX-License-Identifier: MIT
// @sffmc/extra — checkpoint.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createCheckpointTool,
  flushSession,
  flushAll,
  readToolCalls,
  listSessions,
  filePath,
  __setCheckpointDir,
  __cleanup,
} from "./checkpoint";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolCtx(overrides: Partial<{ tool: string; sessionID: string; callID: string }> = {}) {
  return {
    tool: overrides.tool ?? "bash",
    sessionID: overrides.sessionID ?? "test-session-1",
    callID: overrides.callID ?? "call-001",
  };
}

function makeResult(overrides: Partial<{ output: unknown; metadata: unknown }> = {}) {
  return {
    output: overrides.output ?? "ok\n",
    metadata: overrides.metadata ?? { args: { command: "ls" } },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("checkpoint", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sffmc-checkpoint-test-"));
    __setCheckpointDir(tmpDir);
  });

  afterAll(() => {
    __cleanup();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    __cleanup();
    // Remove all files in tmp dir
    try {
      for (const f of readdirSync(tmpDir)) {
        unlinkSync(join(tmpDir, f));
      }
    } catch {
      // dir may not exist yet
    }
  });

  // -----------------------------------------------------------------------
  // Capture: buffer + flush
  // -----------------------------------------------------------------------

  describe("capture", () => {
    it("buffers tool.execute.after calls in memory", async () => {
      const { hooks } = createCheckpointTool({ enabled: true });

      await hooks["tool.execute.after"]!(makeToolCtx(), makeResult());
      await hooks["tool.execute.after"]!(
        makeToolCtx({ callID: "call-002" }),
        makeResult({ metadata: { args: { file: "test.txt" } } }),
      );

      // Not flushed yet — file should not exist
      expect(existsSync(filePath("test-session-1"))).toBe(false);
    });

    it("flushes buffer to disk as JSONL when flushSession called", async () => {
      const { hooks } = createCheckpointTool({ enabled: true });

      await hooks["tool.execute.after"]!(makeToolCtx(), makeResult());
      await hooks["tool.execute.after"]!(
        makeToolCtx({ callID: "call-002" }),
        makeResult({ output: "result2", metadata: { args: { path: "/tmp" } } }),
      );

      flushSession("test-session-1");

      const fp = filePath("test-session-1");
      expect(existsSync(fp)).toBe(true);

      const calls = readToolCalls("test-session-1");
      expect(calls.length).toBe(2);
      expect(calls[0].tool).toBe("bash");
      expect(calls[0].args).toEqual({ command: "ls" });
      expect(calls[0].result).toBe("ok\n");
      expect(calls[0].callID).toBe("call-001");
      expect(calls[0].timestamp).toBeTypeOf("number");

      expect(calls[1].tool).toBe("bash");
      expect(calls[1].args).toEqual({ path: "/tmp" });
      expect(calls[1].result).toBe("result2");
      expect(calls[1].callID).toBe("call-002");
    });

    it("writes header with version 1 on first flush", async () => {
      const { hooks } = createCheckpointTool({ enabled: true });

      await hooks["tool.execute.after"]!(makeToolCtx(), makeResult());
      flushSession("test-session-1");

      const raw = readFileSync(filePath("test-session-1"), "utf-8");
      const lines = raw.trim().split("\n");
      const header = JSON.parse(lines[0]) as Record<string, unknown>;
      expect(header.__type).toBe("header");
      expect(header.sessionID).toBe("test-session-1");
      expect(header.version).toBe(1);
      expect(header.createdAt).toBeTypeOf("number");
    });

    it("appends on subsequent flushes without duplicating header", async () => {
      const { hooks } = createCheckpointTool({ enabled: true });

      await hooks["tool.execute.after"]!(makeToolCtx({ callID: "c1" }), makeResult());
      flushSession("test-session-1");

      await hooks["tool.execute.after"]!(makeToolCtx({ callID: "c2" }), makeResult());
      flushSession("test-session-1");

      const raw = readFileSync(filePath("test-session-1"), "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(3); // 1 header + 2 tool calls
      const headers = lines.filter((l) => {
        try { return (JSON.parse(l) as Record<string, unknown>).__type === "header"; } catch { return false; }
      });
      expect(headers.length).toBe(1);
    });

    it("flushAll flushes all sessions", async () => {
      const { hooks } = createCheckpointTool({ enabled: true });

      await hooks["tool.execute.after"]!(
        makeToolCtx({ sessionID: "s1", callID: "c1" }),
        makeResult(),
      );
      await hooks["tool.execute.after"]!(
        makeToolCtx({ sessionID: "s2", callID: "c2" }),
        makeResult({ output: "s2-out" }),
      );

      flushAll();

      expect(existsSync(filePath("s1"))).toBe(true);
      expect(existsSync(filePath("s2"))).toBe(true);
      expect(readToolCalls("s1").length).toBe(1);
      expect(readToolCalls("s2").length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Restore
  // -----------------------------------------------------------------------

  describe("restore", () => {
    it("reconstructs messages from checkpoint file", async () => {
      const { hooks, tool } = createCheckpointTool({ enabled: true });

      await hooks["tool.execute.after"]!(
        makeToolCtx({ callID: "r1" }),
        makeResult({ output: "result-a", metadata: { args: { a: 1 } } }),
      );
      await hooks["tool.execute.after"]!(
        makeToolCtx({ tool: "glob", callID: "r2" }),
        makeResult({ output: ["f1.ts"], metadata: { args: { pattern: "*.ts" } } }),
      );
      flushSession("test-session-1");

      const result = (await tool.execute({ action: "restore", sessionID: "test-session-1" })) as {
        ok: boolean;
        messages: Array<{ role: string; content: string }>;
        toolCallCount: number;
      };

      expect(result.ok).toBe(true);
      expect(result.toolCallCount).toBe(2);
      expect(result.messages.length).toBe(2);
      expect(result.messages[0].role).toBe("assistant");
      expect(result.messages[0].content).toContain("bash");
      expect(result.messages[0].content).toContain('{"a":1}');
      expect(result.messages[0].content).toContain('"result-a"');
      expect(result.messages[1].content).toContain("glob");
    });

    it("returns error for unknown version", async () => {
      const { tool } = createCheckpointTool({ enabled: true });

      // Manually write a file with version 2
      const fp = filePath("bad-version");
      const header = JSON.stringify({
        __type: "header",
        sessionID: "bad-version",
        version: 2,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }) + "\n";
      writeFileSync(fp, header, "utf-8");

      const result = (await tool.execute({ action: "restore", sessionID: "bad-version" })) as {
        ok: boolean;
        error: string;
      };

      expect(result.ok).toBe(false);
      expect(result.error).toContain("unknown checkpoint version");
    });

    it("returns error when checkpoint not found", async () => {
      const { tool } = createCheckpointTool({ enabled: true });

      const result = (await tool.execute({ action: "restore", sessionID: "nonexistent" })) as {
        ok: boolean;
        error: string;
      };

      expect(result.ok).toBe(false);
      expect(result.error).toBe("checkpoint not found");
    });
  });

  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------

  describe("list", () => {
    it("returns session IDs with checkpoint files", async () => {
      const { hooks, tool } = createCheckpointTool({ enabled: true });

      await hooks["tool.execute.after"]!(
        makeToolCtx({ sessionID: "ses-a", callID: "c1" }),
        makeResult(),
      );
      await hooks["tool.execute.after"]!(
        makeToolCtx({ sessionID: "ses-b", callID: "c2" }),
        makeResult(),
      );
      flushAll();

      const result = (await tool.execute({ action: "list" })) as { ok: boolean; sessions: string[] };

      expect(result.ok).toBe(true);
      expect(result.sessions.sort()).toEqual(["ses-a", "ses-b"]);
    });

    it("returns empty array when no checkpoints exist", async () => {
      const { tool } = createCheckpointTool({ enabled: true });

      const result = (await tool.execute({ action: "list" })) as { ok: boolean; sessions: string[] };

      expect(result.ok).toBe(true);
      expect(result.sessions).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  describe("delete", () => {
    it("removes checkpoint file and returns { deleted: true }", async () => {
      const { hooks, tool } = createCheckpointTool({ enabled: true });

      await hooks["tool.execute.after"]!(
        makeToolCtx({ sessionID: "to-delete", callID: "c1" }),
        makeResult(),
      );
      flushSession("to-delete");
      expect(existsSync(filePath("to-delete"))).toBe(true);

      const result = (await tool.execute({ action: "delete", sessionID: "to-delete" })) as {
        ok: boolean;
        deleted: boolean;
      };

      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(true);
      expect(existsSync(filePath("to-delete"))).toBe(false);
    });

    it("returns { deleted: false } for nonexistent session", async () => {
      const { tool } = createCheckpointTool({ enabled: true });

      const result = (await tool.execute({ action: "delete", sessionID: "nope" })) as {
        ok: boolean;
        deleted: boolean;
      };

      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Auto-restore via messages.transform
  // -----------------------------------------------------------------------

  describe("auto-restore", () => {
    it("injects reconstructed messages when marker found", async () => {
      const { hooks } = createCheckpointTool({ enabled: true });

      // First create a checkpoint
      await hooks["tool.execute.after"]!(
        makeToolCtx({ sessionID: "auto-ses", callID: "ar1" }),
        makeResult({ output: "auto-result", metadata: { args: { x: 42 } } }),
      );
      flushSession("auto-ses");

      // Now simulate messages with marker
      const messages: Array<{ role: string; content: string }> = [
        { role: "user", content: "do something" },
        { role: "system", content: "<!-- EXTRA_RESTORE: auto-ses -->" },
        { role: "user", content: "continue" },
      ];

      await hooks["experimental.chat.messages.transform"]!({}, { messages });

      // Marker message (sole content → empty after removal) is replaced with restored messages
      // Original: [user, system(marker), user] → after: [user, assistant(restored), user]
      expect(messages.length).toBe(3);
      const assistantMsgs = messages.filter((m) => m.role === "assistant");
      expect(assistantMsgs.length).toBe(1);
      expect(assistantMsgs[0].content).toContain("bash");
      expect(assistantMsgs[0].content).toContain('"auto-result"');
      expect(assistantMsgs[0].content).toContain('{"x":42}');
    });

    it("removes marker but does not inject when checkpoint missing", async () => {
      const { hooks } = createCheckpointTool({ enabled: true });

      const messages: Array<{ role: string; content: string }> = [
        { role: "user", content: "hello <!-- EXTRA_RESTORE: missing --> world" },
      ];

      await hooks["experimental.chat.messages.transform"]!({}, { messages });

      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe("hello  world");
    });

    it("handles multiple messages, only acts on first marker", async () => {
      const { hooks } = createCheckpointTool({ enabled: true });

      // Create checkpoint
      await hooks["tool.execute.after"]!(
        makeToolCtx({ sessionID: "multi", callID: "m1" }),
        makeResult({ output: "m-out" }),
      );
      flushSession("multi");

      const messages: Array<{ role: string; content: string }> = [
        { role: "user", content: "first" },
        { role: "system", content: "<!-- EXTRA_RESTORE: multi -->" },
        { role: "system", content: "<!-- EXTRA_RESTORE: multi -->" },
      ];

      await hooks["experimental.chat.messages.transform"]!({}, { messages });

      // Second marker should be untouched (only first processed)
      expect(messages.some((m) => m.content.includes("EXTRA_RESTORE"))).toBe(true);
      expect(messages.filter((m) => m.role === "assistant").length).toBe(1);
    });

    it("appends restored messages after content when marker is not sole content", async () => {
      const { hooks } = createCheckpointTool({ enabled: true });

      await hooks["tool.execute.after"]!(
        makeToolCtx({ sessionID: "not-sole", callID: "ns1" }),
        makeResult({ output: "partial" }),
      );
      flushSession("not-sole");

      const messages: Array<{ role: string; content: string }> = [
        { role: "user", content: "prefix <!-- EXTRA_RESTORE: not-sole --> suffix" },
      ];

      await hooks["experimental.chat.messages.transform"]!({}, { messages });

      // Marker removed from content, restored messages inserted after
      expect(messages.length).toBe(2);
      expect(messages[0].content).toBe("prefix  suffix");
      expect(messages[1].role).toBe("assistant");
    });
  });

  // -----------------------------------------------------------------------
  // Disabled
  // -----------------------------------------------------------------------

  describe("disabled", () => {
    it("tool returns { skipped: true } when disabled", async () => {
      const { tool } = createCheckpointTool({ enabled: false });

      const result = (await tool.execute()) as { ok: boolean; skipped: boolean; reason: string };
      expect(result).toEqual({ ok: true, skipped: true, reason: "feature disabled" });
    });

    it("tool.execute.after hook is undefined when disabled", () => {
      const { hooks } = createCheckpointTool({ enabled: false });
      expect(hooks["tool.execute.after"]).toBeUndefined();
    });

    it("messages.transform hook is undefined when disabled", () => {
      const { hooks } = createCheckpointTool({ enabled: false });
      expect(hooks["experimental.chat.messages.transform"]).toBeUndefined();
    });

    it("tool.execute with args still returns skipped when disabled", async () => {
      const { tool } = createCheckpointTool({ enabled: false });

      const result = (await tool.execute({ action: "list" })) as {
        ok: boolean;
        skipped: boolean;
        reason: string;
      };
      expect(result).toEqual({ ok: true, skipped: true, reason: "feature disabled" });
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("tool.execute rejects unknown action", async () => {
      const { tool } = createCheckpointTool({ enabled: true });

      const result = (await tool.execute({ action: "unknown" as "list" })) as {
        ok: boolean;
        error: string;
      };
      expect(result.ok).toBe(false);
      expect(result.error).toContain("unknown action");
    });

    it("tool.execute requires action", async () => {
      const { tool } = createCheckpointTool({ enabled: true });

      const result = (await tool.execute({} as { action: string })) as {
        ok: boolean;
        error: string;
      };
      expect(result.ok).toBe(false);
      expect(result.error).toBe("action is required");
    });

    it("restore requires sessionID", async () => {
      const { tool } = createCheckpointTool({ enabled: true });

      const result = (await tool.execute({ action: "restore" })) as {
        ok: boolean;
        error: string;
      };
      expect(result.ok).toBe(false);
      expect(result.error).toBe("sessionID is required for restore");
    });

    it("delete requires sessionID", async () => {
      const { tool } = createCheckpointTool({ enabled: true });

      const result = (await tool.execute({ action: "delete" })) as {
        ok: boolean;
        error: string;
      };
      expect(result.ok).toBe(false);
      expect(result.error).toBe("sessionID is required for delete");
    });

    it("flushSession no-ops on empty buffer", () => {
      const { hooks } = createCheckpointTool({ enabled: true });
      // No tool.execute.after calls — buffer is empty
      flushSession("empty-ses");
      expect(existsSync(filePath("empty-ses"))).toBe(false);
    });

    it("handles malformed lines in JSONL gracefully during read", async () => {
      const { hooks } = createCheckpointTool({ enabled: true });

      await hooks["tool.execute.after"]!(
        makeToolCtx({ sessionID: "malformed", callID: "g1" }),
        makeResult({ output: "good" }),
      );
      flushSession("malformed");

      // Append a malformed line manually
      const { appendFileSync } = await import("node:fs");
      appendFileSync(filePath("malformed"), "not valid json\n", "utf-8");

      const calls = readToolCalls("malformed");
      expect(calls.length).toBe(1);
      expect(calls[0].callID).toBe("g1");
    });

    it("lists only .jsonl files, ignores other extensions", async () => {
      const { tool } = createCheckpointTool({ enabled: true });
      const { writeFileSync } = await import("node:fs");

      // Create a valid checkpoint
      const fp = filePath("valid-ses");
      writeFileSync(
        fp,
        JSON.stringify({ __type: "header", sessionID: "valid-ses", version: 1, createdAt: Date.now(), updatedAt: Date.now() }) + "\n",
        "utf-8",
      );

      // Create a non-jsonl file in the same dir
      writeFileSync(join(tmpDir, "notes.txt"), "hello", "utf-8");

      const result = (await tool.execute({ action: "list" })) as { ok: boolean; sessions: string[] };
      expect(result.ok).toBe(true);
      expect(result.sessions).toContain("valid-ses");
      expect(result.sessions).not.toContain("notes");
    });

    it("result.metadata.args is captured as tool call args", async () => {
      const { hooks } = createCheckpointTool({ enabled: true });

      await hooks["tool.execute.after"]!(
        makeToolCtx({ tool: "grep", sessionID: "grep-ses", callID: "grep-1" }),
        { output: "line1\nline2", metadata: { args: { pattern: "TODO", path: "./src" } } },
      );
      flushSession("grep-ses");

      const calls = readToolCalls("grep-ses");
      expect(calls.length).toBe(1);
      expect(calls[0].tool).toBe("grep");
      expect(calls[0].args).toEqual({ pattern: "TODO", path: "./src" });
    });

    it("args default to {} when metadata is missing", async () => {
      const { hooks } = createCheckpointTool({ enabled: true });

      await hooks["tool.execute.after"]!(
        makeToolCtx({ sessionID: "no-meta-ses", callID: "no-meta" }),
        { output: "done" },
      );
      flushSession("no-meta-ses");

      const calls = readToolCalls("no-meta-ses");
      expect(calls.length).toBe(1);
      expect(calls[0].args).toEqual({});
    });

    it("restore returns empty messages for empty checkpoint", async () => {
      const { tool } = createCheckpointTool({ enabled: true });

      // Manually write header-only file (no tool calls)
      const fp = filePath("empty-cp");
      writeFileSync(
        fp,
        JSON.stringify({
          __type: "header",
          sessionID: "empty-cp",
          version: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }) + "\n",
        "utf-8",
      );

      const result = (await tool.execute({ action: "restore", sessionID: "empty-cp" })) as {
        ok: boolean;
        messages: unknown[];
        toolCallCount: number;
      };

      expect(result.ok).toBe(true);
      expect(result.toolCallCount).toBe(0);
      expect(result.messages).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Custom dir via factory config
  // -----------------------------------------------------------------------

  describe("custom dir", () => {
    it("uses custom dir when provided to createCheckpointTool", async () => {
      const customDir = mkdtempSync(join(tmpdir(), "sffmc-custom-cp-"));
      const { hooks } = createCheckpointTool({ enabled: true, dir: customDir });

      await hooks["tool.execute.after"]!(
        makeToolCtx({ sessionID: "custom-ses", callID: "c1" }),
        makeResult(),
      );
      // flushSession needs the same custom dir passed explicitly since the
      // module-level function doesn't know about the factory's dir
      flushSession("custom-ses", customDir);

      const fp = join(customDir, "custom-ses.jsonl");
      expect(existsSync(fp)).toBe(true);

      const calls = readToolCalls("custom-ses", customDir);
      expect(calls.length).toBe(1);
      expect(calls[0].callID).toBe("c1");

      rmSync(customDir, { recursive: true, force: true });
    });

    it("filePath with dir returns path under custom dir", () => {
      const customDir = "/tmp/sffmc-custom-dir";
      const path = filePath("my-session", customDir);
      expect(path).toBe(join(customDir, "my-session.jsonl"));
    });

    it("falls back to getCheckpointDir when dir not provided to factory", () => {
      // No dir in config — uses getCheckpointDir() which is __setCheckpointDir → tmpDir
      createCheckpointTool({ enabled: true });
      const path = filePath("fallback-ses");
      const expected = join(tmpDir, "fallback-ses.jsonl");
      expect(path).toBe(expected);
    });
  });

  // -----------------------------------------------------------------------
  // Shape contract (for index.ts compatibility)
  // -----------------------------------------------------------------------

  describe("shape contract", () => {
    it("returns { tool, hooks } with expected keys", () => {
      const result = createCheckpointTool({ enabled: false });
      expect(result.tool).toBeDefined();
      expect(result.hooks).toBeDefined();
      expect(result.tool.parameters.type).toBe("object");
      expect(result.tool.parameters.properties.action).toBeDefined();
      expect(result.tool.parameters.properties.sessionID).toBeDefined();
      expect(result.tool.parameters.required).toEqual(["action"]);
      // Regression: no `name` field
      expect((result.tool as Record<string, unknown>).name).toBeUndefined();
    });
  });
});
