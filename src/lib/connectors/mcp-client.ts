import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { assertConnectorSecretBinding } from "@/lib/connectors/secret-binding";
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

export async function discoverMcpTools(
  connector: McpConnectorRecord,
  options: { abortSignal?: AbortSignal; actorRole?: SecurityRole } = {},
) {
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
}: {
  connector: McpConnectorRecord;
  toolName: string;
  args: Record<string, unknown>;
  idempotencyKey?: string;
  abortSignal?: AbortSignal;
  actorRole?: SecurityRole;
}) {
  assertSerializedBytes(args, MCP_MAX_TOOL_ARGUMENT_BYTES, "MCP tool arguments");
  const deadlineAt = Date.now() + MCP_TOOL_DEADLINE_MS;
  const session = await connectMcp(connector, {
    deadlineAt,
    idempotencyKey,
    abortSignal,
    actorRole,
  });
  try {
    const result = await session.client.callTool(
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
    return redactExactSecrets(
      toBoundedJsonValue(result, MCP_MAX_TOOL_RESULT_BYTES, "MCP tool result"),
      session.secretValues,
    );
  } catch (error) {
    throw sanitizedConnectorError(error, session.secretValues);
  } finally {
    await closeMcp(session);
  }
}

async function connectMcp(
  connector: McpConnectorRecord,
  options: {
    deadlineAt: number;
    idempotencyKey?: string;
    abortSignal?: AbortSignal;
    actorRole?: SecurityRole;
  },
) {
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
  const auth = createRequestInit(connector, options.actorRole);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: auth.requestInit,
    fetch: createValidatedMcpFetch(
      endpoint,
      options.deadlineAt,
      options.abortSignal,
      options.idempotencyKey,
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

function createRequestInit(
  connector: McpConnectorRecord,
  actorRole?: SecurityRole,
): { requestInit: RequestInit; secretValues: string[] } {
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
  const riskLevel = inferMcpToolRisk(connector.defaultRiskLevel, annotations);

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
): ToolRiskLevel {
  let remoteFloor: ToolRiskLevel = 0;
  if (annotations?.destructiveHint || annotations?.openWorldHint) {
    remoteFloor = 2;
  }
  return Math.max(defaultRisk, remoteFloor) as ToolRiskLevel;
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

function sanitizedConnectorError(
  error: unknown,
  secretValues: Array<string | undefined>,
) {
  const message = redactExactSecrets(
    error instanceof Error ? error.message : "MCP connector request failed.",
    secretValues,
  );
  return new Error(String(message).slice(0, 2_000));
}

function createValidatedMcpFetch(
  endpoint: URL,
  deadlineAt: number,
  abortSignal?: AbortSignal,
  idempotencyKey?: string,
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
      abortSignal,
      AbortSignal.timeout(remainingMs(deadlineAt)),
    ].filter((signal): signal is AbortSignal => Boolean(signal));
    const headers = new Headers(
      init?.headers || (input instanceof Request ? input.headers : undefined),
    );
    if (idempotencyKey && await isMcpToolCallRequest(input, init)) {
      headers.set("idempotency-key", normalizeIdempotencyKey(idempotencyKey));
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
    return limitMcpResponseBody(response, MCP_MAX_RESPONSE_BYTES);
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
