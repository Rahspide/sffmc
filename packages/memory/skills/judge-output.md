---
name: memory:judge-output
description: "Use when the LLM has produced 2+ candidate outputs (code variants, design options, refactor approaches) and needs a multi-criteria verdict. Calls extra_judge with 3 default criteria: correctness, completeness, conciseness. Picks winner with reasoning."
hidden: true
---

# Judge Output

## The Rule

`extra_judge` is for **comparing** candidate outputs, not validating a single one. If you have 1 candidate, use tests, lint, or code review instead. If you have 2-8 candidates with subjective tradeoffs, use `extra_judge`.

The default rubric scores each candidate 0-10 on three criteria: **correctness**, **completeness**, **conciseness**. The judge picks a winner with brief reasoning.

## Default Criteria

1. **correctness** (0-10) — does it solve the problem without bugs?
2. **completeness** (0-10) — does it cover edge cases, error handling, and all requirements?
3. **conciseness** (0-10) — is it minimal, or bloated with irrelevant detail?

## Tool Call

```
extra_judge({
  candidates: [
    "// Option A: recursive approach\nfunction fib(n) { ... }",
    "// Option B: iterative approach\nfunction fib(n) { ... }",
    "// Option C: memoized approach\nconst fib = memoize(function(n) { ... })",
  ],
  rubric: "Score each candidate 0-10 on correctness, completeness, and conciseness. Prefer readability over micro-optimization."
})
```

Returns: `{ winner: 0, reasoning: "Option A is simplest and most readable...", scores: [...] }`.

## When to Use

- 2-8 code variants from parallel generation attempts
- 2-3 design options from a brainstorm
- A/B test of approaches where both "work" but trade off differently
- Any situation where you would otherwise ask the user "which one?"

## When NOT to Use

- You have only 1 candidate (no comparison possible — use tests instead)
- The criteria are objective and testable (just run the tests)
- Candidates are trivial (< 50 tokens each; judge overhead > benefit)
- Performance is the only criterion (benchmark, don't judge)

## Cost

1 judge call = 1 model invocation × 3 criteria = ~3K-10K tokens consumed. Budget accordingly. The judge uses `your-model-id` by default, configurable via `judge_model` in `extra` config.

## Why This Skill Exists

Without it, the LLM picks "the first one that works" without considering tradeoffs. Judge makes the decision explicit, multi-criteria, and auditable.
