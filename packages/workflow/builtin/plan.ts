// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// `plan` builtin workflow, ported in spirit from MiMo-Code's planning patterns
// and adapted for the SFFMC workflow runtime.
//
// Four phases: Scope → Decompose → Estimate → Output.
// One agent per phase. Cheap (no jury), useful for "give me a plan" requests.
//
// Invoked via:
//
//   workflow({ operation: "run", name: "plan", args: { goal: "..." } })

import type { Meta } from "../src/meta.ts"

// ── Meta (used by both the source string AND the registry) ──────────────────

export const meta: Meta = {
  name: "plan",
  description:
    "Plan orchestrator — takes a goal, writes a 1-paragraph scope clarification with success criteria, decomposes it into 5-15 ordered steps with dependencies and parallel groups, and returns a structured plan object.",
  whenToUse:
    "Use when the user wants a concrete plan (steps, deps, time estimates) for a non-trivial task — not a quick reply, but not a full research report either.",
  phases: [
    { title: "Scope",      detail: "Agent reads the goal, writes 1 paragraph of scope clarification + 3-5 success criteria" },
    { title: "Decompose",  detail: "Agent breaks the goal into 5-15 ordered steps, each with a title and 1-line description" },
    { title: "Estimate",   detail: "Agent assigns deps + parallel_group + est_minutes per step, validates no cycles" },
    { title: "Output",     detail: "Returns the structured plan object as the workflow result" },
  ],
}

// ── Source string (executed inside quickjs-emscripten sandbox) ──────────────

export const source = `// SPDX-License-Identifier: MIT
// @sffmc/workflow — plan builtin

export const meta = {
  name: "plan",
  description: "Plan orchestrator — takes a goal, writes a 1-paragraph scope clarification with success criteria, decomposes it into 5-15 ordered steps with dependencies and parallel groups, and returns a structured plan object.",
  whenToUse: "Use when the user wants a concrete plan (steps, deps, time estimates) for a non-trivial task — not a quick reply, but not a full research report either.",
  phases: [
    { title: "Scope",      detail: "Agent reads the goal, writes 1 paragraph of scope clarification + 3-5 success criteria" },
    { title: "Decompose",  detail: "Agent breaks the goal into 5-15 ordered steps, each with a title and 1-line description" },
    { title: "Estimate",   detail: "Agent assigns deps + parallel_group + est_minutes per step, validates no cycles" },
    { title: "Output",     detail: "Returns the structured plan object as the workflow result" },
  ],
};

// ── Tunables ────────────────────────────────────────────────────────────────

const MIN_STEPS = 5;
const MAX_STEPS = 15;
const SUCCESS_CRITERIA_MIN = 3;
const SUCCESS_CRITERIA_MAX = 5;

// ── Structured-output shapes ──────────────────────────────────────────────

const SCOPE_SHAPE = {
  type: "object", required: ["clarification", "success_criteria"],
  properties: {
    clarification: { type: "string" },
    success_criteria: {
      type: "array",
      minItems: SUCCESS_CRITERIA_MIN,
      maxItems: SUCCESS_CRITERIA_MAX,
      items: { type: "string" },
    },
  },
};

const DECOMPOSE_SHAPE = {
  type: "object", required: ["steps"],
  properties: {
    steps: {
      type: "array",
      minItems: MIN_STEPS,
      maxItems: MAX_STEPS,
      items: {
        type: "object",
        required: ["id", "title", "description"],
        properties: {
          id: { type: "string", description: "kebab-case, e.g. 'set-up-database'" },
          title: { type: "string" },
          description: { type: "string", description: "1 sentence" },
        },
      },
    },
  },
};

const ESTIMATE_SHAPE = {
  type: "object", required: ["steps"],
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "deps", "est_minutes", "parallel_group"],
        properties: {
          id: { type: "string" },
          deps: { type: "array", items: { type: "string" } },
          est_minutes: { type: "number", minimum: 1 },
          parallel_group: { type: "integer", minimum: 0 },
        },
      },
    },
    validation: {
      type: "object",
      required: ["no_cycles", "all_deps_exist"],
      properties: {
        no_cycles: { type: "boolean" },
        all_deps_exist: { type: "boolean" },
      },
    },
  },
};

// ── Main orchestration ───────────────────────────────────────────────────

const goal = String(args.goal || "").trim();
if (!goal) {
  throw new Error("plan builtin requires args.goal (string, non-empty)");
}

// Phase 1: Scope
const scopeRaw = await agent(
  "Read the goal and produce a scope clarification.\n\n" +
  "GOAL: " + goal + "\n\n" +
  "Write a 1-paragraph clarification of WHAT the user actually wants (not just the literal request — what's the success state?). " +
  "Then list 3-5 success criteria — concrete, measurable, observable. " +
  "If the goal is ambiguous, state your interpretation in the clarification paragraph.",
  {
    agentType: "general",
    label: "plan:scope",
    phase: "Scope",
    schema: SCOPE_SHAPE,
  },
);

const scope = scopeRaw || { clarification: "Unable to produce scope clarification.", success_criteria: ["Goal completed"] };

// Phase 2: Decompose (parallel: one agent per major work area, OR single agent for simple goals)
const decomposeRaw = await agent(
  "Break the goal into 5-15 concrete, ordered steps.\n\n" +
  "GOAL: " + goal + "\n\n" +
  "SCOPE: " + scope.clarification + "\n\n" +
  "SUCCESS CRITERIA:\n" + scope.success_criteria.map((c) => "  - " + c).join("\\n") + "\n\n" +
  "Each step has an id (kebab-case), title (1-5 words), and description (1 sentence). " +
  "Steps should be ordered by what needs to happen first. " +
  "If a step depends on another, note it in the description — the next phase will formalize deps.",
  {
    agentType: "general",
    label: "plan:decompose",
    phase: "Decompose",
    schema: DECOMPOSE_SHAPE,
  },
);

const decomposed = decomposeRaw || { steps: [] };
const stepCount = Math.max(decomposed.steps.length, MIN_STEPS);

if (decomposed.steps.length < MIN_STEPS) {
  // Recovery: prompt was too conservative, ask once more
  const retryRaw = await agent(
    "The previous attempt produced too few steps. Try again with a more granular breakdown.\n\n" +
    "GOAL: " + goal + "\n\n" +
    "List " + MIN_STEPS + "-" + MAX_STEPS + " ordered steps. Each step is a single concrete action, not a phase.",
    {
      agentType: "general",
      label: "plan:decompose-retry",
      phase: "Decompose",
      schema: DECOMPOSE_SHAPE,
    },
  );
  if (retryRaw && retryRaw.steps && retryRaw.steps.length >= MIN_STEPS) {
    decomposed.steps = retryRaw.steps;
  }
}

if (!decomposed.steps || decomposed.steps.length === 0) {
  throw new Error("plan builtin: Decompose phase produced no steps even after retry");
}

// Phase 3: Estimate (deps + parallel groups + cost)
const estimateRaw = await agent(
  "Take the following steps and add deps, est_minutes, and parallel_group to each.\n\n" +
  "GOAL: " + goal + "\n\n" +
  "STEPS:\n" + decomposed.steps.map((s) => "  " + s.id + " — " + s.title + ": " + s.description).join("\\n") + "\n\n" +
  "For each step, output:\n" +
  "  - id (same as input)\n" +
  "  - deps: array of step ids this depends on (can be empty for the first step)\n" +
  "  - est_minutes: rough estimate (single digit for tiny, 2-3 digits for big)\n" +
  "  - parallel_group: 0 for the first wave, 1 for the next wave that can run in parallel, etc. Steps in the same group have no inter-dependencies and can be done concurrently.\n\n" +
  "Also output validation.no_cycles (true if the dep graph has no cycles) and validation.all_deps_exist (true if every dep id is in the step list).",
  {
    agentType: "general",
    label: "plan:estimate",
    phase: "Estimate",
    schema: ESTIMATE_SHAPE,
  },
);

const estimated = estimateRaw || {
  steps: decomposed.steps.map((s) => ({ id: s.id, deps: [], est_minutes: 30, parallel_group: 0 })),
  validation: { no_cycles: true, all_deps_exist: true },
};

// Merge descriptions back (estimate agent might not preserve them)
const byId = new Map();
for (const s of decomposed.steps) byId.set(s.id, s);
for (const e of estimated.steps) {
  const original = byId.get(e.id);
  if (original) {
    e.title = original.title;
    e.description = original.description;
  }
}

// Phase 4: Output
const totalMinutes = estimated.steps.reduce((sum, s) => sum + (s.est_minutes || 0), 0);
const maxParallelGroup = estimated.steps.reduce((max, s) => Math.max(max, s.parallel_group || 0), 0);

const result = {
  goal: goal,
  scope_clarification: scope.clarification,
  success_criteria: scope.success_criteria,
  steps: estimated.steps,
  total_steps: estimated.steps.length,
  est_total_minutes: totalMinutes,
  parallel_groups: maxParallelGroup + 1,
  validation: estimated.validation,
  phases_completed: ["Scope", "Decompose", "Estimate", "Output"],
};

return result;
`
