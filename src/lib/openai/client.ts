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
import {
  attachModelProviderResponseReceipt,
  getModelProviderResponseReceipt,
  ModelProviderError,
  type ModelAttemptReceipt,
  type ModelProviderResponseReceipt,
} from "@/lib/models/types";
import {
  renderUntrustedObservation,
  type ModelConversationSeedItem,
} from "@/lib/models/conversation";
import { recordAiUsageSafely } from "@/lib/usage/ledger";
import type { AiUsageScope } from "@/lib/usage/types";

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

export function getOpenAIClient(options: { apiKey?: string } = {}) {
  const requestApiKey = options.apiKey?.trim();
  if (requestApiKey) {
    return createOpenAIClient(requestApiKey, false);
  }
  if (!hasOpenAIKey()) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  if (!client) {
    client = createOpenAIClient(process.env.OPENAI_API_KEY!, true);
  }

  return client;
}

function createOpenAIClient(apiKey: string, useDeploymentGateway: boolean) {
  const gateway = useDeploymentGateway ? getOpenAIGatewayConfig() : undefined;
  const scopedClient = new OpenAI({
    apiKey,
    ...(gateway
      ? {
          baseURL: gateway.baseURL,
          defaultHeaders: {
            "x-asael-gateway-token": gateway.token,
          },
        }
      : {}),
  });
  const createResponse = scopedClient.responses.create.bind(scopedClient.responses);
  scopedClient.responses.create = ((body, options) =>
    createResponse({ ...body, store: false }, options)) as typeof scopedClient.responses.create;
  return scopedClient;
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

export async function embedTexts(
  input: string[],
  abortSignal?: AbortSignal,
  usageScope?: AiUsageScope,
) {
  if (!hasOpenAIKey() || input.length === 0) {
    return null;
  }

  const startedAt = Date.now();
  try {
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
    if (usageScope) {
      const inputTokens = finiteToken(response.usage?.prompt_tokens);
      await recordAiUsageSafely({
        ...usageScope,
        status: "completed",
        provider: "openai",
        model: EMBEDDING_MODEL,
        usage: {
          inputTokens,
          totalTokens: finiteToken(response.usage?.total_tokens) || inputTokens,
        },
        providerCallCount: 1,
        attemptCount: 1,
        failedAttemptCount: 0,
        latencyMs: Date.now() - startedAt,
        estimatedCostUsd: estimateModelCostUsd(EMBEDDING_MODEL, {
          inputTokens,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalTokens: finiteToken(response.usage?.total_tokens) || inputTokens,
        }),
      });
    }
    return response.data.map((item) => item.embedding);
  } catch (error) {
    if (usageScope) {
      await recordAiUsageSafely({
        ...usageScope,
        status: "failed",
        provider: "openai",
        model: EMBEDDING_MODEL,
        usage: {},
        providerCallCount: 1,
        attemptCount: 1,
        failedAttemptCount: 1,
        latencyMs: Date.now() - startedAt,
        failureKind: abortSignal?.aborted ? "abort" : "provider_error",
        retryable: !abortSignal?.aborted,
      });
    }
    throw error;
  }
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
  | ModelConversationSeedItem
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
  apiKey,
  usageScope,
  usageRecordId,
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
  /** Server-only request credential. Never persist or include in receipts. */
  apiKey?: string;
  /** Optional provider-bound metering scope for calls that are not metered by the gateway. */
  usageScope?: AiUsageScope;
  /** Stable receipt id lets a later run-event fallback converge without double counting. */
  usageRecordId?: string;
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
  attempts: ModelAttemptReceipt[];
  usageReceiptRecorded: boolean;
  usageReceiptId?: string;
}> {
  const startedAt = Date.now();
  let activeModel = model;
  let fallbackUsed = false;
  let emittedOutput = false;
  let attemptStartedAt = startedAt;
  const failedAttempts: ModelAttemptReceipt[] = [];
  let stream: Awaited<ReturnType<ReturnType<typeof getOpenAIClient>["responses"]["create"]>>;
  try {
    stream = await createTurnStream(activeModel);
  } catch (error) {
    addFailedAttempt(error);
    if (!fallbackModel || fallbackModel === activeModel) {
      throw attachResponseTurnAttempts(error, failedAttempts);
    }
    activeModel = fallbackModel;
    fallbackUsed = true;
    attemptStartedAt = Date.now();
    try {
      stream = await createTurnStream(activeModel);
    } catch (fallbackError) {
      addFailedAttempt(fallbackError);
      throw attachResponseTurnAttempts(fallbackError, failedAttempts);
    }
  }

  function createTurnStream(selectedModel: string) {
    return getOpenAIClient(apiKey ? { apiKey } : undefined).responses.create(
    {
      model: selectedModel,
      ...(instructions ? { instructions } : {}),
      input: openAIResponseInput(input) as never,
      ...(tools && tools.length ? { tools: tools as never } : {}),
      ...(reasoningEffort && supportsReasoningEffort(selectedModel) ? { reasoning: { effort: reasoningEffort } } : {}),
      ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
      stream: true,
      store: false,
    },
    { signal: abortSignal },
  );
  }

  function addFailedAttempt(error: unknown) {
    const aborted = Boolean(abortSignal?.aborted) ||
      (error instanceof Error && error.name === "AbortError");
    const providerFailure = error instanceof ModelProviderError ? error : undefined;
    const responseReceipt = getModelProviderResponseReceipt(error);
    failedAttempts.push({
      provider: "openai",
      model: responseReceipt?.model || activeModel,
      status: "failed",
      latencyMs: responseReceipt?.latencyMs ??
        Math.max(0, Date.now() - attemptStartedAt),
      ...(responseReceipt?.usage ? { usage: responseReceipt.usage } : {}),
      ...(responseReceipt?.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: responseReceipt.estimatedCostUsd }
        : {}),
      ...(responseReceipt?.providerRequestId
        ? { providerRequestId: responseReceipt.providerRequestId }
        : {}),
      ...(aborted
        ? { failureKind: "abort" as const, retryable: false }
        : providerFailure
          ? {
              failureKind: providerFailure.kind,
              retryable: providerFailure.retryable,
            }
          : {}),
    });
  }

  let responseId = "";
  let text = "";
  const callsByItemId = new Map<string, { itemId: string; callId: string; name: string; argumentsJson: string }>();
  let usage: ModelUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 };
  let usageObserved = false;
  let terminalSeen = false;
  let terminalFailure: ModelProviderError | undefined;
  const billableFailureReceipts: ModelProviderResponseReceipt[] = [];

  async function consumeStreamEvent(rawEvent: Record<string, unknown>) {
    const eventType = String(rawEvent.type || "");
    const response = rawEvent.response as {
      id?: string;
      usage?: Record<string, unknown>;
      incomplete_details?: { reason?: string };
    } | undefined;

    if (
      eventType === "response.created" ||
      eventType === "response.completed" ||
      eventType === "response.failed" ||
      eventType === "response.incomplete"
    ) {
      responseId = response?.id || responseId;
    }
    if (
      (eventType === "response.completed" ||
        eventType === "response.failed" ||
        eventType === "response.incomplete") &&
      response?.usage
    ) {
      usage = normalizeUsage(response.usage);
      usageObserved = true;
    }
    if (eventType === "response.completed") terminalSeen = true;
    if (eventType === "response.failed") {
      terminalSeen = true;
      terminalFailure = new ModelProviderError(
        "OpenAI could not complete the response.",
        "openai",
        "unavailable",
        true,
      );
    }
    if (eventType === "response.incomplete") {
      terminalSeen = true;
      const reason = response?.incomplete_details?.reason || "";
      terminalFailure = new ModelProviderError(
        reason === "content_filter"
          ? "OpenAI blocked the response for safety."
          : "OpenAI returned an incomplete response.",
        "openai",
        reason === "content_filter" ? "safety" : "unknown",
        false,
      );
      if (reason === "content_filter") emittedOutput = true;
    }
    if (eventType.startsWith("response.refusal.")) {
      emittedOutput = true;
      terminalFailure = new ModelProviderError(
        "OpenAI refused the request.",
        "openai",
        "safety",
        false,
      );
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
  }

  function currentResponseFailure(error: unknown) {
    return attachModelProviderResponseReceipt(error, {
      ...(usageObserved ? { usage } : {}),
      latencyMs: Date.now() - attemptStartedAt,
      model: activeModel,
      estimatedCostUsd: usageObserved
        ? estimateModelCostUsd(activeModel, usage)
        : undefined,
      providerRequestId: responseId,
    });
  }

  try {
    for await (const rawEvent of stream as AsyncIterable<Record<string, unknown>>) {
      await consumeStreamEvent(rawEvent);
    }
    if (!terminalSeen) {
      throw currentResponseFailure(
        new ModelProviderError(
          "OpenAI ended the stream without a terminal response.",
          "openai",
          "unavailable",
          true,
        ),
      );
    }
    if (terminalFailure) throw currentResponseFailure(terminalFailure);
  } catch (error) {
    const meteredError = getModelProviderResponseReceipt(error)
      ? error
      : currentResponseFailure(error);
    addFailedAttempt(meteredError);
    const failedReceipt = getModelProviderResponseReceipt(meteredError);
    if (emittedOutput || fallbackUsed || !fallbackModel || fallbackModel === activeModel) {
      throw attachResponseTurnAttempts(meteredError, failedAttempts);
    }
    if (failedReceipt?.usage) billableFailureReceipts.push(failedReceipt);
    activeModel = fallbackModel;
    fallbackUsed = true;
    attemptStartedAt = Date.now();
    responseId = "";
    usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 };
    usageObserved = false;
    terminalSeen = false;
    terminalFailure = undefined;
    try {
      stream = await createTurnStream(activeModel);
      for await (const rawEvent of stream as AsyncIterable<Record<string, unknown>>) {
        await consumeStreamEvent(rawEvent);
      }
      if (!terminalSeen) {
        throw currentResponseFailure(
          new ModelProviderError(
            "OpenAI ended the fallback stream without a terminal response.",
            "openai",
            "unavailable",
            true,
          ),
        );
      }
      if (terminalFailure) throw currentResponseFailure(terminalFailure);
    } catch (fallbackError) {
      const meteredFallbackError = getModelProviderResponseReceipt(fallbackError)
        ? fallbackError
        : currentResponseFailure(fallbackError);
      addFailedAttempt(meteredFallbackError);
      const fallbackReceipt = getModelProviderResponseReceipt(meteredFallbackError);
      const billedReceipts = [
        ...billableFailureReceipts,
        ...(fallbackReceipt ? [fallbackReceipt] : []),
      ];
      const combinedError = billedReceipts.length
        ? attachModelProviderResponseReceipt(meteredFallbackError, {
            usage: sumModelUsage(billedReceipts),
            latencyMs: Date.now() - startedAt,
            model: fallbackReceipt?.model || activeModel,
            estimatedCostUsd: sumKnownModelCost(billedReceipts),
            providerRequestId: fallbackReceipt?.providerRequestId,
          })
        : meteredFallbackError;
      throw attachResponseTurnAttempts(combinedError, failedAttempts);
    }
  }

  const calls = [...callsByItemId.values()];
  const activeEstimatedCostUsd = estimateModelCostUsd(activeModel, usage);
  const turnLatencyMs = Date.now() - startedAt;
  const completedReceipt: ModelProviderResponseReceipt = {
    usage,
    latencyMs: Math.max(0, Date.now() - attemptStartedAt),
    model: activeModel,
    estimatedCostUsd: activeEstimatedCostUsd,
    providerRequestId: responseId,
  };
  const billedReceipts = [...billableFailureReceipts, completedReceipt];
  const attempts: ModelAttemptReceipt[] = [
    ...failedAttempts,
    {
      provider: "openai",
      model: activeModel,
      status: "completed",
      latencyMs: completedReceipt.latencyMs,
      usage,
      estimatedCostUsd: activeEstimatedCostUsd,
      ...(responseId ? { providerRequestId: responseId } : {}),
    },
  ];
  const totalUsage = sumModelUsage(billedReceipts);
  const estimatedCostUsd = sumKnownModelCost(billedReceipts);
  const usageReceiptRecorded = usageScope
    ? Boolean(await recordAiUsageSafely({
        ...usageScope,
        ...(usageRecordId ? { id: usageRecordId } : {}),
        status: "completed",
        provider: "openai",
        model: activeModel,
        usage: totalUsage,
        providerCallCount: attempts.length,
        attemptCount: attempts.length,
        failedAttemptCount: failedAttempts.length,
        callReceipts: attempts.map((attempt) => ({
          provider: attempt.provider,
          model: attempt.model,
          status: attempt.status,
          usage: attempt.usage || {},
          latencyMs: attempt.latencyMs,
          estimatedCostUsd: attempt.estimatedCostUsd,
          providerRequestId: attempt.providerRequestId,
          failureKind: attempt.failureKind,
          retryable: attempt.retryable,
        })),
        latencyMs: turnLatencyMs,
        estimatedCostUsd,
        providerRequestId: responseId,
      }))
    : false;
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
    latencyMs: turnLatencyMs,
    usage: totalUsage,
    estimatedCostUsd,
    attempts,
    usageReceiptRecorded,
    ...(usageRecordId ? { usageReceiptId: usageRecordId } : {}),
  };
}

export function openAIResponseInput(input: ResponseTurnInput) {
  if (typeof input === "string") return input;
  return input.map((item) => {
    if (item.type === "message") {
      return { role: item.role, content: item.content };
    }
    if (item.type === "observation") {
      return {
        role: "user" as const,
        content: renderUntrustedObservation(item),
      };
    }
    return item;
  });
}

function attachResponseTurnAttempts(
  error: unknown,
  attempts: ModelAttemptReceipt[],
) {
  const target = error instanceof Error
    ? error
    : new Error("OpenAI response turn failed.", { cause: error });
  try {
    Object.defineProperty(target, "attempts", {
      value: [...attempts],
      enumerable: false,
      configurable: true,
    });
    return target;
  } catch {
    const wrapped = new Error(target.message, { cause: target });
    Object.defineProperty(wrapped, "attempts", {
      value: [...attempts],
      enumerable: false,
      configurable: false,
    });
    const responseReceipt = getModelProviderResponseReceipt(target);
    return responseReceipt
      ? attachModelProviderResponseReceipt(wrapped, responseReceipt)
      : wrapped;
  }
}

function sumModelUsage(receipts: readonly ModelProviderResponseReceipt[]): ModelUsage {
  return receipts.reduce(
    (total, receipt) => ({
      inputTokens: total.inputTokens + (receipt.usage?.inputTokens || 0),
      outputTokens: total.outputTokens + (receipt.usage?.outputTokens || 0),
      cachedInputTokens:
        total.cachedInputTokens + (receipt.usage?.cachedInputTokens || 0),
      totalTokens: total.totalTokens + (receipt.usage?.totalTokens || 0),
    }),
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
  );
}

function sumKnownModelCost(
  receipts: readonly ModelProviderResponseReceipt[],
) {
  if (
    !receipts.length ||
    receipts.some((receipt) => receipt.estimatedCostUsd === undefined)
  ) {
    return undefined;
  }
  return Math.round(
    receipts.reduce(
      (total, receipt) => total + (receipt.estimatedCostUsd || 0),
      0,
    ) * 1_000_000,
  ) / 1_000_000;
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
  apiKey,
  usageScope,
}: {
  instructions: string;
  input: string;
  schema: ResponseFormatTextJSONSchemaConfig["schema"];
  name: string;
  abortSignal?: AbortSignal;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  model?: string;
  apiKey?: string;
  usageScope?: AiUsageScope;
}) {
  return (await createStructuredResponseWithMetrics({
    instructions,
    input,
    schema,
    name,
    abortSignal,
    reasoningEffort,
    model,
    apiKey,
    usageScope,
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
  apiKey,
  usageScope,
}: {
  instructions: string;
  input: string;
  schema: ResponseFormatTextJSONSchemaConfig["schema"];
  name: string;
  abortSignal?: AbortSignal;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  model?: string;
  /** Server-only request credential. Never persist or include in receipts. */
  apiKey?: string;
  usageScope?: AiUsageScope;
}) {
  const startedAt = Date.now();
  try {
    const response = await getOpenAIClient(apiKey ? { apiKey } : undefined).responses.create(
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
    const estimatedCostUsd = estimateModelCostUsd(model, usage);
    const responseFailure = classifyOpenAITerminalResponse(response);
    if (responseFailure || !response.output_text?.trim()) {
      throw attachModelProviderResponseReceipt(
        responseFailure || new ModelProviderError(
          "OpenAI returned no structured output.",
          "openai",
          "unknown",
          false,
        ),
        {
          usage,
          latencyMs: Date.now() - startedAt,
          model,
          estimatedCostUsd,
          providerRequestId: response.id,
        },
      );
    }
    if (usageScope) {
      await recordAiUsageSafely({
        ...usageScope,
        status: "completed",
        provider: "openai",
        model,
        usage,
        providerCallCount: 1,
        attemptCount: 1,
        failedAttemptCount: 0,
        latencyMs: Date.now() - startedAt,
        estimatedCostUsd,
        providerRequestId: response.id,
      });
    }
    return {
      text: response.output_text,
      responseId: response.id,
      model,
      usage,
      latencyMs: Date.now() - startedAt,
      estimatedCostUsd,
    };
  } catch (error) {
    const responseReceipt = getModelProviderResponseReceipt(error);
    const providerFailure = error instanceof ModelProviderError ? error : undefined;
    if (usageScope) {
      await recordAiUsageSafely({
        ...usageScope,
        status: "failed",
        provider: "openai",
        model: responseReceipt?.model || model,
        usage: responseReceipt?.usage || {},
        providerCallCount: 1,
        attemptCount: 1,
        failedAttemptCount: 1,
        latencyMs: Date.now() - startedAt,
        estimatedCostUsd: responseReceipt?.estimatedCostUsd,
        providerRequestId: responseReceipt?.providerRequestId,
        failureKind: abortSignal?.aborted
          ? "abort"
          : providerFailure?.kind || "provider_error",
        retryable: abortSignal?.aborted
          ? false
          : providerFailure?.retryable ?? true,
      });
    }
    throw error;
  }
}

export function classifyOpenAITerminalResponse(response: unknown) {
  const value = response && typeof response === "object"
    ? response as Record<string, unknown>
    : {};
  const status = String(value.status || "");
  const output = Array.isArray(value.output) ? value.output : [];
  const refused = output.some((item) => {
    if (!item || typeof item !== "object") return false;
    const content = (item as Record<string, unknown>).content;
    return Array.isArray(content) && content.some((part) =>
      Boolean(
        part &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "refusal",
      )
    );
  });
  if (refused) {
    return new ModelProviderError(
      "OpenAI refused the request.",
      "openai",
      "safety",
      false,
    );
  }
  if (status === "failed") {
    return new ModelProviderError(
      "OpenAI could not complete the response.",
      "openai",
      "unavailable",
      true,
    );
  }
  if (status === "incomplete") {
    const details = value.incomplete_details && typeof value.incomplete_details === "object"
      ? value.incomplete_details as Record<string, unknown>
      : {};
    const safety = details.reason === "content_filter";
    return new ModelProviderError(
      safety
        ? "OpenAI blocked the response for safety."
        : "OpenAI returned an incomplete response.",
      "openai",
      safety ? "safety" : "unknown",
      false,
    );
  }
  if (status && status !== "completed") {
    return new ModelProviderError(
      `OpenAI response ended with status ${status}.`,
      "openai",
      status === "cancelled" ? "abort" : "unavailable",
      status !== "cancelled",
    );
  }
  return undefined;
}
