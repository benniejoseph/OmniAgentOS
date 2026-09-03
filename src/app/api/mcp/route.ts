import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  runWithDatabaseTenantScope,
  withDatabaseRequestScope,
} from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { checkSharedRateLimit } from "@/lib/http/rate-limit";
import {
  assertTrustedMcpNetworkBoundary,
  authenticateMcpRequest,
  McpAccessError,
  mcpBearerChallenge,
} from "@/lib/mcp/auth";
import { createAsaelMcpServer } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withDatabaseRequestScope(POSTHandler);
export const GET = withDatabaseRequestScope(methodNotAllowed);
export const DELETE = withDatabaseRequestScope(methodNotAllowed);
export const OPTIONS = withDatabaseRequestScope(OPTIONSHandler);

async function POSTHandler(request: Request) {
  let allowedOrigin: string | undefined;
  try {
    allowedOrigin = assertTrustedMcpNetworkBoundary(request);
  } catch (error) {
    return mcpAccessErrorResponse(error);
  }

  let principal: Awaited<ReturnType<typeof authenticateMcpRequest>>;
  try {
    principal = await authenticateMcpRequest(request);
  } catch (error) {
    return mcpAccessErrorResponse(error, allowedOrigin);
  }

  try {
    const rateLimit = await runWithDatabaseTenantScope(
      principal.tenantId,
      () =>
        checkSharedRateLimit({
          key: `mcp:${principal.tenantId}:${principal.keyId}`,
          limit: 240,
          windowMs: 60_000,
        }),
    );
    if (!rateLimit.allowed) {
      return jsonRpcResponse(
        429,
        -32000,
        "MCP request limit reached. Try again shortly.",
        allowedOrigin,
        { "Retry-After": String(rateLimit.retryAfterSeconds) },
      );
    }
  } catch {
    return jsonRpcResponse(
      503,
      -32603,
      "The MCP request budget could not be verified.",
      allowedOrigin,
    );
  }

  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    const response = jsonBodyErrorResponse(error);
    return secureMcpResponse(response, allowedOrigin);
  }

  const server = createAsaelMcpServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      parsedBody: body,
      authInfo: {
        token: "[redacted]",
        clientId: principal.keyId,
        scopes: principal.scopes,
        extra: {
          tenantId: principal.tenantId,
          actorId: principal.actorId,
        },
      },
    });
    return secureMcpResponse(response, allowedOrigin);
  } catch {
    return jsonRpcResponse(
      500,
      -32603,
      "The MCP request could not be completed.",
      allowedOrigin,
    );
  }
}

function OPTIONSHandler(request: Request) {
  try {
    const allowedOrigin = assertTrustedMcpNetworkBoundary(request);
    return secureMcpResponse(new Response(null, { status: 204 }), allowedOrigin);
  } catch (error) {
    return mcpAccessErrorResponse(error);
  }
}

function methodNotAllowed(request: Request) {
  let allowedOrigin: string | undefined;
  try {
    allowedOrigin = assertTrustedMcpNetworkBoundary(request);
  } catch (error) {
    return mcpAccessErrorResponse(error);
  }
  return jsonRpcResponse(
    405,
    -32000,
    "Stateless MCP accepts POST requests only.",
    allowedOrigin,
    { Allow: "POST, OPTIONS" },
  );
}

function mcpAccessErrorResponse(error: unknown, allowedOrigin?: string) {
  if (!(error instanceof McpAccessError)) throw error;
  const headers: Record<string, string> = {};
  if (error.status === 401) {
    headers["WWW-Authenticate"] = mcpBearerChallenge(error.requiredScope);
  }
  return jsonRpcResponse(
    error.status,
    error.status === 401 ? -32001 : -32003,
    error.message,
    allowedOrigin,
    headers,
  );
}

function jsonRpcResponse(
  status: number,
  code: number,
  message: string,
  allowedOrigin?: string,
  extraHeaders: Record<string, string> = {},
) {
  return secureMcpResponse(
    Response.json(
      { jsonrpc: "2.0", error: { code, message }, id: null },
      { status, headers: extraHeaders },
    ),
    allowedOrigin,
  );
}

function secureMcpResponse(response: Response, allowedOrigin?: string) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Vary", appendVary(headers.get("Vary"), "Authorization, Origin"));
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, MCP-Protocol-Version",
    );
    headers.set("Access-Control-Expose-Headers", "MCP-Protocol-Version");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function appendVary(current: string | null, value: string) {
  const values = new Set(
    `${current || ""},${value}`
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  return [...values].join(", ");
}
