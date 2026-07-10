// SPDX-License-Identifier: MIT
// @sffmc/extra — Judge auto-trigger marker extraction
// Pure string scanning extracted from judge.ts (M-3 Wave 3).
// No LLM, no orchestration — just HTML-comment marker parsing.

const JUDGE_MARKER = "<!-- EXTRA_JUDGE_CANDIDATES: ";

export function extractCandidatesFromMessages(
  messages: Array<{ role: string; content: string }>,
): string[] | null {
  for (const msg of messages) {
    if (typeof msg.content !== "string") continue;
    const candidates = parseJudgeMarkerContent(msg.content);
    if (candidates !== null) return candidates;
  }
  return null;
}

/** Extract the candidate JSON array from a single message's content. The
 *  marker span is `<!-- EXTRA_JUDGE_CANDIDATES: <json> -->`. Returns
 *  null when the marker is absent, the JSON is malformed, or the array
 *  has fewer than 2 entries (the documented minimum for judging).
 *
 *  Pinned by: judge.test.ts "extractCandidatesFromMessages marker parsing"
 *  describe block.
 *
 *  Kept separate from the message scanner so the orchestrator reads as
 *  a plain scan loop and the marker/JSON semantics are testable in
 *  isolation via the message body. */
function parseJudgeMarkerContent(content: string): string[] | null {
  const idx = content.indexOf(JUDGE_MARKER);
  if (idx === -1) return null;
  const start = idx + JUDGE_MARKER.length;
  const end = content.indexOf(" -->", start);
  if (end === -1) return null;
  const json = content.slice(start, end).trim();
  try {
    const parsed = JSON.parse(json) as string[];
    if (Array.isArray(parsed) && parsed.length >= 2) {
      return parsed;
    }
  } catch {
    // ignore parse errors — caller keeps scanning subsequent messages
  }
  return null;
}