import { createHash, createHmac } from "node:crypto";
import { classifyProviderError } from "@/lib/models/adapters/openai";
import {
  getModelRuntimeCredential,
  type ModelRuntimeCredential,
} from "@/lib/models/runtime-context";
import type {
  ModelProviderAdapter,
  ModelTarget,
  ModelTextRequest,
  ModelToolDefinition,
  ModelToolTurnRequest,
} from "@/lib/models/types";
import { ModelProviderError } from "@/lib/models/types";
import type { ModelUsage } from "@/lib/openai/model-router";

const PROVIDER = "aws_bedrock" as const;
const AWS_SERVICE = "bedrock";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_000;
const MAX_OUTPUT_TOKENS = 16_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CONTINUATION_MESSAGES = 64;
const MAX_CONTENT_BLOCKS = 64;
const MAX_TOOL_CALLS = 16;
const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;
const DEFAULT_FAST_MODEL = "amazon.nova-lite-v1:0";
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const TOOL_USE_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,64}$/;

export type BedrockRuntimeCredential = Extract<
  ModelRuntimeCredential,
  { kind: "aws_bedrock" }
>;

export type BedrockAdapterOptions = Readonly<{
  fetchImplementation?: typeof fetch;
  now?: () => Date;
  requestTimeoutMs?: number;
}>;

type BedrockToolUse = {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
};

type BedrockContentBlock =
  | { text: string }
  | { toolUse: BedrockToolUse }
  | {
      toolResult: {
        toolUseId: string;
        content: Array<{ text: string }>;
        status: "success" | "error";
      };
    };

type BedrockMessage = {
  role: "user" | "assistant";
  content: BedrockContentBlock[];
};

type BedrockConverseResponse = {
  output?: {
    message?: unknown;
  };
  stopReason?: unknown;
  usage?: {
    inputTokens?: unknown;
    outputTokens?: unknown;
    totalTokens?: unknown;
    cacheReadInputTokens?: unknown;
  };
};

type BedrockCallResult = {
  body: BedrockConverseResponse;
  latencyMs: number;
};

export function createBedrockModelAdapter(
  options: BedrockAdapterOptions = {},
): ModelProviderAdapter {
  const fetchImplementation = options.fetchImplementation || globalThis.fetch;
  const now = options.now || (() => new Date());
  const requestTimeoutMs = boundedInteger(
    options.requestTimeoutMs,
    DEFAULT_TIMEOUT_MS,
    1_000,
    MAX_TIMEOUT_MS,
  );

  return {
    id: PROVIDER,
    configured() {
      return Boolean(environmentCredentials() && deploymentModel("fast"));
    },
    targets(tier) {
      return [{
        provider: PROVIDER,
        model: deploymentModel(tier) || DEFAULT_FAST_MODEL,
        tier,
        features: ["text", "tools"],
      }];
    },
    async generateText(request, target) {
      const result = await callBedrockConverse({
        request,
        target,
        payload: {
          messages: [initialUserMessage(request.input)],
        },
        fetchImplementation,
        now,
        requestTimeoutMs,
      });
      rejectUnsafeStopReason(result.body.stopReason);
      const output = normalizeAssistantOutput(result.body.output?.message);
      if (!output.text) {
        throw new ModelProviderError(
          "Amazon Bedrock returned no text.",
          PROVIDER,
          "unknown",
          false,
        );
      }
      return modelResult(result, target, output.text);
    },
    async generateToolTurn(request, target) {
      const messages = bedrockToolMessages(request);
      const result = await callBedrockConverse({
        request,
        target,
        payload: {
          messages,
          ...(request.tools.length
            ? { toolConfig: bedrockToolConfig(request.tools) }
            : {}),
        },
        fetchImplementation,
        now,
        requestTimeoutMs,
      });
      rejectUnsafeStopReason(result.body.stopReason);
      const output = normalizeAssistantOutput(result.body.output?.message);
      if (!output.text && !output.toolCalls.length) {
        throw new ModelProviderError(
          "Amazon Bedrock returned neither text nor tool calls.",
          PROVIDER,
          "unknown",
          false,
        );
      }
      if (result.body.stopReason === "tool_use" && !output.toolCalls.length) {
        throw new ModelProviderError(
          "Amazon Bedrock reported tool use without a valid tool call.",
          PROVIDER,
          "invalid_request",
          false,
        );
      }
      return {
        ...modelResult(result, target, output.text),
        toolCalls: output.toolCalls,
        continuation: {
          provider: PROVIDER,
          state: [...messages, output.message],
        },
      };
    },
    classifyError(error) {
      return classifyProviderError(PROVIDER, error);
    },
  };
}

export const bedrockModelAdapter = createBedrockModelAdapter();

async function callBedrockConverse(input: {
  request: ModelTextRequest;
  target: ModelTarget;
  payload: Record<string, unknown>;
  fetchImplementation: typeof fetch;
  now: () => Date;
  requestTimeoutMs: number;
}): Promise<BedrockCallResult> {
  if (input.request.abortSignal?.aborted) {
    throw new ModelProviderError(
      "Amazon Bedrock request was aborted.",
      PROVIDER,
      "abort",
      false,
    );
  }
  const credentials = resolveCredentials(input.request);
  const modelId = normalizeModelId(input.target.model);
  const url = bedrockConverseUrl(credentials.region, modelId);
  const payload = {
    ...input.payload,
    ...(input.request.instructions
      ? { system: [{ text: input.request.instructions }] }
      : {}),
    inferenceConfig: {
      maxTokens: boundedInteger(
        input.request.maxOutputTokens,
        DEFAULT_MAX_OUTPUT_TOKENS,
        1,
        MAX_OUTPUT_TOKENS,
      ),
    },
  };
  let body: string;
  try {
    const serialized = JSON.stringify(payload);
    if (!serialized) throw new Error("not serializable");
    body = serialized;
  } catch {
    throw new ModelProviderError(
      "Amazon Bedrock request content is not serializable.",
      PROVIDER,
      "invalid_request",
      false,
    );
  }
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new ModelProviderError(
      "Amazon Bedrock request exceeded the one-megabyte adapter limit.",
      PROVIDER,
      "invalid_request",
      false,
    );
  }

  const signedHeaders = signAwsRequest({
    url,
    method: "POST",
    body,
    credentials,
    now: input.now(),
  });
  const boundedSignal = createBoundedSignal(
    input.request.abortSignal,
    input.requestTimeoutMs,
  );
  const startedAt = Date.now();
  try {
    const response = await input.fetchImplementation(url, {
      method: "POST",
      headers: signedHeaders,
      body,
      cache: "no-store",
      redirect: "error",
      signal: boundedSignal.signal,
    });
    const responseText = await readBoundedResponse(response);
    const parsed = parseResponseJson(responseText, response.ok);
    if (!response.ok) {
      throw bedrockHttpError(
        response.status,
        bedrockErrorCode(response, parsed),
      );
    }
    return {
      body: parsed as BedrockConverseResponse,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (boundedSignal.timedOut()) {
      throw new ModelProviderError(
        "Amazon Bedrock request timed out.",
        PROVIDER,
        "timeout",
        true,
      );
    }
    if (input.request.abortSignal?.aborted) {
      throw new ModelProviderError(
        "Amazon Bedrock request was aborted.",
        PROVIDER,
        "abort",
        false,
      );
    }
    throw error;
  } finally {
    boundedSignal.cleanup();
  }
}

function resolveCredentials(request: ModelTextRequest): BedrockRuntimeCredential {
  const runtime = getModelRuntimeCredential(request, PROVIDER);
  if (runtime) {
    if (runtime.kind !== "aws_bedrock") {
      throw new ModelProviderError(
        "The request-bound Amazon Bedrock credential has an invalid type.",
        PROVIDER,
        "authentication",
        false,
      );
    }
    return normalizeCredentials(runtime);
  }
  const fallback = environmentCredentials();
  if (!fallback) {
    throw new ModelProviderError(
      "Amazon Bedrock is not configured for this request.",
      PROVIDER,
      "authentication",
      false,
    );
  }
  return fallback;
}

function environmentCredentials(): BedrockRuntimeCredential | undefined {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  const region = (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION)?.trim();
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim();
  if (!accessKeyId || !secretAccessKey || !region) return undefined;
  try {
    return normalizeCredentials({
      kind: "aws_bedrock",
      accessKeyId,
      secretAccessKey,
      region,
      ...(sessionToken
        ? { sessionToken }
        : {}),
    });
  } catch {
    return undefined;
  }
}

function normalizeCredentials(
  value: BedrockRuntimeCredential,
): BedrockRuntimeCredential {
  const accessKeyId = value.accessKeyId.trim();
  const secretAccessKey = value.secretAccessKey.trim();
  const region = value.region.trim().toLowerCase();
  const sessionToken = value.sessionToken?.trim();
  if (
    accessKeyId.length < 12 ||
    accessKeyId.length > 256 ||
    /[\u0000-\u0020\u007f]/.test(accessKeyId) ||
    secretAccessKey.length < 24 ||
    secretAccessKey.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(secretAccessKey) ||
    !REGION_PATTERN.test(region) ||
    (sessionToken && (
      sessionToken.length > 8_192 ||
      /[\u0000-\u0020\u007f]/.test(sessionToken)
    ))
  ) {
    throw new ModelProviderError(
      "Amazon Bedrock credentials are invalid.",
      PROVIDER,
      "authentication",
      false,
    );
  }
  return {
    kind: "aws_bedrock",
    accessKeyId,
    secretAccessKey,
    region,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

function deploymentModel(tier: ModelTarget["tier"]) {
  const shared = process.env.AWS_BEDROCK_MODEL?.trim();
  const fast = process.env.AWS_BEDROCK_FAST_MODEL?.trim();
  const reasoning = process.env.AWS_BEDROCK_REASONING_MODEL?.trim();
  if (tier === "reasoning") {
    return reasoning || shared || fast;
  }
  return fast || shared || reasoning;
}

function normalizeModelId(value: string) {
  const modelId = value.trim();
  if (
    !modelId ||
    modelId.length > 2_048 ||
    /[\u0000-\u0020\u007f]/.test(modelId)
  ) {
    throw new ModelProviderError(
      "Amazon Bedrock model ID is invalid.",
      PROVIDER,
      "invalid_request",
      false,
    );
  }
  return modelId;
}

function bedrockConverseUrl(region: string, modelId: string) {
  const suffix = region.startsWith("cn-")
    ? "amazonaws.com.cn"
    : "amazonaws.com";
  return new URL(
    `https://bedrock-runtime.${region}.${suffix}/model/${awsPercentEncode(modelId)}/converse`,
  );
}

function signAwsRequest(input: {
  url: URL;
  method: "POST";
  body: string;
  credentials: BedrockRuntimeCredential;
  now: Date;
}) {
  const amzDate = awsTimestamp(input.now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(input.body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${canonicalHeaderValue(headers[name])}\n`)
    .join("");
  const canonicalRequest = [
    input.method,
    input.url.pathname || "/",
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaderNames.join(";"),
    payloadHash,
  ].join("\n");
  const credentialScope = [
    dateStamp,
    input.credentials.region,
    AWS_SERVICE,
    "aws4_request",
  ].join("/");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, input.credentials.region);
  const serviceKey = hmac(regionKey, AWS_SERVICE);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign).toString("hex");
  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
  };
}

function awsTimestamp(now: Date) {
  if (!Number.isFinite(now.getTime())) {
    throw new ModelProviderError(
      "Amazon Bedrock request time is invalid.",
      PROVIDER,
      "unknown",
      false,
    );
  }
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function canonicalQuery(url: URL) {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [awsPercentEncode(key), awsPercentEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey < rightKey) return -1;
      if (leftKey > rightKey) return 1;
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
      return 0;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function canonicalHeaderValue(value: string) {
  return value.trim().replace(/[\t ]+/g, " ");
}

function awsPercentEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function createBoundedSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let didTimeOut = false;
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    forwardAbort();
  } else {
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

async function readBoundedResponse(response: Response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModelProviderError(
      "Amazon Bedrock response exceeded the adapter limit.",
      PROVIDER,
      "unknown",
      false,
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ModelProviderError(
        "Amazon Bedrock response exceeded the adapter limit.",
        PROVIDER,
        "unknown",
        false,
      );
    }
    text += decoder.decode(part.value, { stream: true });
  }
  return text + decoder.decode();
}

function parseResponseJson(value: string, required: boolean): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A failed provider response can legitimately be empty or non-JSON. Its
    // status and sanitized error type still determine the public failure.
  }
  if (required) {
    throw new ModelProviderError(
      "Amazon Bedrock returned an invalid response.",
      PROVIDER,
      "unknown",
      false,
    );
  }
  return {};
}

function bedrockErrorCode(
  response: Response,
  payload: Record<string, unknown>,
) {
  const raw = response.headers.get("x-amzn-errortype") ||
    stringValue(payload.__type) ||
    stringValue(payload.code);
  if (!raw) return "BedrockServiceError";
  const lastNamespacePart = raw.split("#").at(-1) || raw;
  const code = lastNamespacePart.split(":")[0];
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(code)
    ? code
    : "BedrockServiceError";
}

function bedrockHttpError(status: number, code: string) {
  const normalized = code.toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    normalized.includes("accessdenied") ||
    normalized.includes("unrecognizedclient") ||
    normalized.includes("invalidsignature") ||
    normalized.includes("incompletesignature") ||
    normalized.includes("expiredtoken")
  ) {
    return new ModelProviderError(
      `Amazon Bedrock rejected the request credentials (${code}).`,
      PROVIDER,
      "authentication",
      false,
      status,
    );
  }
  if (
    status === 429 ||
    normalized.includes("throttl") ||
    normalized.includes("servicequota")
  ) {
    return new ModelProviderError(
      `Amazon Bedrock rate-limited the request (${code}).`,
      PROVIDER,
      "rate_limit",
      true,
      status,
    );
  }
  if (status === 408 || status === 504 || normalized.includes("timeout")) {
    return new ModelProviderError(
      `Amazon Bedrock timed out (${code}).`,
      PROVIDER,
      "timeout",
      true,
      status,
    );
  }
  if (
    status >= 500 ||
    status === 424 ||
    normalized.includes("notready") ||
    normalized.includes("internalserver") ||
    normalized.includes("serviceunavailable") ||
    normalized.includes("modelerror")
  ) {
    return new ModelProviderError(
      `Amazon Bedrock is temporarily unavailable (${code}).`,
      PROVIDER,
      "unavailable",
      true,
      status,
    );
  }
  return new ModelProviderError(
    `Amazon Bedrock rejected the request (${code}).`,
    PROVIDER,
    "invalid_request",
    false,
    status,
  );
}

function initialUserMessage(input: string): BedrockMessage {
  if (!input.trim()) {
    throw new ModelProviderError(
      "Amazon Bedrock requires non-empty input.",
      PROVIDER,
      "invalid_request",
      false,
    );
  }
  return { role: "user", content: [{ text: input }] };
}

function bedrockToolMessages(request: ModelToolTurnRequest): BedrockMessage[] {
  if (request.continuation && request.continuation.provider !== PROVIDER) {
    throw new ModelProviderError(
      "Amazon Bedrock cannot consume another provider's continuation state.",
      PROVIDER,
      "invalid_request",
      false,
    );
  }
  const messages = request.continuation?.state.length
    ? normalizeContinuation(request.continuation.state)
    : [initialUserMessage(request.input)];
  if (!request.toolResults?.length) return messages;

  const pendingTools = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if ("toolUse" in block) {
        pendingTools.set(block.toolUse.toolUseId, block.toolUse.name);
      }
    }
  }
  const seenResults = new Set<string>();
  const content = request.toolResults.map((result) => {
    const callId = result.callId.trim();
    const name = result.name.trim();
    if (
      !TOOL_USE_ID_PATTERN.test(callId) ||
      seenResults.has(callId) ||
      pendingTools.get(callId) !== name
    ) {
      throw new ModelProviderError(
        "Amazon Bedrock received an unmatched or duplicate tool result.",
        PROVIDER,
        "invalid_request",
        false,
      );
    }
    seenResults.add(callId);
    return {
      toolResult: {
        toolUseId: callId,
        content: [{ text: result.output }],
        status: result.isError ? "error" as const : "success" as const,
      },
    };
  });
  messages.push({ role: "user", content });
  return messages;
}

function normalizeContinuation(
  state: readonly Record<string, unknown>[],
): BedrockMessage[] {
  if (!state.length || state.length > MAX_CONTINUATION_MESSAGES) {
    throw new ModelProviderError(
      "Amazon Bedrock continuation length is invalid.",
      PROVIDER,
      "invalid_request",
      false,
    );
  }
  return state.map((raw) => {
    const role = raw.role;
    const rawContent = raw.content;
    if (
      (role !== "user" && role !== "assistant") ||
      !Array.isArray(rawContent) ||
      !rawContent.length ||
      rawContent.length > MAX_CONTENT_BLOCKS
    ) {
      throw invalidContinuation();
    }
    const content = rawContent.flatMap((block) => {
      const normalized = normalizeContinuationBlock(block, role);
      return normalized ? [normalized] : [];
    });
    if (!content.length) throw invalidContinuation();
    return { role, content };
  });
}

function normalizeContinuationBlock(
  value: unknown,
  role: "user" | "assistant",
): BedrockContentBlock | undefined {
  const block = recordValue(value);
  if (!block) return undefined;
  if (typeof block.text === "string") return { text: block.text };

  const toolUse = recordValue(block.toolUse);
  if (toolUse && role === "assistant") {
    return { toolUse: normalizeToolUse(toolUse) };
  }
  const toolResult = recordValue(block.toolResult);
  if (toolResult && role === "user") {
    const toolUseId = stringValue(toolResult.toolUseId);
    const status = toolResult.status === "error" ? "error" : "success";
    const rawContent = Array.isArray(toolResult.content)
      ? toolResult.content
      : [];
    const content = rawContent.flatMap((item) => {
      const candidate = recordValue(item);
      return candidate && typeof candidate.text === "string"
        ? [{ text: candidate.text }]
        : [];
    });
    if (!TOOL_USE_ID_PATTERN.test(toolUseId) || !content.length) {
      throw invalidContinuation();
    }
    return { toolResult: { toolUseId, content, status } };
  }
  // Reasoning and provider-specific content are intentionally not carried in
  // the public continuation. This prevents private chain-of-thought leakage.
  return undefined;
}

function invalidContinuation() {
  return new ModelProviderError(
    "Amazon Bedrock continuation state is invalid.",
    PROVIDER,
    "invalid_request",
    false,
  );
}

function bedrockToolConfig(tools: readonly ModelToolDefinition[]) {
  return {
    tools: tools.map((tool) => ({
      toolSpec: {
        name: tool.name,
        description: tool.description || `Use ${tool.name}.`,
        inputSchema: { json: tool.parameters },
      },
    })),
  };
}

function normalizeAssistantOutput(value: unknown) {
  const raw = recordValue(value);
  const rawContent = raw?.content;
  if (
    raw?.role !== "assistant" ||
    !Array.isArray(rawContent) ||
    !rawContent.length ||
    rawContent.length > MAX_CONTENT_BLOCKS
  ) {
    throw new ModelProviderError(
      "Amazon Bedrock returned a malformed assistant message.",
      PROVIDER,
      "unknown",
      false,
    );
  }
  const continuationContent: BedrockContentBlock[] = [];
  const text: string[] = [];
  const toolCalls: Array<{
    callId: string;
    name: string;
    argumentsJson: string;
  }> = [];
  for (const item of rawContent) {
    const block = recordValue(item);
    if (!block) continue;
    if (typeof block.text === "string") {
      text.push(block.text);
      continuationContent.push({ text: block.text });
      continue;
    }
    const rawToolUse = recordValue(block.toolUse);
    if (!rawToolUse) continue;
    const toolUse = normalizeToolUse(rawToolUse);
    const argumentsJson = JSON.stringify(toolUse.input);
    if (Buffer.byteLength(argumentsJson, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
      throw new ModelProviderError(
        "Amazon Bedrock tool arguments exceeded the adapter limit.",
        PROVIDER,
        "invalid_request",
        false,
      );
    }
    toolCalls.push({
      callId: toolUse.toolUseId,
      name: toolUse.name,
      argumentsJson,
    });
    continuationContent.push({ toolUse });
  }
  if (!continuationContent.length || toolCalls.length > MAX_TOOL_CALLS) {
    throw new ModelProviderError(
      "Amazon Bedrock returned unsupported content.",
      PROVIDER,
      "unknown",
      false,
    );
  }
  return {
    text: text.join("").trim(),
    toolCalls,
    message: {
      role: "assistant" as const,
      content: continuationContent,
    },
  };
}

function normalizeToolUse(value: Record<string, unknown>): BedrockToolUse {
  const toolUseId = stringValue(value.toolUseId);
  const name = stringValue(value.name);
  const input = recordValue(value.input);
  if (
    !TOOL_USE_ID_PATTERN.test(toolUseId) ||
    !TOOL_NAME_PATTERN.test(name) ||
    !input
  ) {
    throw new ModelProviderError(
      "Amazon Bedrock returned a malformed tool call.",
      PROVIDER,
      "invalid_request",
      false,
    );
  }
  let cloned: Record<string, unknown>;
  try {
    const serialized = JSON.stringify(input);
    if (!serialized) throw new Error("not serializable");
    cloned = JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    throw new ModelProviderError(
      "Amazon Bedrock returned non-serializable tool arguments.",
      PROVIDER,
      "invalid_request",
      false,
    );
  }
  return { toolUseId, name, input: cloned };
}

function rejectUnsafeStopReason(value: unknown) {
  if (value === "guardrail_intervened" || value === "content_filtered") {
    throw new ModelProviderError(
      "Amazon Bedrock blocked the request for safety.",
      PROVIDER,
      "safety",
      false,
    );
  }
  if (
    value === "malformed_model_output" ||
    value === "malformed_tool_use" ||
    value === "model_context_window_exceeded"
  ) {
    throw new ModelProviderError(
      `Amazon Bedrock stopped with ${String(value)}.`,
      PROVIDER,
      "invalid_request",
      false,
    );
  }
}

function modelResult(
  result: BedrockCallResult,
  target: ModelTarget,
  text: string,
) {
  return {
    text,
    provider: PROVIDER,
    model: target.model,
    usage: bedrockUsage(result.body.usage),
    latencyMs: result.latencyMs,
    costKnown: false as const,
  };
}

function bedrockUsage(raw: BedrockConverseResponse["usage"]): ModelUsage {
  const inputTokens = finite(raw?.inputTokens);
  const outputTokens = finite(raw?.outputTokens);
  const calculatedTotal = inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: finite(raw?.cacheReadInputTokens),
    totalTokens: Math.max(calculatedTotal, finite(raw?.totalTokens)),
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function finite(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), minimum), maximum);
}
