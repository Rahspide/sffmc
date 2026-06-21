// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// `security-audit` builtin workflow: 4-phase SCA-like security scan.
//
// Phases: Scope → Scan → Triage → Report.
// Scan phase uses parallel agents for throughput.
// Outputs structured Findings[] with severity scoring and remediation.
//
// Invoked via:
//
//   workflow({ operation: "run", name: "security-audit", args: { root: "/path/to/project" } })

import type { Meta } from "../src/meta.ts"

// ── Meta (used by both the source string AND the registry) ──────────────────

export const meta: Meta = {
  name: "security-audit",
  description:
    "Security auditor — scans a codebase for secrets, unsafe patterns, vulnerable dependencies, and missing security headers. Scores each finding by severity (critical/high/medium/low) and produces a remediation report.",
  whenToUse:
    "Use when you need a security review of a project — before deployment, after a dependency update, or during code review. Scans for common CVEs, hardcoded secrets, unsafe eval/exec patterns, and missing headers.",
  phases: [
    { title: "Scope",  detail: "Identify audit target: project root, specific paths, dependency manifest" },
    { title: "Scan",   detail: "Parallel agents scan for secrets, unsafe patterns, vulnerable deps, and missing security headers" },
    { title: "Triage", detail: "Score each finding by severity (critical/high/medium/low) and de-duplicate" },
    { title: "Report", detail: "Generate a findings document with remediation steps for each issue" },
  ],
}

// ── Source string (executed inside quickjs-emscripten sandbox) ──────────────

export const source = `// SPDX-License-Identifier: MIT
// @sffmc/workflow — security-audit builtin

export const meta = {
  name: "security-audit",
  description: "Security auditor — scans a codebase for secrets, unsafe patterns, vulnerable dependencies, and missing security headers. Scores each finding by severity (critical/high/medium/low) and produces a remediation report.",
  whenToUse: "Use when you need a security review of a project — before deployment, after a dependency update, or during code review.",
  phases: [
    { title: "Scope",  detail: "Identify audit target: project root, specific paths, dependency manifest" },
    { title: "Scan",   detail: "Parallel agents scan for secrets, unsafe patterns, vulnerable deps, and missing security headers" },
    { title: "Triage", detail: "Score each finding by severity (critical/high/medium/low) and de-duplicate" },
    { title: "Report", detail: "Generate a findings document with remediation steps for each issue" },
  ],
};

// ── Tunables ────────────────────────────────────────────────────────────────

const SECRET_PATTERNS = ["API_KEY", "SECRET", "TOKEN", "PASSWORD", "PRIVATE_KEY", "AUTH_TOKEN"];
const UNSAFE_FUNCTIONS = ["eval(", "exec(", "child_process", "Function(", "setTimeout(", "setInterval("];
const HEADER_CHECKS = ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Strict-Transport-Security"];

// ── Structured-output shapes ──────────────────────────────────────────────

const SCOPE_SHAPE = {
  type: "object", required: ["targets", "files_scanned", "dependencies_found"],
  properties: {
    targets: { type: "array", items: { type: "string" }, description: "Paths to scan" },
    files_scanned: { type: "number", description: "Approximate file count" },
    dependencies_found: { type: "number", description: "Number of dependencies detected" },
    package_manager: { type: "string", description: "npm, pip, cargo, etc." },
    notes: { type: "string", description: "Scope notes" },
  },
};

const SCAN_SHAPE = {
  type: "object", required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["category", "location", "description"],
        properties: {
          category: { type: "string", enum: ["secret", "unsafe-pattern", "vulnerable-dependency", "missing-header"] },
          location: { type: "string", description: "file:line or package@version" },
          description: { type: "string", description: "What was found and why it matters" },
          evidence: { type: "string", description: "Snippet or package name" },
        },
      },
    },
  },
};

const TRIAGE_SHAPE = {
  type: "object", required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["category", "location", "description", "severity", "remediation"],
        properties: {
          category: { type: "string" },
          location: { type: "string" },
          description: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          remediation: { type: "string", description: "Step-by-step fix" },
          cve: { type: "string", description: "CVE ID if applicable" },
          cvss: { type: "number", description: "CVSS score if available" },
        },
      },
    },
  },
};

const REPORT_SHAPE = {
  type: "object", required: ["summary", "findings", "stats"],
  properties: {
    summary: { type: "string", description: "Executive summary of the audit" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "category", "title", "location", "remediation"],
        properties: {
          severity: { type: "string" },
          category: { type: "string" },
          title: { type: "string" },
          location: { type: "string" },
          remediation: { type: "string" },
        },
      },
    },
    stats: {
      type: "object",
      required: ["critical", "high", "medium", "low", "total"],
      properties: {
        critical: { type: "number" },
        high: { type: "number" },
        medium: { type: "number" },
        low: { type: "number" },
        total: { type: "number" },
      },
    },
  },
};

// ── Scope ────

phase("Scope");

const root = String(args.root || args.target || "").trim();
if (!root) {
  throw new Error("security-audit builtin requires args.root or args.target (project path)");
}

// Discover project structure
let scopeFiles = [];
try {
  const files = glob(root + "/**/*.{ts,js,py,go,rs,java,rb,php,sh,yaml,yml,json,toml,env,cfg,conf}");
  scopeFiles = (files || []).slice(0, 500);
} catch (_e) {
  scopeFiles = [];
}

const scopeRaw = await agent(
  "Scope the security audit target.\n\n" +
  "ROOT: " + root + "\n\n" +
  "Discovered " + scopeFiles.length + " source/config files.\n\n" +
  "Identify:\n" +
  "  - Which paths are in scope (source, config, tests, scripts)\n" +
  "  - What package manager and dependency files exist (package.json, requirements.txt, Cargo.toml, etc.)\n" +
  "  - How many dependencies the project has\n" +
  "  - Any notable security-relevant configs (CI pipelines, Dockerfiles, nginx configs)",
  { label: "audit:scope", phase: "Scope", schema: SCOPE_SHAPE }
);

const scope = scopeRaw || { targets: [root], files_scanned: scopeFiles.length, dependencies_found: 0, package_manager: "unknown", notes: "Auto-detected" };

log("Auditing: " + root + " — " + scope.files_scanned + " files, " + scope.dependencies_found + " deps");

// ── Scan (parallel agents) ────

phase("Scan");

const scanTasks = [
  {
    category: "secret",
    prompt: "SCAN FOR HARDCODED SECRETS.\n\n" +
      "Target: " + root + "\n" +
      "Files: " + scopeFiles.length + " source/config files\n\n" +
      "Search for: API keys, tokens, passwords, private keys, auth tokens, connection strings with credentials.\n" +
      "Patterns to look for: " + SECRET_PATTERNS.join(", ") + "\n\n" +
      "For each finding, provide: category='secret', location (file:line), description, evidence (redacted snippet).\n" +
      "Return findings: [] if none found.",
  },
  {
    category: "unsafe-pattern",
    prompt: "SCAN FOR UNSAFE CODE PATTERNS.\n\n" +
      "Target: " + root + "\n" +
      "Files: " + scopeFiles.length + " source files\n\n" +
      "Look for: eval(), exec(), child_process.spawn/exec, Function() constructor, unsafe deserialization,\n" +
      "SQL injection patterns (string concatenation in queries), command injection, path traversal.\n" +
      "Specific patterns: " + UNSAFE_FUNCTIONS.join(", ") + "\n\n" +
      "For each finding: category='unsafe-pattern', location (file:line), description, evidence (code snippet).\n" +
      "Return findings: [] if none found.",
  },
  {
    category: "vulnerable-dependency",
    prompt: "SCAN FOR VULNERABLE DEPENDENCIES.\n\n" +
      "Target: " + root + "\n" +
      "Package manager: " + (scope.package_manager || "auto-detect") + "\n\n" +
      "Check dependency manifests for known-vulnerable versions. Look for:\n" +
      "  - Outdated packages with known CVEs\n" +
      "  - Packages without recent updates (>1 year old)\n" +
      "  - Transitive dependencies from unmaintained sources\n" +
      "  - Packages with known security advisories\n\n" +
      "For each finding: category='vulnerable-dependency', location (package@version), description, evidence.\n" +
      "Return findings: [] if none found.",
  },
  {
    category: "missing-header",
    prompt: "SCAN FOR MISSING SECURITY HEADERS.\n\n" +
      "Target: " + root + "\n\n" +
      "Check server configs, middleware, nginx configs, response headers for:\n" +
      HEADER_CHECKS.map(function (h) { return "  - " + h; }).join("\\n") + "\n\n" +
      "Also check for: CORS misconfiguration, missing CSRF protection, insecure cookies (missing HttpOnly/Secure/SameSite),\n" +
      "clickjacking susceptibility, HSTS absence.\n\n" +
      "For each finding: category='missing-header', location (config file:line), description, evidence.\n" +
      "Return findings: [] if none found.",
  },
];

const scanResults = await parallel(
  scanTasks.map(function (task) {
    return function () {
      return agent(task.prompt, {
        label: "scan:" + task.category,
        phase: "Scan",
        schema: SCAN_SHAPE,
      }).then(function (r) {
        if (!r || !r.findings) return [];
        log(task.category + ": " + r.findings.length + " findings");
        return r.findings;
      }).catch(function (e) {
        log("scan " + task.category + " failed: " + (e.message || e));
        return [];
      });
    };
  })
);

const rawFindings = [];
for (var i = 0; i < scanResults.length; i++) {
  var batch = scanResults[i];
  if (batch && batch.length) {
    for (var j = 0; j < batch.length; j++) {
      rawFindings.push(batch[j]);
    }
  }
}

log("Scan complete: " + rawFindings.length + " raw findings across " + scanTasks.length + " categories");

if (rawFindings.length === 0) {
  return {
    root: root,
    summary: "No security issues found. " + scope.files_scanned + " files scanned, " + scope.dependencies_found + " dependencies checked.",
    findings: [],
    stats: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    scan_categories: scanTasks.map(function (t) { return t.category; }),
  };
}

// ── Triage ────

phase("Triage");

const triageRaw = await agent(
  "Triage the following security findings. Score each by severity and write remediation steps.\n\n" +
  "## Raw Findings (" + rawFindings.length + ")\n\n" +
  rawFindings.map(function (f, i) {
    return "[" + i + "] " + f.category + " at " + f.location + ": " + f.description;
  }).join("\\n") + "\n\n" +
  "## Severity rules\n" +
  "- **critical**: Hardcoded production credentials, RCE via user input, known CVEs with CVSS ≥ 9.0, auth bypass\n" +
  "- **high**: Unsafe eval/exec with user-controlled input, vulnerable deps with known exploits, missing auth headers on sensitive endpoints\n" +
  "- **medium**: Unsafe patterns in non-critical paths, outdated deps without known exploits, missing security headers on non-sensitive pages\n" +
  "- **low**: Minor config issues, informational findings, defense-in-depth improvements\n\n" +
  "For each finding, write 1-3 sentence remediation. De-duplicate similar findings (same root cause, different locations).\n" +
  "If a finding is a false positive, drop it and explain why in a note.\n\n" +
  "Return the triaged list with severity and remediation.",
  { label: "audit:triage", phase: "Triage", schema: TRIAGE_SHAPE }
);

const triaged = triageRaw || { findings: [] };
const findings = triaged.findings || [];

// ── Report ────

phase("Report");

const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

const stats = { critical: 0, high: 0, medium: 0, low: 0, total: findings.length };
for (var si = 0; si < findings.length; si++) {
  var sev = findings[si].severity;
  if (sev === "critical") stats.critical++;
  else if (sev === "high") stats.high++;
  else if (sev === "medium") stats.medium++;
  else stats.low++;
}

const sortedFindings = findings.slice().sort(function (a, b) {
  return (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99);
});

const reportRaw = await agent(
  "Write the security audit report.\n\n" +
  "## Project: " + root + "\n" +
  "## Scope: " + scope.files_scanned + " files, " + scope.dependencies_found + " dependencies\n\n" +
  "## Triage Results (" + findings.length + " findings)\n" +
  "  Critical: " + stats.critical + "\n" +
  "  High: " + stats.high + "\n" +
  "  Medium: " + stats.medium + "\n" +
  "  Low: " + stats.low + "\n\n" +
  "## Findings\n" +
  sortedFindings.map(function (f, i) {
    var cve = f.cve ? " (CVE: " + f.cve + ")" : "";
    return "[" + i + "] [" + f.severity.toUpperCase() + "] " + f.category + " at " + f.location + cve + "\\n" +
      "  Description: " + f.description + "\\n" +
      "  Remediation: " + f.remediation;
  }).join("\\n\\n") + "\n\n" +
  "Write an executive summary (2-4 sentences), then format each finding with a clear title, severity, category, location, and step-by-step remediation. " +
  "Include the stats object.",
  { label: "audit:report", phase: "Report", schema: REPORT_SHAPE }
);

if (!reportRaw || !reportRaw.findings) {
  return {
    root: root,
    summary: "Audit completed. " + stats.total + " findings identified (" + stats.critical + " critical, " + stats.high + " high, " + stats.medium + " medium, " + stats.low + " low).",
    findings: sortedFindings,
    stats: stats,
    phases_completed: ["Scope", "Scan", "Triage", "Report"],
  };
}

return {
  root: root,
  summary: reportRaw.summary,
  findings: reportRaw.findings,
  stats: reportRaw.stats,
  phases_completed: ["Scope", "Scan", "Triage", "Report"],
  remediation_priority: "Address critical items immediately. High items within this sprint. Medium/low items in the next cycle.",
};
`
