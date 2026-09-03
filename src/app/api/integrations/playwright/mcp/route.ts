import { LEGACY_PLAYWRIGHT_MCP_ENDPOINT } from "@/lib/connectors/mcp-trust";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_REQUEST_BYTES = 4_000_000;
const UPSTREAM_TIMEOUT_MS = 70_000;
const requestHeaderAllowlist = [
  "accept",
  "authorization",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "x-omniagent-browser-scope",
  "x-omniagent-browser-session",
] as const;
const responseHeaderAllowlist = [
  "cache-control",
  "content-type",
  "mcp-session-id",
  "retry-after",
  "www-authenticate",
] as const;

export async function GET(request: Request) {
  return proxyPlaywrightMcp(request);
}

export async function POST(request: Request) {
  return proxyPlaywrightMcp(request);
}

export async function DELETE(request: Request) {
  return proxyPlaywrightMcp(request);
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { Allow: "GET, POST, DELETE, OPTIONS" },
  });
}

async function proxyPlaywrightMcp(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(contentLength) || contentLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "MCP request is too large." }, { status: 413 });
  }

  const headers = new Headers();
  for (const name of requestHeaderAllowlist) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let body: ArrayBuffer | undefined;
  if (hasBody) {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_REQUEST_BYTES) {
      return Response.json({ error: "MCP request is too large." }, { status: 413 });
    }
  }

  try {
    const upstream = await fetch(LEGACY_PLAYWRIGHT_MCP_ENDPOINT, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const responseHeaders = new Headers();
    for (const name of responseHeaderAllowlist) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json(
      { error: "Asael's managed browser service is temporarily unavailable." },
      { status: 502 },
    );
  }
}
