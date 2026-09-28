import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Test transport for the provider contract suite. It replays recorded
 * provider responses, or passes requests to the live API and records what
 * came back. Either way the adapter reads a response rebuilt from the same
 * recorded form, so a replay behaves as the live run did.
 *
 * Request headers are never read, so API keys and signatures never reach a
 * fixture, and response headers are kept only if they are listed below.
 */

export type ContractMode = "fixture" | "live" | "record";

export type ContractRequest = {
  method: string;
  /** Origin and path. The query is dropped. */
  url: string;
  /** The JSON body, or the raw text when it is not JSON. */
  body?: unknown;
};

export type ContractSseEvent = {
  event?: string;
  /** Parsed JSON, or the raw text of a data line that is not a JSON object. */
  data: unknown;
};

export type ContractResponse = {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  sse?: ContractSseEvent[];
  text?: string;
};

export type ContractExchange = {
  request: { method: string; url: string };
  response: ContractResponse;
};

export type ContractScenario = {
  /** The day the scenario was recorded from the live API, or null if hand-written. */
  recordedAt: string | null;
  exchanges: ContractExchange[];
};

export type ProviderFixture = {
  provider: string;
  model: string;
  region?: string;
  note: string;
  scenarios: Record<string, ContractScenario>;
};

// Headers an adapter or SDK reads. Others, such as organization ids and
// cookies, are dropped.
export const KEPT_RESPONSE_HEADERS = new Set([
  "content-type",
  "request-id",
  "x-request-id",
  "x-amzn-requestid",
  "x-amzn-errortype",
  "retry-after",
  "retry-after-ms",
  "x-should-retry",
]);

export const FIXTURE_NOTE =
  "Scenarios with a recordedAt date were recorded from the live API by npm run test:provider-contract:record. Scenarios whose recordedAt is null are hand-written from the provider's API reference; the truncated and rate_limit scenarios cannot be recorded on demand.";

export type ContractTransport = {
  fetch: typeof fetch;
  /**
   * Starts a scenario. In fixture mode, requests get `exchanges` in order;
   * in live and record mode they go to the upstream fetch.
   */
  begin(label: string, exchanges?: readonly ContractExchange[]): void;
  /** The requests sent since begin, oldest first. */
  requests(): ContractRequest[];
  /** The requests and responses since begin, as a fixture records them. */
  exchanges(): ContractExchange[];
  /**
   * Ends the scenario. Returns each request that did not match the fixture,
   * and any recorded response that was never requested.
   */
  finish(): string[];
};

export function createContractTransport(options: {
  mode: ContractMode;
  upstream?: typeof fetch;
}): ContractTransport {
  let label = "";
  let queue: readonly ContractExchange[] = [];
  let sent: ContractRequest[] = [];
  let seen: ContractExchange[] = [];
  let problems: string[] = [];

  const transportFetch: typeof fetch = async (input, init) => {
    const request = captureRequest(input, init);
    const index = sent.length;
    sent.push(request);
    let response: ContractResponse;
    if (options.mode === "fixture") {
      response = fixtureResponse(request, index);
    } else {
      if (!options.upstream) {
        throw new Error("The provider contract transport has no upstream fetch.");
      }
      response = await recordResponse(await options.upstream(input, init));
    }
    seen.push({
      request: { method: request.method, url: request.url },
      response,
    });
    return toResponse(response);
  };

  function fixtureResponse(request: ContractRequest, index: number) {
    const expected = queue[index];
    if (!expected) {
      return mismatch(`request ${index + 1} (${request.method} ${request.url}) has no recorded response`);
    }
    if (
      expected.request.method !== request.method ||
      expected.request.url !== request.url
    ) {
      return mismatch(
        `request ${index + 1} was ${request.method} ${request.url}, but the fixture expected ${expected.request.method} ${expected.request.url}`,
      );
    }
    return expected.response;
  }

  function mismatch(problem: string): ContractResponse {
    problems.push(`${label}: ${problem}`);
    return {
      status: 400,
      headers: { "content-type": "application/json" },
      json: {
        error: {
          type: "contract_fixture_mismatch",
          message: `The provider contract fixture does not match: ${problem}.`,
        },
      },
    };
  }

  return {
    fetch: transportFetch,
    begin(nextLabel, exchanges = []) {
      label = nextLabel;
      queue = exchanges;
      sent = [];
      seen = [];
      problems = [];
    },
    requests: () => sent.map((request) => ({ ...request })),
    exchanges: () => seen.map((exchange) => ({ ...exchange })),
    finish() {
      const unused = options.mode === "fixture"
        ? queue.length - sent.length
        : 0;
      const result = unused > 0
        ? [...problems, `${label}: ${unused} recorded ${unused === 1 ? "response was" : "responses were"} never requested`]
        : [...problems];
      label = "";
      queue = [];
      sent = [];
      seen = [];
      problems = [];
      return result;
    },
  };
}

function captureRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): ContractRequest {
  const href = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  const url = new URL(href);
  const method = (
    init?.method ||
    (typeof input === "object" && !(input instanceof URL) ? input.method : "GET")
  ).toUpperCase();
  const body = requestBody(init?.body);
  return {
    method,
    url: `${url.origin}${url.pathname}`,
    ...(body === undefined ? {} : { body }),
  };
}

function requestBody(body: RequestInit["body"] | undefined): unknown {
  let text: string | undefined;
  if (typeof body === "string") text = body;
  else if (body instanceof Uint8Array) text = new TextDecoder().decode(body);
  else if (body instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(body));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The recorded form of a live response, keeping only the listed headers. */
export async function recordResponse(response: Response): Promise<ContractResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (KEPT_RESPONSE_HEADERS.has(key.toLowerCase())) {
      headers[key.toLowerCase()] = value;
    }
  });
  const body = await response.text();
  const contentType = headers["content-type"] || "";
  const recorded: ContractResponse = {
    status: response.status,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
  if (contentType.includes("text/event-stream")) {
    return { ...recorded, sse: parseSse(body) };
  }
  if (body && contentType.includes("json")) {
    try {
      return { ...recorded, json: JSON.parse(body) as unknown };
    } catch {
      // A body that claims to be JSON and is not is kept as text.
    }
  }
  return body ? { ...recorded, text: body } : recorded;
}

/** A Response for the recorded form, as the adapter would have received it. */
export function toResponse(recorded: ContractResponse): Response {
  const headers = new Headers(recorded.headers || {});
  let body: string | null = null;
  if (recorded.sse) {
    if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
    body = writeSse(recorded.sse);
  } else if (recorded.json !== undefined) {
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    body = JSON.stringify(recorded.json);
  } else if (recorded.text !== undefined) {
    body = recorded.text;
  }
  const bodyless = recorded.status === 204 || recorded.status === 304;
  return new Response(bodyless ? null : body, {
    status: recorded.status,
    headers,
  });
}

export function parseSse(text: string): ContractSseEvent[] {
  const events: ContractSseEvent[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n\n+/)) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (!data.length && event === undefined) continue;
    const raw = data.join("\n");
    events.push({
      ...(event === undefined ? {} : { event }),
      data: parseSseData(raw),
    });
  }
  return events;
}

function parseSseData(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Not JSON, such as [DONE].
  }
  return raw;
}

export function writeSse(events: readonly ContractSseEvent[]): string {
  return events.map((item) => {
    const data = typeof item.data === "string"
      ? item.data
      : JSON.stringify(item.data);
    const lines = data.split("\n").map((line) => `data: ${line}`).join("\n");
    return `${item.event === undefined ? "" : `event: ${item.event}\n`}${lines}\n\n`;
  }).join("");
}

export function readProviderFixture(file: string): ProviderFixture | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as ProviderFixture;
}

export function writeProviderFixture(file: string, fixture: ProviderFixture) {
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
}

/**
 * The fixture after a recording. Recorded scenarios replace their earlier
 * versions. Scenarios not recorded this time are kept, with each URL that a
 * recorded scenario shows has changed, such as a Bedrock model or region,
 * moved to its new value.
 */
export function mergeRecordedScenarios(
  existing: ProviderFixture | undefined,
  recording: {
    provider: string;
    model: string;
    region?: string;
    recordedAt: string;
    scenarios: Readonly<Record<string, readonly ContractExchange[]>>;
  },
): ProviderFixture {
  const earlier = existing?.scenarios || {};
  const moved = new Map<string, string>();
  for (const [name, exchanges] of Object.entries(recording.scenarios)) {
    earlier[name]?.exchanges.forEach((exchange, index) => {
      const url = exchanges[index]?.request.url;
      if (url && url !== exchange.request.url) moved.set(exchange.request.url, url);
    });
  }
  const names = [
    ...Object.keys(earlier),
    ...Object.keys(recording.scenarios).filter((name) => !(name in earlier)),
  ];
  const scenarios: Record<string, ContractScenario> = {};
  for (const name of names) {
    const recorded = recording.scenarios[name];
    scenarios[name] = recorded
      ? { recordedAt: recording.recordedAt, exchanges: [...recorded] }
      : {
          ...earlier[name],
          exchanges: earlier[name].exchanges.map((exchange) => ({
            ...exchange,
            request: {
              ...exchange.request,
              url: moved.get(exchange.request.url) || exchange.request.url,
            },
          })),
        };
  }
  return {
    provider: recording.provider,
    model: recording.model,
    ...(recording.region ? { region: recording.region } : {}),
    note: FIXTURE_NOTE,
    scenarios,
  };
}
