import { describe, it, expect } from "bun:test";
import { stripEos, looksLikeEosOnly, DEFAULT_EOS_PATTERNS } from "./patterns";

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
});

describe("Plugin entry", () => {
  it("exports default object with id and server function", async () => {
    const mod = await import("./index");
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("@sffmc/eos-stripper");
    expect(typeof mod.default.server).toBe("function");
  });

  it("server returns expected hooks", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    expect(typeof hooks.config).toBe("function");
    expect(typeof hooks["experimental.text.complete"]).toBe("function");
  });

  it("text.complete strips EOS from end", async () => {
    const mod = await import("./index");
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
    const mod = await import("./index");
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
});
