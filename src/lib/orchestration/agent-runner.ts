import { AGENT_MODEL, hasOpenAIKey } from "@/lib/config";
import { consolidateRunMemory } from "@/lib/memory/consolidator";
import { saveMemory } from "@/lib/memory/store";
import { embedTexts, streamOpenAIResponse } from "@/lib/openai/client";
import { buildAgentInstructions, transcriptFromMessages } from "@/lib/orchestration/prompts";
import type { AgentEvent, AgentRunRequest } from "@/lib/orchestration/types";
import { buildContextPack } from "@/lib/rag/context-engine";
import {
  appendRunEvent,
  completeAgentRun,
  createAgentRun,
  failAgentRun,
  recordRunConsolidation,
  updateRunContextCount,
} from "@/lib/runs/store";

export async function* runAgent(
  request: AgentRunRequest,
  abortSignal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const mode = request.mode || "orchestrate";
  const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
  const query = lastUserMessage?.content || "";
  const run = await createAgentRun({
    mode,
    prompt: query,
    messages: request.messages,
    model: hasOpenAIKey() ? AGENT_MODEL : "fallback",
  });

  async function emit(event: AgentEvent) {
    await appendRunEvent(run.id, event);
    return event;
  }

  try {
    yield await emit({ type: "status", label: "retrieving memory", detail: "Building an adaptive evidence pack from memory and RAG." });
    const retrieval = await buildContextPack(query, { limit: 8 });
    await updateRunContextCount(run.id, retrieval.results.length);
    yield await emit({
      type: "memory",
      title: `context pack ready (${retrieval.profile.mode})`,
      count: retrieval.results.length,
    });

    const instructions = buildAgentInstructions({
      mode,
      memoryContext: retrieval.contextBlock,
    });
    const input = transcriptFromMessages(request.messages);

    let response = "";

    if (!hasOpenAIKey()) {
      yield await emit({ type: "status", label: "dev fallback", detail: "OPENAI_API_KEY is not configured." });
      for (const chunk of fallbackResponse(query, retrieval.results.length)) {
        response += chunk;
        yield await emit({ type: "delta", text: chunk });
        await wait(18);
      }
    } else {
      yield await emit({ type: "status", label: "reasoning", detail: "Streaming from the OpenAI Responses API." });
      for await (const delta of streamOpenAIResponse({
        instructions,
        input,
        abortSignal,
      })) {
        response += delta;
        yield await emit({ type: "delta", text: delta });
      }
    }

    if (query.trim() && response.trim()) {
      const episodeContent = [`User request: ${query}`, `Assistant response: ${response}`].join("\n\n");
      const embedding = (await embedTexts([episodeContent]))?.[0];
      await saveMemory({
        type: "episode",
        title: `Agent run: ${query.slice(0, 72)}`,
        content: episodeContent,
        tags: ["agent-run", mode],
        source: "agent",
        importance: 0.42,
        embedding,
      });

      yield await emit({
        type: "status",
        label: "consolidating memory",
        detail: "Extracting durable facts, decisions, procedures, preferences, and tasks.",
      });
      const consolidation = await consolidateRunMemory({
        runId: run.id,
        mode,
        prompt: query,
        response,
      });
      await recordRunConsolidation(run.id, {
        count: consolidation.saved.length,
        error: consolidation.error,
      });
      yield await emit({
        type: "memory",
        title: consolidation.error ? "memory consolidation failed" : "memory consolidated",
        count: consolidation.saved.length,
      });
    }

    await completeAgentRun(run.id, response);
    yield await emit({ type: "done", response });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent run failed.";
    await failAgentRun(run.id, message);
    yield await emit({ type: "error", message });
  }
}

function fallbackResponse(query: string, memoryCount: number) {
  const prompt = query.trim() || "No task was provided.";
  const text = [
    `I can run in full OpenAI mode after OPENAI_API_KEY is configured. `,
    `For now, I prepared the orchestration path for: "${prompt}".\n\n`,
    `Plan:\n`,
    `1. Clarify the objective and acceptance criteria.\n`,
    `2. Retrieve relevant memories and project knowledge (${memoryCount} records matched this request).\n`,
    `3. Select tools or connectors needed for the job.\n`,
    `4. Execute in small verifiable steps.\n`,
    `5. Save durable learnings back to memory.\n\n`,
    `Next action: add OPENAI_API_KEY to .env.local, then retry this command for model-backed reasoning.`,
  ].join("");

  return text.match(/.{1,42}(\s|$)/g) || [text];
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
