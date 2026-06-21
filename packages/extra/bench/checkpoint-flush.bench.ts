#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// @sffmc/extra — synthetic microbenchmark for checkpoint flush batching (v0.14.5).
//
// Measures hook throughput (calls/sec) at three buffer sizes (10 / 100 / 1000)
// using a default flush threshold of 50. For n < flushThreshold no auto-flush
// occurs during the loop — `cleanup()` is responsible for writing the buffer;
// for n ≥ flushThreshold auto-flushes happen mid-loop and the timer/cleanup
// write is a no-op. The clock stops BEFORE `cleanup()` so cleanup cost is not
// attributed to the hook call rate.
//
// Run:
//   bun packages/extra/bench/checkpoint-flush.bench.ts
//   FLUSH_THRESHOLD=10 bun packages/extra/bench/checkpoint-flush.bench.ts

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpointTool } from "../src/checkpoint";

async function bench(flushThreshold: number, numCalls: number) {
  const tmpDir = mkdtempSync(join(tmpdir(), "sffmc-bench-"));
  try {
    const { hooks, cleanup } = createCheckpointTool({
      enabled: true,
      dir: tmpDir,
      flushThreshold,
      // Long interval — the periodic timer must not fire during the loop.
      flushIntervalMs: 60_000,
    });
    const hook = hooks["tool.execute.after"]!;

    const sessionID = "bench-session";
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < numCalls; i++) {
      await hook(
        { tool: "test", sessionID, callID: `call-${i}` },
        { output: `result-${i}`, title: `t${i}`, metadata: { args: { i } } },
      );
    }
    // Stop the clock before cleanup() so cleanup cost is not counted in
    // ops/sec. cleanup() still has to run so the on-disk file is fully
    // flushed (otherwise fileSize would be 0 for n < flushThreshold).
    const t1 = Bun.nanoseconds();
    cleanup();

    const elapsedMs = (t1 - t0) / 1_000_000;
    const opsPerSec = numCalls / (elapsedMs / 1000);
    const fileSize = existsSync(join(tmpDir, `${sessionID}.jsonl`))
      ? readFileSync(join(tmpDir, `${sessionID}.jsonl`)).length
      : 0;
    return { numCalls, elapsedMs, opsPerSec, fileSize };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const flushThreshold = Number(process.env.FLUSH_THRESHOLD ?? 50);
const sizes = [10, 100, 1000];
const results = [];
for (const n of sizes) {
  const r = await bench(flushThreshold, n);
  results.push(r);
  console.log(
    `n=${r.numCalls.toString().padStart(4)}  ` +
    `elapsed=${r.elapsedMs.toFixed(2).padStart(8)}ms  ` +
    `${r.opsPerSec.toFixed(0).padStart(8)} ops/sec  ` +
    `file=${r.fileSize}B`,
  );
}