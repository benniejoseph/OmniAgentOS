import { embedTexts } from "@/lib/openai/client";
import { chunkText, normalizeTextForChunking } from "@/lib/rag/chunk";
import { indexMemoryGraphRecords } from "@/lib/memory/graph";
import { saveMemories, searchMemories } from "@/lib/memory/store";
import type { MemorySearchResult } from "@/lib/memory/types";
import { createKnowledgeDocument, searchKnowledge } from "@/lib/rag/store";
import { jsonbSafeText, jsonbSafeTruncate } from "@/lib/rag/text-safety";
import type { KnowledgeSearchResult, KnowledgeSourceType } from "@/lib/rag/types";
import { redactSensitive } from "@/lib/security/context";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { projectCanonicalEvidenceEntities } from "@/lib/entities/extraction";
import {
  buildCanonicalTextSourceWrite,
  type TextSourceLineageInput,
} from "@/lib/sources/text-lineage";
import type { AiUsageScope } from "@/lib/usage/types";
import type { CaptureIngestGuard } from "@/lib/capture/ingest-guard";

export async function ingestTextDocument({
  idempotencyKey,
  tenantId,
  title,
  content,
  source = "ingest",
  sourceType = "text",
  tags = [],
  metadata,
  evidenceRefs = [],
  abortSignal,
  usageScope,
  sourceLineage,
  captureIngestGuard,
}: {
  idempotencyKey?: string;
  tenantId?: string;
  title: string;
  content: string;
  source?: string;
  sourceType?: KnowledgeSourceType;
  tags?: string[];
  metadata?: Record<string, unknown>;
  evidenceRefs?: string[];
  abortSignal?: AbortSignal;
  usageScope?: AiUsageScope;
  sourceLineage?: TextSourceLineageInput;
  captureIngestGuard?: CaptureIngestGuard;
}) {
  if ((usageScope?.actorId || captureIngestGuard?.actorId) && !sourceLineage) {
    throw new Error(
      "Actor-attributed knowledge ingestion requires canonical source lineage.",
    );
  }
  const safeTitle = jsonbSafeTruncate(String(redactSensitive(title)), 240);
  const safeContent = jsonbSafeTruncate(
    String(redactSensitive(content)),
    900_000,
  );
  const safeSource = jsonbSafeTruncate(
    String(redactSensitive(source)),
    2_000,
  );
  const safeTags = tags
    .map((tag) => jsonbSafeTruncate(String(redactSensitive(tag)), 80))
    .slice(0, 50);
  const chunks = chunkText(safeContent).map((chunk) => ({
    ...chunk,
    content: jsonbSafeText(chunk.content),
  }));
  const canonicalSourceWrite = sourceLineage
    ? buildCanonicalTextSourceWrite({
        lineage: sourceLineage,
        content: safeContent,
        normalizedContent: normalizeTextForChunking(safeContent),
        chunks,
        revisionMetadata: {
          titleSha256: sourceContractSha256(safeTitle),
          sourceSha256: sourceContractSha256(safeSource),
          sourceType,
          tagsSha256: sourceContractSha256([...safeTags].sort()),
        },
      })
    : undefined;
  const embeddings = await embedKnowledgeTexts(
    chunks.map((chunk) => chunk.content),
    abortSignal,
    usageScope,
  );
  abortSignal?.throwIfAborted();
  const knowledge = await createKnowledgeDocument({
    idempotencyKey,
    tenantId,
    title: safeTitle,
    content: safeContent,
    source: safeSource,
    sourceType,
    tags: safeTags,
    metadata,
    canonicalSourceWrite,
    captureIngestGuard,
    chunks: chunks.map((chunk) => ({
      ...chunk,
      embedding: embeddings?.[chunk.index],
    })),
  });
  if (canonicalSourceWrite) {
    await projectCanonicalEvidenceEntities({
      sourceWrite: canonicalSourceWrite,
      chunks: knowledge.chunks.map((chunk) => ({
        index: chunk.chunkIndex,
        content: chunk.content,
      })),
    });
  }
  abortSignal?.throwIfAborted();

  const records = await saveMemories(
    chunks.map((chunk) => ({
      id: idempotencyKey
        ? `${knowledge.document.id}_memory_${chunk.index}`
        : undefined,
      tenantId,
      type: "knowledge",
      title:
        chunks.length > 1
          ? `${safeTitle} (${chunk.index + 1}/${chunks.length})`
          : safeTitle,
      content: chunk.content,
      source: safeSource,
      tags: ["rag", ...safeTags],
      scope: "workspace",
      importance: 0.72,
      assertedBy: "import",
      evidenceRefs: [
        `knowledge:${knowledge.document.id}`,
        ...(knowledge.lineage?.evidenceUnitIdsByChunkIndex[chunk.index]
          ? [
              `evidence:${knowledge.lineage.evidenceUnitIdsByChunkIndex[chunk.index]}`,
            ]
          : []),
        ...evidenceRefs.map((reference) => String(redactSensitive(reference)).trim().slice(0, 500)).filter(Boolean),
      ],
      embedding: embeddings?.[chunk.index],
      ...(canonicalSourceWrite
        ? {
            executionScope: canonicalSourceWrite.executionScope,
            formationOrigin: "source_observation" as const,
          }
        : {}),
    })),
    { captureIngestGuard },
  );
  abortSignal?.throwIfAborted();
  await indexMemoryGraphRecords(records, "knowledge.ingest", {
    captureIngestGuard,
  });

  return {
    document: knowledge.document,
    chunks: knowledge.chunks,
    memories: records,
  };
}

async function embedKnowledgeTexts(
  input: string[],
  abortSignal?: AbortSignal,
  usageScope?: AiUsageScope,
) {
  try {
    return await embedTexts(input, abortSignal, usageScope);
  } catch (error) {
    if (abortSignal?.aborted) throw abortSignal.reason || error;
    // Lexical RAG and durable memory remain useful when the optional vector
    // provider is unavailable; a later re-index can add embeddings.
    return null;
  }
}

export async function retrieveContext(
  query: string,
  limit = 8,
  options: { tenantId?: string; usageScope?: AiUsageScope } = {},
) {
  // P2.1 writes canonical actor ownership only as a shadow lineage. Retrieval
  // deliberately remains on the legacy tenant-scoped index until P3.1 adds
  // actor/visibility/grant enforcement to every read path before cutover.
  const safeQuery = String(redactSensitive(query));
  const queryEmbedding = (await embedTexts([safeQuery], undefined, options.usageScope))?.[0];
  const [memoryResults, knowledgeResults] = await Promise.all([
    searchMemories(safeQuery, { limit, queryEmbedding, tenantId: options.tenantId }),
    searchKnowledge(safeQuery, { limit, queryEmbedding, tenantId: options.tenantId }),
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

  return String(
    redactSensitive(
      items
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
        .join("\n\n---\n\n"),
    ),
  );
}
