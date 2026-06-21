// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
//
// Phases: Detect → Map → Transform → Verify → Report.
// Finds all imports of a target library, builds old→new API mapping,
// generates patches, runs verification, and produces a migration summary.
//
// Invoked via:
//
//   workflow({ operation: "run", name: "lib-migrate", args: { from: "old-lib", to: "new-lib", root: "/path/to/project" } })

import type { Meta } from "../src/meta.ts"

// ── Meta (used by both the source string AND the registry) ──────────────────

export const meta: Meta = {
  name: "lib-migrate",
  description:
    "Library migration assistant — detects all imports of a target library, builds old→new API mapping using LLM agents, generates transformation patches, runs verification (tests/typecheck), and produces a migration summary report.",
  whenToUse:
    "Use when migrating a codebase from one library to another (e.g., moment → luxon, express → fastify, classnames → clsx). Also useful for major version upgrades with breaking API changes.",
  phases: [
    { title: "Detect",   detail: "Find all imports/requires of the target library across the codebase" },
    { title: "Map",      detail: "Build old API → new API mapping using LLM agents for complex cases" },
    { title: "Transform", detail: "Generate transformation patches for each import site" },
    { title: "Verify",   detail: "Run tests and typecheck to validate the migration" },
    { title: "Report",   detail: "Produce a migration summary with success/failure counts and remaining manual work" },
  ],
}

// ── Source string (executed inside quickjs-emscripten sandbox) ──────────────

export const source = `// SPDX-License-Identifier: MIT
// @sffmc/workflow — lib-migrate builtin

export const meta = {
  name: "lib-migrate",
  description: "Library migration assistant — detects all imports of a target library, builds old→new API mapping using LLM agents, generates transformation patches, runs verification (tests/typecheck), and produces a migration summary report.",
  whenToUse: "Use when migrating a codebase from one library to another (e.g., moment → luxon, express → fastify, classnames → clsx). Also useful for major version upgrades with breaking API changes.",
  phases: [
    { title: "Detect",   detail: "Find all imports/requires of the target library across the codebase" },
    { title: "Map",      detail: "Build old API → new API mapping using LLM agents for complex cases" },
    { title: "Transform", detail: "Generate transformation patches for each import site" },
    { title: "Verify",   detail: "Run tests and typecheck to validate the migration" },
    { title: "Report",   detail: "Produce a migration summary with success/failure counts and remaining manual work" },
  ],
};

// ── Tunables ────────────────────────────────────────────────────────────────

const MAX_IMPORT_SITES = 200;
const MAX_FILE_BYTES = 50_000;
const BATCH_SIZE = 10;

// ── Structured-output shapes ──────────────────────────────────────────────

const DETECT_SHAPE = {
  type: "object", required: ["imports"],
  properties: {
    imports: {
      type: "array",
      maxItems: MAX_IMPORT_SITES,
      items: {
        type: "object",
        required: ["file", "line", "import_statement", "imported_symbols"],
        properties: {
          file: { type: "string", description: "File path relative to root" },
          line: { type: "number", description: "Line number of the import" },
          import_statement: { type: "string", description: "Full import/require line" },
          imported_symbols: { type: "array", items: { type: "string" }, description: "Symbols imported from the library" },
          usage_count: { type: "number", description: "How many times the library is used in this file" },
        },
      },
    },
    stats: {
      type: "object",
      properties: {
        total_files: { type: "number" },
        total_imports: { type: "number" },
        unique_symbols: { type: "array", items: { type: "string" } },
      },
    },
  },
};

const MAP_SHAPE = {
  type: "object", required: ["mappings"],
  properties: {
    mappings: {
      type: "array",
      items: {
        type: "object",
        required: ["old_api", "new_api", "confidence", "notes"],
        properties: {
          old_api: { type: "string", description: "Old API signature (function name, method, import path)" },
          new_api: { type: "string", description: "New API signature (equivalent in target library)" },
          confidence: { type: "string", enum: ["exact", "high", "medium", "low", "manual"] },
          notes: { type: "string", description: "Migration notes, caveats, breaking changes" },
          code_before: { type: "string", description: "Example usage before" },
          code_after: { type: "string", description: "Example usage after" },
        },
      },
    },
  },
};

const TRANSFORM_SHAPE = {
  type: "object", required: ["patches"],
  properties: {
    patches: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "before", "after", "reason"],
        properties: {
          file: { type: "string" },
          before: { type: "string", description: "Exact code to replace" },
          after: { type: "string", description: "Replacement code" },
          reason: { type: "string", description: "Which mapping this applies" },
          auto_applicable: { type: "boolean", description: "Whether this can be auto-applied safely" },
        },
      },
    },
  },
};

const VERIFY_SHAPE = {
  type: "object", required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["check", "status", "details"],
        properties: {
          check: { type: "string", description: "What was verified (e.g., 'typecheck', 'unit tests')" },
          status: { type: "string", enum: ["pass", "fail", "skipped"] },
          details: { type: "string", description: "Output summary" },
          errors: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const REPORT_SHAPE = {
  type: "object", required: ["summary", "stats", "remaining"],
  properties: {
    summary: { type: "string", description: "2-4 sentence migration summary" },
    stats: {
      type: "object",
      required: ["total_files", "total_imports", "auto_migrated", "manual_required", "verification_passed"],
      properties: {
        total_files: { type: "number" },
        total_imports: { type: "number" },
        auto_migrated: { type: "number" },
        manual_required: { type: "number" },
        verification_passed: { type: "boolean" },
      },
    },
    remaining: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "issue", "suggestion"],
        properties: {
          file: { type: "string" },
          issue: { type: "string" },
          suggestion: { type: "string" },
        },
      },
    },
  },
};

// ── Detect ────

phase("Detect");

const fromLib = String(args.from || args.source || "").trim();
const toLib = String(args.to || args.target_lib || "").trim();
const root = String(args.root || "").trim();

if (!fromLib) {
  throw new Error("lib-migrate builtin requires args.from (source library name, e.g. 'moment')");
}
if (!toLib) {
  throw new Error("lib-migrate builtin requires args.to (target library name, e.g. 'luxon')");
}
if (!root) {
  throw new Error("lib-migrate builtin requires args.root (project path)");
}

// Discover source files
var sourceFiles = [];
try {
  var patterns = [
    root + "/**/*.ts",
    root + "/**/*.tsx",
    root + "/**/*.js",
    root + "/**/*.jsx",
    root + "/**/*.vue",
    root + "/**/*.svelte",
  ];
  for (var pi = 0; pi < patterns.length; pi++) {
    try {
      var found = glob(patterns[pi]);
      if (found && found.length) {
        for (var fi = 0; fi < found.length; fi++) {
          sourceFiles.push(found[fi]);
        }
      }
    } catch (_e) { /* skip unsupported */ }
  }
  sourceFiles = sourceFiles.filter(function (f) {
    return !(/node_modules|dist|build|\\.test\\.|\\.spec\\.|vendor/.test(f));
  }).slice(0, 500);
} catch (_e) {
  sourceFiles = [];
}

log("Scanning " + sourceFiles.length + " source files for imports of '" + fromLib + "'");

// Read a sample for context
var fileSample = "";
var sampleCount = 0;
for (var fi = 0; fi < sourceFiles.length && sampleCount < 8; fi++) {
  var fp = sourceFiles[fi];
  if (!exists(fp)) continue;
  var c = readFile(fp);
  if (!c || c.length > MAX_FILE_BYTES) continue;
  fileSample += "\\n\\n=== " + fp + " ===\\n" + c.slice(0, 1500);
  sampleCount++;
}

const detectRaw = await agent(
  "Detect all imports of the source library.\n\n" +
  "SOURCE LIBRARY: '" + fromLib + "'\n" +
  "TARGET LIBRARY: '" + toLib + "'\n" +
  "Project root: " + root + "\n" +
  "Source files: " + sourceFiles.length + "\n\n" +
  "Sample file contents:\n" + fileSample + "\n\n" +
  "## Task\n" +
  "Find every file that imports from '" + fromLib + "' (both ES import and CommonJS require).\n" +
  "For each import site, identify:\n" +
  "  - file: relative path\n" +
  "  - line: line number\n" +
  "  - import_statement: the full import/require line\n" +
  "  - imported_symbols: which specific symbols are imported\n" +
  "  - usage_count: estimated number of usages in the file\n\n" +
  "Include ALL unique symbols imported across the codebase so we can build a complete mapping.",
  { label: "migrate:detect", phase: "Detect", schema: DETECT_SHAPE }
);

const detected = detectRaw || { imports: [], stats: { total_files: 0, total_imports: 0, unique_symbols: [] } };
const imports = detected.imports || [];

log("Detected " + imports.length + " import sites across " + (detected.stats && detected.stats.total_files || 0) + " files");

if (imports.length === 0) {
  return {
    from: fromLib,
    to: toLib,
    summary: "No imports of '" + fromLib + "' found in " + root + ". Migration not needed.",
    stats: { total_files: 0, total_imports: 0, auto_migrated: 0, manual_required: 0, verification_passed: true },
    remaining: [],
    patches: [],
    phases_completed: ["Detect", "Map", "Transform", "Verify", "Report"],
    note: "No files to migrate. Verify the library name is correct.",
  };
}

// ── Map ────

phase("Map");

var uniqueSymbols = (detected.stats && detected.stats.unique_symbols) || [];
if (uniqueSymbols.length === 0) {
  // Extract unique symbols from detected imports
  var symSet = {};
  for (var ii = 0; ii < imports.length; ii++) {
    var syms = imports[ii].imported_symbols || [];
    for (var si = 0; si < syms.length; si++) {
      symSet[syms[si]] = true;
    }
  }
  uniqueSymbols = Object.keys(symSet);
}

const mapRaw = await agent(
  "Build an old API → new API mapping for the migration.\n\n" +
  "FROM: '" + fromLib + "'\n" +
  "TO: '" + toLib + "'\n\n" +
  "## Symbols used in the codebase (" + uniqueSymbols.length + ")\n" +
  uniqueSymbols.map(function (s) { return "  - " + s; }).join("\\n") + "\n\n" +
  "## Import sites (" + imports.length + ")\n" +
  imports.map(function (imp) {
    return "  " + imp.file + ":" + imp.line + " — " + imp.import_statement;
  }).join("\\n") + "\n\n" +
  "## Task\n" +
  "For each unique symbol, provide the equivalent in '" + toLib + "'.\n" +
  "  - old_api: the original API call (function name, method, import path)\n" +
  "  - new_api: the equivalent in the target library\n" +
  "  - confidence: 'exact' (drop-in replacement), 'high' (minor syntax change), 'medium' (different API shape), 'low' (major rewrite), 'manual' (no direct equivalent)\n" +
  "  - notes: caveats, breaking changes, behavioral differences\n" +
  "  - code_before / code_after: short example (1-3 lines each)\n\n" +
  "If you are not confident about a mapping, mark it 'manual' and explain the gap.\n" +
  "Include common patterns: constructor calls, static methods, configuration, error handling.",
  { label: "migrate:map", phase: "Map", schema: MAP_SHAPE }
);

const mappings = (mapRaw && mapRaw.mappings) ? mapRaw.mappings : [];

log("Built " + mappings.length + " API mappings (" +
  mappings.filter(function (m) { return m.confidence === "exact" || m.confidence === "high"; }).length +
  " auto-migratable, " +
  mappings.filter(function (m) { return m.confidence === "manual"; }).length +
  " manual)");

// ── Transform ────

phase("Transform");

// Read files that need migration and generate patches
var filesToMigrate = [];
for (var ii = 0; ii < imports.length; ii++) {
  var imp = imports[ii];
  if (filesToMigrate.indexOf(imp.file) === -1) {
    filesToMigrate.push(imp.file);
  }
}

var fileContents = "";
for (var fi = 0; fi < filesToMigrate.length && fi < 15; fi++) {
  var fp = filesToMigrate[fi];
  if (!exists(fp)) continue;
  var content = readFile(fp);
  if (!content || content.length > MAX_FILE_BYTES) continue;
  fileContents += "\\n\\n=== " + fp + " ===\\n" + content;
}

const transformRaw = await agent(
  "Generate transformation patches for the migration.\n\n" +
  "FROM: '" + fromLib + "'\n" +
  "TO: '" + toLib + "'\n\n" +
  "## API Mappings (" + mappings.length + ")\n" +
  mappings.map(function (m, i) {
    return "[" + i + "] " + m.confidence.toUpperCase() + " :: " + m.old_api + " → " + m.new_api + "\\n  " + m.notes;
  }).join("\\n") + "\n\n" +
  "## Files to migrate (" + filesToMigrate.length + ")\n" +
  filesToMigrate.join("\\n") + "\n\n" +
  "## File contents\n" + fileContents + "\n\n" +
  "## Task\n" +
  "For each import site that can be auto-migrated, produce a before/after patch:\n" +
  "  - file: which file to change\n" +
  "  - before: the exact code to replace (must match the file verbatim)\n" +
  "  - after: the replacement code\n" +
  "  - reason: which mapping this applies\n" +
  "  - auto_applicable: true if the patch is safe to apply without manual review, false if it needs human judgment\n\n" +
  "For 'manual' confidence mappings, note them but do NOT generate patches.\n" +
  "Only generate patches for 'exact' and 'high' confidence mappings.",
  { label: "migrate:transform", phase: "Transform", schema: TRANSFORM_SHAPE }
);

const patches = (transformRaw && transformRaw.patches) ? transformRaw.patches : [];

log("Generated " + patches.length + " patches (" +
  patches.filter(function (p) { return p.auto_applicable; }).length + " auto-applicable)");

// ── Verify ────

phase("Verify");

const verifyRaw = await agent(
  "Verify the migration by checking test and typecheck results.\n\n" +
  "FROM: '" + fromLib + "' → TO: '" + toLib + "'\n\n" +
  "## Patches Applied: " + patches.length + "\n" +
  patches.map(function (p, i) {
    return "[" + i + "] " + p.file + ": " + p.reason + " (" + (p.auto_applicable ? "auto" : "manual") + ")";
  }).join("\\n") + "\n\n" +
  "## Task\n" +
  "Verify the migration by checking:\n" +
  "1. Do any remaining imports of '" + fromLib + "' exist? (grep for '" + fromLib + "')\n" +
  "2. Do the new imports of '" + toLib + "' resolve correctly?\n" +
  "3. Suggest running: typecheck, unit tests, lint\n" +
  "4. List any errors that would block the migration\n\n" +
  "Even if you cannot execute tests directly, analyze the patches for likely issues:\n" +
  "  - Unmatched function signatures\n" +
  "  - Missing imports\n" +
  "  - Behavioral differences between old and new APIs\n\n" +
  "Return the verification results with status (pass/fail/skipped) for each check.",
  { label: "migrate:verify", phase: "Verify", schema: VERIFY_SHAPE }
);

const verification = verifyRaw || { results: [] };
var allPassed = true;
var verResults = verification.results || [];
for (var vi = 0; vi < verResults.length; vi++) {
  if (verResults[vi].status === "fail") allPassed = false;
}

log("Verification: " + (allPassed ? "ALL PASSED" : "SOME FAILURES"));

// ── Report ────

phase("Report");

var manualCount = mappings.filter(function (m) { return m.confidence === "manual" || m.confidence === "low"; }).length;
var autoCount = patches.filter(function (p) { return p.auto_applicable; }).length;
var totalPatches = patches.length;

const reportRaw = await agent(
  "Write the migration summary report.\n\n" +
  "## Migration: " + fromLib + " → " + toLib + "\n" +
  "## Project: " + root + "\n\n" +
  "## Detect\n" +
  "  Files with imports: " + (detected.stats && detected.stats.total_files || 0) + "\n" +
  "  Total import sites: " + imports.length + "\n" +
  "  Unique symbols: " + uniqueSymbols.length + "\n\n" +
  "## Map\n" +
  "  Total mappings: " + mappings.length + "\n" +
  "  Auto-migratable (exact/high): " + (mappings.length - manualCount) + "\n" +
  "  Manual review needed: " + manualCount + "\n\n" +
  "## Transform\n" +
  "  Patches generated: " + totalPatches + "\n" +
  "  Auto-applicable: " + autoCount + "\n\n" +
  "## Verify\n" +
  "  Checks run: " + verResults.length + "\n" +
  "  All passed: " + allPassed + "\n" +
  verResults.map(function (r) { return "  - " + r.check + ": " + r.status; }).join("\\n") + "\n\n" +
  "## Manual mappings requiring attention\n" +
  mappings.filter(function (m) { return m.confidence === "manual" || m.confidence === "low"; })
    .map(function (m) { return "  - " + m.old_api + " → " + m.new_api + " (" + m.confidence + "): " + m.notes; }).join("\\n") + "\n\n" +
  "Write:\n" +
  "1. A 2-4 sentence executive summary\n" +
  "2. Stats object with total_files, total_imports, auto_migrated, manual_required, verification_passed\n" +
  "3. Remaining items list — files needing manual migration, with issue + suggestion for each",
  { label: "migrate:report", phase: "Report", schema: REPORT_SHAPE }
);

if (!reportRaw) {
  return {
    from: fromLib,
    to: toLib,
    root: root,
    summary: "Migration from " + fromLib + " to " + toLib + ": " + autoCount + " patches auto-generated, " + manualCount + " APIs need manual review. " + (allPassed ? "Verification passed." : "Some verification failures — see below."),
    stats: {
      total_files: (detected.stats && detected.stats.total_files) || 0,
      total_imports: imports.length,
      auto_migrated: autoCount,
      manual_required: manualCount,
      verification_passed: allPassed,
    },
    remaining: mappings.filter(function (m) { return m.confidence === "manual" || m.confidence === "low"; }).map(function (m) {
      return { file: "(various)", issue: m.old_api + " has no direct equivalent in " + toLib, suggestion: m.notes };
    }),
    mappings: mappings,
    patches: patches,
    verification: verification,
    phases_completed: ["Detect", "Map", "Transform", "Verify", "Report"],
  };
}

return {
  from: fromLib,
  to: toLib,
  root: root,
  summary: reportRaw.summary,
  stats: reportRaw.stats,
  remaining: reportRaw.remaining,
  mappings: mappings,
  patches: patches,
  verification: verification,
  phases_completed: ["Detect", "Map", "Transform", "Verify", "Report"],
  next_steps: [
    "Apply auto-applicable patches ",
    "Review and apply manual patches one at a time",
    "Run full test suite after all patches are applied",
    "Run typecheck to catch any remaining type errors",
    "Update any documentation referencing " + fromLib,
  ],
};
`
