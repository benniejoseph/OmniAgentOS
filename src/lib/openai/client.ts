import OpenAI from "openai";
import type { ResponseFormatTextJSONSchemaConfig } from "openai/resources/responses/responses";
import { AGENT_MODEL, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, hasOpenAIKey } from "@/lib/config";

let client: OpenAI | null = null;

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

export type ResponseTurnInput =
  | string
  | Array<{ type: "function_call_output"; call_id: string; output: string }>;

/**
 * Streams one model turn. Text deltas flow through onDelta; any function calls
 * the model emitted are returned so the caller can execute them and continue
 * the conversation with previous_response_id chaining.
 */
export async function streamResponseTurn({
  instructions,
  input,
  previousResponseId,
  tools,
  onDelta,
  abortSignal,
}: {
  instructions?: string;
  input: ResponseTurnInput;
  previousResponseId?: string;
  tools?: ResponseFunctionTool[];
  onDelta: (text: string) => void | Promise<void>;
  abortSignal?: AbortSignal;
}): Promise<{ responseId: string; functionCalls: ResponseFunctionCall[]; text: string }> {
  const stream = await getOpenAIClient().responses.create(
    {
      model: AGENT_MODEL,
      ...(instructions ? { instructions } : {}),
      input: input as never,
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      ...(tools && tools.length ? { tools: tools as never } : {}),
      stream: true,
    },
    { signal: abortSignal },
  );

  let responseId = "";
  let text = "";
  const callsByItemId = new Map<string, { callId: string; name: string; argumentsJson: string }>();

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

  return {
    responseId,
    text,
    functionCalls: [...callsByItemId.values()].map((call) => ({
      callId: call.callId,
      name: call.name,
      argumentsJson: call.argumentsJson,
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
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    },
    { signal: abortSignal },
  );

  return response.output_text;
}
