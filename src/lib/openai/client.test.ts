import { afterEach, describe, expect, it, vi } from "vitest";

const openAiMocks = vi.hoisted(() => ({
  createResponse: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = { create: openAiMocks.createResponse };
    embeddings = { create: vi.fn() };
  },
}));

const originalKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  openAiMocks.createResponse.mockReset();
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
});
