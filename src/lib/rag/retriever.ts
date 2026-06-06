import { embedTexts } from "@/lib/openai/client";
import { chunkText } from "@/lib/rag/chunk";
import { indexMemoryGraphRecords } from "@/lib/memory/graph";
import { saveMemory, searchMemories } from "@/lib/memory/store";
import type { MemorySearchResult } from "@/lib/memory/types";
import { createKnowledgeDocument, searchKnowledge } from "@/lib/rag/store";
import type { KnowledgeSearchResult, KnowledgeSourceType } from "@/lib/rag/types";

export async function ingestTextDocument({
  title,
  content,
  source = "ingest",
  sourceType = "text",
  tags = [],
}: {
  title: string;
  content: string;
  source?: string;
  sourceType?: KnowledgeSourceType;
  tags?: string[];
}) {
  const chunks = chunkText(content);
  const embeddings = await embedTexts(chunks.map((chunk) => chunk.content));
  const knowledge = await createKnowledgeDocument({
    title,
    content,
    source,
    sourceType,
    tags,
    chunks: chunks.map((chunk) => ({
      ...chunk,
      embedding: embeddings?.[chunk.index],
    })),
  });

  const records = [];
  for (const chunk of chunks) {
    records.push(
      await saveMemory({
        type: "knowledge",
        title: chunks.length > 1 ? `${title} (${chunk.index + 1}/${chunks.length})` : title,
        content: chunk.content,
        source,
        tags: ["rag", ...tags],
        scope: "workspace",
        importance: 0.72,
        embedding: embeddings?.[chunk.index],
      }),
    );
  }
  await indexMemoryGraphRecords(records, "knowledge.ingest");

  return {
    document: knowledge.document,
    chunks: knowledge.chunks,
    memories: records,
  };
}

export async function retrieveContext(query: string, limit = 8) {
  const queryEmbedding = (await embedTexts([query]))?.[0];
  const [memoryResults, knowledgeResults] = await Promise.all([
    searchMemories(query, { limit, queryEmbedding }),
    searchKnowledge(query, { limit, queryEmbedding }),
  ]);
  const contextItems = [
    ...memoryResults.map((result) => ({ kind: "memory" as const, result })),
    ...knowledgeResults.map((result) => ({ kind: "knowledge" as const, result })),
  ]
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, limit);

  return {
    results: contextItems,
    memoryResults,
    knowledgeResults,
    contextBlock: formatContext(contextItems),
  };
}

function formatContext(
  items: Array<
    | { kind: "memory"; result: MemorySearchResult }
    | { kind: "knowledge"; result: KnowledgeSearchResult }
  >,
) {
  if (items.length === 0) {
    return "No relevant long-term memory or RAG records were found.";
  }

  return items
    .map((item, index) => {
      if (item.kind === "memory") {
        const memory = item.result.record;
        return [
          `[${index + 1}] Memory: ${memory.title}`,
          `type: ${memory.type}; tags: ${memory.tags.join(", ") || "none"}; score: ${item.result.score.toFixed(2)}`,
          `reasons: ${item.result.reasons.join(", ") || "ranked context"}`,
          memory.content,
        ].join("\n");
      }

      const { chunk, document } = item.result;
      return [
        `[${index + 1}] Knowledge: ${chunk.title}`,
        `source: ${document?.title || chunk.source}; tags: ${chunk.tags.join(", ") || "none"}; score: ${item.result.score.toFixed(2)}`,
        `reasons: ${item.result.reasons.join(", ") || "ranked context"}`,
        chunk.content,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}
