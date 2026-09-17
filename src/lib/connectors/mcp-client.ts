import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { assertConnectorSecretBinding } from "@/lib/connectors/secret-binding";
import { resolveMcpBearerCredential } from "@/lib/connectors/credential-store";
import {
  assertMcpEndpointIsSupported,
  isOfficialGitHubMcpEndpoint,
  isRemoteBrowserMcpIdentity,
  isRemoteBrowserMcpTool,
  RETIRED_REMOTE_BROWSER_MCP_MESSAGE,
} from "@/lib/connectors/mcp-trust";
import type { McpConnectorRecord, McpToolRecord } from "@/lib/connectors/types";
import { createMcpToolId } from "@/lib/connectors/store";
import { assertPublicHttpUrl, fetchPublicHttpUrl } from "@/lib/security/network";
import { redactExactSecrets } from "@/lib/security/secret-redaction";
import type { SecurityRole } from "@/lib/security/types";
import type { ToolRiskLevel } from "@/lib/tools/types";

const CLIENT_INFO = {
  name: "asael",
  version: "0.1.0",
};

const MCP_DISCOVERY_DEADLINE_MS = 45_000;
const MCP_TOOL_DEADLINE_MS = 65_000;
const MCP_MAX_DISCOVERY_PAGES = 20;
const MCP_MAX_TOOLS = 250;
const MCP_MAX_DISCOVERY_SCHEMA_BYTES = 1_000_000;
const MCP_MAX_RESPONSE_BYTES = 2_000_000;
const MCP_MAX_TOOL_ARGUMENT_BYTES = 256_000;
const MCP_MAX_TOOL_RESULT_BYTES = 1_000_000;
const MCP_MAX_INSTRUCTIONS_BYTES = 64_000;

type McpRequestPolicy = {
  deadlineAt: number;
  idempotencyKey?: string;
  abortSignal?: AbortSignal;
  responseMaxBytes: number;
};

type McpConnectedSession = {
  client: Client;
  transport: StreamableHTTPClientTransport;
  secretValues: string[];
};

export type McpSessionScope = {
  tenantId: string;
  actorId: string;
  executionId: string;
};

export async function discoverMcpTools(
  connector: McpConnectorRecord,
  options: {
    abortSignal?: AbortSignal;
    actorId?: string;
    actorRole?: SecurityRole;
  } = {},
) {
  assertSupportedMcpConnector(connector);
  const deadlineAt = Date.now() + MCP_DISCOVERY_DEADLINE_MS;
  const session = await connectMcp(connector, {
    deadlineAt,
    abortSignal: options.abortSignal,
    actorRole: options.actorRole,
  });
  try {
    const discoveredTools = redactExactSecrets(
      await collectTools(session.client, deadlineAt, options.abortSignal),
      session.secretValues,
    );
    const retiredTool = discoveredTools.find((tool) => isRemoteBrowserMcpTool(tool));
    if (retiredTool) {
      throw new Error(
        `${RETIRED_REMOTE_BROWSER_MCP_MESSAGE} Discovery quarantined tool ${safeToolName(retiredTool.name)}.`,
      );
    }
    const now = new Date().toISOString();
    const tools = discoveredTools.map((tool) => toToolRecord(connector, tool, now));
    const instructions = redactExactSecrets(
      session.client.getInstructions(),
      session.secretValues,
    );
    assertSerializedBytes(instructions, MCP_MAX_INSTRUCTIONS_BYTES, "MCP server instructions");

    return {
      tools,
      capabilities: toPlainObject(
        redactExactSecrets(
          session.client.getServerCapabilities(),
          session.secretValues,
        ),
      ),
      instructions,
      serverVersion: toPlainObject(
        redactExactSecrets(session.client.getServerVersion(), session.secretValues),
      ),
    };
  } catch (error) {
    throw sanitizedConnectorError(error, session.secretValues);
  } finally {
    await closeMcp(session);
  }
}

export async function callMcpTool({
  connector,
  toolName,
  args,
  idempotencyKey,
  abortSignal,
  actorRole,
  sessionScope,
  includeImages = false,
}: {
  connector: McpConnectorRecord;
  toolName: string;
  args: Record<string, unknown>;
  idempotencyKey?: string;
  abortSignal?: AbortSignal;
  actorRole?: SecurityRole;
  sessionScope?: McpSessionScope;
  /** Binary MCP content is never returned; retained only to reject legacy evidence callers. */
  includeImages?: boolean;
}) {
  assertSupportedMcpConnector(connector);
  if (isRemoteBrowserMcpTool({ name: toolName })) {
    throw new Error(RETIRED_REMOTE_BROWSER_MCP_MESSAGE);
  }
  if (includeImages) {
    throw new Error("Embedded remote MCP images are not accepted.");
  }
  assertSerializedBytes(args, MCP_MAX_TOOL_ARGUMENT_BYTES, "MCP tool arguments");
  const deadlineAt = Date.now() + MCP_TOOL_DEADLINE_MS;
  const lease = await acquireToolSession(connector, {
    deadlineAt,
    idempotencyKey,
    abortSignal,
    actorRole,
    sessionScope,
  });
  let receivedToolResult = false;
  try {
    const result = await lease.session.client.callTool(
      {
        name: toolName,
        arguments: args,
      },
      undefined,
      {
        timeout: Math.min(60_000, remainingMs(deadlineAt)),
        maxTotalTimeout: remainingMs(deadlineAt),
        signal: abortSignal,
      },
    );
    receivedToolResult = true;
    const safeResult = redactExactSecrets(
      toBoundedJsonValue(
        omitMcpBinaryContent(result),
        MCP_MAX_TOOL_RESULT_BYTES,
        "MCP tool result",
      ),
      lease.session.secretValues,
    );
    const failure = mcpToolFailureMessage(safeResult);
    if (failure) {
      throw new Error(failure);
    }
    return safeResult;
  } catch (error) {
    if (!receivedToolResult) {
      lease.invalidate();
    }
    throw sanitizedConnectorError(error, lease.session.secretValues);
  } finally {
    await lease.release();
  }
}

function omitMcpBinaryContent(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.content)) {
    return result;
  }
  const omitted = {
    image: 0,
    audio: 0,
    resourceBlob: 0,
  };
  const content = result.content.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [item];
    }
    const block = item as Record<string, unknown>;
    if (block.type === "image") {
      omitted.image += 1;
      return [];
    }
    if (block.type === "audio") {
      omitted.audio += 1;
      return [];
    }
    if (
      block.type === "resource" &&
      block.resource &&
      typeof block.resource === "object" &&
      !Array.isArray(block.resource) &&
      typeof (block.resource as Record<string, unknown>).blob === "string"
    ) {
      omitted.resourceBlob += 1;
      return [];
    }
    return [item];
  });
  const omittedCount = omitted.image + omitted.audio + omitted.resourceBlob;
  if (!omittedCount) return result;
  const labels = [
    omitted.image ? `${omitted.image} image` : "",
    omitted.audio ? `${omitted.audio} audio` : "",
    omitted.resourceBlob ? `${omitted.resourceBlob} binary resource` : "",
  ].filter(Boolean);
  return {
    ...result,
    content: [
      ...content,
      {
        type: "text",
        text: `[${labels.join(", ")} MCP ${omittedCount === 1 ? "block was" : "blocks were"} omitted.]`,
      },
    ],
  };
}

async function acquireToolSession(
  connector: McpConnectorRecord,
  options: {
    deadlineAt: number;
    idempotencyKey?: string;
    abortSignal?: AbortSignal;
    actorRole?: SecurityRole;
    sessionScope?: McpSessionScope;
    responseMaxBytes?: number;
  },
): Promise<{
  session: McpConnectedSession;
  invalidate: () => void;
  release: () => Promise<void>;
}> {
  const session = await connectMcp(connector, options);
  return {
    session,
    invalidate: () => undefined,
    release: () => closeMcp(session),
  };
}

function mcpRequestPolicy(options: {
  deadlineAt: number;
  idempotencyKey?: string;
  abortSignal?: AbortSignal;
  responseMaxBytes?: number;
}): McpRequestPolicy {
  return {
    deadlineAt: options.deadlineAt,
    idempotencyKey: options.idempotencyKey,
    abortSignal: options.abortSignal,
    responseMaxBytes: options.responseMaxBytes || MCP_MAX_RESPONSE_BYTES,
  };
}

async function connectMcp(
  connector: McpConnectorRecord,
  options: {
    deadlineAt: number;
    idempotencyKey?: string;
    abortSignal?: AbortSignal;
    actorRole?: SecurityRole;
    sessionScope?: McpSessionScope;
    responseMaxBytes?: number;
    requestPolicy?: McpRequestPolicy;
  },
): Promise<McpConnectedSession> {
  assertSupportedMcpConnector(connector);
  if (connector.transport !== "streamable_http") {
    throw new Error(`Unsupported MCP transport: ${connector.transport}`);
  }

  await assertPublicHttpUrl(connector.endpoint, "MCP endpoint");
  const endpoint = new URL(connector.endpoint);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("MCP endpoint must use http or https.");
  }

  const client = new Client(CLIENT_INFO, {
    capabilities: {},
  });
  const auth = await createRequestInit(
    connector,
    options.actorRole,
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: auth.requestInit,
    fetch: createValidatedMcpFetch(
      endpoint,
      options.requestPolicy || mcpRequestPolicy(options),
    ),
  });

  try {
    await client.connect(transport, {
      timeout: Math.min(15_000, remainingMs(options.deadlineAt)),
      maxTotalTimeout: remainingMs(options.deadlineAt),
      signal: options.abortSignal,
    });
    return { client, transport, secretValues: auth.secretValues };
  } catch (error) {
    await closeMcp({ client, transport });
    throw sanitizedConnectorError(error, auth.secretValues);
  }
}

async function collectTools(client: Client, deadlineAt: number, abortSignal?: AbortSignal) {
  const tools: Tool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let schemaBytes = 0;

  do {
    if (pages >= MCP_MAX_DISCOVERY_PAGES) {
      throw new Error(`MCP discovery exceeded ${MCP_MAX_DISCOVERY_PAGES} pages.`);
    }
    const page = await client.listTools(
      { cursor },
      {
        timeout: Math.min(10_000, remainingMs(deadlineAt)),
        maxTotalTimeout: remainingMs(deadlineAt),
        signal: abortSignal,
      },
    );
    pages += 1;
    tools.push(...page.tools);
    if (tools.length > MCP_MAX_TOOLS) {
      throw new Error(`MCP discovery exceeded ${MCP_MAX_TOOLS} tools.`);
    }
    schemaBytes += serializedBytes(page.tools);
    if (schemaBytes > MCP_MAX_DISCOVERY_SCHEMA_BYTES) {
      throw new Error("MCP discovery schemas exceeded the configured byte limit.");
    }
    cursor = page.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error("MCP discovery returned a repeated pagination cursor.");
      }
      seenCursors.add(cursor);
    }
  } while (cursor);

  return tools;
}

async function closeMcp(session: {
  client: Client;
  transport: StreamableHTTPClientTransport;
}) {
  await session.transport.terminateSession().catch(() => undefined);
  await session.client.close().catch(() => undefined);
}

async function createRequestInit(
  connector: McpConnectorRecord,
  actorRole?: SecurityRole,
): Promise<{ requestInit: RequestInit; secretValues: string[] }> {
  const headers = new Headers();
  const secretValues: string[] = [];
  if (connector.authType === "bearer_env") {
    const envName = connector.authTokenEnv?.trim().toUpperCase();
    if (!envName) {
      throw new Error("Bearer-token MCP connector requires an auth token environment variable name.");
    }
    assertConnectorSecretBinding({
      envName,
      tenantId: connector.tenantId,
      targetUrl: connector.endpoint,
      role: actorRole,
    });
    const token = process.env[envName];
    if (!token) {
      throw new Error(`MCP auth token environment variable ${envName} is not configured.`);
    }
    headers.set("authorization", `Bearer ${token}`);
    secretValues.push(token);
  } else if (connector.authType === "bearer_vault") {
    const token = await resolveMcpBearerCredential(connector);
    headers.set("authorization", `Bearer ${token}`);
    secretValues.push(token);
  }
  return {
    requestInit: {
      redirect: "manual",
      headers,
    },
    secretValues,
  };
}

function toToolRecord(connector: McpConnectorRecord, tool: Tool, now: string): McpToolRecord {
  const annotations = toPlainObject(tool.annotations);
  const riskLevel = inferMcpToolRisk(connector.defaultRiskLevel, annotations, {
    endpoint: connector.endpoint,
    toolName: tool.name,
    trustReadOnlyAnnotations: !connector.approvalRequired,
  });

  return {
    id: createMcpToolId(connector.id, tool.name),
    connectorId: connector.id,
    connectorName: connector.name,
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: toPlainObject(tool.inputSchema) || { type: "object" },
    outputSchema: toPlainObject(tool.outputSchema),
    annotations,
    riskLevel,
    approvalRequired: connector.approvalRequired || riskLevel >= 2,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

export function inferMcpToolRisk(
  defaultRisk: ToolRiskLevel,
  annotations?: Record<string, unknown>,
  options: {
    endpoint?: string;
    toolName?: string;
    trustReadOnlyAnnotations?: boolean;
  } = {},
): ToolRiskLevel {
  const destructive = annotations?.destructiveHint === true;
  const readOnly = annotations?.readOnlyHint === true;
  if (
    isOfficialGitHubMcpEndpoint(options.endpoint) &&
    isKnownGitHubMutation(options.toolName)
  ) {
    return Math.max(defaultRisk, 2) as ToolRiskLevel;
  }
  if (
    readOnly &&
    !destructive &&
    options.trustReadOnlyAnnotations &&
    isOfficialGitHubMcpEndpoint(options.endpoint)
  ) {
    return 0;
  }

  let remoteFloor: ToolRiskLevel = 0;
  if (
    destructive ||
    annotations?.readOnlyHint === false ||
    annotations?.openWorldHint === true
  ) {
    remoteFloor = 2;
  }
  return Math.max(defaultRisk, remoteFloor) as ToolRiskLevel;
}

function isKnownGitHubMutation(toolName?: string) {
  return toolName === "actions_run_trigger";
}

function toPlainObject(value: unknown): Record<string, unknown> | undefined {
  const json = toJsonValue(value);
  if (json && typeof json === "object" && !Array.isArray(json)) {
    return json as Record<string, unknown>;
  }

  return undefined;
}

function toJsonValue<T>(value: T): T | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function toBoundedJsonValue<T>(value: T, maxBytes: number, label: string): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not JSON serializable.`);
  }
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new Error(`${label} exceeded the configured byte limit.`);
  }
  return JSON.parse(serialized) as T;
}

function assertSerializedBytes(value: unknown, maxBytes: number, label: string) {
  const bytes = serializedBytes(value);
  if (bytes > maxBytes) {
    throw new Error(`${label} exceeded the configured byte limit.`);
  }
}

function serializedBytes(value: unknown) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("MCP data must be JSON serializable.");
  }
  return serialized ? new TextEncoder().encode(serialized).byteLength : 0;
}

function mcpToolFailureMessage(value: unknown) {
  const result = toPlainObject(value);
  if (result?.isError !== true) return undefined;

  const details = Array.isArray(result.content)
    ? result.content.flatMap((item) => {
        const content = toPlainObject(item);
        const text = content?.type === "text" && typeof content.text === "string"
          ? content.text.trim()
          : "";
        return text ? [text] : [];
      })
    : [];
  const detail = details.join("\n").slice(0, 1_800);
  return detail
    ? `MCP tool reported an error: ${detail}`
    : "MCP tool reported an error.";
}

function sanitizedConnectorError(
  error: unknown,
  secretValues: Array<string | undefined>,
) {
  const message = redactExactSecrets(
    connectorErrorMessage(error),
    secretValues,
  );
  return new Error(String(message).slice(0, 2_000));
}

function connectorErrorMessage(error: unknown) {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current) && chain.length < 6) {
    seen.add(current);
    chain.push(current);
    current = current && typeof current === "object"
      ? (current as { cause?: unknown }).cause
      : undefined;
  }

  const codes = chain
    .map((item) => item && typeof item === "object"
      ? String((item as { code?: unknown }).code || "")
      : "")
    .filter(Boolean);
  if (codes.some((code) => code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT")) {
    return "MCP endpoint connection timed out.";
  }
  const connectionCode = codes.find((code) => [
    "EAI_AGAIN",
    "EAI_FAIL",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
  ].includes(code));
  if (connectionCode) {
    return `MCP endpoint connection failed (${connectionCode}).`;
  }

  const errors = chain.filter((item): item is Error => item instanceof Error);
  if (errors.some((item) => item.name === "AbortError" || item.name === "TimeoutError")) {
    return "MCP request timed out or was cancelled.";
  }

  const primary = errors[0]?.message.trim();
  if (primary?.toLowerCase() === "fetch failed") {
    return "MCP endpoint request failed before receiving a response.";
  }
  return primary || "MCP connector request failed.";
}

function assertSupportedMcpConnector(connector: McpConnectorRecord) {
  assertMcpEndpointIsSupported(connector.endpoint);
  if (isRemoteBrowserMcpIdentity(connector)) {
    throw new Error(RETIRED_REMOTE_BROWSER_MCP_MESSAGE);
  }
}

function safeToolName(value: string | undefined) {
  const normalized = (value || "unnamed")
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return JSON.stringify(normalized || "unnamed");
}

function createValidatedMcpFetch(
  endpoint: URL,
  policy: McpRequestPolicy,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input), endpoint);
    if (requestUrl.origin !== endpoint.origin) {
      throw new Error(
        `MCP request resolved outside the connector origin (${requestUrl.origin} !== ${endpoint.origin}).`,
      );
    }
    const signals = [
      init?.signal,
      policy.abortSignal,
      AbortSignal.timeout(remainingMs(policy.deadlineAt)),
    ].filter((signal): signal is AbortSignal => Boolean(signal));
    const headers = new Headers(
      init?.headers || (input instanceof Request ? input.headers : undefined),
    );
    if (policy.idempotencyKey && await isMcpToolCallRequest(input, init)) {
      headers.set("idempotency-key", normalizeIdempotencyKey(policy.idempotencyKey));
    }
    const response = await fetchPublicHttpUrl(input instanceof Request ? input : requestUrl, {
      ...init,
      headers,
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    }, "MCP request URL");
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel("MCP redirects are disabled.").catch(() => undefined);
      throw new Error(`MCP server returned a redirect (${response.status}); redirects are disabled.`);
    }
    return limitMcpResponseBody(response, policy.responseMaxBytes);
  }) as typeof fetch;
}

async function isMcpToolCallRequest(input: RequestInfo | URL, init?: RequestInit) {
  let body: string | undefined;
  if (typeof init?.body === "string") {
    body = init.body;
  } else if (input instanceof Request && !init?.body && input.method === "POST") {
    body = await input.clone().text().catch(() => undefined);
  }
  if (!body) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed)
      ? parsed.some(isMcpToolCallMessage)
      : isMcpToolCallMessage(parsed);
  } catch {
    return false;
  }
}

function isMcpToolCallMessage(value: unknown) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { method?: unknown }).method === "tools/call",
  );
}

function limitMcpResponseBody(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel("MCP response byte limit exceeded.").catch(() => undefined);
    throw new Error("MCP response exceeded the configured byte limit.");
  }
  if (!response.body) {
    return response;
  }

  const reader = response.body.getReader();
  let bytesRead = 0;
  const boundedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          await reader.cancel("MCP response byte limit exceeded.").catch(() => undefined);
          controller.error(new Error("MCP response exceeded the configured byte limit."));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(boundedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function remainingMs(deadlineAt: number) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new Error("MCP operation exceeded its total deadline.");
  }
  return remaining;
}

function normalizeIdempotencyKey(value: string) {
  const normalized = value.trim().replace(/[\r\n]/g, "").slice(0, 200);
  if (!normalized) {
    throw new Error("Idempotency key must not be empty.");
  }
  return normalized;
}
