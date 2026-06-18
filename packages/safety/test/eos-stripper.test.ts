import { describe, it, expect } from "bun:test";
import { stripEos, looksLikeEosOnly, DEFAULT_EOS_PATTERNS } from "../../eos-stripper/src/patterns";

describe("stripEos", () => {
  it("strips single EOS token from end", () => {
    expect(stripEos("hello world</s>", DEFAULT_EOS_PATTERNS)).toBe("hello world");
  });

  it("strips multiple EOS tokens from end", () => {
    expect(
      stripEos("result</s><|im_end|>", DEFAULT_EOS_PATTERNS),
    ).toBe("result");
  });

  it("does not strip EOS from middle", () => {
    const input = "use </s> to end the sequence in llama.cpp";
    expect(stripEos(input, DEFAULT_EOS_PATTERNS)).toBe(input);
  });

  it("strips whitespace-padded EOS", () => {
    expect(stripEos("output  </s>", DEFAULT_EOS_PATTERNS)).toBe("output");
  });

  it("handles empty string", () => {
    expect(stripEos("", DEFAULT_EOS_PATTERNS)).toBe("");
  });

  it("handles text that is only EOS tokens", () => {
    expect(stripEos("</s><|im_end|>", DEFAULT_EOS_PATTERNS)).toBe("");
  });

  it("handles <|eot_id|> pattern", () => {
    expect(stripEos("result<|eot_id|>", DEFAULT_EOS_PATTERNS)).toBe("result");
  });

  it("handles [/INST] pattern", () => {
    expect(stripEos("output[/INST]", DEFAULT_EOS_PATTERNS)).toBe("output");
  });

  it("handles custom patterns", () => {
    const custom = ["<EOS>", "###END###"];
    expect(stripEos("done<EOS>", custom)).toBe("done");
    expect(stripEos("done###END###<EOS>", custom)).toBe("done");
  });

  it("strips multiple identical EOS tokens from end", () => {
    expect(stripEos("result</s></s></s>", DEFAULT_EOS_PATTERNS)).toBe("result");
  });

  it("preserves EOS in middle while stripping trailing EOS", () => {
    expect(
      stripEos("use </s> to end</s>", DEFAULT_EOS_PATTERNS),
    ).toBe("use </s> to end");
  });

  it("handles input that is only whitespace", () => {
    expect(stripEos("   \t\n  ", DEFAULT_EOS_PATTERNS)).toBe("");
  });

  it("handles mixed known and unknown tokens at end", () => {
    // Only known patterns stripped from end; unknown tokens remain
    // </s> is in the middle, <unknown> at end — neither stripped since
    // <unknown> is not a known EOS pattern and </s> is not at end
    expect(stripEos("hello</s><unknown>", DEFAULT_EOS_PATTERNS)).toBe("hello</s><unknown>");
    // But when known EOS is at end alongside unknown, known is stripped
    expect(stripEos("hello<unknown></s>", DEFAULT_EOS_PATTERNS)).toBe("hello<unknown>");
  });

  it("handles newline before EOS", () => {
    expect(stripEos("output\n</s>", DEFAULT_EOS_PATTERNS)).toBe("output");
  });

  it("handles <|end_of_turn|> pattern", () => {
    expect(stripEos("done<|end_of_turn|>", DEFAULT_EOS_PATTERNS)).toBe("done");
  });

  it("handles <end_of_utterance> pattern", () => {
    expect(stripEos("text<end_of_utterance>", DEFAULT_EOS_PATTERNS)).toBe("text");
  });
});

describe("looksLikeEosOnly", () => {
  it("returns true for EOS-only text", () => {
    expect(looksLikeEosOnly("</s>", DEFAULT_EOS_PATTERNS)).toBe(true);
    expect(looksLikeEosOnly("</s><|im_end|>", DEFAULT_EOS_PATTERNS)).toBe(true);
  });

  it("returns true for EOS with whitespace", () => {
    expect(looksLikeEosOnly("  </s>  ", DEFAULT_EOS_PATTERNS)).toBe(true);
  });

  it("returns false for mixed content", () => {
    expect(looksLikeEosOnly("hello</s>", DEFAULT_EOS_PATTERNS)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(looksLikeEosOnly("", DEFAULT_EOS_PATTERNS)).toBe(false);
  });

  it("returns false for whitespace-only string", () => {
    expect(looksLikeEosOnly("   \t\n  ", DEFAULT_EOS_PATTERNS)).toBe(false);
  });

  it("returns true for single EOS token with surrounding whitespace", () => {
    expect(looksLikeEosOnly("  <|im_end|>  ", DEFAULT_EOS_PATTERNS)).toBe(true);
  });

  it("returns false for EOS embedded in word", () => {
    expect(looksLikeEosOnly("hello</s>world", DEFAULT_EOS_PATTERNS)).toBe(false);
  });

  it("returns true for multiple mixed EOS tokens", () => {
    expect(looksLikeEosOnly("</s><|im_end|><|eot_id|>[/INST]", DEFAULT_EOS_PATTERNS)).toBe(true);
  });
});

describe("Plugin entry", () => {
  it("exports default object with id and server function", async () => {
    const mod = await import("../../eos-stripper/src/index");
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("@sffmc/eos-stripper");
    expect(typeof mod.default.server).toBe("function");
  });

  it("server returns expected hooks", async () => {
    const mod = await import("../../eos-stripper/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    expect(typeof hooks["experimental.text.complete"]).toBe("function");
  });

  it("text.complete strips EOS from end", async () => {
    const mod = await import("../../eos-stripper/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const data = { text: "hello world</s>" };
    await hooks["experimental.text.complete"]!(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      data,
    );
    expect(data.text).toBe("hello world");
  });

  it("text.complete replaces EOS-only text with empty", async () => {
    const mod = await import("../../eos-stripper/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const data = { text: "</s><|im_end|>" };
    await hooks["experimental.text.complete"]!(
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      data,
    );
    expect(data.text).toBe("");
  });

  it("text.complete ignores text with no EOS tokens", async () => {
    const mod = await import("../../eos-stripper/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const data = { text: "clean output with no tokens" };
    await hooks["experimental.text.complete"]!(
      { sessionID: "s1", messageID: "m2", partID: "p1" },
      data,
    );
    expect(data.text).toBe("clean output with no tokens");
  });

  it("text.complete preserves EOS tokens in the middle of text", async () => {
    const mod = await import("../../eos-stripper/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const data = { text: "call </s> to stop generation" };
    await hooks["experimental.text.complete"]!(
      { sessionID: "s1", messageID: "m3", partID: "p1" },
      data,
    );
    expect(data.text).toBe("call </s> to stop generation");
  });

  it("text.complete handles whitespace-only EOS", async () => {
    const mod = await import("../../eos-stripper/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const data = { text: "  </s>  <|im_end|>  " };
    await hooks["experimental.text.complete"]!(
      { sessionID: "s1", messageID: "m4", partID: "p1" },
      data,
    );
    expect(data.text).toBe("");
  });
});
