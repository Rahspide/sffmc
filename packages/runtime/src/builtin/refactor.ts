// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE
//
// `refactor` builtin workflow: read existing code, diagnose smells, propose
// refactors as before/after patches. Does NOT auto-apply (safer).
//
// Four phases: Scan → Diagnose → Propose → Output.
// One agent per phase. The workflow reads files via workspace primitives
// and returns proposals; the user reviews and applies with git/diff tools.
//
// Invoked via:
//
//   workflow({ operation: "run", name: "refactor", args: { target: "src/foo.ts", goal: "..." } })

import type { Meta } from "../src/meta.ts"

// ── Meta ──────────────────────────────────────────────────────────────────

export const meta: Meta = {
  name: "refactor",
  description:
    "Refactor proposer — reads a file or directory, lists 3-7 code smells, proposes 1-5 refactor patches (before/after with reason), and returns them for user review. Does NOT auto-apply.",
  whenToUse:
    "Use when you want a refactor plan for a file or small area — duplication, long methods, etc. The workflow returns proposals; you apply them yourself with git/diff.",
  phases: [
    { title: "Scan",     detail: "Lists files in target, picks the most complex, reads them" },
    { title: "Diagnose", detail: "Agent reads the files, lists 3-7 concrete smells (duplication, complexity, naming, etc.)" },
    { title: "Propose",  detail: "Agent writes 1-5 refactor proposals as before/after patches with reasons" },
    { title: "Output",   detail: "Returns the smells + proposals for user review; does NOT apply" },
  ],
}

// ── Source string (executed inside quickjs-emscripten sandbox) ──────────────

export const source = `// SPDX-License-Identifier: MIT
// @sffmc/runtime — refactor builtin

export const meta = {
  name: "refactor",
  description: "Refactor proposer — reads a file or directory, lists 3-7 code smells, proposes 1-5 refactor patches (before/after with reason), and returns them for user review. Does NOT auto-apply.",
  whenToUse: "Use when you want a refactor plan for a file or small area — duplication, long methods, etc. The workflow returns proposals; you apply them yourself with git/diff.",
  phases: [
    { title: "Scan",     detail: "Lists files in target, picks the most complex, reads them" },
    { title: "Diagnose", detail: "Agent reads the files, lists 3-7 concrete smells (duplication, complexity, naming, etc.)" },
    { title: "Propose",  detail: "Agent writes 1-5 refactor proposals as before/after patches with reasons" },
    { title: "Output",   detail: "Returns the smells + proposals for user review; does NOT apply" },
  ],
};

// ── Tunables ──────────────────────────────────────────────────────────────

const MAX_FILES_READ = 5;
const MAX_FILE_BYTES = 50_000;
const SMELLS_MIN = 3;
const SMELLS_MAX = 7;
const PROPOSALS_MIN = 1;
const PROPOSALS_MAX = 5;

// ── Structured-output shapes ──────────────────────────────────────────────

const SCAN_SHAPE = {
  type: "object", required: ["files"],
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "size", "lines"],
        properties: {
          path: { type: "string" },
          size: { type: "number" },
          lines: { type: "number" },
        },
      },
    },
    picked: {
      type: "array",
      description: "Top MAX_FILES_READ files by complexity (lines × density heuristic)",
      items: { type: "string" },
    },
  },
};

const DIAGNOSE_SHAPE = {
  type: "object", required: ["smells"],
  properties: {
    smells: {
      type: "array",
      minItems: SMELLS_MIN,
      maxItems: SMELLS_MAX,
      items: {
        type: "object",
        required: ["kind", "location", "description", "severity"],
        properties: {
          kind: { type: "string", description: "duplication, complexity, naming, dead-code, coupling, etc." },
          location: { type: "string", description: "file:line or file:function" },
          description: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
  },
};

const PROPOSE_SHAPE = {
  type: "object", required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      minItems: PROPOSALS_MIN,
      maxItems: PROPOSALS_MAX,
      items: {
        type: "object",
        required: ["file_path", "title", "before", "after", "reason", "risk"],
        properties: {
          file_path: { type: "string" },
          title: { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
          reason: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          addresses_smell: { type: "string", description: "Which smell this fixes" },
        },
      },
    },
  },
};

// ── Main orchestration ────────────────────────────────────────────────────

const target = String(args.target || "").trim();
const goal = String(args.goal || "improve readability and reduce duplication").trim();
const workspace = String(args.workspace || "").trim();

if (!target) {
  throw new Error("refactor builtin requires args.target (file or directory path)");
}
if (!workspace) {
  throw new Error("refactor builtin requires args.workspace (jail directory)");
}

// Scan
const scanRaw = await agent(
  "Scan the target and report file structure.\n\n" +
  "TARGET: " + target + "\n" +
  "GOAL: " + goal + "\n\n" +
  "Use the file primitives to:\n" +
  "  1. Glob " + target + " to find all source files (exclude node_modules, .git, dist, build, coverage)\n" +
  "  2. For each, get size (bytes) and line count\n" +
  "  3. Pick the top " + MAX_FILES_READ + " most complex files (highest line count, or those that import many others)\n" +
  "  4. Read those files' contents\n" +
  "  5. Return a summary of what you found\n\n" +
  "Workspace: " + workspace + "\n" +
  "Use readFile(), glob(), exists() from the workspace primitives (not node:fs directly).",
  {
    agentType: "general",
    label: "refactor:scan",
    phase: "Scan",
    schema: SCAN_SHAPE,
  },
);

const scan = scanRaw || { files: [], picked: [] };
if (!scan.picked || scan.picked.length === 0) {
  throw new Error("refactor builtin: Scan phase found no files to analyze at " + target);
}

// Diagnose (read picked files, list smells)
let pickedContents = "";
for (const f of (scan.picked || []).slice(0, MAX_FILES_READ)) {
  if (!exists(f)) continue;
  const content = readFile(f);
  if (content.length > MAX_FILE_BYTES) continue;
  pickedContents += "\\n\\n=== " + f + " ===\\n" + content;
}

const diagnoseRaw = await agent(
  "Diagnose code smells in the following files.\n\n" +
  "GOAL: " + goal + "\n\n" +
  "FILES:" + pickedContents + "\n\n" +
  "List 3-7 concrete smells. For each:\n" +
  "  - kind: 'duplication' | 'complexity' | 'naming' | 'dead-code' | 'coupling' | 'magic-number' | etc.\n" +
  "  - location: 'file.ts:LINE' or 'file.ts:function_name'\n" +
  "  - description: 1-2 sentences, concrete (quote the code)\n" +
  "  - severity: 'low' | 'medium' | 'high'\n\n" +
  "Don't be pedantic — focus on real wins. Skip nits like 'could use a const instead of a let' unless they matter.",
  {
    agentType: "general",
    label: "refactor:diagnose",
    phase: "Diagnose",
    schema: DIAGNOSE_SHAPE,
  },
);

const diagnose = diagnoseRaw || { smells: [] };
if (!diagnose.smells || diagnose.smells.length === 0) {
  throw new Error("refactor builtin: Diagnose phase found no smells");
}

// Propose (1-5 patches targeting the worst smells)
const proposeRaw = await agent(
  "Propose 1-5 refactor patches for the following code.\n\n" +
  "GOAL: " + goal + "\n\n" +
  "SMELLS:\n" +
  diagnose.smells.map((s) => "  [" + s.severity + "] " + s.kind + " at " + s.location + ": " + s.description).join("\\n") + "\n\n" +
  "FILES:" + pickedContents + "\n\n" +
  "For each proposal:\n" +
  "  - file_path: which file to change\n" +
  "  - title: short (3-7 words)\n" +
  "  - before: the exact code to replace (must match the file verbatim, including whitespace)\n" +
  "  - after: the replacement code\n" +
  "  - reason: 1-2 sentences, what improves and why\n" +
  "  - risk: 'low' | 'medium' | 'high' (low = same behavior, high = subtle behavior change)\n" +
  "  - addresses_smell: which smell this fixes (kind:location)\n\n" +
  "Order proposals by impact (highest ). Skip trivial changes — focus on real wins.",
  {
    agentType: "general",
    label: "refactor:propose",
    phase: "Propose",
    schema: PROPOSE_SHAPE,
  },
);

const propose = proposeRaw || { proposals: [] };
if (!propose.proposals || propose.proposals.length === 0) {
  throw new Error("refactor builtin: Propose phase produced no proposals");
}

// Output (return everything for user review)
const result = {
  target: target,
  goal: goal,
  scan: {
    files_total: (scan.files || []).length,
    files_analyzed: (scan.picked || []).length,
    files_analyzed_paths: scan.picked || [],
  },
  smells: diagnose.smells,
  smells_count: (diagnose.smells || []).length,
  proposals: propose.proposals,
  proposals_count: (propose.proposals || []).length,
  phases_completed: ["Scan", "Diagnose", "Propose", "Output"],
  next_steps: [
    "Review the proposals above",
    "Apply each one with: edit_file <file_path> with <before> -> <after>",
    "Or use: git apply after reconstructing the patch",
    "Run tests after each apply to confirm behavior unchanged",
  ],
  NOT_APPLIED_WARNING: "This workflow did NOT modify any files. The proposals are advisory.",
};

return result;
`
