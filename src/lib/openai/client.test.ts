import { afterEach, describe, expect, it, vi } from "vitest";

const openAiMocks = vi.hoisted(() => ({
  createResponse: vi.fn(),
  retrieveModel: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = { create: openAiMocks.createResponse };
    embeddings = { create: vi.fn() };
    models = { retrieve: openAiMocks.retrieveModel };
  },
}));

const originalKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  openAiMocks.createResponse.mockReset();
  openAiMocks.retrieveModel.mockReset();
  vi.useRealTimers();
  if (originalKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalKey;
  }
});

describe("OpenAI response privacy", () => {
  it("forces store=false even when a caller requests storage", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    openAiMocks.createResponse.mockResolvedValue({});
    const { getOpenAIClient } = await import("@/lib/openai/client");
    const create = getOpenAIClient().responses.create as unknown as (
      body: Record<string, unknown>,
    ) => Promise<unknown>;

    await create({ model: "test-model", input: "private", store: true });

    expect(openAiMocks.createResponse).toHaveBeenCalledWith(
      expect.objectContaining({ store: false }),
      undefined,
    );
  });

  it("fails a readiness probe even when the client ignores cancellation", async () => {
    vi.useFakeTimers();
    process.env.OPENAI_API_KEY = "test-key";
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
