import { afterEach, describe, expect, it, vi } from "vitest";

const openAiMocks = vi.hoisted(() => ({
  constructorOptions: vi.fn(),
  createResponse: vi.fn(),
  retrieveModel: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    constructor(options: unknown) {
      openAiMocks.constructorOptions(options);
    }
    responses = { create: openAiMocks.createResponse };
    embeddings = { create: vi.fn() };
    models = { retrieve: openAiMocks.retrieveModel };
  },
}));

const originalKey = process.env.OPENAI_API_KEY;
const originalGatewayUrl = process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
const originalGatewayToken = process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
const originalVercelEnvironment = process.env.VERCEL_ENV;
const gatewayToken = "b".repeat(64);

afterEach(() => {
  vi.resetModules();
  openAiMocks.constructorOptions.mockReset();
  openAiMocks.createResponse.mockReset();
  openAiMocks.retrieveModel.mockReset();
  vi.useRealTimers();
  if (originalKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalKey;
  }
  restoreEnvironment(
    "OMNIAGENT_OPENAI_GATEWAY_URL",
    originalGatewayUrl,
  );
  restoreEnvironment(
    "OMNIAGENT_OPENAI_GATEWAY_TOKEN",
    originalGatewayToken,
  );
  restoreEnvironment("VERCEL_ENV", originalVercelEnvironment);
});

describe("OpenAI response privacy", () => {
  it("forces store=false even when a caller requests storage", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
    openAiMocks.createResponse.mockResolvedValue({});
    const { getOpenAIClient } = await import("@/lib/openai/client");
    const create = getOpenAIClient().responses.create as unknown as (
      body: Record<string, unknown>,
    ) => Promise<unknown>;

    await create({ model: "test-model", input: "private", store: true });

    expect(openAiMocks.constructorOptions).toHaveBeenCalledWith({
      apiKey: "test-key",
    });
    expect(openAiMocks.createResponse).toHaveBeenCalledWith(
      expect.objectContaining({ store: false }),
      undefined,
    );
  });

  it("uses the gateway base and token without replacing upstream API auth", async () => {
    process.env.OPENAI_API_KEY = "upstream-api-key";
    process.env.OMNIAGENT_OPENAI_GATEWAY_URL =
      "https://gateway.asael.example/openai/";
    process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN = gatewayToken;
    const { getOpenAIClient } = await import("@/lib/openai/client");

    getOpenAIClient();

    expect(openAiMocks.constructorOptions).toHaveBeenCalledWith({
      apiKey: "upstream-api-key",
      baseURL: "https://gateway.asael.example/openai/v1",
      defaultHeaders: {
        "x-asael-gateway-token": gatewayToken,
      },
    });
  });

  it("does not expose raw credentials when production gateway configuration is invalid", async () => {
    process.env.OPENAI_API_KEY = "upstream-api-key";
    process.env.VERCEL_ENV = "production";
    process.env.OMNIAGENT_OPENAI_GATEWAY_URL =
      "https://owner:url-password@gateway.asael.example/openai";
    process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN = gatewayToken;
    const { getOpenAIClient } = await import("@/lib/openai/client");

    let failure: unknown;
    try {
      getOpenAIClient();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "OpenAI gateway configuration is invalid.",
    );
    expect((failure as Error).message).not.toContain("upstream-api-key");
    expect((failure as Error).message).not.toContain(gatewayToken);
    expect((failure as Error).message).not.toContain("url-password");
    expect((failure as Error).message).not.toContain("gateway.asael.example");
    expect(openAiMocks.constructorOptions).not.toHaveBeenCalled();
  });

  it("fails a readiness probe even when the client ignores cancellation", async () => {
    vi.useFakeTimers();
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_URL;
    delete process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN;
    openAiMocks.retrieveModel.mockReturnValue(new Promise(() => undefined));
    const { getOpenAIReadiness } = await import("@/lib/openai/client");

    const readiness = getOpenAIReadiness({
      timeoutMs: 1_000,
      maxAgeMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(readiness).resolves.toMatchObject({
      configured: true,
      reachable: false,
      error: "OpenAI readiness probe timed out.",
    });
  });
});

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
