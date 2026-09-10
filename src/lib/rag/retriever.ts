import { createHash } from "node:crypto";
import { embedTexts } from "@/lib/openai/client";
import { chunkText, normalizeTextForChunking } from "@/lib/rag/chunk";
import {
  indexMemoryGraphRecords,
  queueMemoryGraphRebuild,
} from "@/lib/memory/graph";
import { saveMemories } from "@/lib/memory/store";
import {
  createKnowledgeDocument,
  retireSupersededCaptureKnowledge,
} from "@/lib/rag/store";
import { buildContextPack } from "@/lib/rag/context-engine";
import { jsonbSafeText, jsonbSafeTruncate } from "@/lib/rag/text-safety";
import type { KnowledgeSourceType } from "@/lib/rag/types";
import { redactSensitive } from "@/lib/security/context";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import {
  captureExtractionUnitSchema,
  renderCaptureExtractionUnits,
  type CaptureExtractionUnit,
} from "@/lib/capture/extraction";
import { projectCanonicalEvidenceEntities } from "@/lib/entities/extraction";
import {
  buildCanonicalTextSourceWrite,
  type TextSourceLineageInput,
} from "@/lib/sources/text-lineage";
import type { AiUsageScope } from "@/lib/usage/types";
import type { CaptureIngestGuard } from "@/lib/capture/ingest-guard";
import type { ExecutionScope } from "@/lib/security/execution-scope";

export type KnowledgeIngestProgress = Readonly<{
  stage:
    | "chunking"
    | "embedding"
    | "knowledge"
    | "entities"
    | "memory"
    | "graph";
  chunkCount?: number;
  memoryCount?: number;
}>;

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
  executionScope,
  structuredUnits,
  deferMemoryGraphIndex = false,
  onProgress,
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
  executionScope?: ExecutionScope;
  structuredUnits?: CaptureExtractionUnit[];
  deferMemoryGraphIndex?: boolean;
  onProgress?: (progress: KnowledgeIngestProgress) => void | Promise<void>;
}) {
  if ((usageScope?.actorId || captureIngestGuard?.actorId) && !sourceLineage) {
    throw new Error(
      "Actor-attributed knowledge ingestion requires canonical source lineage.",
    );
  }
  const safeTitle = jsonbSafeTruncate(String(redactSensitive(title)), 240);
  const structured = structuredUnits?.length
    ? normalizeStructuredIngestUnits(content, structuredUnits)
    : undefined;
  const safeContent = structured?.content || jsonbSafeTruncate(
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
  await onProgress?.({ stage: "chunking" });
  abortSignal?.throwIfAborted();
  const chunks = structured?.chunks || chunkText(safeContent).map((chunk) => ({
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
  await onProgress?.({ stage: "embedding", chunkCount: chunks.length });
  abortSignal?.throwIfAborted();
  const embeddings = await embedKnowledgeTexts(
    chunks.map((chunk) => chunk.content),
    abortSignal,
    usageScope,
  );
  abortSignal?.throwIfAborted();
  await onProgress?.({ stage: "knowledge", chunkCount: chunks.length });
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
    await onProgress?.({ stage: "entities", chunkCount: chunks.length });
    abortSignal?.throwIfAborted();
    await projectCanonicalEvidenceEntities({
      sourceWrite: canonicalSourceWrite,
      chunks: knowledge.chunks.map((chunk) => ({
        index: chunk.chunkIndex,
        content: chunk.content,
      })),
    });
  }
  abortSignal?.throwIfAborted();

  await onProgress?.({ stage: "memory", chunkCount: chunks.length });
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
      ...((canonicalSourceWrite || executionScope)
        ? {
            executionScope:
              canonicalSourceWrite?.executionScope || executionScope,
            ...(canonicalSourceWrite
              ? { formationOrigin: "source_observation" as const }
              : {}),
          }
        : {}),
    })),
    { captureIngestGuard },
  );
  const retired = captureIngestGuard
    ? await retireSupersededCaptureKnowledge({
        captureIngestGuard,
        executionScope:
          canonicalSourceWrite?.executionScope || executionScope!,
        keepDocumentId: knowledge.document.id,
      })
    : { documents: 0, memories: 0 };
  abortSignal?.throwIfAborted();
  await onProgress?.({
    stage: "graph",
    chunkCount: chunks.length,
    memoryCount: records.length,
  });
  abortSignal?.throwIfAborted();
  if (deferMemoryGraphIndex) {
    await queueMemoryGraphRebuild({ tenantId });
  } else {
    await indexMemoryGraphRecords(records, "knowledge.ingest", {
      captureIngestGuard,
    });
  }

  return {
    document: knowledge.document,
    chunks: knowledge.chunks,
    memories: records,
    retired,
  };
}

function normalizeStructuredIngestUnits(
  content: string,
  input: readonly CaptureExtractionUnit[],
) {
  const parsed = input.map((unit) => captureExtractionUnitSchema.parse(unit));
  if (
    normalizeTextForChunking(content) !==
      normalizeTextForChunking(renderCaptureExtractionUnits(parsed))
  ) {
    throw new Error(
      "Structured extraction units must exactly compose the ingest content.",
    );
  }
  const safeContents = parsed.map((unit) => normalizeTextForChunking(
    jsonbSafeText(String(redactSensitive(unit.content))),
  ));
  if (safeContents.some((value) => !value)) {
    throw new Error("Structured extraction contains an empty evidence unit.");
  }
  const safeContent = safeContents.join("\n\n");
  let cursor = 0;
  const chunks = parsed.map((unit, index) => {
    const safeUnitContent = safeContents[index];
    const characterStart = cursor;
    const characterEnd = characterStart + safeUnitContent.length;
    cursor = characterEnd + 2;
    return {
      index,
      content: safeUnitContent,
      characterStart,
      characterEnd,
      label: unit.label,
      metadata: {
        evidenceLabel: unit.label,
        evidenceLocatorKind: unit.locator.kind,
      },
      locator: unit.locator.kind === "text_span"
        ? {
            kind: "text_span" as const,
            offsetUnit: "utf16_code_unit" as const,
            startOffset: characterStart,
            endOffsetExclusive: characterEnd,
            containerLength: safeContent.length,
            containerSha256: createHash("sha256").update(safeContent).digest("hex"),
          }
        : unit.locator,
    };
  });
  return { content: safeContent, chunks };
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
  const pack = await buildContextPack(safeQuery, {
    limit,
    tenantId: options.tenantId,
    usageScope: options.usageScope,
    persistTrace: false,
    queryPlanning: { allowSemanticModel: false },
  });

  return {
    results: pack.results,
    memoryResults: pack.memoryResults,
    knowledgeResults: pack.knowledgeResults,
    contextBlock: pack.contextBlock,
    budget: pack.budget,
    retrieval: {
      embedding: pack.profile.embedding,
      reranker: pack.profile.reranker,
    },
  };
}
