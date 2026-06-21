import OpenAI from "openai";
import type { ResponseFormatTextJSONSchemaConfig } from "openai/resources/responses/responses";
import { AGENT_MODEL, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, hasOpenAIKey } from "@/lib/config";

let client: OpenAI | null = null;

// Only reasoning models (gpt-5 family, o-series) accept the `reasoning.effort`
// parameter; gpt-4o and other chat models reject it with a 400.
function supportsReasoningEffort(model: string) {
  return /^(gpt-5|o\d)/i.test(model);
}

export function getOpenAIClient() {
  if (!hasOpenAIKey()) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return client;
}

export async function embedTexts(input: string[]) {
  if (!hasOpenAIKey() || input.length === 0) {
    return null;
  }

  const response = await getOpenAIClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input,
    ...(EMBEDDING_MODEL.startsWith("text-embedding-3")
      ? { dimensions: EMBEDDING_DIMENSIONS }
      : {}),
  });

  return response.data.map((item) => item.embedding);
}

export async function* streamOpenAIResponse({
  instructions,
  input,
  abortSignal,
}: {
  instructions: string;
  input: string;
  abortSignal?: AbortSignal;
}) {
  const stream = await getOpenAIClient().responses.create(
    {
      model: AGENT_MODEL,
      instructions,
      input,
      stream: true,
    },
    { signal: abortSignal },
  );

  for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
    if (event.type === "response.output_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        yield delta;
      }
    }
  }
}

export type ResponseFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: false;
};

export type ResponseFunctionCall = {
  callId: string;
  name: string;
  argumentsJson: string;
};

export type ResponseFunctionCallItem = {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
};

export type ConversationItem =
  | { role: "user"; content: string }
  | ResponseFunctionCallItem
  | { type: "function_call_output"; call_id: string; output: string };

export type ResponseTurnInput = string | ConversationItem[];

/**
 * Streams one model turn. Text deltas flow through onDelta; any function calls
 * the model emitted are returned alongside their raw items so the caller can
 * build a full conversation array for the next turn (ZDR-safe, no previous_response_id).
 */
export async function streamResponseTurn({
  instructions,
  input,
  tools,
  onDelta,
  abortSignal,
  reasoningEffort,
  maxOutputTokens,
}: {
  instructions?: string;
  input: ResponseTurnInput;
  tools?: ResponseFunctionTool[];
  onDelta: (text: string) => void | Promise<void>;
  abortSignal?: AbortSignal;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  maxOutputTokens?: number;
}): Promise<{ responseId: string; functionCalls: ResponseFunctionCall[]; functionCallItems: ResponseFunctionCallItem[]; text: string }> {
  const stream = await getOpenAIClient().responses.create(
    {
      model: AGENT_MODEL,
      ...(instructions ? { instructions } : {}),
      input: input as never,
      ...(tools && tools.length ? { tools: tools as never } : {}),
      ...(reasoningEffort && supportsReasoningEffort(AGENT_MODEL) ? { reasoning: { effort: reasoningEffort } } : {}),
      ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
      stream: true,
    },
    { signal: abortSignal },
  );

  let responseId = "";
  let text = "";
  const callsByItemId = new Map<string, { itemId: string; callId: string; name: string; argumentsJson: string }>();

  for await (const rawEvent of stream as AsyncIterable<Record<string, unknown>>) {
    const eventType = String(rawEvent.type || "");

    if (eventType === "response.created") {
      const response = rawEvent.response as { id?: string } | undefined;
      responseId = response?.id || responseId;
    }

    if (eventType === "response.output_text.delta" && typeof rawEvent.delta === "string" && rawEvent.delta) {
      text += rawEvent.delta;
      await onDelta(rawEvent.delta);
    }

    if (eventType === "response.output_item.added") {
      const item = rawEvent.item as
        | { id?: string; type?: string; call_id?: string; name?: string; arguments?: string }
        | undefined;
      if (item?.type === "function_call" && item.id) {
        callsByItemId.set(item.id, {
          itemId: item.id,
          callId: item.call_id || item.id,
          name: item.name || "",
          argumentsJson: item.arguments || "",
        });
      }
    }

    if (eventType === "response.function_call_arguments.done") {
      const itemId = typeof rawEvent.item_id === "string" ? rawEvent.item_id : "";
      const call = callsByItemId.get(itemId);
      if (call && typeof rawEvent.arguments === "string") {
        call.argumentsJson = rawEvent.arguments;
      }
    }

    if (eventType === "response.completed") {
      const response = rawEvent.response as { id?: string } | undefined;
      responseId = response?.id || responseId;
    }
  }

  const calls = [...callsByItemId.values()];
  return {
    responseId,
    text,
    functionCalls: calls.map((call) => ({
      callId: call.callId,
      name: call.name,
      argumentsJson: call.argumentsJson,
    })),
    functionCallItems: calls.map((call) => ({
      type: "function_call" as const,
      id: call.itemId,
      call_id: call.callId,
      name: call.name,
      arguments: call.argumentsJson,
    })),
  };
}

export async function createStructuredResponse({
  instructions,
  input,
  schema,
  name,
  abortSignal,
  reasoningEffort,
}: {
  instructions: string;
  input: string;
  schema: ResponseFormatTextJSONSchemaConfig["schema"];
  name: string;
  abortSignal?: AbortSignal;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}) {
  const response = await getOpenAIClient().responses.create(
    {
      model: AGENT_MODEL,
      instructions,
      input,
      text: {
        format: {
          type: "json_schema",
          name,
          strict: true,
          schema,
        },
      },
      ...(reasoningEffort && supportsReasoningEffort(AGENT_MODEL) ? { reasoning: { effort: reasoningEffort } } : {}),
    },
    { signal: abortSignal },
  );

  return response.output_text;
}
