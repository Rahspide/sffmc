// SPDX-License-Identifier: MIT
// @sffmc/extra — Judge LLM call (sync + streaming)
// LLM invocation extracted from judge.ts (M-3 Wave 3).
// Owns callJudge (private) + callJudgeStream (public).

import type { RichPluginContext } from "@sffmc/utilities";
import { buildJudgePrompt } from "./judge-prompt.ts";
import { parseJudgeResponse } from "./judge-parse.ts";
import type { JudgeResponse, JudgeResult, JudgeStreamChunk } from "./judge-types.ts";

export async function callJudge(
  candidates: string[],
  rubric: string,
  model: string,
  ctx: RichPluginContext,
): Promise<{ response: JudgeResponse; latencyMs: number }> {
  const session = ctx.client?.session;
  if (!session?.message) {
    throw new Error("ctx.client.session.message() not available");
  }

  const { system, user } = buildJudgePrompt(candidates, rubric);

  const start = performance.now();

  const response = await session.message({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    model,
    temperature: 0.2,
  });

  const latencyMs = Math.round(performance.now() - start);

  const text = extractJudgeSessionText(response);

  const parsed = parseJudgeResponse(text, candidates.length);
  if (!parsed) {
    throw new Error("judge parse failed");
  }

  return { response: parsed, latencyMs };
}

/** Extract the plain-text content from a session.message() response.
 *  Filters out non-text parts (e.g. tool_use blocks), joins the text
 *  parts with newlines. Kept private — same shape as dream.ts's
 *  `extractResponseText`, but the two streams don't share a type. */
function extractJudgeSessionText(response: {
  content: Array<{ type: string; text?: unknown }>;
}): string {
  return response.content
    .filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Streaming LLM judge call — delegates to callJudge() and emits progress chunks
// ---------------------------------------------------------------------------

export async function callJudgeStream(
  candidates: string[],
  rubric: string,
  model: string,
  ctx: RichPluginContext,
  onChunk: (chunk: JudgeStreamChunk) => void,
): Promise<JudgeResult> {
  try {
    const { response, latencyMs } = await callJudge(candidates, rubric, model, ctx);
    emitJudgeResultChunks(onChunk, response);
    return buildJudgeStreamResult(response, model, latencyMs);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    onChunk({ type: "error", error: errMsg });
    throw err;
  }
}

/** Emit the four-stage progress chunks in fixed order — downstream
 *  consumers pin the order: scores → winner → reasoning → complete.
 *  The order is a contract; reordering breaks any consumer that
 *  processes each stage as it arrives.
 *
 *  Pinned by: judge.test.ts "callJudgeStream chunk emission order". */
function emitJudgeResultChunks(
  onChunk: (chunk: JudgeStreamChunk) => void,
  response: JudgeResponse,
): void {
  onChunk({ type: "scores", scores: response.scores });
  onChunk({ type: "winner", winner: response.winner });
  onChunk({ type: "reasoning", reasoning: response.reasoning });
  onChunk({ type: "complete" });
}

/** Build the final JudgeResult from a successful call. The model name is
 *  the ORIGINAL model passed to callJudge (the response doesn't carry it). */
function buildJudgeStreamResult(
  response: JudgeResponse,
  model: string,
  latencyMs: number,
): JudgeResult {
  return {
    ok: true,
    scores: response.scores,
    winner: response.winner,
    reasoning: response.reasoning,
    model,
    latencyMs,
  };
}