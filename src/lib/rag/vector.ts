import { EMBEDDING_DIMENSIONS } from "@/lib/config";

export function toVectorLiteral(embedding?: number[] | null) {
  if (!embedding?.length || embedding.length !== EMBEDDING_DIMENSIONS) {
    return null;
  }

  return `[${embedding.map((value) => normalizeVectorNumber(value)).join(",")}]`;
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
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
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
