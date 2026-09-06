import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  embedTexts: vi.fn(),
  hasOpenAIKey: vi.fn(),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return { ...actual, hasOpenAIKey: mocks.hasOpenAIKey };
});
vi.mock("@/lib/openai/client", () => ({ embedTexts: mocks.embedTexts }));

import {
  LOCAL_MULTILINGUAL_EMBEDDING_DIMENSIONS,
  embedLocalMultilingualTexts,
  embedRetrievalTexts,
  retrievalEmbeddingCapabilities,
  retrievalEmbeddingCosine,
} from "@/lib/rag/retrieval-embedding";

describe("P4.4 retrieval embedding adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasOpenAIKey.mockReturnValue(true);
    mocks.embedTexts.mockResolvedValue([[0.1, 0.2]]);
  });

  it("uses external embeddings only when the disclosure policy allows them", async () => {
    const local = await embedRetrievalTexts(["private query"]);
    expect(local.receipt).toMatchObject({
      provider: "local",
      externalDisclosure: false,
      fallbackReason: "external_provider_not_allowed",
    });
    expect(local.vectors[0]).toHaveLength(
      LOCAL_MULTILINGUAL_EMBEDDING_DIMENSIONS,
    );
    expect(mocks.embedTexts).not.toHaveBeenCalled();

    const external = await embedRetrievalTexts(["allowed query"], {
      allowedExternalProviders: ["openai"],
    });
    expect(external.receipt).toMatchObject({
      provider: "openai",
      externalDisclosure: true,
      supportsStoredVectorIndex: true,
    });
    expect(mocks.embedTexts).toHaveBeenCalledOnce();
  });

  it("falls back locally when an allowed provider is absent or fails", async () => {
    mocks.hasOpenAIKey.mockReturnValue(false);
    const unavailable = await embedRetrievalTexts(["consulta"], {
      allowedExternalProviders: ["openai"],
    });
    expect(unavailable.receipt).toMatchObject({
      provider: "local",
      fallbackReason: "external_provider_unavailable",
    });

    mocks.hasOpenAIKey.mockReturnValue(true);
    mocks.embedTexts.mockRejectedValue(new Error("provider failed"));
    const failed = await embedRetrievalTexts(["consulta"], {
      allowedExternalProviders: ["openai"],
    });
    expect(failed.receipt).toMatchObject({
      provider: "local",
      fallbackReason: "external_provider_failed",
    });
  });

  it("maps multilingual paraphrases closer than unrelated concepts", () => {
    const [spanish, english, unrelated] = embedLocalMultilingualTexts([
      "procedimiento de despliegue de base de datos",
      "database deployment procedure",
      "customer invoice renewal",
    ]);
    expect(retrievalEmbeddingCosine(spanish, english)).toBeGreaterThan(0.45);
    expect(retrievalEmbeddingCosine(spanish, unrelated)).toBeLessThan(0.15);
  });

  it("publishes immutable space and disclosure capabilities", () => {
    expect(retrievalEmbeddingCapabilities.local).toMatchObject({
      provider: "local",
      multilingual: true,
      requiresCredential: false,
      supportsStoredVectorIndex: false,
    });
    expect(retrievalEmbeddingCapabilities.openai).toMatchObject({
      provider: "openai",
      requiresCredential: true,
      supportsStoredVectorIndex: true,
    });
    expect(retrievalEmbeddingCapabilities.local.spaceId).not.toBe(
      retrievalEmbeddingCapabilities.openai.spaceId,
    );
    expect(Object.isFrozen(retrievalEmbeddingCapabilities.local)).toBe(true);
    expect(Object.isFrozen(retrievalEmbeddingCapabilities.openai)).toBe(true);
  });
});
