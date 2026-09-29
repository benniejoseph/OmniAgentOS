import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  generateModelStructured,
  generateModelText,
  generateModelToolTurn,
} from "@/lib/models/gateway";
import {
  createContractTransport,
  mergeRecordedScenarios,
  readProviderFixture,
  writeProviderFixture,
  type ContractExchange,
  type ContractMode,
  type ProviderFixture,
} from "@/lib/models/provider-contract/harness";
import { getModelProvider } from "@/lib/models/registry";
import {
  bindModelRuntime,
  type ModelRuntimeCredential,
} from "@/lib/models/runtime-context";
import {
  getModelProviderResponseReceipt,
  ModelProviderError,
  type ModelAttemptReceipt,
  type ModelGenerationResult,
  type ModelStructuredRequest,
  type ModelTarget,
  type ModelTextRequest,
  type ModelToolDefinition,
  type ModelToolTurnRequest,
  type ProviderId,
} from "@/lib/models/types";

/**
 * Runs each provider adapter, through the model gateway, against recorded
 * provider responses. PROVIDER_CONTRACT_LIVE=1 sends the same requests to the
 * live APIs instead, and PROVIDER_CONTRACT_RECORD=1 also saves what came back
 * as the new fixtures.
 */

// The Bedrock adapter keeps the fetch it finds when its module loads, so
// fetch is replaced before any module loads.
const transportFetch = vi.hoisted(() => {
  const upstream = globalThis.fetch;
  const handler: { current?: typeof fetch } = {};
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    handler.current
      ? handler.current(input, init)
      : Promise.reject(new Error("No provider contract transport is installed.")));
  return { upstream, handler };
});

const MODE: ContractMode = process.env.PROVIDER_CONTRACT_RECORD === "1"
  ? "record"
  : process.env.PROVIDER_CONTRACT_LIVE === "1"
    ? "live"
    : "fixture";
const LIVE = MODE !== "fixture";
const TIMEOUT = LIVE ? 120_000 : undefined;

const transport = createContractTransport({
  mode: MODE,
  upstream: transportFetch.upstream,
});
transportFetch.handler.current = transport.fetch;

const PROVIDERS = ["anthropic", "openai", "google", "aws_bedrock"] as const;
type ContractProvider = typeof PROVIDERS[number];

const FIXTURE_DIR = fileURLToPath(
  new URL("./provider-contract/fixtures/", import.meta.url),
);

function fixtureFile(provider: ContractProvider) {
  return path.join(FIXTURE_DIR, `${provider}.json`);
}

const fixtures: Partial<Record<ContractProvider, ProviderFixture>> = {};
for (const provider of PROVIDERS) {
  const fixture = readProviderFixture(fixtureFile(provider));
  if (fixture) fixtures[provider] = fixture;
}

const PRICING_ENV: Record<ContractProvider, string> = {
  anthropic: "ANTHROPIC_MODEL_PRICING_JSON",
  openai: "OPENAI_MODEL_PRICING_JSON",
  google: "GEMINI_MODEL_PRICING_JSON",
  aws_bedrock: "BEDROCK_MODEL_PRICING_JSON",
};

// US dollars per million tokens.
const PRICE = { input: 1, output: 4, cachedInput: 0.1, cacheWrite: 1.25 };

const API_KEY_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
} as const;

// Letters and hyphens only, so a secret scanner does not take them for keys.
const FIXTURE_API_KEYS = {
  anthropic: "sk-ant-contract-fixture-key",
  openai: "sk-proj-contract-fixture-key",
  google: "AIzaContractFixtureKey",
} as const;

const INVALID_API_KEYS = {
  anthropic: "sk-ant-contract-invalid-key",
  openai: "sk-proj-contract-invalid-key",
  google: "AIzaContractInvalidKey",
} as const;

function bedrockRegion() {
  return LIVE
    ? process.env.AWS_REGION?.trim() ||
        process.env.AWS_DEFAULT_REGION?.trim() ||
        "us-east-1"
    : fixtures.aws_bedrock?.region || "us-east-1";
}

function liveCredential(
  provider: ContractProvider,
): ModelRuntimeCredential | undefined {
  if (provider === "aws_bedrock") {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
    if (!accessKeyId || !secretAccessKey) return undefined;
    const sessionToken = process.env.AWS_SESSION_TOKEN?.trim();
    return {
      kind: "aws_bedrock",
      accessKeyId,
      secretAccessKey,
      region: bedrockRegion(),
      ...(sessionToken ? { sessionToken } : {}),
    };
  }
  const apiKey = process.env[API_KEY_ENV[provider]]?.trim();
  return apiKey ? { kind: "api_key", apiKey } : undefined;
}

function fixtureCredential(provider: ContractProvider): ModelRuntimeCredential {
  if (provider === "aws_bedrock") {
    return {
      kind: "aws_bedrock",
      accessKeyId: "CONTRACTFIXTUREKEYID",
      secretAccessKey: "contract-fixture-secret-access-key",
      region: bedrockRegion(),
    };
  }
  return { kind: "api_key", apiKey: FIXTURE_API_KEYS[provider] };
}

function invalidCredential(provider: ContractProvider): ModelRuntimeCredential {
  if (provider === "aws_bedrock") {
    return {
      kind: "aws_bedrock",
      accessKeyId: "CONTRACTINVALIDKEYID",
      secretAccessKey: "contract-invalid-secret-access-key",
      region: bedrockRegion(),
    };
  }
  return { kind: "api_key", apiKey: INVALID_API_KEYS[provider] };
}

function credentialFor(provider: ContractProvider) {
  return LIVE ? liveCredential(provider) : fixtureCredential(provider);
}

/** The adapter's reasoning target, on the fixture's model unless live. */
function targetFor(provider: ContractProvider): ModelTarget {
  const target = getModelProvider(provider)?.targets("reasoning")[0];
  if (!target) throw new Error(`The ${provider} adapter has no reasoning target.`);
  if (LIVE) return target;
  const fixture = fixtures[provider];
  if (!fixture) {
    throw new Error(
      `There is no ${provider} fixture. Record one with npm run test:provider-contract:record.`,
    );
  }
  return { ...target, model: fixture.model };
}

function bind<T extends ModelTextRequest>(
  provider: ContractProvider,
  request: T,
  credential: ModelRuntimeCredential | undefined = credentialFor(provider),
): T {
  const credentials: Partial<Record<ProviderId, ModelRuntimeCredential>> = {};
  if (credential) credentials[provider] = credential;
  return bindModelRuntime(request, {
    targets: [targetFor(provider)],
    credentials,
  });
}

function base(provider: ContractProvider) {
  return {
    tier: "reasoning",
    preferredProvider: provider,
    allowedProviders: [provider],
    maxOutputTokens: 2_000,
    reasoningEffort: "low",
  } satisfies Partial<ModelTextRequest>;
}

function textRequest(
  provider: ContractProvider,
  credential?: ModelRuntimeCredential,
) {
  return bind<ModelTextRequest>(provider, {
    ...base(provider),
    instructions: "Follow the user's instruction exactly.",
    input: "Reply with the single word: ready",
  }, credential);
}

const WEATHER_TOOL: ModelToolDefinition = {
  type: "function",
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "The city name, such as Paris." },
    },
    required: ["city"],
    additionalProperties: false,
  },
};

const WEATHER_RESULT = JSON.stringify({
  city: "Paris",
  forecast: "sunny",
  temperatureC: 21,
});

function toolRequest(
  provider: ContractProvider,
  fields: Partial<ModelToolTurnRequest> = {},
) {
  return bind<ModelToolTurnRequest>(provider, {
    ...base(provider),
    instructions: "Use the get_weather tool to answer questions about the weather.",
    input: "What is the weather in Paris right now?",
    tools: [WEATHER_TOOL],
    ...fields,
  });
}

const PLACE_SCHEMA = {
  type: "object",
  properties: {
    city: { type: "string" },
    country: { type: "string" },
  },
  required: ["city", "country"],
  additionalProperties: false,
};

function structuredRequest(provider: ContractProvider) {
  return bind<ModelStructuredRequest>(provider, {
    ...base(provider),
    instructions: "Return the city and country named in the text.",
    input: "The Eiffel Tower is in Paris, France.",
    name: "place",
    schema: PLACE_SCHEMA,
  });
}

/** The request fields the wire checks read, in each provider's format. */
type WireBody = {
  tools?: Array<{ name?: unknown }>;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  generation_config?: { tool_choice?: unknown };
  toolConfig?: { tools?: Array<{ toolSpec?: { name?: unknown } }> };
  messages?: Array<{ role?: unknown; content?: unknown }>;
  input?: unknown;
  text?: { format?: unknown };
};

function items(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object")
    : [];
}

function messageBlocks(body: WireBody) {
  return (body.messages || []).flatMap((message) => items(message.content));
}

type Wire = {
  toolNames(body: WireBody): string[];
  /** Whether the request asks for a reply without a tool call. */
  noCallRequested(body: WireBody): boolean;
  /** The ids of the tool calls the request replays. */
  callIds(body: WireBody): string[];
  /** The call ids of the tool results the request sends. */
  resultIds(body: WireBody): string[];
  singleCallRequested?(body: WireBody): boolean;
};

const WIRE: Record<ContractProvider, Wire> = {
  anthropic: {
    toolNames: (body) => (body.tools || []).map((tool) => String(tool.name)),
    noCallRequested: (body) => items([body.tool_choice])[0]?.type === "none",
    callIds: (body) => messageBlocks(body)
      .filter((block) => block.type === "tool_use")
      .map((block) => String(block.id)),
    resultIds: (body) => messageBlocks(body)
      .filter((block) => block.type === "tool_result")
      .map((block) => String(block.tool_use_id)),
    singleCallRequested: (body) =>
      items([body.tool_choice])[0]?.disable_parallel_tool_use === true,
  },
  openai: {
    toolNames: (body) => (body.tools || []).map((tool) => String(tool.name)),
    noCallRequested: (body) => body.tool_choice === "none",
    callIds: (body) => items(body.input)
      .filter((item) => item.type === "function_call")
      .map((item) => String(item.call_id)),
    resultIds: (body) => items(body.input)
      .filter((item) => item.type === "function_call_output")
      .map((item) => String(item.call_id)),
    singleCallRequested: (body) => body.parallel_tool_calls === false,
  },
  google: {
    toolNames: (body) => (body.tools || []).map((tool) => String(tool.name)),
    noCallRequested: (body) => body.generation_config?.tool_choice === "none",
    callIds: (body) => items(body.input)
      .filter((step) => step.type === "function_call")
      .map((step) => String(step.id)),
    resultIds: (body) => items(body.input)
      .filter((step) => step.type === "function_result")
      .map((step) => String(step.call_id)),
  },
  aws_bedrock: {
    toolNames: (body) => (body.toolConfig?.tools || [])
      .map((tool) => String(tool.toolSpec?.name)),
    // Converse has no tool choice that forbids a call, so the adapter asks
    // for a text answer in the last user message.
    noCallRequested: (body) => {
      const last = items(body.messages?.at(-1)?.content).at(-1);
      return typeof last?.text === "string" &&
        /without calling a tool/i.test(last.text);
    },
    callIds: (body) => messageBlocks(body)
      .flatMap((block) => items([block.toolUse]))
      .map((use) => String(use.toolUseId)),
    resultIds: (body) => messageBlocks(body)
      .flatMap((block) => items([block.toolResult]))
      .map((result) => String(result.toolUseId)),
  },
};

function bodyOf(index: number) {
  return (transport.requests()[index]?.body || {}) as WireBody;
}

const recorded: Partial<Record<ContractProvider, Record<string, ContractExchange[]>>> = {};

/**
 * Runs one scenario. In fixture mode the transport serves the scenario's
 * recorded responses, and any request that does not match them fails the
 * test. In record mode the exchanges of a passing scenario are kept.
 */
async function contract(
  provider: ContractProvider,
  scenario: string,
  body: () => Promise<void>,
) {
  const label = `${provider}/${scenario}`;
  if (MODE === "fixture") {
    const exchanges = fixtures[provider]?.scenarios[scenario]?.exchanges;
    if (!exchanges) {
      throw new Error(
        `The ${provider} fixture has no ${scenario} scenario. Record it with npm run test:provider-contract:record.`,
      );
    }
    transport.begin(label, exchanges);
  } else {
    transport.begin(label);
  }
  let failed = false;
  let failure: unknown;
  try {
    await body();
  } catch (error) {
    failed = true;
    failure = error;
  }
  const exchanges = transport.exchanges();
  // A request that did not match the fixture explains the failure better
  // than the error the adapter made of the mismatch response.
  expect(transport.finish()).toEqual([]);
  if (failed) throw failure;
  if (MODE === "record") {
    recorded[provider] = { ...recorded[provider], [scenario]: exchanges };
  }
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("The request succeeded, but it was expected to fail.");
}

function attemptsOf(error: unknown) {
  return (error as { attempts?: ModelAttemptReceipt[] }).attempts || [];
}

function expectUsage(provider: ContractProvider, result: ModelGenerationResult) {
  const { usage } = result;
  expect(result.provider).toBe(provider);
  expect(usage.inputTokens).toBeGreaterThan(0);
  expect(usage.outputTokens).toBeGreaterThan(0);
  // Every billed token class counts as input or output, so a total that
  // differs means the adapter missed a class the provider reported.
  expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
  expect(usage.cachedInputTokens).toBeLessThanOrEqual(usage.inputTokens);
  const target = targetFor(provider);
  // A provider may report a dated snapshot of the requested model, such as
  // gpt-5-2025-08-07 for gpt-5. Pricing lists only the requested id, and a
  // snapshot is priced as the model it snapshots.
  expect(result.model.startsWith(target.model)).toBe(true);
  const cacheWriteInputTokens = usage.cacheWriteInputTokens || 0;
  expect(result.costKnown).toBe(true);
  expect(result.estimatedCostUsd).toBeCloseTo(
    ((usage.inputTokens - usage.cachedInputTokens - cacheWriteInputTokens) * PRICE.input +
      usage.cachedInputTokens * PRICE.cachedInput +
      cacheWriteInputTokens * PRICE.cacheWrite +
      usage.outputTokens * PRICE.output) / 1_000_000,
    5,
  );
  expect(result.providerRequestId).toBeTruthy();
  expect(result.attempts).toEqual([
    expect.objectContaining({ provider, status: "completed" }),
  ]);
}

let dataDirectory = "";

beforeAll(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "provider-contract-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", dataDirectory);
  // The OpenAI SDK reads OPENAI_BASE_URL, and an empty value keeps its default.
  vi.stubEnv("OPENAI_BASE_URL", "");
  for (const provider of PROVIDERS) {
    vi.stubEnv(PRICING_ENV[provider], JSON.stringify({ [targetFor(provider).model]: PRICE }));
  }
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dataDirectory, { recursive: true, force: true });
  if (MODE !== "record") return;
  const recordedAt = new Date().toISOString().slice(0, 10);
  for (const provider of PROVIDERS) {
    const scenarios = recorded[provider];
    if (!scenarios) continue;
    writeProviderFixture(
      fixtureFile(provider),
      mergeRecordedScenarios(fixtures[provider], {
        provider,
        model: targetFor(provider).model,
        ...(provider === "aws_bedrock" ? { region: bedrockRegion() } : {}),
        recordedAt,
        scenarios,
      }),
    );
  }
});

describe.each(PROVIDERS)("%s provider contract", (provider) => {
  const run = it.runIf(!LIVE || Boolean(liveCredential(provider)));
  // A reply cut off at the token limit and a rate limit cannot be produced
  // on demand, so they run only from the hand-written fixtures.
  const fixtureOnly = it.runIf(!LIVE);
  const wire = WIRE[provider];

  run("answers a text request and meters it", async () => {
    await contract(provider, "text", async () => {
      const result = await generateModelText(textRequest(provider));

      expect(result.text).toMatch(/ready/i);
      expectUsage(provider, result);
    });
  }, TIMEOUT);

  run("calls a tool, then answers from its result without another call", async () => {
    await contract(provider, "tool_round_trip", async () => {
      const first = await generateModelToolTurn(toolRequest(provider));

      expect(first.toolCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of first.toolCalls) {
        expect(call.callId).toBeTruthy();
        expect(call.name).toBe("get_weather");
        expect(JSON.parse(call.argumentsJson)).toEqual({
          city: expect.stringMatching(/paris/i),
        });
      }
      expectUsage(provider, first);

      const second = await generateModelToolTurn(toolRequest(provider, {
        toolChoice: "none",
        continuation: first.continuation,
        toolResults: first.toolCalls.map((call) => ({
          callId: call.callId,
          name: call.name,
          output: WEATHER_RESULT,
        })),
      }));

      expect(second.toolCalls).toEqual([]);
      expect(second.text).toMatch(/sunny|21/i);
      expectUsage(provider, second);

      const requests = transport.requests();
      const firstBody = bodyOf(0);
      const lastBody = bodyOf(requests.length - 1);
      const callIds = first.toolCalls.map((call) => call.callId);
      expect(wire.toolNames(firstBody)).toEqual(["get_weather"]);
      expect(wire.toolNames(lastBody)).toEqual(["get_weather"]);
      expect(wire.noCallRequested(firstBody)).toBe(false);
      expect(wire.noCallRequested(lastBody)).toBe(true);
      expect(wire.callIds(lastBody)).toEqual(callIds);
      expect(wire.resultIds(lastBody)).toEqual(callIds);

      // Claude and Gemini need their reply back exactly as sent, with its
      // thinking signatures. Bedrock replays only text and tool blocks.
      const reply = transport.exchanges()[0].response.json as {
        content?: unknown;
        steps?: unknown;
      };
      if (provider === "anthropic") {
        expect(lastBody.messages?.[1]).toEqual({
          role: "assistant",
          content: reply.content,
        });
      }
      if (provider === "google") {
        const steps = items(reply.steps);
        expect(items(lastBody.input).slice(1, 1 + steps.length)).toEqual(steps);
      }
    });
  }, TIMEOUT);

  // Only the Claude and OpenAI adapters can ask for one call per turn and
  // produce structured output.
  if (provider === "anthropic" || provider === "openai") {
    run("asks for one tool call when parallel calls are off", async () => {
      await contract(provider, "single_call", async () => {
        const result = await generateModelToolTurn(toolRequest(provider, {
          input: "What is the weather in Paris and in Tokyo right now?",
          parallelToolCalls: false,
        }));

        expect(result.toolCalls).toHaveLength(1);
        expect(wire.singleCallRequested?.(bodyOf(0))).toBe(true);
        expectUsage(provider, result);
      });
    }, TIMEOUT);

    run("returns output that matches a JSON schema", async () => {
      await contract(provider, "structured", async () => {
        const result = await generateModelStructured(structuredRequest(provider));

        expect(JSON.parse(result.text)).toEqual({
          city: expect.stringMatching(/paris/i),
          country: expect.stringMatching(/france/i),
        });
        const body = bodyOf(0);
        if (provider === "anthropic") {
          expect(items(body.tools)[0]?.input_schema).toEqual(PLACE_SCHEMA);
        } else {
          expect(body.text?.format).toMatchObject({
            type: "json_schema",
            strict: true,
            schema: PLACE_SCHEMA,
          });
        }
        expectUsage(provider, result);
      });
    }, TIMEOUT);
  }

  run("reports a rejected credential as an authentication failure", async () => {
    await contract(provider, "authentication", async () => {
      const error = await rejection(
        generateModelText(textRequest(provider, invalidCredential(provider))),
      );

      expect(error).toBeInstanceOf(ModelProviderError);
      expect(error).toMatchObject({
        provider,
        kind: "authentication",
        retryable: false,
      });
      expect(attemptsOf(error)).toEqual([
        expect.objectContaining({
          provider,
          status: "failed",
          failureKind: "authentication",
        }),
      ]);
    });
  }, TIMEOUT);

  fixtureOnly("fails a reply cut off at the token limit and meters it", async () => {
    await contract(provider, "truncated", async () => {
      const error = await rejection(generateModelToolTurn(toolRequest(provider)));

      expect(error).toBeInstanceOf(ModelProviderError);
      expect(error).toMatchObject({ provider, kind: "unknown", retryable: false });
      expect((error as Error).message).toMatch(/token limit/i);
      expect(
        getModelProviderResponseReceipt(error)?.usage?.outputTokens,
      ).toBeGreaterThan(0);
      const attempts = attemptsOf(error);
      expect(attempts).toEqual([
        expect.objectContaining({
          provider,
          status: "failed",
          failureKind: "unknown",
        }),
      ]);
      expect(attempts[0].usage?.outputTokens).toBeGreaterThan(0);
    });
  });

  fixtureOnly("reports a rate limit as a retryable failure", async () => {
    await contract(provider, "rate_limit", async () => {
      const error = await rejection(generateModelText(textRequest(provider)));

      expect(error).toBeInstanceOf(ModelProviderError);
      expect(error).toMatchObject({ provider, kind: "rate_limit", retryable: true });
      expect(attemptsOf(error)).toEqual([
        expect.objectContaining({
          provider,
          status: "failed",
          failureKind: "rate_limit",
          retryable: true,
        }),
      ]);
    });
  });
});

it.runIf(LIVE)("has live credentials for at least one provider", () => {
  expect(PROVIDERS.filter((provider) => liveCredential(provider))).not.toEqual([]);
});
