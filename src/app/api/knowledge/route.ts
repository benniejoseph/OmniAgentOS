import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseBoundedInteger } from "@/lib/http/body";
import { redactSensitive } from "@/lib/security/context";
import { embedRetrievalTexts } from "@/lib/rag/retrieval-embedding";
import { rerankRetrievalCandidates } from "@/lib/rag/learned-reranker";
import { knowledgeDeletionMutationFromRequest } from "@/lib/rag/deletion-events";
import {
  getKnowledgeStats,
  deleteKnowledgeDocumentsBySourcePrefix,
  listKnowledgeChunks,
  listKnowledgeDocuments,
  searchKnowledge,
} from "@/lib/rag/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

async function DELETEHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "write.memory", resourceType: "knowledge", metadata: { operation: "delete_source" } }); }
  catch (error) { return forbiddenResponse(error); }
  const source = new URL(request.url).searchParams.get("source")?.trim();
  if (!source || !["google:", "google:mail:", "google:calendar:", "google:drive:"].includes(source)) {
    return Response.json({ error: "Choose a supported connected source." }, { status: 400 });
  }
  try {
    const deleted = await deleteKnowledgeDocumentsBySourcePrefix(source, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      mutation: knowledgeDeletionMutationFromRequest(request, context, source),
    });
    return Response.json({ deleted, source }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Knowledge deletion failed.";
    return Response.json(
      { error: message },
      { status: message.startsWith("Idempotency-Key") ? 400 : 409 },
    );
  }
}

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "knowledge",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().slice(0, 4_000);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, {
    max: 100,
  });

  if (query) {
    const safeQuery = String(redactSensitive(query));
    const embeddingResult = await embedRetrievalTexts([safeQuery], {
      usageScope: {
        tenantId: context.tenantId,
        actorId: context.actorId,
        sourceStreamId: "api:knowledge",
        operation: "embedding",
        purpose: "api.knowledge.search",
        credentialSource: "deployment_environment",
      },
    });
    const results = await searchKnowledge(safeQuery, {
      limit,
      queryEmbedding: embeddingResult.vectors[0],
      queryEmbeddingSpaceId: embeddingResult.receipt.spaceId,
      tenantId: context.tenantId,
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
    return Response.json({
      results: reranked.results.map(({ value: result, score }) => ({
        ...result,
        baseScore: result.score,
        score,
        chunk: withoutEmbedding(result.chunk),
      })),
      retrieval: {
        embedding: embeddingResult.receipt,
        reranker: reranked.receipt,
      },
      stats: await getKnowledgeStats({ tenantId: context.tenantId }),
    });
  }

  const [documents, chunks, stats] = await Promise.all([
    listKnowledgeDocuments(limit, { tenantId: context.tenantId }),
    listKnowledgeChunks(limit, { tenantId: context.tenantId }),
    getKnowledgeStats({ tenantId: context.tenantId }),
  ]);

  return Response.json({
    documents,
    chunks: chunks.map(withoutEmbedding),
    stats,
  });
}

function withoutEmbedding<T extends { embedding?: number[] }>(record: T) {
  const publicRecord = { ...record };
  delete publicRecord.embedding;
  return publicRecord;
}
