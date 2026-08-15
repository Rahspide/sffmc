// v0.15.2 safety hardening — `normalizeCommand` unit tests.
//
// Pure-function tests for the four obfuscation layers the rule engine
// needs to peel off before regex matching:
//   - NFKC Unicode normalization (fullwidth → ASCII)
//   - Null-byte stripping
//   - Shell line-continuation joining
//   - ANSI / OSC escape stripping
//
// These tests do NOT exercise the corpus runner — see
// packages/safety/test/corpus.test.ts for end-to-end coverage. The
// corpus is wired through `gate.ts`, which Subagent C owns; this file
// validates the normalizer in isolation so the integration phase has
// one less unknown.

import { describe, test, expect } from "bun:test";
import { normalizeCommand } from "../src/rules/normalize";

// =====================================================================
// A. ANSI / OSC stripping
// =====================================================================

describe("normalizeCommand — ANSI / OSC stripping", () => {
  test("CSI color codes (foreground red)", () => {
    expect(normalizeCommand("\x1b[31mrm -rf /\x1b[0m")).toBe("rm -rf /");
  });

  test("CSI multiple parameters (bold red)", () => {
    expect(normalizeCommand("\x1b[1;31mrm -rf /tmp/x\x1b[0m")).toBe(
      "rm -rf /tmp/x",
    );
  });

  test("ANSI inside double-quoted arg", () => {
    expect(normalizeCommand('echo -e "\x1b[31mrm -rf /\x1b[0m"')).toBe(
      'echo -e "rm -rf /"',
    );
  });

  test("CSI 256-color (\x1b[38;5;208m orange)", () => {
    expect(normalizeCommand("\x1b[38;5;208mrm -rf /\x1b[0m")).toBe(
      "rm -rf /",
    );
  });

  test("OSC title bar (BEL-terminated)", () => {
    expect(normalizeCommand("\x1b]0;malicious title\x07")).toBe("");
  });

  test("OSC + payload", () => {
    expect(normalizeCommand("\x1b]0;title\x07rm -rf /")).toBe("rm -rf /");
  });

  test("OSC with ST terminator (ESC \\)", () => {
    expect(normalizeCommand("\x1b]0;title\x1b\\rm -rf /")).toBe("rm -rf /");
  });

  test("Multiple stacked CSI sequences", () => {
    expect(normalizeCommand("\x1b[31m\x1b[1mr\x1b[0mm -rf /")).toBe(
      "rm -rf /",
    );
  });

  test("Reset code in the middle", () => {
    expect(normalizeCommand("rm\x1b[0m -rf /")).toBe("rm -rf /");
  });

  test("Cursor-move sequences (\\x1b[2J clear, \\x1b[H home)", () => {
    expect(normalizeCommand("\x1b[2Jrm -rf /\x1b[H")).toBe("rm -rf /");
  });

  test("Bold + underline combo", () => {
    expect(normalizeCommand("\x1b[1;4mrm -rf /\x1b[0m")).toBe("rm -rf /");
  });

  test("Empty CSI params (\x1b[m is a synonym for reset)", () => {
    expect(normalizeCommand("\x1b[mrm -rf /\x1b[m")).toBe("rm -rf /");
  });
});

// =====================================================================
// B. Null-byte stripping
// =====================================================================

describe("normalizeCommand — null-byte stripping", () => {
  test("single null in the middle", () => {
    expect(normalizeCommand("rm\x00 -rf /")).toBe("rm -rf /");
  });

  test("single null inside a word", () => {
    expect(normalizeCommand('echo\x00 "x"')).toBe('echo "x"');
  });

  test("multiple nulls inside a word", () => {
    expect(normalizeCommand("r\x00m\x00 -rf /")).toBe("rm -rf /");
  });

  test("leading null", () => {
    expect(normalizeCommand("\x00rm -rf /")).toBe("rm -rf /");
  });

  test("trailing null", () => {
    expect(normalizeCommand("rm -rf /\x00")).toBe("rm -rf /");
  });

  test("string of only nulls", () => {
    expect(normalizeCommand("\x00\x00\x00")).toBe("");
  });
});

// =====================================================================
// C. NFKC Unicode normalization
// =====================================================================

describe("normalizeCommand — NFKC normalization", () => {
  test("fullwidth lowercase (ｒｍ)", () => {
    expect(normalizeCommand("ｒｍ -rf /")).toBe("rm -rf /");
  });

  test("fullwidth uppercase (ＲＭ)", () => {
    expect(normalizeCommand("ＲＭ -RF /")).toBe("RM -RF /");
  });

  test("fullwidth `bash`", () => {
    expect(normalizeCommand('ｂａｓｈ -c "rm -rf /"')).toBe(
      'bash -c "rm -rf /"',
    );
  });

  test("fullwidth `CHMOD`", () => {
    expect(normalizeCommand("ＣＨＭＯＤ 777 foo")).toBe("CHMOD 777 foo");
  });

  test("fullwidth `MKFS`", () => {
    expect(normalizeCommand("ＭＫＦＳ /dev/sda")).toBe("MKFS /dev/sda");
  });

  test("preserves café (already NFKC)", () => {
    expect(normalizeCommand("café")).toBe("café");
  });

  test("preserves naïve (ï is preserved by NFKC)", () => {
    expect(normalizeCommand("naïve")).toBe("naïve");
  });

  test("preserves über (ü is preserved by NFKC)", () => {
    expect(normalizeCommand("über")).toBe("über");
  });

  test("ASCII unchanged", () => {
    expect(normalizeCommand("DROP TABLE users")).toBe("DROP TABLE users");
  });

  test("empty string stays empty", () => {
    expect(normalizeCommand("")).toBe("");
  });
});

// =====================================================================
// D. Line-continuation stripping
// =====================================================================

describe("normalizeCommand — line-continuation stripping", () => {
  test("basic `\\\n` join", () => {
    expect(normalizeCommand("rm -rf \\\n/")).toBe("rm -rf /");
  });

  test("continuation inside a chained command", () => {
    expect(normalizeCommand('echo "x" \\\n; rm -rf /')).toBe(
      'echo "x" ; rm -rf /',
    );
  });

  test("multiple continuations in one command", () => {
    expect(normalizeCommand("cmd1 \\\n; cmd2 \\\n; cmd3")).toBe(
      "cmd1 ; cmd2 ; cmd3",
    );
  });

  test("CRLF line ending (Windows style)", () => {
    expect(normalizeCommand("rm -rf \\\r\n/")).toBe("rm -rf /");
  });

  test("no continuation → no change", () => {
    expect(normalizeCommand("rm -rf /")).toBe("rm -rf /");
  });

  test("continuation that splits a flag from its argument", () => {
    expect(normalizeCommand("ls \\\n-la")).toBe("ls -la");
  });
});

// =====================================================================
// E. Combined transformations
// =====================================================================

describe("normalizeCommand — combined obfuscations", () => {
  test("ANSI + null + payload", () => {
    expect(normalizeCommand('printf "\x1b[31m\x00rm -rf /\x1b[0m"')).toBe(
      'printf "rm -rf /"',
    );
  });

  test("fullwidth + null + line-continuation", () => {
    // Runtime: ＲＭ<NUL> -rf \<LF>/  (the trailing `\<newline>` is the
    // shell line-continuation the spec strips).
    expect(normalizeCommand("ＲＭ\x00 -rf \\\n/")).toBe("RM -rf /");
  });

  test("ANSI inside single-quoted arg + null", () => {
    expect(normalizeCommand("printf '\x1b[31mrm\x00-rf /\x1b[0m'")).toBe(
      "printf 'rm-rf /'",
    );
  });

  test("fullwidth + ANSI", () => {
    expect(normalizeCommand("\x1b[31mＲＭ -rf /\x1b[0m")).toBe("RM -rf /");
  });

  test("every layer stacked", () => {
    // Runtime: r<NUL>m<ESC>[31m -rf \<LF>/<ESC>[0m
    expect(
      normalizeCommand("r\x00m\x1b[31m -rf \\\n/\x1b[0m"),
    ).toBe("rm -rf /");
  });
});

// =====================================================================
// F. Negative cases — must NOT mutate legitimate commands
// =====================================================================

describe("normalizeCommand — negative cases (must not mutate)", () => {
  test("plain `rm -rf /` (a command the gate will still deny)", () => {
    expect(normalizeCommand("rm -rf /")).toBe("rm -rf /");
  });

  test("`chmod 755 file` (legitimate mode change)", () => {
    expect(normalizeCommand("chmod 755 file")).toBe("chmod 755 file");
  });

  test("`git commit -m` with rm in the message body", () => {
    expect(normalizeCommand('git commit -m "fix rm -rf"')).toBe(
      'git commit -m "fix rm -rf"',
    );
  });

  test("`echo hello world`", () => {
    expect(normalizeCommand("echo hello world")).toBe("echo hello world");
  });

  test("`ls -la /tmp`", () => {
    expect(normalizeCommand("ls -la /tmp")).toBe("ls -la /tmp");
  });

  test("`cat file.txt | grep \"rm -rf\"` (data inside argument)", () => {
    expect(normalizeCommand('cat file.txt | grep "rm -rf"')).toBe(
      'cat file.txt | grep "rm -rf"',
    );
  });
});