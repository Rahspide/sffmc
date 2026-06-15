// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// `doc-gen` builtin workflow: 3-phase API documentation generator.
//
// Phases: Inventory → Generate → Assemble.
// Scans codebase for public APIs, generates docstrings + usage examples,
// and assembles a docs/api.md artifact.
//
// Invoked via:
//
//   workflow({ operation: "run", name: "doc-gen", args: { root: "/path/to/project" } })

import type { Meta } from "../src/meta.ts"

// ── Meta (used by both the source string AND the registry) ──────────────────

export const meta: Meta = {
  name: "doc-gen",
  description:
    "API documentation generator — scans a codebase for public APIs (functions, classes, exports), generates docstrings with usage examples, and assembles a docs/api.md artifact.",
  whenToUse:
    "Use when you need to generate or refresh API documentation for a codebase. Works well after adding new public APIs or before a release.",
  phases: [
    { title: "Inventory", detail: "Scan codebase, find all public APIs (exported functions, classes, types, constants)" },
    { title: "Generate",  detail: "For each API, generate a docstring + usage example using LLM agents" },
    { title: "Assemble",  detail: "Produce a docs/api.md artifact with all documented APIs" },
  ],
}

// ── Source string (executed inside quickjs-emscripten sandbox) ──────────────

export const source = `// SPDX-License-Identifier: MIT
// @sffmc/workflow — doc-gen builtin

export const meta = {
  name: "doc-gen",
  description: "API documentation generator — scans a codebase for public APIs (functions, classes, exports), generates docstrings with usage examples, and assembles a docs/api.md artifact.",
  whenToUse: "Use when you need to generate or refresh API documentation for a codebase. Works well after adding new public APIs or before a release.",
  phases: [
    { title: "Inventory", detail: "Scan codebase, find all public APIs (exported functions, classes, types, constants)" },
    { title: "Generate",  detail: "For each API, generate a docstring + usage example using LLM agents" },
    { title: "Assemble",  detail: "Produce a docs/api.md artifact with all documented APIs" },
  ],
};

// ── Tunables ────────────────────────────────────────────────────────────────

const MAX_APIS = 100;
const MAX_FILE_BYTES = 30_000;
const BATCH_SIZE = 5; // APIs per generation batch

// ── Structured-output shapes ──────────────────────────────────────────────

const INVENTORY_SHAPE = {
  type: "object", required: ["apis"],
  properties: {
    apis: {
      type: "array",
      maxItems: MAX_APIS,
      items: {
        type: "object",
        required: ["name", "kind", "file", "signature"],
        properties: {
          name: { type: "string", description: "Function/class/type name" },
          kind: { type: "string", enum: ["function", "class", "type", "interface", "const", "enum", "namespace"] },
          file: { type: "string", description: "Source file path relative to root" },
          signature: { type: "string", description: "Full signature or declaration line" },
          exported: { type: "boolean", description: "Whether it's publicly exported" },
        },
      },
    },
    stats: {
      type: "object",
      properties: {
        total_files: { type: "number" },
        total_apis: { type: "number" },
        by_kind: { type: "object", description: "Count by kind" },
      },
    },
  },
};

const DOC_SHAPE = {
  type: "object", required: ["name", "docstring", "example", "params", "returns"],
  properties: {
    name: { type: "string" },
    docstring: { type: "string", description: "JSDoc/TSDoc formatted description" },
    example: { type: "string", description: "Usage example in code" },
    params: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "type", "description"],
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    returns: {
      type: "object",
      required: ["type", "description"],
      properties: {
        type: { type: "string" },
        description: { type: "string" },
      },
    },
  },
};

const ASSEMBLE_SHAPE = {
  type: "object", required: ["markdown"],
  properties: {
    markdown: { type: "string", description: "Full docs/api.md content" },
    toc: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "anchor"],
        properties: {
          title: { type: "string" },
          anchor: { type: "string" },
        },
      },
    },
  },
};

// ── Phase 1: Inventory ─────────────────────────────────────────────────────

phase("Inventory");

const root = String(args.root || args.target || "").trim();
if (!root) {
  throw new Error("doc-gen builtin requires args.root or args.target (project path)");
}

// Discover source files
var sourceFiles = [];
try {
  var patterns = [
    root + "/**/*.ts",
    root + "/**/*.tsx",
    root + "/**/*.js",
    root + "/**/*.jsx",
    root + "/**/*.py",
    root + "/**/*.go",
    root + "/**/*.rs",
  ];
  for (var pi = 0; pi < patterns.length; pi++) {
    try {
      var found = glob(patterns[pi]);
      if (found && found.length) {
        for (var fi = 0; fi < found.length; fi++) {
          sourceFiles.push(found[fi]);
        }
      }
    } catch (_e) { /* skip unsupported patterns */ }
  }
  // Exclude test files, node_modules, dist
  sourceFiles = sourceFiles.filter(function (f) {
    return !(/node_modules|dist|build|__tests__|\.test\\.|\\.spec\\.|vendor/.test(f));
  }).slice(0, 200);
} catch (_e) {
  sourceFiles = [];
}

log("Found " + sourceFiles.length + " source files to scan");

if (sourceFiles.length === 0) {
  return {
    root: root,
    summary: "No source files found at " + root,
    apis: [],
    markdown: "# API Documentation\\n\\nNo source files found.",
  };
}

// Read a sample of files for context
var fileContents = "";
var filesRead = 0;
for (var fi = 0; fi < sourceFiles.length && filesRead < 10; fi++) {
  var fp = sourceFiles[fi];
  if (!exists(fp)) continue;
  var content = readFile(fp);
  if (!content || content.length > MAX_FILE_BYTES) continue;
  fileContents += "\\n\\n=== " + fp + " ===\\n" + content.slice(0, 2000);
  filesRead++;
}

const inventoryRaw = await agent(
  "Inventory all public APIs in the codebase.\n\n" +
  "ROOT: " + root + "\n" +
  "Source files found: " + sourceFiles.length + "\n\n" +
  "Sample file contents:\n" + fileContents + "\n\n" +
  "## Task\n" +
  "Identify all PUBLICLY EXPORTED APIs (functions, classes, types, interfaces, consts, enums).\n" +
  "For each API, provide:\n" +
  "  - name: the exported name\n" +
  "  - kind: 'function' | 'class' | 'type' | 'interface' | 'const' | 'enum' | 'namespace'\n" +
  "  - file: relative path to the source file\n" +
  "  - signature: the full declaration line (first line of the signature)\n" +
  "  - exported: true\n\n" +
  "Exclude: internal/private items, test files, build artifacts.\n" +
  "Limit to " + MAX_APIS + " most important APIs.\n" +
  "Group by file. Return stats with counts by kind.",
  { label: "doc-gen:inventory", phase: "Inventory", schema: INVENTORY_SHAPE }
);

const inventory = inventoryRaw || { apis: [], stats: { total_files: 0, total_apis: 0 } };
const apis = (inventory.apis || []).slice(0, MAX_APIS);

log("Inventoried " + apis.length + " APIs across " + (inventory.stats && inventory.stats.total_files || 0) + " files");

if (apis.length === 0) {
  return {
    root: root,
    summary: "No public APIs found to document.",
    apis: [],
    markdown: "# API Documentation\\n\\nNo public APIs found in " + root,
  };
}

// ── Phase 2: Generate (parallel batches) ───────────────────────────────────

phase("Generate");

// Split into batches
var batches = [];
for (var i = 0; i < apis.length; i += BATCH_SIZE) {
  batches.push(apis.slice(i, i + BATCH_SIZE));
}

var documented = [];
for (var bi = 0; bi < batches.length; bi++) {
  var batch = batches[bi];
  var batchResults = await parallel(
    batch.map(function (api) {
      return function () {
        return agent(
          "Generate documentation for a public API.\n\n" +
          "## API\n" +
          "  Name: " + api.name + "\n" +
          "  Kind: " + api.kind + "\n" +
          "  File: " + api.file + "\n" +
          "  Signature: " + api.signature + "\n\n" +
          "## Task\n" +
          "Write a complete docstring and usage example.\n\n" +
          "1. **docstring**: JSDoc/TSDoc format. Describe WHAT it does (not how), 1-3 sentences. Mention edge cases.\n" +
          "2. **example**: Realistic, runnable code example showing typical usage. 2-8 lines.\n" +
          "3. **params**: For each parameter — name, type, description (1 line each).\n" +
          "4. **returns**: Type and description of the return value.\n\n" +
          "If the kind is 'type' or 'interface', describe the shape and provide a construction example instead of params/returns.",
          { label: "doc:" + api.name, phase: "Generate", schema: DOC_SHAPE }
        ).then(function (r) {
          if (!r) return null;
          return { name: api.name, kind: api.kind, file: api.file, signature: api.signature, doc: r };
        }).catch(function (e) {
          log("doc gen failed for " + api.name + ": " + (e.message || e));
          return null;
        });
      };
    })
  );
  for (var ri = 0; ri < batchResults.length; ri++) {
    if (batchResults[ri]) documented.push(batchResults[ri]);
  }
}

log("Generated docs for " + documented.length + "/" + apis.length + " APIs");

// ── Phase 3: Assemble ──────────────────────────────────────────────────────

phase("Assemble");

// Build a summary of documented APIs for the assembler
var apiSummary = documented.map(function (entry) {
  return "### " + entry.name + " (" + entry.kind + ")\\n" +
    "**File:** " + entry.file + "\\n" +
    "**Signature:** \x60" + entry.signature + "\x60\\n\\n" +
    entry.doc.docstring + "\\n\\n" +
    "**Example:**\\n\x60\x60\x60\\n" + entry.doc.example + "\\n\x60\x60\x60\\n";
}).join("\\n---\\n\\n");

const assembleRaw = await agent(
  "Assemble the final API documentation markdown file.\n\n" +
  "## Project: " + root + "\n" +
  "## APIs Documented: " + documented.length + "\n\n" +
  "## Documentation Content\n" + apiSummary + "\n\n" +
  "## Task\n" +
  "Produce a well-structured docs/api.md file:\n\n" +
  "1. Title: '# API Reference' with a 1-2 sentence intro\n" +
  "2. Table of Contents: anchors linking to each section\n" +
  "3. Group APIs by kind (Functions, Classes, Types, etc.) or by file/module\n" +
  "4. For each API: name, signature, full docstring, params table, returns, example\n" +
  "5. End with a 'See Also' section linking to related docs if applicable\n\n" +
  "Use proper markdown formatting. The markdown field must contain the COMPLETE file content.",
  { label: "doc-gen:assemble", phase: "Assemble", schema: ASSEMBLE_SHAPE }
);

var markdown = (assembleRaw && assembleRaw.markdown)
  ? assembleRaw.markdown
  : "# API Reference\\n\\n" + apiSummary;

return {
  root: root,
  summary: "Documented " + documented.length + " public APIs across " + (inventory.stats && inventory.stats.total_files || 0) + " files.",
  apis: documented.map(function (e) {
    return {
      name: e.name,
      kind: e.kind,
      file: e.file,
      signature: e.signature,
      docstring: e.doc.docstring,
      example: e.doc.example,
    };
  }),
  markdown: markdown,
  toc: (assembleRaw && assembleRaw.toc) || [],
  phases_completed: ["Inventory", "Generate", "Assemble"],
  artifact_path: "docs/api.md",
  next_steps: [
    "Write the generated markdown to docs/api.md",
    "Review docstrings for accuracy against source",
    "Add cross-references to related APIs",
    "Regenerate when public API surface changes",
  ],
};
`
