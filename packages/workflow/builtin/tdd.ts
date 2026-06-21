// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// `tdd` builtin workflow: structured TDD-style artifact generation.
//
// Five phases: Spec → Red → Green → Refactor → Verify.
// One agent per phase. Generates test files + implementation files as
// artifacts (does NOT execute them — agent primitives are LLM calls).
//
// Invoked via:
//
//   workflow({ operation: "run", name: "tdd", args: { feature: "..." } })

import type { Meta } from "../src/meta.ts"

// ── Meta ──────────────────────────────────────────────────────────────────

export const meta: Meta = {
  name: "tdd",
  description:
    "TDD-style artifact generation — takes a feature spec, writes 3-5 acceptance criteria as test names, generates failing test code, writes minimal implementation to pass them, suggests refactor notes, and returns the test+impl files as artifacts.",
  whenToUse:
    "Use when you want test code + minimal impl + refactor notes generated together for a new feature. Note: workflow generates artifacts, it does not execute tests. Run the generated code yourself.",
  phases: [
    { title: "Spec",     detail: "Agent reads the feature, writes 3-5 acceptance criteria as test names" },
    { title: "Red",      detail: "Agent writes failing test code for each criterion" },
    { title: "Green",    detail: "Agent writes minimal implementation to pass the tests" },
    { title: "Refactor", detail: "Agent suggests refactor notes (extracted helpers, naming, structure) without breaking tests" },
    { title: "Verify",   detail: "Returns the test files + impl files as artifacts in the result" },
  ],
}

// ── Source string (executed inside quickjs-emscripten sandbox) ──────────────

export const source = `// SPDX-License-Identifier: MIT
// @sffmc/workflow — tdd builtin

export const meta = {
  name: "tdd",
  description: "TDD-style artifact generation — takes a feature spec, writes 3-5 acceptance criteria as test names, generates failing test code, writes minimal implementation to pass them, suggests refactor notes, and returns the test+impl files as artifacts.",
  whenToUse: "Use when you want test code + minimal impl + refactor notes generated together for a new feature. Note: workflow generates artifacts, it does not execute tests. Run the generated code yourself.",
  phases: [
    { title: "Spec",     detail: "Agent reads the feature, writes 3-5 acceptance criteria as test names" },
    { title: "Red",      detail: "Agent writes failing test code for each criterion" },
    { title: "Green",    detail: "Agent writes minimal implementation to pass the tests" },
    { title: "Refactor", detail: "Agent suggests refactor notes (extracted helpers, naming, structure) without breaking tests" },
    { title: "Verify",   detail: "Returns the test files + impl files as artifacts in the result" },
  ],
};

// ── Tunables ──────────────────────────────────────────────────────────────

const CRITERIA_MIN = 3;
const CRITERIA_MAX = 5;

// ── Structured-output shapes ──────────────────────────────────────────────

const SPEC_SHAPE = {
  type: "object", required: ["criteria"],
  properties: {
    criteria: {
      type: "array",
      minItems: CRITERIA_MIN,
      maxItems: CRITERIA_MAX,
      items: {
        type: "object",
        required: ["name", "given", "when", "then"],
        properties: {
          name: { type: "string", description: "Test name, e.g. 'rejects negative input'" },
          given: { type: "string", description: "Setup" },
          when: { type: "string", description: "Action" },
          then: { type: "string", description: "Expected outcome" },
        },
      },
    },
  },
};

const RED_SHAPE = {
  type: "object", required: ["test_file_path", "test_file_content"],
  properties: {
    test_file_path: { type: "string", description: "Where the test file should live, e.g. 'src/foo.test.ts'" },
    test_file_content: { type: "string", description: "Full file content with imports + describe + failing tests" },
  },
};

const GREEN_SHAPE = {
  type: "object", required: ["impl_file_path", "impl_file_content"],
  properties: {
    impl_file_path: { type: "string" },
    impl_file_content: { type: "string", description: "Minimal impl — just enough to make the tests pass" },
  },
};

const REFACTOR_SHAPE = {
  type: "object", required: ["notes"],
  properties: {
    notes: {
      type: "array",
      items: { type: "string", description: "1 refactor note per item (extract helper, rename, dedupe, etc.)" },
    },
    optional_patches: {
      type: "array",
      description: "0+ optional patches the user can apply; not auto-applied",
      items: {
        type: "object",
        required: ["file_path", "before", "after", "reason"],
        properties: {
          file_path: { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
};

// ── Main orchestration ────────────────────────────────────────────────────

const feature = String(args.feature || "").trim();
if (!feature) {
  throw new Error("tdd builtin requires args.feature (string, non-empty)");
}

const language = String(args.language || "typescript");
const testFramework = String(args.testFramework || "bun test");

// Step 1: Spec
const specRaw = await agent(
  "Write 3-5 acceptance criteria as test names for the following feature.\n\n" +
  "FEATURE: " + feature + "\n\n" +
  "LANGUAGE: " + language + "\n" +
  "TEST FRAMEWORK: " + testFramework + "\n\n" +
  "Each criterion uses given/when/then format. The 'name' is the test function name. " +
  "Cover: happy path, edge cases, error cases. Don't test implementation details — test behavior.",
  {
    agentType: "general",
    label: "tdd:spec",
    phase: "Spec",
    schema: SPEC_SHAPE,
  },
);

const spec = specRaw || { criteria: [] };

if (!spec.criteria || spec.criteria.length < CRITERIA_MIN) {
  throw new Error("tdd builtin: Spec phase produced fewer than " + CRITERIA_MIN + " criteria");
}

// Step 2: Red (write failing tests)
const redRaw = await agent(
  "Write the failing test file for the following feature.\n\n" +
  "FEATURE: " + feature + "\n\n" +
  "LANGUAGE: " + language + "\n" +
  "TEST FRAMEWORK: " + testFramework + "\n\n" +
  "ACCEPTANCE CRITERIA:\n" +
  spec.criteria.map((c) => "  - " + c.name + ": given " + c.given + ", when " + c.when + ", then " + c.then).join("\\n") + "\n\n" +
  "Output the FULL test file content (with imports, describe blocks, all " + spec.criteria.length + " tests). " +
  "Each test must be a complete function — not a stub. The tests should FAIL when run against a missing/stub implementation. " +
  "Use idiomatic patterns for " + language + " and " + testFramework + ".",
  {
    agentType: "general",
    label: "tdd:red",
    phase: "Red",
    schema: RED_SHAPE,
  },
);

if (!redRaw || !redRaw.test_file_path || !redRaw.test_file_content) {
  throw new Error("tdd builtin: Red phase did not produce test file content");
}

// Step 3: Green (minimal implementation)
const greenRaw = await agent(
  "Write the MINIMAL implementation that makes the following tests pass.\n\n" +
  "FEATURE: " + feature + "\n\n" +
  "LANGUAGE: " + language + "\n\n" +
  "TEST FILE (" + redRaw.test_file_path + "):\n" +
  redRaw.test_file_content + "\n\n" +
  "CRITICAL: produce the LEAST CODE that makes all the tests pass. Do not add features, helpers, or abstractions that aren't strictly needed. " +
  "If the test imports a function, export that function. If the test calls a method, define that method. " +
  "Inline simple values rather than introducing constants. Prefer copy-paste over premature DRY.",
  {
    agentType: "general",
    label: "tdd:green",
    phase: "Green",
    schema: GREEN_SHAPE,
  },
);

if (!greenRaw || !greenRaw.impl_file_path || !greenRaw.impl_file_content) {
  throw new Error("tdd builtin: Green phase did not produce implementation file content");
}

// Step 4: Refactor (notes + optional patches, NOT auto-applied)
const refactorRaw = await agent(
  "Suggest refactor notes for the following implementation. Do NOT change behavior.\n\n" +
  "TEST FILE:\n" + redRaw.test_file_content + "\n\n" +
  "IMPL FILE (" + greenRaw.impl_file_path + "):\n" + greenRaw.impl_file_content + "\n\n" +
  "List 1-5 refactor opportunities as plain notes (e.g. 'extract helper', 'rename X to Y', 'split into 2 functions'). " +
  "Optionally include 0+ before/after patches the user can apply — but mark them as optional. " +
  "Do NOT auto-apply the patches. The user reviews them.",
  {
    agentType: "general",
    label: "tdd:refactor",
    phase: "Refactor",
    schema: REFACTOR_SHAPE,
  },
);

const refactor = refactorRaw || { notes: [], optional_patches: [] };

// Step 5: Verify (output artifacts)
const result = {
  feature: feature,
  language: language,
  test_framework: testFramework,
  spec: {
    criteria: spec.criteria,
    criteria_count: spec.criteria.length,
  },
  red: {
    test_file_path: redRaw.test_file_path,
    test_file_content: redRaw.test_file_content,
    test_count: spec.criteria.length,
  },
  green: {
    impl_file_path: greenRaw.impl_file_path,
    impl_file_content: greenRaw.impl_file_content,
  },
  refactor: {
    notes: refactor.notes || [],
    optional_patches: refactor.optional_patches || [],
  },
  artifacts: [
    { path: redRaw.test_file_path, kind: "test", content: redRaw.test_file_content },
    { path: greenRaw.impl_file_path, kind: "impl", content: greenRaw.impl_file_content },
  ],
  phases_completed: ["Spec", "Red", "Green", "Refactor", "Verify"],
  next_steps: [
    "Write the test file to " + redRaw.test_file_path,
    "Run the tests — they should FAIL (red phase, expected)",
    "Write the impl file to " + greenRaw.impl_file_path,
    "Run the tests — they should PASS (green phase)",
    "Review refactor notes and optional patches; apply if useful",
  ],
};

return result;
`
