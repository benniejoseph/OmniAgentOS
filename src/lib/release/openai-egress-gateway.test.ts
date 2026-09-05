import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type IncomingHttpHeaders,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from "node:http";
import type { request as httpsRequest } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { startOpenAIEgressGateway } from "../../../scripts/openai-egress-gateway.mjs";

const MEBIBYTE = 1024 * 1024;
const gatewayToken = "gateway-token-that-is-at-least-32-chars";
const previousGatewayToken = "previous-gateway-token-that-is-at-least-32-chars";
const openAIAuth = "Bearer sk-test-openai-authorization-value";
const servers = new Set<Server>();
const gateways = new Set<Awaited<ReturnType<typeof startOpenAIEgressGateway>>>();

afterEach(async () => {
  for (const gateway of gateways) await gateway.close({ graceMs: 0 });
  gateways.clear();
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
});

describe("Fly OpenAI egress gateway", () => {
  it("exposes bounded health and enforces exact auth and route allowlists", async () => {
    let upstreamRequests = 0;
    const upstream = await startServer((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    const gateway = await startGateway(upstream.baseUrl);

    const health = await fetch(`${gateway.baseUrl}/healthz`);
    await expect(health.json()).resolves.toEqual({
      status: "healthy",
      service: "asael-openai-egress",
      region: "unknown",
      revision: "unknown",
      protocol: "1",
    });
    expect(health.status).toBe(200);

    const unauthorized = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);

    const wrongToken = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: "POST",
      headers: gatewayHeaders({ "x-asael-gateway-token": `${gatewayToken}x` }),
      body: "{}",
    });
    expect(wrongToken.status).toBe(401);

    const disallowed = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: gatewayHeaders(),
      body: "{}",
    });
    expect(disallowed.status).toBe(404);

    const wrongMethod = await fetch(`${gateway.baseUrl}/v1/models/gpt-5`, {
      method: "POST",
      headers: gatewayHeaders(),
      body: "{}",
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(upstreamRequests).toBe(0);
  });

  it("forwards only governed headers to the default allowlisted OpenAI origin", async () => {
    let receivedHeaders: IncomingHttpHeaders = {};
    let receivedBody = "";
    const observations: RequestOptions[] = [];
    const upstream = await startServer(async (request, response) => {
      receivedHeaders = request.headers;
      for await (const chunk of request) receivedBody += chunk.toString();
      response.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": "upstream-request-1",
        "set-cookie": "must-not-cross=1",
      });
      response.end('{"data":[{"embedding":[0.1]}]}');
    });
    const gateway = await startGateway(upstream.baseUrl, { observations });

    const response = await fetch(`${gateway.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        ...gatewayHeaders(),
        cookie: "must-not-cross=1",
        "x-forwarded-for": "203.0.113.1",
      },
      body: '{"model":"embedding-test","input":["private prompt"]}',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ embedding: [0.1] }] });
    expect(response.headers.get("x-request-id")).toBe("upstream-request-1");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(observations[0]).toMatchObject({
      protocol: "https:",
      hostname: "api.openai.com",
      port: 443,
      method: "POST",
      path: "/v1/embeddings",
    });
    expect(receivedHeaders.authorization).toBe(openAIAuth);
    expect(receivedHeaders["x-asael-gateway-token"]).toBeUndefined();
    expect(receivedHeaders.cookie).toBeUndefined();
    expect(receivedHeaders["x-forwarded-for"]).toBeUndefined();
    expect(receivedBody).toContain("private prompt");
  });

  it("supports the allowlisted US OpenAI origin", async () => {
    const observations: RequestOptions[] = [];
    const upstream = await startServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"data":[]}');
    });
    const gateway = await startGateway(upstream.baseUrl, {
      observations,
      upstreamHostname: "us.api.openai.com",
    });

    const response = await fetch(`${gateway.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: gatewayHeaders(),
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(observations[0]?.hostname).toBe("us.api.openai.com");
  });

  it("accepts primary and previous tokens during a bounded rotation overlap", async () => {
    let upstreamRequests = 0;
    const upstream = await startServer(async (request, response) => {
      upstreamRequests += 1;
      for await (const chunk of request) void chunk;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    const gateway = await startGateway(upstream.baseUrl, {
      previousToken: previousGatewayToken,
    });

    const primary = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: "POST",
      headers: gatewayHeaders(),
      body: "{}",
    });
    const previous = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: "POST",
      headers: gatewayHeaders({
        "x-asael-gateway-token": previousGatewayToken,
      }),
      body: "{}",
    });
    const unknown = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: "POST",
      headers: gatewayHeaders({
        "x-asael-gateway-token": "unknown-gateway-token-that-is-at-least-32-chars",
      }),
      body: "{}",
    });

    expect(primary.status).toBe(200);
    expect(previous.status).toBe(200);
    expect(unknown.status).toBe(401);
    expect(upstreamRequests).toBe(2);
  });

  it("streams SSE responses without buffering and redacts payloads and credentials from logs", async () => {
    const lines: string[] = [];
    let releaseSecondChunk!: () => void;
    const secondChunkGate = new Promise<void>((resolve) => { releaseSecondChunk = resolve; });
    const logger = {
      log: (line: string) => lines.push(line),
      warn: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    };
    const upstream = await startServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"response.output_text.delta","delta":"first"}\n\n');
      await secondChunkGate;
      response.end('data: {"type":"response.completed"}\n\n');
    });
    const gateway = await startGateway(upstream.baseUrl, {
      logger,
      previousToken: previousGatewayToken,
    });
    const privatePrompt = "PROMPT_MUST_NEVER_REACH_LOGS";

    const response = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: "POST",
      headers: gatewayHeaders({
        "x-asael-gateway-token": previousGatewayToken,
      }),
      body: JSON.stringify({ input: privatePrompt, stream: true }),
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("first");
    releaseSecondChunk();
    const remaining = await readRemaining(reader);
    expect(remaining).toContain("response.completed");

    const logOutput = lines.join("\n");
    expect(logOutput).not.toContain(privatePrompt);
    expect(logOutput).not.toContain(gatewayToken);
    expect(logOutput).not.toContain(previousGatewayToken);
    expect(logOutput).not.toContain(openAIAuth);
    expect(logOutput).toContain('"event":"openai_egress.completed"');
  });

  it("permits 11 MiB transcription uploads while rejecting smaller JSON route overruns", async () => {
    let receivedBytes = 0;
    let upstreamRequests = 0;
    const upstream = await startServer(async (request, response) => {
      upstreamRequests += 1;
      for await (const chunk of request) receivedBytes += chunk.length;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"text":"ok"}');
    });
    const gateway = await startGateway(upstream.baseUrl);
    const audio = Buffer.alloc(11 * MEBIBYTE, 1);

    const accepted = await fetch(`${gateway.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        ...gatewayHeaders(),
        "content-type": "multipart/form-data; boundary=test-boundary",
      },
      body: audio,
    });
    expect(accepted.status).toBe(200);
    expect(receivedBytes).toBe(audio.length);

    const rejected = await rawRequest(gateway.baseUrl, {
      method: "POST",
      path: "/v1/embeddings",
      headers: {
        ...gatewayHeaders(),
        "content-length": String(2 * MEBIBYTE + 1),
      },
    });
    expect(rejected.status).toBe(413);
    expect(upstreamRequests).toBe(1);
  });

  it("bounds concurrency and upstream duration without retrying POSTs", async () => {
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let upstreamRequests = 0;
    const upstream = await startServer(async (request, response) => {
      upstreamRequests += 1;
      for await (const chunk of request) void chunk;
      if (request.url?.startsWith("/v1/responses")) {
        markStarted();
        await firstRelease;
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"output":[]}');
        return;
      }
      // Deliberately never produce headers for the bounded readiness request.
    });
    const gateway = await startGateway(upstream.baseUrl, {
      maxConcurrency: 1,
      routeOverrides: { model_readiness: { timeoutMs: 40 } },
    });

    const first = fetch(`${gateway.baseUrl}/v1/responses`, {
      method: "POST",
      headers: gatewayHeaders(),
      body: "{}",
    });
    await firstStarted;
    const busy = await fetch(`${gateway.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: gatewayHeaders(),
      body: "{}",
    });
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");
    releaseFirst();
    expect((await first).status).toBe(200);

    const timedOut = await fetch(`${gateway.baseUrl}/v1/models/gpt-5`, {
      headers: gatewayHeaders({ "content-type": undefined }),
    });
    expect(timedOut.status).toBe(504);
    expect(upstreamRequests).toBe(2);
  });

  it("stops accepting connections while allowing an active stream to drain", async () => {
    let releaseStream!: () => void;
    let markStarted!: () => void;
    const streamStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const streamRelease = new Promise<void>((resolve) => { releaseStream = resolve; });
    const upstream = await startServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      markStarted();
      await streamRelease;
      response.end("data: done\n\n");
    });
    const gateway = await startGateway(upstream.baseUrl);
    const response = await fetch(`${gateway.baseUrl}/v1/responses`, {
      method: "POST",
      headers: gatewayHeaders(),
      body: "{}",
    });
    await streamStarted;
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");

    let closed = false;
    const close = gateway.close({ graceMs: 1_000 }).then(() => { closed = true; });
    await delay(30);
    expect(closed).toBe(false);
    releaseStream();
    expect(await readRemaining(reader)).toContain("done");
    await close;
    expect(closed).toBe(true);
  });

  it("rejects weak deployment tokens before binding a port", async () => {
    await expect(startOpenAIEgressGateway({ token: "too-short", port: 0 })).rejects.toThrow(
      "32-256 URL-safe characters",
    );
  });

  it("rejects an arbitrary OpenAI upstream before binding a port", async () => {
    await expect(startOpenAIEgressGateway({
      token: gatewayToken,
      upstreamHostname: "openai.example.com",
      port: 0,
    })).rejects.toThrow(
      "OMNIAGENT_OPENAI_UPSTREAM_HOST must be api.openai.com or us.api.openai.com",
    );
  });

  it("rejects invalid or redundant previous tokens before binding a port", async () => {
    await expect(startOpenAIEgressGateway({
      token: gatewayToken,
      previousToken: "too-short",
      port: 0,
    })).rejects.toThrow(
      "OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN must be 32-256 URL-safe characters",
    );
    await expect(startOpenAIEgressGateway({
      token: gatewayToken,
      previousToken: gatewayToken,
      port: 0,
    })).rejects.toThrow(
      "OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN must differ",
    );
  });
});

async function startGateway(
  upstreamBaseUrl: string,
  options: Record<string, unknown> & { observations?: RequestOptions[] } = {},
) {
  const { observations = [], ...gatewayOptions } = options;
  const upstreamUrl = new URL(upstreamBaseUrl);
  const upstreamRequest = ((requestOptions: RequestOptions, callback: Parameters<typeof httpsRequest>[1]) => {
    observations.push(requestOptions);
    return httpRequest({
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      method: requestOptions.method,
      path: requestOptions.path,
      headers: requestOptions.headers,
    }, callback as never);
  }) as typeof httpsRequest;
  const gateway = await startOpenAIEgressGateway({
    token: gatewayToken,
    host: "127.0.0.1",
    port: 0,
    upstreamRequest,
    upstreamAgent: false,
    logger: silentLogger,
    ...gatewayOptions,
  });
  gateways.add(gateway);
  const address = gateway.address;
  if (!address || typeof address === "string") throw new Error("Gateway did not bind TCP.");
  return { ...gateway, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind TCP.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function gatewayHeaders(
  overrides: Record<string, string | undefined> = {},
) {
  return Object.fromEntries(Object.entries({
    authorization: openAIAuth,
    "content-type": "application/json",
    "x-asael-gateway-token": gatewayToken,
    ...overrides,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function rawRequest(baseUrl: string, options: RequestOptions) {
  const url = new URL(baseUrl);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      ...options,
    }, async (response) => {
      let body = "";
      for await (const chunk of response) body += chunk.toString();
      resolve({ status: response.statusCode || 0, body });
    });
    request.once("error", reject);
    request.end();
  });
}

async function readRemaining(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  return text + decoder.decode();
}

const silentLogger = { log() {}, warn() {}, error() {} };
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
