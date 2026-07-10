// SPDX-License-Identifier: MIT
// @sffmc/extra — Dream LLM helpers
// Cluster-naming and cluster-summarization LLM calls + prompt builders
// extracted from dream.ts (M-3 Wave 1). Pure data builders (`buildXxxPrompt`)
// co-located with the call wrappers that hit `ctx.client.session.message`.

import { NoLLMClientError, type RichPluginContext } from "@sffmc/utilities";
import { DREAM_LLM_SNIPPET_LENGTH, DREAM_SNIPPET_LENGTH, type MemoryRow } from "./dream-types.ts";

/** LLM-based cluster naming: generates a 3-5 word topic phrase for a cluster.
 *   LOW migration: the per-entry preview length is now
 *  configurable via `snippetLength` (defaults to `DREAM_SNIPPET_LENGTH` = 100). */
export async function nameClusterViaLLM(
  cluster: MemoryRow[],
  ctx: RichPluginContext,
  model: string,
  snippetLength: number = DREAM_SNIPPET_LENGTH,
): Promise<string> {
  const session = ctx.client?.session;
  if (!session?.message) {
    throw new NoLLMClientError();
  }
  const { system, user } = buildNameClusterPrompt(cluster, snippetLength);
  const response = await session.message({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    model,
    temperature: 0.2,
  });
  const text = extractResponseText(response);
  return text || "untitled cluster";
}

/** Build the {system, user} prompt pair for cluster-naming. Pure data
 *  builder — no I/O, no LLM call. Shared entry format: `[source_path]
 *  preview-substring`. The system string contains "topic-namer" as the
 *  role marker (used by the cluster processing mock to route between
 *  naming and summarization calls); the user header is the contract with
 *  the LLM prompt.
 *
 *  Pinned by: dream.test.ts "nameClusterViaLLM prompt structure"
 *  describe block. */
function buildNameClusterPrompt(
  cluster: MemoryRow[],
  snippetLength: number,
): { system: string; user: string } {
  const entries = cluster.map(
    (e) => `[${e.source_path}] ${e.content.substring(0, snippetLength)}`,
  );
  return {
    system:
      "You are a topic-namer. Given a cluster of related memory entries, produce a 3-5 word phrase that names the topic. Output ONLY the phrase, nothing else.",
    user: `Name the topic of these ${cluster.length} related memory entries:\n\n${entries.join("\n\n")}`,
  };
}

/** LLM-based summarization: sends cluster entries to the model for a concise summary.
 *   LOW migration: the per-entry length is now configurable via
 *  `llmSnippetLength` (defaults to `DREAM_LLM_SNIPPET_LENGTH` = 200). */
export async function summarizeViaLLM(
  cluster: MemoryRow[],
  ctx: RichPluginContext,
  model: string,
  llmSnippetLength: number = DREAM_LLM_SNIPPET_LENGTH,
): Promise<string> {
  const session = ctx.client?.session;
  if (!session?.message) {
    throw new NoLLMClientError();
  }
  const { system, user } = buildSummarizeClusterPrompt(cluster, llmSnippetLength);
  const response = await session.message({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    model,
    temperature: 0.3,
  });
  const text = extractResponseText(response);
  return text || concatenateSummary(cluster);
}

/** Build the {system, user} prompt pair for cluster-summarization. Pure
 *  data builder; mirrors buildNameClusterPrompt. The system string
 *  contains "memory summarizer" as the role marker.
 *
 *  Pinned by: dream.test.ts "summarizeClusterContent prompt structure"
 *  describe block (catches the system+user message via the runDream
 *  integration mock). */
function buildSummarizeClusterPrompt(
  cluster: MemoryRow[],
  llmSnippetLength: number,
): { system: string; user: string } {
  const entries = cluster.map(
    (e) => `[${e.source_path}] ${e.content.substring(0, llmSnippetLength)}`,
  );
  return {
    system:
      "You are a memory summarizer. Produce a concise 1-3 sentence summary of the following related memory entries, capturing the single most important insight.",
    user: `Summarize these ${cluster.length} related memory entries:\n\n${entries.join("\n\n")}`,
  };
}

/** Extract the plain-text content from an LLM session.message() response.
 *  Filters out non-text parts (e.g. tool_use blocks), joins the text parts
 *  with newlines, and trims the result. Shared between nameClusterViaLLM
 *  and summarizeViaLLM; kept private since the LLM response shape is
 *  internal to the session contract.
 *
 *  Pinned by: dream.test.ts "extractResponseText fallback" describe block
 *  (empty content → falls back to "untitled cluster" for naming,
 *  concatenateSummary for summarizing). */
function extractResponseText(response: {
  content: Array<{ type: string; text?: unknown }>;
}): string {
  return response.content
    .filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("\n")
    .trim();
}

// `concatenateSummary` is imported lazily to keep this module's
// dependency on dream-db.ts one-way (dream-llm doesn't otherwise need
// filesystem helpers). The fallback path matches the original behavior.
import { concatenateSummary } from "./dream-db.ts";

// ---------------------------------------------------------------------------
// Try-helpers (the orchestrator's per-cluster entry point).
// dream-clustering.ts uses these — kept here so all LLM I/O is colocated.
// ---------------------------------------------------------------------------

/** Phase 6 helper: try the cluster-naming LLM call. On failure, push
 *  the error message and fall back to the default "untitled cluster".
 *  Pure: never throws (the orchestrator relies on this so a naming
 *  failure does not abort the cluster processing). */
export async function tryLLMClusterNaming(
  cluster: MemoryRow[],
  ctx: RichPluginContext,
  summaryModel: string | undefined,
  snippetLength: number,
  errors: string[],
): Promise<string> {
  try {
    return await nameClusterViaLLM(
      cluster,
      ctx,
      summaryModel ?? "",
      snippetLength,
    );
  } catch (err) {
    errors.push(`cluster naming LLM failed: ${String(err)}`);
    return "untitled cluster";
  }
}

/** Phase 6 helper: try the cluster-summarization LLM call. On failure,
 *  push the error message and fall back to concatenateSummary. Pure:
 *  never throws. */
export async function tryLLMClusterSummary(
  cluster: MemoryRow[],
  ctx: RichPluginContext,
  summaryModel: string | undefined,
  llmSnippetLength: number,
  snippetLength: number,
  errors: string[],
): Promise<string> {
  try {
    return await summarizeViaLLM(
      cluster,
      ctx,
      summaryModel ?? "",
      llmSnippetLength,
    );
  } catch (err) {
    errors.push(
      `summarization LLM failed for cluster of ${cluster.length}: ${String(err)}`,
    );
    return concatenateSummary(cluster, snippetLength);
  }
}