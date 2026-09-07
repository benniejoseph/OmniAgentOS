import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { rerankRetrievalCandidates } from "@/lib/rag/learned-reranker";
import { embedRetrievalTexts } from "@/lib/rag/retrieval-embedding";
import {
  deleteKnowledgeDocumentsBySourcePrefix,
  getKnowledgeStats,
  listKnowledgeChunks,
  listKnowledgeDocuments,
  searchKnowledge,
} from "@/lib/rag/store";
import { redactSensitive } from "@/lib/security/context";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { AiUsageScope } from "@/lib/usage/types";

export const knowledgeListServiceInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
}).strict();

export const knowledgeSearchServiceInputSchema = z.object({
  query: z.string().trim().min(1).max(4_000),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();

export const knowledgeIngestServiceInputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  content: z.string().min(1).max(20_000),
  source: z.string().trim().max(2_000).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
}).strict();

export const knowledgeSourceDeleteServiceInputSchema = z.object({
  source: z.enum([
    "google:",
    "google:mail:",
    "google:calendar:",
    "google:drive:",
  ]),
}).strict();

export const knowledgeSourceDeletePreviewServiceInputSchema = knowledgeSourceDeleteServiceInputSchema;

export const governedKnowledgeSourceDeleteServiceInputSchema = knowledgeSourceDeleteServiceInputSchema.extend({
  expectedTargetsSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

type KnowledgeServiceOptions = Readonly<{
  abortSignal?: AbortSignal;
  usageScope?: AiUsageScope;
}>;

export async function listKnowledgeService(
  caller: AppServiceCaller,
  input: z.input<typeof knowledgeListServiceInputSchema>,
) {
  const value = knowledgeListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("knowledge.list"),
  );
  const owner = { tenantId: caller.context.tenantId };
  const [documents, chunks, stats] = await Promise.all([
    listKnowledgeDocuments(value.limit, owner),
    listKnowledgeChunks(value.limit, owner),
    getKnowledgeStats(owner),
  ]);
  return completeAppServiceCall(authorized, {
    documents,
    chunks: chunks.map(withoutEmbedding),
    stats,
  }, { resourceCount: documents.length + chunks.length });
}

export async function searchKnowledgeService(
  caller: AppServiceCaller,
  input: z.input<typeof knowledgeSearchServiceInputSchema>,
  options: KnowledgeServiceOptions = {},
) {
  const value = knowledgeSearchServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("knowledge.search"),
  );
  const safeQuery = String(redactSensitive(value.query));
  const embeddingResult = await embedRetrievalTexts([safeQuery], {
    abortSignal: options.abortSignal,
    usageScope: options.usageScope || defaultUsageScope(
      caller,
      "app.knowledge.search",
    ),
  });
  const results = await searchKnowledge(safeQuery, {
    limit: value.limit,
    queryEmbedding: embeddingResult.vectors[0],
    queryEmbeddingSpaceId: embeddingResult.receipt.spaceId,
    tenantId: caller.context.tenantId,
  });
  const reranked = rerankRetrievalCandidates(
    safeQuery,
    results.map((result) => ({
      value: result,
      text: `${result.chunk.title}\n${result.chunk.content}`,
      baseScore: result.score,
      freshnessScore: result.recencyScore,
    })),
  );
  const publicResults = reranked.results.map(({ value: result, score }) => ({
    score,
    baseScore: result.score,
    vectorScore: result.vectorScore,
    lexicalScore: result.lexicalScore,
    reasons: result.reasons,
    chunk: withoutEmbedding(result.chunk),
    document: result.document,
  }));
  return completeAppServiceCall(authorized, {
    results: publicResults,
    retrieval: {
      embedding: embeddingResult.receipt,
      reranker: reranked.receipt,
    },
    stats: await getKnowledgeStats({ tenantId: caller.context.tenantId }),
  }, { resourceCount: publicResults.length });
}

export async function ingestKnowledgeService(
  caller: AppServiceCaller,
  input: z.input<typeof knowledgeIngestServiceInputSchema>,
  options: KnowledgeServiceOptions & {
    effectTargetId?: string;
    observedAt?: string;
  } = {},
) {
  const value = redactSensitive(
    knowledgeIngestServiceInputSchema.parse(input),
  ) as z.output<typeof knowledgeIngestServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("knowledge.ingest"),
  );
  const source = value.source || "tool-executor";
  const executionScope = caller.executionScope!;
  const result = await ingestTextDocument({
    tenantId: caller.context.tenantId,
    title: value.title,
    content: value.content,
    source,
    sourceType: "manual",
    tags: value.tags || ["tool-execution"],
    usageScope: options.usageScope || defaultUsageScope(
      caller,
      "app.knowledge.ingest",
    ),
    executionScope,
    ...(executionScope.initiatingActorId && options.observedAt
      ? {
          sourceLineage: {
            executionScope,
            connectionId: "first_party.knowledge_service",
            adapterId: "asael.knowledge_service",
            adapterVersionId: "1",
            externalItemId:
              caller.idempotencyKey ||
              options.effectTargetId ||
              `knowledge_service_${sourceContractSha256({
                title: value.title,
                content: value.content,
                source,
              })}`,
            sourceKind: "document" as const,
            capturedAt: options.observedAt,
          },
        }
      : {}),
  });
  return completeAppServiceCall(authorized, {
    document: result.document,
    chunks: result.chunks.length,
    memories: result.memories.length,
  });
}

export async function deleteKnowledgeSourceService(
  caller: AppServiceCaller,
  input: z.input<typeof knowledgeSourceDeleteServiceInputSchema>,
) {
  const value = knowledgeSourceDeleteServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("knowledge.delete_source"),
  );
  const deleted = z.object({
    documents: z.number().int().min(0),
    memories: z.number().int().min(0),
  }).strict().parse(await deleteKnowledgeDocumentsBySourcePrefix(value.source, {
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    mutation: {
      executionScope: caller.executionScope!,
      idempotencyKey: caller.idempotencyKey!,
    },
  }));
  return completeAppServiceCall(authorized, {
    deleted,
    source: value.source,
  }, { resourceCount: deleted.documents });
}

export async function previewGovernedKnowledgeSourceDeleteService(
  caller: AppServiceCaller,
  input: z.input<typeof knowledgeSourceDeletePreviewServiceInputSchema>,
) {
  const value = knowledgeSourceDeletePreviewServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.knowledge.delete.preview"),
  );
  const targets = (await listKnowledgeDocuments(5_000, {
    tenantId: caller.context.tenantId,
  }))
    .filter((document) => document.source.startsWith(value.source))
    .map((document) => ({ id: document.id, source: document.source, title: document.title }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return completeAppServiceCall(authorized, {
    source: value.source,
    targets,
    targetsSha256: canonicalJsonSha256(targets),
    irreversible: true as const,
  }, { resourceCount: targets.length });
}

export async function deleteGovernedKnowledgeSourceService(
  caller: AppServiceCaller,
  input: z.input<typeof governedKnowledgeSourceDeleteServiceInputSchema>,
) {
  const value = governedKnowledgeSourceDeleteServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.knowledge.delete"),
  );
  const preview = await previewGovernedKnowledgeSourceDeleteService(caller, {
    source: value.source,
  });
  if (preview.data.targetsSha256 !== value.expectedTargetsSha256) {
    throw new Error("Knowledge deletion targets changed after preview; review the exact targets again.");
  }
  const result = await deleteKnowledgeSourceService(caller, { source: value.source });
  return completeAppServiceCall(authorized, {
    ...result.data,
    deletedTargetIds: preview.data.targets.map((target) => target.id),
    targetsSha256: preview.data.targetsSha256,
  }, { resourceCount: result.data.deleted.documents });
}

function withoutEmbedding<T extends { embedding?: number[] }>(record: T) {
  const publicRecord = { ...record };
  delete publicRecord.embedding;
  return publicRecord;
}

function defaultUsageScope(
  caller: AppServiceCaller,
  purpose: string,
): AiUsageScope {
  const sourceId = caller.idempotencyKey ||
    caller.executionScope?.correlationId || crypto.randomUUID();
  return {
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    sourceStreamId: `app-service:${sourceId}`,
    operation: "embedding",
    purpose,
    correlationId: caller.executionScope?.correlationId || sourceId,
    causationId: caller.executionScope?.causationId || undefined,
    executionScope: caller.executionScope,
    credentialSource: "deployment_environment",
  };
}
