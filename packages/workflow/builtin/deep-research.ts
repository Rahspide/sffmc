// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// Canonical deep-research workflow, ported from MiMo-Code
// (XiaomiMiMo/MiMo-Code @ 42e7da3 — packages/opencode/src/workflow/builtin/deep-research.js).
//
// Six phases: Plan → Search → Extract → Group → Crosscheck → Report.
// Adversarial jury (3 jurors, 2-reject quorum) validates every fact.
//
// The exported `source` string is the raw workflow script that runs inside
// the quickjs-emscripten sandbox.  It is registered as a built-in in
// ../src/builtin-registry.ts so anyone can invoke it with:
//
//   workflow({ operation: "run", name: "deep-research", args: { question: "..." } })

import type { Meta } from "../src/meta.ts"

// ── Meta (used by both the source string AND the registry) ──────────────────

export const meta: Meta = {
  name: "deep-research",
  description:
    "Deep research orchestrator — runs parallel web searches, reads the strongest sources, cross-checks each fact with an adversarial jury, and writes a cited report.",
  whenToUse:
    "Use when the user wants a thorough, multi-source, fact-checked answer rather than a quick reply.",
  phases: [
    { title: "Plan",       detail: "Break the question (from args) into several complementary search lines" },
    { title: "Search",     detail: "One web-search agent per line, in parallel" },
    { title: "Extract",    detail: "De-duplicate URLs, read the top sources, pull out checkable facts" },
    { title: "Group",      detail: "Fold facts that assert the same thing into one so each is checked once" },
    { title: "Crosscheck", detail: "Adversarial jury per fact — a majority of reject votes drops it" },
    { title: "Report",     detail: "Rank survivors by certainty, merge, and cite" },
  ],
}

// ── Source string (executed inside quickjs-emscripten sandbox) ──────────────

export const source = `// SPDX-License-Identifier: MIT
// @sffmc/workflow — deep-research builtin

export const meta = {
  name: "deep-research",
  description: "Deep research orchestrator — runs parallel web searches, reads the strongest sources, cross-checks each fact with an adversarial jury, and writes a cited report.",
  whenToUse: "Use when the user wants a thorough, multi-source, fact-checked answer rather than a quick reply.",
  phases: [
    { title: "Plan",       detail: "Break the question (from args) into several complementary search lines" },
    { title: "Search",     detail: "One web-search agent per line, in parallel" },
    { title: "Extract",    detail: "De-duplicate URLs, read the top sources, pull out checkable facts" },
    { title: "Group",      detail: "Fold facts that assert the same thing into one so each is checked once" },
    { title: "Crosscheck", detail: "Adversarial jury per fact — a majority of reject votes drops it" },
    { title: "Report",     detail: "Rank survivors by certainty, merge, and cite" },
  ],
};

// ── Tunables ────────────────────────────────────────────────────────────────

const JURY_SIZE = 3;         // crosscheck voters per fact
const REJECT_QUORUM = 2;     // reject votes that kill a fact
const SOURCE_BUDGET = 15;    // hard cap on URLs read
const FACT_CAP = 25;         // hard cap on facts reaching crosscheck

// ── Structured-output shapes ───────────────────────────────────────────────

const PLAN_SHAPE = {
  type: "object", required: ["lines"],
  properties: {
    lines: { type: "array", items: {
      type: "object", required: ["topic", "why"],
      properties: {
        topic: { type: "string" },
        why: { type: "string" },
      },
    }},
  },
};

const HITS_SHAPE = {
  type: "object", required: ["hits"],
  properties: {
    hits: { type: "array", items: {
      type: "object", required: ["url", "title"],
      properties: {
        url: { type: "string" },
        title: { type: "string" },
        snippet: { type: "string" },
        tier: { type: "string" },
      },
    }},
  },
};

const READ_SHAPE = {
  type: "object", required: ["facts"],
  properties: {
    facts: { type: "array", items: {
      type: "object", required: ["claim", "quote", "source"],
      properties: {
        claim: { type: "string" },
        quote: { type: "string" },
        source: { type: "string" },
      },
    }},
  },
};

const VERDICT_SHAPE = {
  type: "object", required: ["verdict"],
  properties: {
    verdict: { enum: ["accept", "reject"] },
    reason: { type: "string" },
  },
};

const GROUP_SHAPE = {
  type: "object", required: ["groups"],
  properties: {
    groups: { type: "array", items: {
      type: "object", required: ["canonical", "members"],
      properties: {
        canonical: { type: "string" },
        members: { type: "array", items: { type: "number" } },
        urls: { type: "array", items: { type: "string" } },
      },
    }},
  },
};

const REPORT_SHAPE = {
  type: "object", required: ["summary", "sections"],
  properties: {
    summary: { type: "string" },
    sections: { type: "array", items: {
      type: "object", required: ["title", "body", "citations"],
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        citations: { type: "array", items: { type: "string" } },
      },
    }},
  },
};

// ── URL helpers ────────────────────────────────────────────────────────────

const canonURL = function (u) {
  try {
    const parsed = new URL(u);
    return (parsed.hostname.replace(/^www\\\\./, "") + parsed.pathname.replace(/\\/$/, "")).toLowerCase();
  } catch (_e) { return ("" + u).toLowerCase(); }
};

const FIT_RANK = { high: 0, medium: 1, low: 2 };

const hostFromURL = function (u) {
  try { return new URL(u).hostname.replace(/^www\\\\./, ""); }
  catch (_e) { return "unknown"; }
};

// ── Step 1: Plan ──────────────────────────────────────────────────────────

phase("Plan");

const TOPIC = (typeof args === "string" && args.trim()) || (args && args.question) || "";

if (!TOPIC) {
  return { error: "No research question provided. Pass the question as args.question or as a plain args string." };
}

const plan = await agent(
  "You are planning a research sweep. Turn the question below into complementary web searches.\\n\\n" +
  "## Question\\n" + TOPIC + "\\n\\n" +
  "## What to produce\\n" +
  "Break the question into 3-7 complementary search lines. Choose directions that fit the subject:\\n" +
  "- general overview · technical/academic depth · latest developments · skeptical/opposing takes · hands-on notes\\n" +
  "- a clinical question: mechanism · frequent causes · dangerous look-alikes · guideline sources · warning signs\\n" +
  "- a software question: current best practice · measured benchmarks · known limits · who ships it · cost & trade-offs\\n\\n" +
  "Keep each line tight enough to surface high-signal pages. Do not let two lines overlap.\\n" +
  "Return structured output only.",
  { label: "plan", schema: PLAN_SHAPE }
);

if (!plan) {
  return { error: "Planning step produced nothing — cannot split the question into searches." };
}

log("Q: " + TOPIC.slice(0, 80) + (TOPIC.length > 80 ? "\\u2026" : ""));
log("Split into " + plan.lines.length + " lines: " + plan.lines.map(function (l) { return l.topic; }).join(", "));

// ── Shared state for de-dup across pipeline stages ─────────────────────────

const taken = new Map();
const repeats = [];
const overflow = [];
let slotsLeft = SOURCE_BUDGET;

// ── Agent prompts ──────────────────────────────────────────────────────────

const searchPrompt = function (line) {
  return "You are one of several researchers, each chasing a different line of inquiry.\\n\\n" +
    "Overall question: \\"" + TOPIC + "\\"\\n\\n" +
    "Your line: **" + line.topic + "**" + (line.why ? " — " + line.why : "") + "\\n\\n" +
    "Run WebSearch and hand back the 4-6 most useful results.\\n" +
    "Judge usefulness against the OVERALL question, not just your line. Drop content farms and SEO spam.\\n" +
    "Give each result a one-line snippet on why it matters.\\n\\nReturn structured output only.";
};

const readPrompt = function (source, line) {
  return "Read one source and pull out checkable facts.\\n\\n" +
    "Overall question: \\"" + TOPIC + "\\"\\n\\n" +
    "**URL:** " + source.url + "\\n**Title:** " + source.title + "\\n**Surfaced by:** the \\"" + line + "\\" line\\n\\n" +
    "## Steps\\n1. Fetch the page with WebFetch.\\n" +
    "2. Pull 2-5 FALSIFIABLE facts that bear on the question. Each fact must:\\n" +
    "   - state something concrete and checkable (no vague hand-waving)\\n" +
    "   - quote the source verbatim as backing\\n" +
    "   - include the source URL\\n" +
    "3. If the page will not load or is off-topic, return facts: [].\\n\\nReturn structured output only.";
};

const groupPrompt = function (facts) {
  return "Fold together the facts below that assert the SAME thing, so each assertion gets checked only once.\\n\\n" +
    "Overall question: \\"" + TOPIC + "\\"\\n\\n" +
    "Merge only facts that make the same claim (even if worded differently or from different sources). " +
    "If you are unsure, leave them apart — collapsing two distinct facts can let a shaky one ride on a solid one's coattails.\\n\\n" +
    "## Facts (index: claim — source)\\n" +
    facts.map(function (f, i) { return i + ": " + f.claim + " — " + f.source; }).join("\\n") + "\\n\\n" +
    "Per group, return a single canonical wording, the member indices, and the combined source URLs.\\n\\nReturn structured output only.";
};

const crosscheckPrompt = function (fact, n) {
  return "You are juror " + (n + 1) + " of " + JURY_SIZE + ", and your job is to try to KNOCK THIS DOWN.\\n\\n" +
    "Stay skeptical. " + REJECT_QUORUM + " of " + JURY_SIZE + " jurors voting reject will drop the fact.\\n\\n" +
    "## Question in scope\\n" + TOPIC + "\\n\\n" +
    "## Fact on trial\\n\\"" + fact.statement + "\\"\\n\\n" +
    "**Source:** " + fact.source + "\\n**Quote:** \\"" + fact.quote + "\\"\\n\\n" +
    "## Run through these\\n" +
    "1. Does the quote actually back the fact, or is the fact reaching beyond it?\\n" +
    "2. Search for contradicting evidence — does any trustworthy source disagree or add big caveats?\\n" +
    "3. Is the source strong enough for how bold the fact is? (big claims need primary sources)\\n" +
    "4. Has it gone stale? (check dates — old facts in fast-moving areas are suspect)\\n" +
    "5. Is it really marketing copy, a press release, a cherry-picked number, or forum chatter?\\n\\n" +
    "Vote **verdict: \\"reject\\"** when: the quote does not support it / something contradicts it / the source is too weak for the claim / it's outdated / it's spin.\\n" +
    "Vote **verdict: \\"accept\\"** only when the fact is well-backed, current, and the source matches its boldness.\\n" +
    "When genuinely unsure, reject. Your reason MUST be concrete.\\n\\nReturn structured output only.";
};

// ── Step 2 + 3: Search → de-dup → read (pipeline with two stages) ─────────

const perLine = await pipeline(
  plan.lines,

  // Stage 1 — search
  function (line) {
    return agent(searchPrompt(line), {
      label: "search:" + line.topic, phase: "Search", schema: HITS_SHAPE
    }).then(function (r) {
      if (!r) return null;
      log(line.topic + ": " + r.hits.length + " hits");
      return { line: line.topic, hits: r.hits };
    });
  },

  // Stage 2 — de-dup + read
  function (found) {
    if (!found) return null;

    const byFit = [].concat(found.hits).sort(function (a, b) {
      return (FIT_RANK[a.tier] || 0) - (FIT_RANK[b.tier] || 0);
    });

    const fresh = [];
    for (var i = 0; i < byFit.length; i++) {
      var h = byFit[i];
      var key = canonURL(h.url);
      if (taken.has(key)) {
        repeats.push({ url: h.url, title: h.title, line: found.line, sameAs: taken.get(key) });
        continue;
      }
      if (slotsLeft <= 0 && (FIT_RANK[h.tier] || 0) >= 1) {
        overflow.push({ url: h.url, title: h.title, line: found.line });
        continue;
      }
      taken.set(key, { line: found.line, title: h.title });
      slotsLeft--;
      fresh.push(h);
    }

    if (fresh.length < found.hits.length) {
      log(found.line + ": " + fresh.length + " fresh (" + (found.hits.length - fresh.length) + " dropped)");
    }

    return parallel(
      fresh.map(function (source) {
        return function () {
          var host = hostFromURL(source.url);
          return agent(readPrompt(source, found.line), {
            label: "read:" + host,
            phase: "Extract",
            schema: READ_SHAPE,
          }).then(function (out) {
            if (!out) return null;
            return {
              url: source.url, title: source.title, line: found.line,
              facts: out.facts.map(function (f) { return { claim: f.claim, quote: f.quote, source: f.source || source.url }; }),
            };
          }).catch(function (e) {
            log("read failed: " + source.url + " — " + (e.message || e));
            return { url: source.url, title: source.title, line: found.line, facts: [] };
          });
        };
      })
    );
  }
);

const sources = (perLine || []).flat().filter(Boolean);
const facts = [];
for (var si = 0; si < sources.length; si++) {
  var sf = sources[si];
  if (sf && sf.facts) {
    for (var fi = 0; fi < sf.facts.length; fi++) {
      facts.push(sf.facts[fi]);
    }
  }
}

const topFacts = facts.slice(0, FACT_CAP);

log("Read " + sources.length + " sources \\u2192 " + facts.length + " facts \\u2192 checking top " + topFacts.length);

if (topFacts.length === 0) {
  return {
    question: TOPIC,
    summary: "No facts could be extracted. " + sources.length + " sources read, all empty or failed.",
    sections: [],
    stats: { lines: plan.lines.length, sources: sources.length, facts: 0, repeats: repeats.length },
  };
}

// ── Step 4: Group ─────────────────────────────────────────────────────────

phase("Group");

const grouped = await agent(groupPrompt(topFacts), { label: "group", phase: "Group", schema: GROUP_SHAPE });

const groups = (grouped && grouped.groups && grouped.groups.length)
  ? grouped.groups.map(function (g) {
      var members = (g.members || []).filter(function (i) { return i >= 0 && i < topFacts.length; });
      var head = topFacts[members[0] != null ? members[0] : 0] || {};
      var urls = (g.urls && g.urls.length ? g.urls : members.map(function (i) { return topFacts[i].source; }));
      return { statement: g.canonical || head.claim || "(unknown)", quote: head.quote || "", source: (urls[0] || head.source || ""), urls: urls };
    })
  : topFacts.map(function (f) { return { statement: f.claim, quote: f.quote, source: f.source, urls: [f.source] }; });

log("Folded " + topFacts.length + " facts \\u2192 " + groups.length + " groups");

// ── Step 5: Crosscheck ────────────────────────────────────────────────────

phase("Crosscheck");

const judged = (await parallel(
  groups.map(function (fact) {
    return function () {
      return parallel(
        Array.from({ length: JURY_SIZE }, function (_, n) {
          return function () {
            return agent(crosscheckPrompt(fact, n), {
              label: "j" + n + ":" + fact.statement.slice(0, 40),
              phase: "Crosscheck",
              schema: VERDICT_SHAPE,
            });
          };
        })
      ).then(function (rulings) {
        var cast = rulings.filter(Boolean);
        var rejects = 0;
        for (var i = 0; i < cast.length; i++) {
          if (cast[i].verdict === "reject") rejects++;
        }
        var abstain = JURY_SIZE - cast.length;
        var kept = cast.length >= REJECT_QUORUM && rejects < REJECT_QUORUM;
        log("\\"" + fact.statement.slice(0, 50) + "\\u2026\\": " + (cast.length - rejects) + "-" + rejects + (abstain > 0 ? " (" + abstain + " abstain)" : "") + " " + (kept ? "\\u2713" : "\\u2717"));
        return { fact: fact, verdicts: cast, rejectCount: rejects, kept: kept };
      });
    };
  })
)).filter(Boolean);

var upheld = [];
var dropped = [];
for (var ji = 0; ji < judged.length; ji++) {
  var j = judged[ji];
  if (j.kept) upheld.push(j); else dropped.push(j);
}

log("Crosscheck done: " + judged.length + " facts \\u2192 " + upheld.length + " upheld, " + dropped.length + " dropped");

if (upheld.length === 0) {
  return {
    question: TOPIC,
    summary: "Every one of the " + judged.length + " facts was rejected on crosscheck. Inconclusive — sources were likely weak or claims overstated.",
    sections: [],
    rejected: dropped.map(function (f) { return { statement: f.fact.statement, tally: (f.verdicts.length - f.rejectCount) + "-" + f.rejectCount, source: f.fact.source }; }),
    sources: sources.map(function (s) { return { url: s.url, factCount: (s.facts || []).length }; }),
    stats: { lines: plan.lines.length, sources: sources.length, facts: facts.length, checked: judged.length, upheld: 0, dropped: dropped.length },
  };
}

// ── Step 6: Report ────────────────────────────────────────────────────────

phase("Report");

var digest = upheld.map(function (entry, i) {
  var f = entry.fact;
  var rulings = entry.verdicts;
  return "### [" + i + "] " + f.statement + "\\n" +
    "Tally: " + (rulings.length - entry.rejectCount) + "-" + entry.rejectCount + " · Sources: " + (f.urls || [f.source]).join(", ") + "\\n" +
    "Quote: \\"" + f.quote + "\\"\\n";
}).join("\\n");

var droppedDigest = dropped.length > 0
  ? "\\n## Rejected on crosscheck (shown for transparency)\\n" +
    dropped.map(function (entry) {
      return "- \\"" + entry.fact.statement + "\\" (" + entry.fact.source + ", tally " + (entry.verdicts.length - entry.rejectCount) + "-" + entry.rejectCount + ")";
    }).join("\\n")
  : "";

const report = await agent(
  "## Write the research report\\n\\n" +
  "**Question:** " + TOPIC + "\\n\\n" +
  upheld.length + " facts came through a " + JURY_SIZE + "-juror crosscheck. Fold any remaining duplicates and write this up.\\n\\n" +
  "## Facts that held up\\n" + digest + "\\n" + droppedDigest + "\\n\\n" +
  "## How to write it\\n" +
  "1. Merge facts that say the same thing and pool their sources.\\n" +
  "2. Gather related facts into coherent sections, each one speaking to the question.\\n" +
  "3. Open with a 3-5 sentence summary answering the question.\\n" +
  "4. Each section needs: a title, a body paragraph, and citations (source URLs).\\n" +
  "5. End with limits — what is shaky, what sources were thin, what may have gone stale.\\n\\nReturn structured output only.",
  { label: "report", schema: REPORT_SHAPE }
);

if (!report) {
  return {
    question: TOPIC,
    summary: "Report step was skipped or failed — returning " + upheld.length + " checked facts unmerged.",
    sections: [],
    upheld: upheld.map(function (entry) {
      return { statement: entry.fact.statement, source: entry.fact.source, quote: entry.fact.quote, tally: (entry.verdicts.length - entry.rejectCount) + "-" + entry.rejectCount };
    }),
    rejected: dropped.map(function (entry) {
      return { statement: entry.fact.statement, tally: (entry.verdicts.length - entry.rejectCount) + "-" + entry.rejectCount, source: entry.fact.source };
    }),
    sources: sources.map(function (s) { return { url: s.url, factCount: (s.facts || []).length }; }),
    stats: { lines: plan.lines.length, sources: sources.length, facts: facts.length, checked: judged.length, upheld: upheld.length, dropped: dropped.length },
  };
}

return {
  question: TOPIC,
  summary: report.summary,
  sections: report.sections,
  rejected: dropped.map(function (entry) {
    return { statement: entry.fact.statement, tally: (entry.verdicts.length - entry.rejectCount) + "-" + entry.rejectCount, source: entry.fact.source };
  }),
  sources: sources.map(function (s) { return { url: s.url, factCount: (s.facts || []).length }; }),
  stats: {
    lines: plan.lines.length,
    sourcesRead: sources.length,
    factsFound: facts.length,
    factsChecked: judged.length,
    upheld: upheld.length,
    dropped: dropped.length,
    repeatUrls: repeats.length,
    overBudget: overflow.length,
  },
};
`

// Total ~280 LOC in the source string
