import OpenAI from "openai";
import type { ResponseFormatTextJSONSchemaConfig } from "openai/resources/responses/responses";
import {
  AGENT_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  getOpenAIGatewayConfig,
  hasOpenAIKey,
} from "@/lib/config";
import { estimateModelCostUsd, type ModelUsage } from "@/lib/openai/model-router";

let client: OpenAI | null = null;
let readinessCache:
  | {
      checkedAt: number;
      result: OpenAIReadiness;
    }
  | undefined;

export type OpenAIReadiness = {
  configured: boolean;
  reachable: boolean;
  model: string;
  checkedAt: string;
  error?: string;
};

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
    const gateway = getOpenAIGatewayConfig();
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(gateway
        ? {
            baseURL: gateway.baseURL,
            defaultHeaders: {
              "x-asael-gateway-token": gateway.token,
            },
          }
        : {}),
    });
    const createResponse = client.responses.create.bind(client.responses);
    client.responses.create = ((body, options) =>
      createResponse({ ...body, store: false }, options)) as typeof client.responses.create;
  }

  return client;
}

export async function getOpenAIReadiness(
  options: { timeoutMs?: number; maxAgeMs?: number } = {},
): Promise<OpenAIReadiness> {
  const now = Date.now();
  const maxAgeMs = options.maxAgeMs ?? 60_000;
  if (readinessCache && now - readinessCache.checkedAt < maxAgeMs) {
    return readinessCache.result;
  }
  const checkedAt = new Date(now).toISOString();
  if (!hasOpenAIKey()) {
    return {
      configured: false,
      reachable: false,
      model: AGENT_MODEL,
      checkedAt,
      error: "OPENAI_API_KEY is not configured.",
    };
  }

  const controller = new AbortController();
  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? 5_000, 1_000),
    15_000,
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let result: OpenAIReadiness;
  try {
    const timeoutError = new Error("OpenAI readiness probe timed out.");
    timeoutError.name = "AbortError";
    await Promise.race([
      getOpenAIClient().models.retrieve(AGENT_MODEL, {
        signal: controller.signal,
        maxRetries: 0,
        timeout: timeoutMs,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
    result = {
      configured: true,
      reachable: true,
      model: AGENT_MODEL,
      checkedAt,
    };
  } catch (error) {
    result = {
      configured: true,
      reachable: false,
      model: AGENT_MODEL,
      checkedAt,
      error: error instanceof Error
        ? error.name === "AbortError"
          ? "OpenAI readiness probe timed out."
          : error.message.slice(0, 500)
        : "OpenAI readiness probe failed.",
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
  readinessCache = { checkedAt: now, result };
  return result;
}

export async function embedTexts(input: string[], abortSignal?: AbortSignal) {
  if (!hasOpenAIKey() || input.length === 0) {
    return null;
  }

  const response = await getOpenAIClient().embeddings.create(
    {
      model: EMBEDDING_MODEL,
      input,
      ...(EMBEDDING_MODEL.startsWith("text-embedding-3")
        ? { dimensions: EMBEDDING_DIMENSIONS }
        : {}),
    },
    { signal: abortSignal },
  );

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
      store: false,
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
  model = AGENT_MODEL,
  fallbackModel,
}: {
  instructions?: string;
  input: ResponseTurnInput;
  tools?: ResponseFunctionTool[];
  onDelta: (text: string) => void | Promise<void>;
  abortSignal?: AbortSignal;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  maxOutputTokens?: number;
  model?: string;
  fallbackModel?: string;
}): Promise<{
  responseId: string;
  functionCalls: ResponseFunctionCall[];
  functionCallItems: ResponseFunctionCallItem[];
  text: string;
  model: string;
  fallbackUsed: boolean;
  latencyMs: number;
  usage: ModelUsage;
  estimatedCostUsd?: number;
}> {
  const startedAt = Date.now();
  let activeModel = model;
  let fallbackUsed = false;
  let emittedOutput = false;
  let stream: Awaited<ReturnType<ReturnType<typeof getOpenAIClient>["responses"]["create"]>>;
  try {
    stream = await createTurnStream(activeModel);
  } catch (error) {
    if (!fallbackModel || fallbackModel === activeModel) throw error;
    activeModel = fallbackModel;
    fallbackUsed = true;
    stream = await createTurnStream(activeModel);
  }

  function createTurnStream(selectedModel: string) {
    return getOpenAIClient().responses.create(
    {
      model: selectedModel,
      ...(instructions ? { instructions } : {}),
      input: input as never,
      ...(tools && tools.length ? { tools: tools as never } : {}),
      ...(reasoningEffort && supportsReasoningEffort(selectedModel) ? { reasoning: { effort: reasoningEffort } } : {}),
      ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
      stream: true,
      store: false,
    },
    { signal: abortSignal },
  );
  }

  let responseId = "";
  let text = "";
  const callsByItemId = new Map<string, { itemId: string; callId: string; name: string; argumentsJson: string }>();
  let usage: ModelUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 };

  try {
    for await (const rawEvent of stream as AsyncIterable<Record<string, unknown>>) {
    const eventType = String(rawEvent.type || "");

    if (eventType === "response.created") {
      const response = rawEvent.response as { id?: string } | undefined;
      responseId = response?.id || responseId;
    }

    if (eventType === "response.output_text.delta" && typeof rawEvent.delta === "string" && rawEvent.delta) {
      text += rawEvent.delta;
      emittedOutput = true;
      await onDelta(rawEvent.delta);
    }

    if (eventType === "response.output_item.added") {
      const item = rawEvent.item as
        | { id?: string; type?: string; call_id?: string; name?: string; arguments?: string }
        | undefined;
      if (item?.type === "function_call" && item.id) {
        emittedOutput = true;
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
      const response = rawEvent.response as { id?: string; usage?: Record<string, unknown> } | undefined;
      responseId = response?.id || responseId;
      usage = normalizeUsage(response?.usage);
    }
  }
  } catch (error) {
    if (emittedOutput || fallbackUsed || !fallbackModel || fallbackModel === activeModel) throw error;
    activeModel = fallbackModel;
    fallbackUsed = true;
    stream = await createTurnStream(activeModel);
    for await (const rawEvent of stream as AsyncIterable<Record<string, unknown>>) {
      const eventType = String(rawEvent.type || "");
      if (eventType === "response.created") responseId = (rawEvent.response as { id?: string } | undefined)?.id || responseId;
      if (eventType === "response.output_text.delta" && typeof rawEvent.delta === "string" && rawEvent.delta) {
        text += rawEvent.delta;
        await onDelta(rawEvent.delta);
      }
      if (eventType === "response.output_item.added") {
        const item = rawEvent.item as { id?: string; type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
        if (item?.type === "function_call" && item.id) callsByItemId.set(item.id, { itemId: item.id, callId: item.call_id || item.id, name: item.name || "", argumentsJson: item.arguments || "" });
      }
      if (eventType === "response.function_call_arguments.done") {
        const call = callsByItemId.get(typeof rawEvent.item_id === "string" ? rawEvent.item_id : "");
        if (call && typeof rawEvent.arguments === "string") call.argumentsJson = rawEvent.arguments;
      }
      if (eventType === "response.completed") {
        const completed = rawEvent.response as { id?: string; usage?: Record<string, unknown> } | undefined;
        responseId = completed?.id || responseId;
        usage = normalizeUsage(completed?.usage);
      }
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
    model: activeModel,
    fallbackUsed,
    latencyMs: Date.now() - startedAt,
    usage,
    estimatedCostUsd: estimateModelCostUsd(activeModel, usage),
  };
}

function normalizeUsage(raw?: Record<string, unknown>): ModelUsage {
  const details = raw?.input_tokens_details as Record<string, unknown> | undefined;
  const inputTokens = finiteToken(raw?.input_tokens);
  const outputTokens = finiteToken(raw?.output_tokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: finiteToken(details?.cached_tokens),
    totalTokens: finiteToken(raw?.total_tokens) || inputTokens + outputTokens,
  };
}

function finiteToken(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

export async function createStructuredResponse({
  instructions,
  input,
  schema,
  name,
  abortSignal,
  reasoningEffort,
  model,
}: {
  instructions: string;
  input: string;
  schema: ResponseFormatTextJSONSchemaConfig["schema"];
  name: string;
  abortSignal?: AbortSignal;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  model?: string;
}) {
  return (await createStructuredResponseWithMetrics({
    instructions,
    input,
    schema,
    name,
    abortSignal,
    reasoningEffort,
    model,
  })).text;
}

export async function createStructuredResponseWithMetrics({
  instructions,
  input,
  schema,
  name,
  abortSignal,
  reasoningEffort,
  model = AGENT_MODEL,
}: {
  instructions: string;
  input: string;
  schema: ResponseFormatTextJSONSchemaConfig["schema"];
  name: string;
  abortSignal?: AbortSignal;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  model?: string;
}) {
  const startedAt = Date.now();
  const response = await getOpenAIClient().responses.create(
    {
      model,
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
      ...(reasoningEffort && supportsReasoningEffort(model) ? { reasoning: { effort: reasoningEffort } } : {}),
      store: false,
    },
    { signal: abortSignal },
  );

  const usage = normalizeUsage(response.usage as unknown as Record<string, unknown> | undefined);
  return {
    text: response.output_text,
    responseId: response.id,
    model,
    usage,
    latencyMs: Date.now() - startedAt,
    estimatedCostUsd: estimateModelCostUsd(model, usage),
  };
}
