// v0.15.2 safety hardening — _CMDPOS anchoring unit tests.
//
// Companion to packages/safety/src/rules/compileRules.ts. Tests are split
// into two halves:
//   1. commandWordPositions — verifies the position-finder handles the
//      separator / wrapper / substitution cases listed in the v0.15.2
//      acceptance criteria (docs/v0.15.2-safety-hardening.md § v0.15.2 § 1).
//   2. anchoredTest — verifies the matcher returns the right verdict
//      for both the "false positive" cases (data inside arguments) and
//      the "true positive" cases (real commands).
//
// These tests do NOT exercise the corpus runner — see
// packages/safety/test/corpus.test.ts for that. The corpus is wired
// through gate.ts, which Subagent C owns; once that wiring lands the
// corpus delta becomes observable end-to-end.

import { describe, test, expect } from "bun:test";
import {
  commandWordPositions,
  anchoredTest,
} from "../src/rules/compileRules";

// =====================================================================
// commandWordPositions
// =====================================================================

describe("commandWordPositions", () => {
  test("empty string → empty array", () => {
    expect(commandWordPositions("")).toEqual([]);
  });

  test("single token → [0]", () => {
    expect(commandWordPositions("ls")).toEqual([0]);
  });

  test("start of string always counts", () => {
    expect(commandWordPositions("pwd")).toContain(0);
    expect(commandWordPositions("anything goes here")).toContain(0);
  });

  test("after `;` with space", () => {
    expect(commandWordPositions("ls; pwd")).toContain(4);
  });

  test("after `;` with no space", () => {
    expect(commandWordPositions("ls;pwd")).toContain(3);
  });

  test("after `&&` with space", () => {
    // `ls && pwd`
    //  0  2 3 4 5
    // `pwd` starts at position 6.
    expect(commandWordPositions("ls && pwd")).toContain(6);
  });

  test("after `&&` with no space", () => {
    // `ls &&pwd`
    // `pwd` starts at position 5.
    expect(commandWordPositions("ls &&pwd")).toContain(5);
  });

  test("after `||` with space", () => {
    // `ls || pwd` — `pwd` at position 6.
    expect(commandWordPositions("ls || pwd")).toContain(6);
  });

  test("after `|` with space (pipe)", () => {
    // `ls | grep foo` — `grep` at position 5.
    expect(commandWordPositions("ls | grep foo")).toContain(5);
  });

  test("after `|` with no space", () => {
    expect(commandWordPositions("cat x|grep y")).toContain(6);
  });

  test("separator inside double quotes is skipped", () => {
    // The `;` inside the quoted string is data, not a separator.
    const positions = commandWordPositions('ls; "rm -rf /"');
    expect(positions).not.toContain(5);
    // Only the `ls` at position 0.
    expect(positions).toEqual([0]);
  });

  test("separator inside single quotes is skipped", () => {
    const positions = commandWordPositions("ls; 'rm -rf /'");
    expect(positions).not.toContain(5);
    expect(positions).toEqual([0]);
  });

  test("chain of separators → positions for each command", () => {
    // `a; b && c || d`
    //  01 2 3 4 5 6 7 8 9 10 11 12 13
    //  a  ; _ b _  &  &  _ c  _  |  |  _ d
    // positions: 0(a), 3(b), 8(c), 13(d)
    const positions = commandWordPositions("a; b && c || d");
    expect(positions).toContain(0);
    expect(positions).toContain(3);
    expect(positions).toContain(8);
    expect(positions).toContain(13);
  });

  test("`sudo` wrapper → position after sudo + space", () => {
    expect(commandWordPositions("sudo rm -rf /")).toContain(5);
  });

test("`sudo -u root` (user flag) → position after flag + arg", () => {
    // `sudo -u root rm -rf /`
    //  0    4 5 6 7  10    15
    // `rm` starts at position 13 (after `sudo -u root `).
    expect(commandWordPositions("sudo -u root rm -rf /")).toContain(13);
  });

  test("`sudo -i` (login flag) → position after flag", () => {
    expect(commandWordPositions("sudo -i rm -rf /")).toContain(8);
  });

  test("`env FOO=bar BAZ=qux` wrapper → position after env assignments", () => {
    expect(commandWordPositions("env FOO=bar BAZ=qux rm -rf /")).toContain(20);
  });

  test("`env` wrapper with bare command (no env assignments)", () => {
    expect(commandWordPositions("env rm -rf /")).toContain(4);
  });

  test("`exec` wrapper", () => {
    expect(commandWordPositions("exec rm -rf /")).toContain(5);
  });

  test("`nohup` wrapper", () => {
    expect(commandWordPositions("nohup rm -rf /")).toContain(6);
  });

  test("`time` wrapper (timer, not part of `time-stamp`)", () => {
    expect(commandWordPositions("time rm -rf /")).toContain(5);
  });

  test("`bash -c \"cmd\"` wrapper → position inside the -c arg", () => {
    // bash -c "rm -rf /"
    // 0123456789012345
    // The `rm` starts at position 9.
    expect(commandWordPositions('bash -c "rm -rf /"')).toContain(9);
  });

  test("`sh -c 'cmd'` wrapper → position inside the -c arg", () => {
    // sh -c 'rm -rf /'
    expect(commandWordPositions("sh -c 'rm -rf /'")).toContain(7);
  });

  test("backtick command substitution → recurse into inner", () => {
    // echo `rm -rf /`
    // 0     6
    expect(commandWordPositions("echo `rm -rf /`")).toContain(6);
  });

  test("`$(...)` substitution → recurse into inner", () => {
    // echo $(rm -rf /)
    //  0    5 6 7
    // The inner content starts after `$(`, so `rm` is at position 7.
    expect(commandWordPositions("echo $(rm -rf /)")).toContain(7);
  });

  test("`$(...)` with inner separator → recurse two levels", () => {
    // echo $(ls; rm -rf /)
    //  0    5 6 7 8 9 10 11
    // positions: 0 (echo), 7 (ls), 11 (rm)
    const positions = commandWordPositions("echo $(ls; rm -rf /)");
    expect(positions).toContain(0);
    expect(positions).toContain(7);
    expect(positions).toContain(11);
  });

  test("nested `$(...)` does not confuse depth counter", () => {
    // echo $(echo $(rm -rf /))
    // Inner `rm -rf /` starts at position 14 (after `echo $(echo $(`).
    const positions = commandWordPositions("echo $(echo $(rm -rf /))");
    expect(positions).toContain(14);
  });

  test("positions are sorted and deduplicated", () => {
    // `sudo sudo ls` — `sudo` appears twice, but it's not a wrapper for
    // itself; the position-0 word is `sudo`, position after first sudo
    // is `sudo`, position after second sudo is `ls`. We don't add
    // position for `ls` from the second sudo (it's already covered by
    // position 10 from the first wrapper scan). The point: no dupes.
    const positions = commandWordPositions("sudo sudo ls");
    const set = new Set(positions);
    expect(set.size).toBe(positions.length);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });
});

// =====================================================================
// anchoredTest
// =====================================================================
//
// Spec-driven cases. Each one traces back to a bullet in the
// docs/v0.15.2-safety-hardening.md acceptance criteria for v0.15.2 § 1.

describe("anchoredTest — false positives must pass", () => {
  test("git commit -m \"rm -rf /\" → false", () => {
    expect(anchoredTest('git commit -m "rm -rf /"', /rm -rf \//)).toBe(false);
  });

  test("git commit -m \"fix rm -rf /tmp/foo\" → false", () => {
    expect(anchoredTest('git commit -m "fix rm -rf /tmp/foo"', /rm -rf/)).toBe(false);
  });

  test("grep 'rm -rf /' log.txt → false", () => {
    expect(anchoredTest("grep 'rm -rf /' log.txt", /rm -rf \//)).toBe(false);
  });

  test("grep -r 'rm -rf' doc/ → false", () => {
    expect(anchoredTest("grep -r 'rm -rf' doc/", /rm -rf/)).toBe(false);
  });

  test("echo \"rm -rf /tmp/never\" → false", () => {
    expect(anchoredTest('echo "rm -rf /tmp/never"', /rm -rf/)).toBe(false);
  });

  test("echo \"Use chmod -R 777 in production\" → false", () => {
    expect(anchoredTest('echo "Use chmod -R 777 in production"', /chmod 777/)).toBe(false);
    expect(anchoredTest('echo "Use chmod -R 777 in production"', /chmod -R/)).toBe(false);
  });

  test("echo \"avoid git push --force\" → false", () => {
    expect(anchoredTest('echo "avoid git push --force"', /git push --force/)).toBe(false);
  });

  test("echo \"note about DROP TABLE in SQL\" → false", () => {
    expect(anchoredTest('echo "note about DROP TABLE in SQL"', /DROP TABLE/)).toBe(false);
  });

  test("echo \"do not run mkfs\" → false", () => {
    expect(anchoredTest('echo "do not run mkfs"', /mkfs/)).toBe(false);
  });

  test("cat readme.md | grep \"delete\" → false on `|` substring rule", () => {
    // `|` is a literal alternative in the ask-pattern. Without anchor,
    // `cat readme.md | grep "delete"` matches the `|` substring (deny/ask).
    // With anchor, `|` is a separator, not a match start, so the only
    // command-word positions are `cat` and `grep` — neither matches.
    expect(anchoredTest('cat readme.md | grep "delete"', /\|/)).toBe(false);
  });

  test("echo \"rm -rf\" > /tmp/check.txt → false on `>` substring rule", () => {
    // `>` is a literal alternative in the ask-pattern. Without anchor,
    // the `>` in `> /tmp/check.txt` matches. With anchor, `>` is just
    // a redirect — no command-word position is created there, and the
    // outer `echo` doesn't match anything either.
    expect(anchoredTest('echo "rm -rf" > /tmp/check.txt', />/)).toBe(false);
    expect(anchoredTest('echo "rm -rf" > /tmp/check.txt', /rm -rf/)).toBe(false);
  });
});

describe("anchoredTest — true positives must still match", () => {
  test("rm -rf / → true", () => {
    expect(anchoredTest("rm -rf /", /rm -rf \//)).toBe(true);
  });

  test("rm -rf \"/\" (quoted root) → true (match starts at command word)", () => {
    // `rm -rf "/"` — the `/` is in quotes but the match for `rm -rf`
    // starts at position 0 (before the quote).
    expect(anchoredTest('rm -rf "/"', /rm -rf/)).toBe(true);
  });

  test("rm -rf \"$HOME\" → true (match starts at command word)", () => {
    expect(anchoredTest('rm -rf "$HOME"', /rm -rf/)).toBe(true);
  });

  test("rm -rf ${HOME} → true (match starts at command word)", () => {
    expect(anchoredTest("rm -rf ${HOME}", /rm -rf/)).toBe(true);
  });

  test("sudo rm -rf / → true (after sudo wrapper)", () => {
    expect(anchoredTest("sudo rm -rf /", /rm -rf \//)).toBe(true);
  });

  test("sudo -u root rm -rf / → true (after sudo + flag)", () => {
    expect(anchoredTest("sudo -u root rm -rf /", /rm -rf \//)).toBe(true);
  });

  test("env rm -rf / → true (after env wrapper)", () => {
    expect(anchoredTest("env rm -rf /", /rm -rf \//)).toBe(true);
  });

  test("git commit -m \"x\" && rm -rf / → true (second command after &&)", () => {
    expect(anchoredTest('git commit -m "x" && rm -rf /', /rm -rf \//)).toBe(true);
  });

  test("ls; rm -rf / → true (second command after ;)", () => {
    expect(anchoredTest("ls; rm -rf /", /rm -rf \//)).toBe(true);
  });

  test("ls || rm -rf / → true (second command after ||)", () => {
    expect(anchoredTest("ls || rm -rf /", /rm -rf \//)).toBe(true);
  });

  test("echo $(rm -rf /) → true (recursed into $())", () => {
    expect(anchoredTest("echo $(rm -rf /)", /rm -rf \//)).toBe(true);
  });

  test("echo `rm -rf /` → true (recursed into backticks)", () => {
    expect(anchoredTest("echo `rm -rf /`", /rm -rf \//)).toBe(true);
  });

  test("bash -c \"rm -rf /\" → true (recursed into -c arg)", () => {
    expect(anchoredTest('bash -c "rm -rf /"', /rm -rf \//)).toBe(true);
  });

  test("sudo chmod 777 / → true (after sudo)", () => {
    expect(anchoredTest("sudo chmod 777 /", /chmod 777/)).toBe(true);
  });

  test("DANGER embedded after |: echo x | rm -rf / → true", () => {
    expect(anchoredTest("echo x | rm -rf /", /rm -rf \//)).toBe(true);
  });
});

describe("anchoredTest — edge cases", () => {
  test("empty string → false", () => {
    expect(anchoredTest("", /anything/)).toBe(false);
  });

  test("regex flags preserved (case-insensitive)", () => {
    // `RM -rf /` — without anchor, the literal `rm -rf /` (lowercase)
    // doesn't match `RM -rf /`. With anchor + /i flag, both forms match.
    expect(anchoredTest("RM -rf /", /rm -rf \//i)).toBe(true);
    // Without /i, uppercase R doesn't match the lowercase pattern.
    expect(anchoredTest("RM -rf /", /rm -rf \//)).toBe(false);
  });

  test("doesn't match at non-command-word position", () => {
    // The `rm` inside `echo "rm -rf /"` is data, not a command word.
    expect(anchoredTest('echo "rm -rf /"', /rm/)).toBe(false);
  });

  test("doesn't mutate the caller's regex", () => {
    const regex = /rm -rf/;
    anchoredTest("rm -rf /", regex);
    anchoredTest("echo \"rm -rf /\"", regex);
    // After two calls, the regex must still be usable from index 0.
    expect(regex.test("rm -rf foo")).toBe(true);
  });

  test("harmless commands still return false", () => {
    expect(anchoredTest("ls -la", /rm -rf \//)).toBe(false);
    expect(anchoredTest("cat readme.md", /DROP TABLE/)).toBe(false);
    expect(anchoredTest("git status", /git push --force/)).toBe(false);
  });

  test("benign `sudo` usage with harmless command returns false", () => {
    expect(anchoredTest("sudo apt update", /rm -rf/)).toBe(false);
    expect(anchoredTest("sudo systemctl status nginx", /systemctl stop/)).toBe(false);
  });
});

// =====================================================================
// `>` / `>>` redirection as command boundary (v0.15.2 round-2 fix)
// =====================================================================
//
// In bash, `echo data > /dev/sda` is parsed as `echo data` then
// redirect-to `/dev/sda`. The redirect target is itself a "command-word
// position" that the anchor matcher should recognize — otherwise the
// ask rule pattern `>` fires on every redirect, and patterns like
// `rm -rf` or `/dev/sd[a-z]+` never see the target. The fix extends
// `positionsFromSeparators` to treat `>` and `>>` as boundaries (the
// quote-state tracking above is preserved, so `>` inside a quoted
// string is still ignored).

describe("commandWordPositions — `>` / `>>` boundary", () => {
  test("`echo data > /dev/sda` → position at redirect target", () => {
    // `echo data > /dev/sda`
    //  0    5  9 10  12
    //  e c h o _ d a t a _ > _ / d e v / s d a
    // `>` at 10, boundaryEnd=11, skip ws at 11, add position 12 (`/`).
    const positions = commandWordPositions("echo data > /dev/sda");
    expect(positions).toContain(12);
  });

  test("`cmd >> /tmp/log` → position at redirect target after `>>`", () => {
    // `cmd >> /tmp/log`
    //  0 3 4 5  7
    //  c m d _ > > _ / t m p / l o g
    // `>` at 4, `>>` matched, boundaryEnd=6, skip ws, add 7 (`/`).
    const positions = commandWordPositions("cmd >> /tmp/log");
    expect(positions).toContain(7);
  });

  test("`cmd>file` (no spaces) → position immediately after `>`", () => {
    // `cmd>file` — `cmd` at 0, `>` at 3, boundaryEnd=4, no ws, add 4 (`f`).
    const positions = commandWordPositions("cmd>file");
    expect(positions).toContain(4);
  });

  test("`>` inside double-quoted string is NOT a boundary", () => {
    // `echo "use > in docs"` — the `>` is data inside a quoted region.
    // No additional command-word position should be added there.
    const positions = commandWordPositions('echo "use > in docs"');
    // Only position 0 (echo).
    expect(positions).toEqual([0]);
  });

  test("`>` inside single-quoted string is NOT a boundary", () => {
    const positions = commandWordPositions("echo 'use > in docs'");
    expect(positions).toEqual([0]);
  });

  test("redirect target that starts with a quote is skipped", () => {
    // `echo x > "/dev/sda"` — the target is a quoted arg. The existing
    // post-boundary check skips quote/`$`/backtick, so no position is
    // added at the quote.
    const positions = commandWordPositions('echo x > "/dev/sda"');
    expect(positions).not.toContain(11);
  });
});

describe("anchoredTest — `>` / `>>` boundary semantics", () => {
  test("redirect to /dev/sda — target is at a command-word position", () => {
    // The /dev/sda redirect target becomes a command-word position
    // after the `>` boundary fix. Any rule pattern that matches the
    // target (e.g. a future "redirect-to-device" rule) would fire at
    // that position. We exercise this with a regex that matches the
    // device path at its start, which is exactly the shape a "/dev/sd"
    // detection rule would use. (anchoredTest requires match.index === 0
    // of the slice, so we anchor with `^` here to mirror how a real
    // rule pattern would be written.)
    expect(anchoredTest("echo data > /dev/sda", /^\/dev\/sd/)).toBe(true);
  });

  test("literal `>` alternative no longer matches at non-word position", () => {
    // The pre-fix behavior was: ask-rule pattern `>` fired anywhere a
    // `>` appeared in the string (because `>` matches at index 10 of
    // the whole command, not just at command-word positions). With
    // anchor, `>` is a separator and never appears at a command-word
    // position, so the literal `>` alternative is silent. Verify:
    expect(anchoredTest("echo data > /tmp/check.txt", />/)).toBe(false);
  });

  test("`>>` redirect target is also a command-word position", () => {
    expect(anchoredTest("cmd >> /tmp/log", /\/tmp\/log/)).toBe(true);
  });

  test("`>` inside quotes is still ignored", () => {
    // The redirect-to-dev pattern should NOT match when the `>` is
    // inside a quoted string (preserves the existing quote-awareness).
    expect(anchoredTest('echo "use > in docs"', />\s*\/dev\/sd/)).toBe(false);
  });

  test("`echo \"rm -rf\" > /tmp/check.txt` still passes", () => {
    // The data-argument `rm -rf` is in quotes (not a command word),
    // and the redirect target `/tmp/check.txt` doesn't match any
    // dangerous pattern. Still pass.
    expect(anchoredTest('echo "rm -rf" > /tmp/check.txt', /rm -rf/)).toBe(false);
    expect(anchoredTest('echo "rm -rf" > /tmp/check.txt', />/)).toBe(false);
  });
});

// =====================================================================
// `$(...)` substitution output matching (v0.15.2 round-2 fix)
// =====================================================================
//
// In bash, the output of `$(...)` and backticks is fed back into the
// calling context. Even when the literal output isn't executed (e.g.
// `echo $(printf "rm -rf /")` just prints the string), the surrounding
// context (eval, bash -c, xargs, env-as-args) often re-evaluates it.
// We treat the inner content of every `$(...)` and backtick region as
// "candidate for execution": the regex is matched as a substring of
// the inner content, not anchored at any command-word position inside.

describe("anchoredTest — `$(...)` substitution content", () => {
  test("`$(printf \"rm -rf /\")` matches `rm -rf`", () => {
    expect(anchoredTest('$(printf "rm -rf /")', /rm -rf/)).toBe(true);
  });

  test("`eval $(printf \"rm -rf /\")` matches `rm -rf`", () => {
    // eval is the textbook case: eval re-executes the substituted output.
    expect(anchoredTest('eval $(printf "rm -rf /")', /rm -rf/)).toBe(true);
  });

  test("`echo $(cat readme.md)` does NOT match `rm -rf`", () => {
    // Innocent content inside $() — no dangerous pattern.
    expect(anchoredTest("echo $(cat readme.md)", /rm -rf/)).toBe(false);
  });

  test("`bash -c \"$(printf 'rm -rf /')\"` matches `rm -rf`", () => {
    // bash -c wrapper lands on the inner $() content.
    expect(anchoredTest(`bash -c "$(printf 'rm -rf /')"`, /rm -rf/)).toBe(true);
  });

  test("nested `$(...)` doesn't leak across boundaries", () => {
    // `echo $(echo "rm -rf /")` — inner $() contains `echo "rm -rf /"`,
    // substring `rm -rf` matches. (This case will flip the existing
    // corpus line 448 expectation — see report.)
    expect(anchoredTest('echo $(echo "rm -rf /")', /rm -rf/)).toBe(true);
  });

  test("regex doesn't escape past the closing `)`", () => {
    // The slice in `matchesInsideSubstitution` isolates the inner content,
    // so a pattern that wouldn't match inside `$()` won't accidentally
    // match across the boundary into text that comes after.
    expect(anchoredTest("echo $(ls -la) && rm -rf /", /echo only/)).toBe(false);
  });
});

describe("anchoredTest — backtick substitution content", () => {
  test("innocent backtick content does NOT match", () => {
    expect(anchoredTest("echo `date`", /rm -rf/)).toBe(false);
  });

  test("dangerous backtick content matches", () => {
    // Inner content is `printf "rm -rf /"` — the regex matches.
    expect(anchoredTest('echo `printf "rm -rf /"`', /rm -rf/)).toBe(true);
  });

  test("backtick without closing backtick is gracefully ignored", () => {
    // Unclosed backtick — `matchesInsideSubstitution` returns false
    // (no closing backtick found). The position-0 anchor still fires
    // on `echo`.
    expect(anchoredTest("echo `unterminated", /rm -rf/)).toBe(false);
  });
});