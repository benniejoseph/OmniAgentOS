import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createContractTransport,
  FIXTURE_NOTE,
  mergeRecordedScenarios,
  parseSse,
  readProviderFixture,
  toResponse,
  writeProviderFixture,
  writeSse,
  type ContractExchange,
  type ProviderFixture,
} from "@/lib/models/provider-contract/harness";

const URL_A = "https://api.example.test/v1/messages";
const URL_B = "https://api.example.test/v1/other";

function exchange(url: string, status: number, json: unknown): ContractExchange {
  return {
    request: { method: "POST", url },
    response: { status, headers: { "content-type": "application/json" }, json },
  };
}

function post(body: unknown) {
  return { method: "POST", body: JSON.stringify(body) };
}

describe("provider contract transport in fixture mode", () => {
  it("serves the recorded responses in order and captures each request", async () => {
    const transport = createContractTransport({ mode: "fixture" });
    transport.begin("example/text", [
      exchange(URL_A, 200, { turn: 1 }),
      exchange(URL_B, 429, { turn: 2 }),
    ]);

    const first = await transport.fetch(URL_A, post({ ask: "one" }));
    const second = await transport.fetch(new URL(URL_B), post({ ask: "two" }));

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ turn: 1 });
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ turn: 2 });
    expect(transport.requests()).toEqual([
      { method: "POST", url: URL_A, body: { ask: "one" } },
      { method: "POST", url: URL_B, body: { ask: "two" } },
    ]);
    expect(transport.finish()).toEqual([]);
  });

  it("answers a request to another URL with a 400 and reports it", async () => {
    const transport = createContractTransport({ mode: "fixture" });
    transport.begin("example/text", [exchange(URL_A, 200, { turn: 1 })]);

    const response = await transport.fetch(URL_B, post({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: "contract_fixture_mismatch" },
    });
    expect(transport.finish()).toEqual([
      `example/text: request 1 was POST ${URL_B}, but the fixture expected POST ${URL_A}`,
    ]);
  });

  it("answers a request with another method with a 400 and reports it", async () => {
    const transport = createContractTransport({ mode: "fixture" });
    transport.begin("example/text", [exchange(URL_A, 200, { turn: 1 })]);

    const response = await transport.fetch(URL_A, { method: "get" });

    expect(response.status).toBe(400);
    expect(transport.finish()).toEqual([
      `example/text: request 1 was GET ${URL_A}, but the fixture expected POST ${URL_A}`,
    ]);
  });

  it("reports a request that has no recorded response", async () => {
    const transport = createContractTransport({ mode: "fixture" });
    transport.begin("example/text", [exchange(URL_A, 200, { turn: 1 })]);

    await transport.fetch(URL_A, post({}));
    const extra = await transport.fetch(URL_A, post({}));

    expect(extra.status).toBe(400);
    expect(transport.finish()).toEqual([
      `example/text: request 2 (POST ${URL_A}) has no recorded response`,
    ]);
  });

  it("reports recorded responses that were never requested", async () => {
    const transport = createContractTransport({ mode: "fixture" });
    transport.begin("example/one", [
      exchange(URL_A, 200, {}),
      exchange(URL_A, 200, {}),
    ]);
    await transport.fetch(URL_A, post({}));
    expect(transport.finish()).toEqual([
      "example/one: 1 recorded response was never requested",
    ]);

    transport.begin("example/two", [
      exchange(URL_A, 200, {}),
      exchange(URL_A, 200, {}),
    ]);
    expect(transport.finish()).toEqual([
      "example/two: 2 recorded responses were never requested",
    ]);
  });

  it("starts each scenario with no requests or problems", async () => {
    const transport = createContractTransport({ mode: "fixture" });
    transport.begin("example/one", []);
    await transport.fetch(URL_A, post({}));

    transport.begin("example/two", [exchange(URL_A, 200, {})]);
    await transport.fetch(URL_A, post({}));

    expect(transport.requests()).toHaveLength(1);
    expect(transport.finish()).toEqual([]);
  });

  it("drops the query and never reads request headers", async () => {
    const transport = createContractTransport({ mode: "fixture" });
    transport.begin("example/text", [exchange(URL_A, 200, {})]);

    await transport.fetch(`${URL_A}?key=query-secret-value`, {
      method: "POST",
      headers: {
        authorization: "Bearer header-secret-value",
        "x-api-key": "header-secret-value",
      },
      body: "not json",
    });

    expect(transport.requests()).toEqual([
      { method: "POST", url: URL_A, body: "not json" },
    ]);
    const recorded = JSON.stringify(transport.exchanges());
    expect(recorded).not.toContain("secret-value");
    expect(transport.finish()).toEqual([]);
  });

  it("reads the method and URL of a Request", async () => {
    const transport = createContractTransport({ mode: "fixture" });
    transport.begin("example/text", [exchange(URL_A, 200, {})]);

    await transport.fetch(new Request(URL_A, { method: "POST" }));

    expect(transport.requests()).toEqual([{ method: "POST", url: URL_A }]);
    expect(transport.finish()).toEqual([]);
  });
});

describe.each(["live", "record"] as const)("provider contract transport in %s mode", (mode) => {
  const upstreamCalls: string[] = [];
  afterEach(() => {
    upstreamCalls.length = 0;
  });

  it("sends the request upstream and returns the response rebuilt from its recorded form", async () => {
    const upstream: typeof fetch = async (input) => {
      upstreamCalls.push(String(input));
      return new Response(JSON.stringify({ id: "resp_1" }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_1",
          "openai-organization": "org-private",
          "set-cookie": "session=private",
        },
      });
    };
    const transport = createContractTransport({ mode, upstream });
    transport.begin("example/text");

    const response = await transport.fetch(URL_A, post({ ask: "one" }));

    expect(upstreamCalls).toEqual([URL_A]);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "resp_1" });
    expect([...response.headers.keys()].sort()).toEqual([
      "content-type",
      "x-request-id",
    ]);
    expect(transport.exchanges()).toEqual([{
      request: { method: "POST", url: URL_A },
      response: {
        status: 201,
        headers: { "content-type": "application/json", "x-request-id": "req_1" },
        json: { id: "resp_1" },
      },
    }]);
    expect(transport.finish()).toEqual([]);
  });

  it("records a server-sent event stream as events and replays it", async () => {
    const stream = [
      ": keep-alive",
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"ready"}',
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\r\n");
    const upstream: typeof fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    const transport = createContractTransport({ mode, upstream });
    transport.begin("example/stream");

    const response = await transport.fetch(URL_A, post({}));
    const events = [
      {
        event: "response.created",
        data: { type: "response.created", response: { id: "resp_1" } },
      },
      {
        event: "response.output_text.delta",
        data: { type: "response.output_text.delta", delta: "ready" },
      },
      { data: "[DONE]" },
    ];

    expect(transport.exchanges()[0].response.sse).toEqual(events);
    const replayed = await response.text();
    expect(replayed).toBe(writeSse(events));
    expect(parseSse(replayed)).toEqual(events);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(transport.finish()).toEqual([]);
  });

  it("keeps a body that is not JSON as text", async () => {
    const bodies = [
      new Response("upstream failed", {
        status: 502,
        headers: { "content-type": "text/plain" },
      }),
      new Response("{broken", {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
      new Response(null, { status: 403 }),
    ];
    const upstream: typeof fetch = async () => bodies.shift()!;
    const transport = createContractTransport({ mode, upstream });
    transport.begin("example/errors");

    await transport.fetch(URL_A, post({}));
    await transport.fetch(URL_A, post({}));
    const empty = await transport.fetch(URL_A, post({}));

    expect(transport.exchanges().map((item) => item.response)).toEqual([
      { status: 502, headers: { "content-type": "text/plain" }, text: "upstream failed" },
      { status: 500, headers: { "content-type": "application/json" }, text: "{broken" },
      { status: 403 },
    ]);
    expect(await empty.text()).toBe("");
    expect(transport.finish()).toEqual([]);
  });
});

describe("provider contract responses", () => {
  it("gives a JSON or event stream response its content type when none was recorded", async () => {
    const json = toResponse({ status: 200, json: { ok: true } });
    const sse = toResponse({ status: 200, sse: [{ data: { ok: true } }] });

    expect(json.headers.get("content-type")).toBe("application/json");
    expect(await json.json()).toEqual({ ok: true });
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    expect(await sse.text()).toBe('data: {"ok":true}\n\n');
  });

  it("writes each event name before its data", () => {
    expect(writeSse([
      { event: "message_start", data: { type: "message_start" } },
      { data: "line one\nline two" },
    ])).toBe(
      'event: message_start\ndata: {"type":"message_start"}\n\ndata: line one\ndata: line two\n\n',
    );
  });
});

describe("provider contract fixtures", () => {
  const recordedExchange = (url: string) => exchange(url, 200, { recorded: true });
  const handWritten = (url: string) => exchange(url, 429, { handWritten: true });

  it("replaces recorded scenarios and keeps the others with their URLs moved", () => {
    const existing: ProviderFixture = {
      provider: "aws_bedrock",
      model: "old-model",
      region: "us-east-1",
      note: "old note",
      scenarios: {
        text: { recordedAt: null, exchanges: [handWritten(URL_A)] },
        rate_limit: { recordedAt: null, exchanges: [handWritten(URL_A)] },
        truncated: { recordedAt: "2026-01-01", exchanges: [handWritten(URL_B)] },
      },
    };

    const merged = mergeRecordedScenarios(existing, {
      provider: "aws_bedrock",
      model: "new-model",
      region: "us-west-2",
      recordedAt: "2026-09-27",
      scenarios: {
        text: [recordedExchange(URL_B)],
        authentication: [recordedExchange(URL_B)],
      },
    });

    expect(merged).toEqual({
      provider: "aws_bedrock",
      model: "new-model",
      region: "us-west-2",
      note: FIXTURE_NOTE,
      scenarios: {
        text: { recordedAt: "2026-09-27", exchanges: [recordedExchange(URL_B)] },
        rate_limit: { recordedAt: null, exchanges: [handWritten(URL_B)] },
        truncated: { recordedAt: "2026-01-01", exchanges: [handWritten(URL_B)] },
        authentication: {
          recordedAt: "2026-09-27",
          exchanges: [recordedExchange(URL_B)],
        },
      },
    });
    expect(Object.keys(merged.scenarios)).toEqual([
      "text",
      "rate_limit",
      "truncated",
      "authentication",
    ]);
    expect(existing.scenarios.rate_limit.exchanges[0].request.url).toBe(URL_A);
  });

  it("creates a fixture when none exists", () => {
    expect(mergeRecordedScenarios(undefined, {
      provider: "openai",
      model: "gpt-5",
      recordedAt: "2026-09-27",
      scenarios: { text: [recordedExchange(URL_A)] },
    })).toEqual({
      provider: "openai",
      model: "gpt-5",
      note: FIXTURE_NOTE,
      scenarios: {
        text: { recordedAt: "2026-09-27", exchanges: [recordedExchange(URL_A)] },
      },
    });
  });

  it("writes a fixture that reads back unchanged, and reads a missing one as undefined", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "provider-contract-"));
    try {
      const file = path.join(directory, "openai.json");
      const fixture: ProviderFixture = {
        provider: "openai",
        model: "gpt-5",
        note: FIXTURE_NOTE,
        scenarios: { text: { recordedAt: null, exchanges: [handWritten(URL_A)] } },
      };

      expect(readProviderFixture(file)).toBeUndefined();
      writeProviderFixture(file, fixture);
      expect(readProviderFixture(file)).toEqual(fixture);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
