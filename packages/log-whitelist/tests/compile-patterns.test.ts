import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { compilePatterns } from "../src/index";

// Silence the package logger's `console.warn` calls so test output stays clean.
// `compilePatterns` calls `log.warn(...)` for both ReDoS rejections and
// invalid-regex catches — the test assertions cover behaviour, not stderr.
let warnSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy?.mockRestore();
});

describe("compilePatterns — ReDoS guard", () => {
  it("skips a catastrophically-backtracking whitelist pattern", () => {
    const out = compilePatterns(["^(a+)+$"]);
    // Pattern must NOT be compiled — would otherwise hang every hot-path call.
    expect(out).toHaveLength(0);
    // And the warn hook fired so the operator can see why their config is ignored.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const call = (warnSpy!.mock.calls[0] ?? []).map(String).join(" ");
    expect(call).toContain("^(a+)+$");
    expect(call).toMatch(/unsafe|ReDoS/i);
  });

  it("skips unsafe patterns alongside safe ones (only safe ones survive)", () => {
    const out = compilePatterns(["^(a+)+$", "^(b+)+$", "^INFO$", "^DEBUG$"]);
    expect(out.map((re) => re.source)).toEqual(["^INFO$", "^DEBUG$"]);
  });

  it("uses a valid pattern normally", () => {
    const out = compilePatterns(["^INFO\\s+"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe("^INFO\\s+");
    expect(out[0]!.test("INFO ready")).toBe(true);
    expect(out[0]!.test("WARN ready")).toBe(false);
    // No warn for a safe + valid pattern.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still drops an invalid-regex (syntax error) — regression", () => {
    // `[` is an unclosed character class — both safe-regex's parser and the
    // native `new RegExp(...)` throw on it. Either path correctly skips the
    // pattern; the contract we care about is: pattern NOT compiled, operator
    // SEES a warning naming the offending pattern.
    const out = compilePatterns(["["]);
    expect(out).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const call = (warnSpy!.mock.calls[0] ?? []).map(String).join(" ");
    expect(call).toContain("[");
  });

  it("skips empty strings silently (existing behaviour preserved)", () => {
    const out = compilePatterns(["", "^INFO$", ""]);
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe("^INFO$");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
