<!-- Copied verbatim from XiaomiMiMo/MiMo-Code @ 42e7da3 on 2026-06-14. License: see upstream LICENSE -->
---
name: compose:benchmark
hidden: true
description: Use when you need to measure or compare performance — before optimizing, after a change that might affect speed, or when investigating a performance regression
---

# Benchmarking and Performance Measurement

## Overview

Systematically measure performance to make data-driven decisions. This skill guides the LLM through identifying what to measure, building or using a harness, collecting metrics, and comparing against a baseline. No guessing — numbers only.

**Core principle:** Optimize with data, not intuition.

**Announce at start:** "I'm using the compose:benchmark skill to measure performance."

## When to Use

- Before optimizing — establish baseline first
- After a change that might affect speed — confirm no regression
- When investigating a reported slowdown — isolate the cause
- Comparing two implementation approaches — which is faster?
- Verifying an optimization claim — did it actually help?

**Don't use for:** trivial operations where the answer is obvious (e.g., "is array.push faster than manual index assignment?" — yes, and the difference doesn't matter).

## The Process

### Phase 1: Identify What to Benchmark

1. **Define the operation:** What function, algorithm, or workflow are you measuring? Be specific — "the login endpoint" is vague; "the `bcrypt.compare()` call in `POST /auth/login`" is specific.
2. **Define the metric:** What matters?
   - **Throughput** (ops/sec, requests/sec) — for servers, ETL pipelines
   - **Latency** (ms per operation) — for UI, APIs, user-facing code
   - **Memory** (MB allocated, peak RSS) — for data processing, long-running services
   - **Startup time** (ms to ready) — for CLI tools, containers
3. **Define the scale:** What input sizes will you test?
   - Small (N=10) — common case
   - Medium (N=1,000) — representative load
   - Large (N=100,000) — stress test
   - If the operation is constant-time (O(1)), one size is enough. If it's O(n) or worse, test at least 3 sizes.
4. **State your hypothesis:** "I expect this change to reduce latency by 20% for N=1000."

### Phase 2: Build or Use a Benchmark Harness

Decide on the approach:

**Option A: Use an existing benchmark framework** (preferred when available)
- JavaScript/TypeScript: `mitata`, `benchmark.js`, `vitest bench`
- Python: `pytest-benchmark`, `timeit`
- Rust: `criterion`
- Go: `testing.B`

**Option B: Write a minimal harness** (when no framework exists or the operation is simple)

A minimal harness must:
1. Warm up (run the operation a few times before measuring — JIT compilation, cache loading)
2. Run multiple iterations (at least 10 for stable operations, 100+ for noisy ones)
3. Time each iteration using a high-resolution timer (`performance.now()`, `process.hrtime.bigint()`, `time.perf_counter_ns()`)
4. Report: min, max, mean, median (p50), p95, p99
5. Avoid measuring setup/teardown — only measure the operation itself

**Option C: Use a dedicated benchmarking tool**
- HTTP endpoints: `wrk`, `oha`, `autocannon`
- Database queries: `pgbench`, built-in `EXPLAIN ANALYZE`
- CLI commands: `hyperfine`

**Save the harness** to `benchmarks/<name>-<date>.ts` (or appropriate extension) so results are reproducible.

### Phase 3: Run and Collect Metrics

1. **Establish a quiet environment:**
   - Close other applications
   - Disable background processes when possible
   - Run on the same hardware for comparisons
   - Note CPU throttling (laptop on battery vs. plugged in)

2. **Run the baseline first** (current code, before changes):
   ```
   Baseline: N=1000
     Mean: 12.3 ms
     p50:  11.8 ms
     p95:  14.1 ms
     p99:  16.7 ms
     Min:  10.2 ms
     Max:  18.9 ms
   ```

3. **Make the change**, then run again.

4. **Run each measurement at least 3 times** to check for variance. If variance is high (>20% between runs), the environment is too noisy — increase iterations or find a quieter environment.

### Phase 4: Compare Against Baseline

Present results in a table:

```
| Metric     | Baseline (N=1000) | After Change (N=1000) | Delta    |
|------------|-------------------|----------------------|----------|
| Mean (ms)  | 12.3              | 8.9                  | -27.6% ✅ |
| p50 (ms)   | 11.8              | 8.6                  | -27.1%   |
| p95 (ms)   | 14.1              | 10.2                 | -27.7%   |
| p99 (ms)   | 16.7              | 12.4                 | -25.7%   |
```

**Interpret the results:**
- **Improvement** (>10% faster): ✅
- **Regression** (>10% slower): ❌
- **Within noise** (<10% change): ~ (statistically insignificant)
- **Variance too high:** ⚠️ Cannot conclude — need more samples

If the hypothesis was wrong, say so. Negative results are still results.

### Phase 5: Output Report

Produce a structured benchmark report:

```markdown
## Benchmark Report: [Operation Name]

**Date:** [YYYY-MM-DD]
**Environment:** [OS, CPU, RAM, Node/Bun/Python version]
**Methodology:** [Framework used, iterations, warmup]

### Summary
[One sentence conclusion — e.g., "The optimization reduced mean latency by 27.6% for N=1000."]

### Results Table
[Table from Phase 4]

### Interpretation
- [What the numbers mean in practice]
- [Any surprises or unexpected findings]
- [Edge cases: did large inputs behave differently?]

### Recommendations
- [If improvement confirmed → merge, deploy]
- [If regression found → revert, investigate]
- [If inconclusive → run more samples, reduce environment noise]
- [If optimization had no effect → revert, the complexity isn't worth it]
- [Suggested next benchmark if relevant]
```

## Heuristics

- **Warmup is not optional.** Cold runs are misleading. Always warm up before timing.
- **One variable at a time.** Change only one thing between baseline and comparison. If you changed the algorithm AND the data structure, you can't attribute the speed change.
- **Microbenchmarks lie.** A 2x speedup in a 0.001ms function means nothing if it's called once per request. Always tie back to end-user impact.
- **Profile before benchmarking.** Use a profiler (`--inspect`, `pprof`, `perf`) to find the actual hot path. Don't optimize the wrong thing.
- **Save the harness.** Reproducibility matters more than pretty output.
- **Benchmark the benchmark.** If your harness adds 5ms overhead and the operation takes 0.1ms, your measurements are noise. Reduce overhead or increase iterations.

## Red Flags — STOP

- Optimizing without a baseline → **you don't know if you helped**
- Measuring only mean latency → **mean hides tail latency (p99 matters for user experience)**
- Comparing results from different machines → **invalid comparison**
- Claiming "it's faster" without numbers → **that's guessing, not benchmarking**
- Running one iteration and calling it done → **variance will fool you**

## Integration

After the benchmark report is complete:
- Use **compose:report** to include benchmark findings in the final report.
- If optimization is confirmed, proceed with the change.
- If regression is found, use **compose:debug** to investigate.
- If building a plan that involves performance work, reference this skill to remind the executor to benchmark before and after.
