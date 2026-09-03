import { randomUUID } from "node:crypto";
import { modelTargets } from "@/lib/models/registry";
import { bindModelRuntime, getModelRuntime } from "@/lib/models/runtime-context";
import type {
  ModelAttemptReceipt,
  ModelGenerationResult,
  ModelProviderAdapter,
  ModelStructuredRequest,
  ModelTextRequest,
  ModelToolDefinition,
  ModelToolResult,
  ModelToolTurnRequest,
  ModelToolTurnResult,
} from "@/lib/models/types";
import {
  attachModelProviderResponseReceipt,
  getModelProviderResponseReceipt,
  ModelProviderError,
} from "@/lib/models/types";
import { recordAiUsageSafely } from "@/lib/usage/ledger";

const MAX_TARGET_ATTEMPTS = 4;
const MAX_TOOL_DEFINITIONS = 32;
const MAX_TOOL_DESCRIPTION_CHARS = 1_000;
const MAX_TOOL_SCHEMA_BYTES = 16 * 1024;
const MAX_TOOL_SCHEMA_TOTAL_BYTES = 64 * 1024;
const MAX_TOOL_RESULT_CHARS = 8_000;
const MAX_TOOL_RESULTS_PER_TURN = 5;

export async function generateModelText(request: ModelTextRequest): Promise<ModelGenerationResult> {
  return executeGateway(request, "text", (adapter, target) =>
    adapter.generateText(request, target)
  );
}

export async function generateModelStructured(request: ModelStructuredRequest): Promise<ModelGenerationResult> {
  return executeGateway(request, "json_schema", (adapter, target) => {
    if (!adapter.generateStructured) {
      throw new ModelProviderError(
        `${adapter.id} does not support structured generation.`,
        adapter.id,
        "invalid_request",
        false,
      );
    }
    return adapter.generateStructured(request, target);
  });
}

export async function generateModelToolTurn(
  request: ModelToolTurnRequest,
): Promise<ModelToolTurnResult> {
  if (
    request.continuation &&
    request.continuation.provider !== request.preferredProvider
  ) {
    throw new ModelProviderError(
      "Tool-turn continuation state cannot cross model providers.",
      request.preferredProvider,
      "invalid_request",
      false,
    );
  }
  if (
    request.allowedProviders &&
    !request.allowedProviders.includes(request.preferredProvider)
  ) {
    throw new ModelProviderError(
      "The preferred provider is outside this request's provider allowlist.",
      request.preferredProvider,
      "invalid_request",
      false,
    );
  }

  const crossProviderFirstTurn =
    !request.continuation &&
    request.allowCrossProviderFallback === true &&
    request.allowedProviders?.some(
      (provider) => provider !== request.preferredProvider,
    ) === true;
  const gatewayRequest: ModelToolTurnRequest = {
    ...request,
    allowedProviders: crossProviderFirstTurn
      ? request.allowedProviders
      : [request.preferredProvider],
    allowCrossProviderFallback: crossProviderFirstTurn,
    tools: request.tools,
    toolResults: sanitizeToolResults(request.toolResults),
  };
  const runtime = getModelRuntime(request);
  if (runtime) bindModelRuntime(gatewayRequest, runtime);
  return executeGateway(
    gatewayRequest,
    "tools",
    (adapter, target) => {
      if (!adapter.generateToolTurn) {
        throw new ModelProviderError(
          `${adapter.id} does not support governed tool turns.`,
          adapter.id,
          "invalid_request",
          false,
        );
      }
      const candidateRequest: ModelToolTurnRequest = {
        ...gatewayRequest,
        preferredProvider: adapter.id,
        allowedProviders: [adapter.id],
        allowCrossProviderFallback: false,
        tools: sanitizeToolDefinitions(gatewayRequest.tools, adapter.id),
      };
      if (runtime) bindModelRuntime(candidateRequest, runtime);
      return adapter.generateToolTurn(candidateRequest, target);
    },
  );
}

async function executeGateway<
  TResult extends Omit<ModelGenerationResult, "attempts">,
>(
  request: ModelTextRequest,
  feature: "text" | "json_schema" | "tools",
  execute: (
    adapter: ModelProviderAdapter,
    target: ReturnType<typeof modelTargets>[number]["target"],
  ) => Promise<TResult>,
): Promise<TResult & { attempts: ModelAttemptReceipt[] }> {
  const gatewayStartedAt = Date.now();
  const usageRecordId = request.usageScope ? randomUUID() : undefined;
  const runtime = getModelRuntime(request);
  const candidates = modelTargets({
    tier: request.tier || "fast",
    feature,
    preferredProvider: request.preferredProvider,
    allowedProviders: request.allowedProviders,
    allowCrossProviderFallback: request.allowCrossProviderFallback,
    runtimeTargets: runtime?.targets,
  }).slice(0, MAX_TARGET_ATTEMPTS);
  if (!candidates.length) {
    const gatewayLatencyMs = Date.now() - gatewayStartedAt;
    let usageReceiptRecorded = false;
    if (request.usageScope) {
      usageReceiptRecorded = Boolean(await recordAiUsageSafely({
        ...request.usageScope,
        id: usageRecordId,
        status: "failed",
        provider:
          request.preferredProvider || request.allowedProviders?.[0] || "local",
        model: "unresolved",
        usage: {},
        providerCallCount: 0,
        attemptCount: 0,
        failedAttemptCount: 0,
        latencyMs: gatewayLatencyMs,
        failureKind: "unavailable",
        retryable: false,
      }));
    }
    throw attachAttempts(attachModelProviderResponseReceipt(
      new ModelProviderError(
        `No configured model provider supports ${feature}.`,
        request.preferredProvider || request.allowedProviders?.[0] || "local",
        "unavailable",
        false,
      ),
      {
        usage: {},
        latencyMs: gatewayLatencyMs,
        model: "unresolved",
      },
    ), [], usageRecordId, usageReceiptRecorded);
  }

  const attempts: ModelAttemptReceipt[] = [];
  let lastError: ModelProviderError | undefined;
  for (const [index, candidate] of candidates.entries()) {
    const startedAt = Date.now();
    try {
      const result = await execute(candidate.adapter, candidate.target);
      attempts.push({
        provider: result.provider,
        model: result.model,
        status: "completed",
        latencyMs: result.latencyMs,
        usage: result.usage,
        ...(result.costKnown && result.estimatedCostUsd !== undefined
          ? { estimatedCostUsd: result.estimatedCostUsd }
          : {}),
        ...(result.providerRequestId
          ? { providerRequestId: result.providerRequestId }
          : {}),
      });
      const totalUsage = sumAttemptUsage(attempts);
      const estimatedCostUsd = sumKnownAttemptCost(attempts);
      const gatewayLatencyMs = Date.now() - gatewayStartedAt;
      let usageReceiptRecorded = false;
      if (request.usageScope) {
        usageReceiptRecorded = Boolean(await recordAiUsageSafely({
          ...request.usageScope,
          id: usageRecordId,
          status: "completed",
          provider: result.provider,
          model: result.model,
          usage: totalUsage,
          providerCallCount: attempts.length,
          attemptCount: attempts.length,
          failedAttemptCount: attempts.filter((attempt) => attempt.status === "failed").length,
          callReceipts: modelAttemptCallReceipts(attempts),
          latencyMs: gatewayLatencyMs,
          estimatedCostUsd,
          providerRequestId: result.providerRequestId,
        }));
      }
      return {
        ...result,
        usage: totalUsage,
        estimatedCostUsd,
        costKnown: estimatedCostUsd !== undefined,
        latencyMs: gatewayLatencyMs,
        attempts,
        usageReceiptRecorded,
        ...(usageRecordId ? { usageReceiptId: usageRecordId } : {}),
      };
    } catch (error) {
      const failure = candidate.adapter.classifyError(error);
      const responseReceipt =
        getModelProviderResponseReceipt(error) ||
        getModelProviderResponseReceipt(failure);
      attempts.push({
        provider: candidate.adapter.id,
        model: responseReceipt?.model || candidate.target.model,
        status: "failed",
        latencyMs: responseReceipt?.latencyMs ?? Date.now() - startedAt,
        failureKind: failure.kind,
        retryable: failure.retryable,
        ...(responseReceipt?.usage ? { usage: responseReceipt.usage } : {}),
        ...(responseReceipt?.estimatedCostUsd !== undefined
          ? { estimatedCostUsd: responseReceipt.estimatedCostUsd }
          : {}),
        ...(responseReceipt?.providerRequestId
          ? { providerRequestId: responseReceipt.providerRequestId }
          : {}),
      });
      lastError = failure;
      if (!failure.retryable || index === candidates.length - 1) {
        const totalUsage = sumAttemptUsage(attempts);
        const estimatedCostUsd = sumKnownAttemptCost(attempts);
        const gatewayLatencyMs = Date.now() - gatewayStartedAt;
        const meteredFailure = attachModelProviderResponseReceipt(failure, {
          usage: totalUsage,
          latencyMs: gatewayLatencyMs,
          model: responseReceipt?.model || candidate.target.model,
          estimatedCostUsd,
          providerRequestId: responseReceipt?.providerRequestId,
        });
        let usageReceiptRecorded = false;
        if (request.usageScope) {
          usageReceiptRecorded = Boolean(await recordAiUsageSafely({
            ...request.usageScope,
            id: usageRecordId,
            status: "failed",
            provider: candidate.adapter.id,
            model: responseReceipt?.model || candidate.target.model,
            usage: totalUsage,
            providerCallCount: attempts.length,
            attemptCount: attempts.length,
            failedAttemptCount: attempts.length,
            callReceipts: modelAttemptCallReceipts(attempts),
            latencyMs: gatewayLatencyMs,
            estimatedCostUsd,
            providerRequestId: responseReceipt?.providerRequestId,
            failureKind: failure.kind,
            retryable: failure.retryable,
          }));
        }
        throw attachAttempts(
          meteredFailure,
          attempts,
          usageRecordId,
          usageReceiptRecorded,
        );
      }
    }
  }
  throw attachAttempts(
    lastError || new ModelProviderError("Every model provider failed.", "local", "unknown", false),
    attempts,
  );
}

function sumAttemptUsage(attempts: readonly ModelAttemptReceipt[]) {
  return attempts.reduce(
    (total, attempt) => ({
      inputTokens: total.inputTokens + (attempt.usage?.inputTokens || 0),
      outputTokens: total.outputTokens + (attempt.usage?.outputTokens || 0),
      cachedInputTokens:
        total.cachedInputTokens + (attempt.usage?.cachedInputTokens || 0),
      totalTokens: total.totalTokens + (attempt.usage?.totalTokens || 0),
    }),
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
  );
}

function sumKnownAttemptCost(attempts: readonly ModelAttemptReceipt[]) {
  if (
    !attempts.length ||
    attempts.some((attempt) => attempt.estimatedCostUsd === undefined)
  ) {
    return undefined;
  }
  return Math.round(
    attempts.reduce(
      (total, attempt) => total + (attempt.estimatedCostUsd || 0),
      0,
    ) * 1_000_000,
  ) / 1_000_000;
}

function modelAttemptCallReceipts(attempts: readonly ModelAttemptReceipt[]) {
  return attempts.map((attempt) => ({
    provider: attempt.provider,
    model: attempt.model,
    status: attempt.status,
    usage: attempt.usage || {},
    latencyMs: attempt.latencyMs,
    estimatedCostUsd: attempt.estimatedCostUsd,
    providerRequestId: attempt.providerRequestId,
    failureKind: attempt.failureKind,
    retryable: attempt.retryable,
  }));
}

function sanitizeToolDefinitions(
  tools: readonly ModelToolDefinition[],
  provider: ModelToolTurnRequest["preferredProvider"],
) {
  if (tools.length > MAX_TOOL_DEFINITIONS) {
    throw new ModelProviderError(
      `Model tool count exceeds the ${MAX_TOOL_DEFINITIONS}-tool limit.`,
      provider,
      "invalid_request",
      false,
    );
  }
  const sanitized: ModelToolDefinition[] = [];
  const seen = new Set<string>();
  let totalSchemaBytes = 0;

  for (const tool of tools) {
    const name = tool.name.trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || seen.has(name)) {
      throw new ModelProviderError(
        `Invalid or duplicate model tool name: ${name || "(empty)"}.`,
        provider,
        "invalid_request",
        false,
      );
    }
    let serializedSchema: string;
    try {
      serializedSchema = JSON.stringify(tool.parameters);
    } catch {
      throw new ModelProviderError(
        `Tool schema for ${name} is not serializable.`,
        provider,
        "invalid_request",
        false,
      );
    }
    const schemaBytes = Buffer.byteLength(serializedSchema, "utf8");
    if (
      schemaBytes > MAX_TOOL_SCHEMA_BYTES ||
      totalSchemaBytes + schemaBytes > MAX_TOOL_SCHEMA_TOTAL_BYTES
    ) {
      throw new ModelProviderError(
        `Tool schema budget exceeded for ${name}.`,
        provider,
        "invalid_request",
        false,
      );
    }
    const parsedSchema = JSON.parse(serializedSchema) as Record<string, unknown>;
    if (!parsedSchema || typeof parsedSchema !== "object" || Array.isArray(parsedSchema)) {
      throw new ModelProviderError(
        `Tool schema for ${name} must be a JSON object.`,
        provider,
        "invalid_request",
        false,
      );
    }
    seen.add(name);
    totalSchemaBytes += schemaBytes;
    sanitized.push({
      type: "function",
      name,
      description: tool.description
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, MAX_TOOL_DESCRIPTION_CHARS),
      parameters: parsedSchema,
    });
  }
  return sanitized;
}

function sanitizeToolResults(results: readonly ModelToolResult[] | undefined) {
  return (results || []).slice(0, MAX_TOOL_RESULTS_PER_TURN).map((result) => ({
    callId: String(result.callId).slice(0, 256),
    name: String(result.name).slice(0, 64),
    output: String(result.output).slice(0, MAX_TOOL_RESULT_CHARS),
    ...(result.isError ? { isError: true } : {}),
  }));
}

function attachAttempts(
  error: Error,
  attempts: ModelAttemptReceipt[],
  usageReceiptId?: string,
  usageReceiptRecorded = false,
) {
  Object.defineProperty(error, "attempts", {
    value: attempts,
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(error, "usageReceiptRecorded", {
    value: usageReceiptRecorded,
    enumerable: false,
    configurable: true,
  });
  if (usageReceiptId) {
    Object.defineProperty(error, "usageReceiptId", {
      value: usageReceiptId,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}
