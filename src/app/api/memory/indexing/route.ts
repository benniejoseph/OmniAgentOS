import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "@/lib/config";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { embedTextsWithRuntime } from "@/lib/openai/client";
import {
  applyKnowledgeChunkEmbeddingBackfill,
  getKnowledgeStats,
  listKnowledgeChunksMissingEmbeddings,
} from "@/lib/rag/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const requestSchema = z.object({
  action: z.literal("backfill_embeddings"),
  limit: z.number().int().min(1).max(96).default(48),
}).strict();
const privateHeaders = { "cache-control": "private, no-store" };

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid knowledge indexing request.",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "knowledge_index",
      metadata: { action: parsed.data.action, limit: parsed.data.limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const correlationId = request.headers.get("x-correlation-id")?.trim() ||
    `knowledge_embedding_backfill_${randomUUID()}`;
  const access = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.write,
    auditPurpose: "api.knowledge.embedding_backfill",
    correlationId,
  });
  if (!access) {
    return Response.json({
      error: "Canonical user attribution is unavailable for this session.",
    }, { status: 409, headers: privateHeaders });
  }

  const chunks = await listKnowledgeChunksMissingEmbeddings(
    parsed.data.limit,
    { tenantId: context.tenantId },
  );
  if (!chunks.length) {
    const stats = await getKnowledgeStats({ tenantId: context.tenantId });
    return Response.json({
      processed: 0,
      remaining: Math.max(0, stats.chunks - stats.embedded),
      complete: stats.chunks === stats.embedded,
    }, { headers: privateHeaders });
  }
  const embedded = await embedTextsWithRuntime(
    chunks.map((chunk) => chunk.content),
    undefined,
    {
      tenantId: context.tenantId,
      actorId: access.actorBinding.canonicalActorId,
      sourceStreamId: `knowledge-index:${access.actorBinding.canonicalActorId}`,
      operation: "embedding",
      purpose: "knowledge.embedding_backfill",
      correlationId,
      executionScope: access.executionScope,
    },
  );
  if (
    !embedded ||
    embedded.vectors.length !== chunks.length ||
    embedded.dimensions !== EMBEDDING_DIMENSIONS
  ) {
    return Response.json({
      error: "The embedding provider is unavailable. Existing lexical search is unchanged.",
    }, { status: 503, headers: privateHeaders });
  }
  const result = await applyKnowledgeChunkEmbeddingBackfill({
    tenantId: context.tenantId,
    chunks: chunks.map((chunk, index) => ({
      id: chunk.id,
      expectedUpdatedAt: chunk.updatedAt,
      embedding: embedded.vectors[index]!,
    })),
    executionScope: access.executionScope,
    provider: embedded.provider,
    model: embedded.model,
    dimensions: embedded.dimensions,
  });
  const stats = await getKnowledgeStats({ tenantId: context.tenantId });
  const remaining = Math.max(0, stats.chunks - stats.embedded);
  return Response.json({
    processed: result.updatedCount,
    remaining,
    complete: remaining === 0,
    receipt: {
      chunkSetSha256: result.chunkSetSha256,
      provider: embedded.provider,
      model: embedded.model,
      dimensions: embedded.dimensions,
    },
  }, { headers: privateHeaders });
}
