import { VECTOR_INDEX_DIMENSIONS } from "@/lib/config";

export function toVectorLiteral(embedding?: number[] | null) {
  const normalized = normalizeEmbeddingDimensions(embedding);
  if (!normalized) {
    return null;
  }

  return `[${normalized.map((value) => normalizeVectorNumber(value)).join(",")}]`;
}

export function normalizeEmbeddingDimensions(
  embedding?: number[] | null,
  dimensions = VECTOR_INDEX_DIMENSIONS,
) {
  if (!embedding?.length || embedding.length < dimensions) {
    return null;
  }

  return embedding.slice(0, dimensions);
}

export function parseEmbedding(value: unknown): number[] | undefined {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseEmbedding(parsed);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function cosineSimilarity(a: number[], b: number[]) {
  const normalizedA = normalizeEmbeddingDimensions(a);
  const normalizedB = normalizeEmbeddingDimensions(b);
  if (!normalizedA || !normalizedB || normalizedA.length !== normalizedB.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < normalizedA.length; i += 1) {
    dot += normalizedA[i] * normalizedB[i];
    normA += normalizedA[i] * normalizedA[i];
    normB += normalizedB[i] * normalizedB[i];
  }

  if (!normA || !normB) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeVectorNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return Number(value).toPrecision(8);
}
