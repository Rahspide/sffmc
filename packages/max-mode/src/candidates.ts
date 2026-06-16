import { type RichPluginContext } from "@sffmc/shared"
import { type SchemaOnlyTool } from "./types"

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

export interface Candidate {
  id: string;
  temperature: number;
  draft: string;
  toolCalls: ToolCall[];
  tokens: number;
}

interface GenerateConfig {
  n: number;
  models: string[];
  temperature: number;
}

export function makeSchemaOnlyTools(tools: SchemaOnlyTool[]): SchemaOnlyTool[] {
  const stripped: SchemaOnlyTool[] = [];
  for (const tool of tools) {
    stripped.push({
      definition: { ...tool.definition },
    });
  }
  return stripped;
}

export function buildCandidatePrompt(
  userPrompt: string,
  candidateIndex: number,
  totalCandidates: number,
): Array<{ role: string; content: string }> {
  return [
    {
      role: "system",
      content: [
        `You are Candidate #${candidateIndex + 1} of ${totalCandidates} solving a problem.`,
        `Generate your best solution.`,
        `You may suggest tool calls, but they will NOT be executed — they are for review only.`,
        `Be thorough and complete. Output your full reasoning and final answer.`,
      ].join("\n"),
    },
    {
      role: "user",
      content: userPrompt,
    },
  ];
}

export async function generateCandidates(
  prompt: string,
  config: GenerateConfig,
  ctx: RichPluginContext,
): Promise<Candidate[]> {
  const session = ctx.client?.session;
  if (!session?.message) {
    throw new Error("[max-mode] SDK client.session.message() not available");
  }

  const model = config.models[0] || String(ctx.config?.model || "");
  const candidates: Candidate[] = [];

  const messages = buildCandidatePrompt(prompt, 0, config.n);
  const requests = Array.from({ length: config.n }, (_, i) =>
    session.message!({
      messages: buildCandidatePrompt(prompt, i, config.n),
      model,
      temperature: config.temperature,
    }),
  );

  const results = await Promise.allSettled(requests);

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      candidates.push({
        id: `candidate-${i}`,
        temperature: config.temperature,
        draft: `[ERROR] Candidate ${i + 1} failed: ${String(result.reason)}`,
        toolCalls: [],
        tokens: 0,
      });
      continue;
    }

    const response = result.value;
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const part of response.content) {
      if (part.type === "text" && part.text) {
        textParts.push(part.text);
      } else if (part.type === "toolCall" && part.toolCall) {
        toolCalls.push({
          name: part.toolCall.name,
          args: part.toolCall.args || {},
          id: part.toolCall.id,
        });
      }
    }

    candidates.push({
      id: `candidate-${i}`,
      temperature: config.temperature,
      draft: textParts.join("\n"),
      toolCalls,
      tokens: response.usage?.totalTokens ?? 0,
    });
  }

  return candidates;
}
