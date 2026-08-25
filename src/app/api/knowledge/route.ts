import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseBoundedInteger } from "@/lib/http/body";
import { embedTexts } from "@/lib/openai/client";
import { redactSensitive } from "@/lib/security/context";
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
  const deleted = await deleteKnowledgeDocumentsBySourcePrefix(source, { tenantId: context.tenantId });
  return Response.json({ deleted, source }, { headers: { "cache-control": "private, no-store" } });
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
    const queryEmbedding = (await embedTexts([safeQuery]))?.[0];
    return Response.json({
      results: (
        await searchKnowledge(safeQuery, {
          limit,
          queryEmbedding,
          tenantId: context.tenantId,
        })
      ).map((result) => ({
        ...result,
        chunk: withoutEmbedding(result.chunk),
      })),
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
