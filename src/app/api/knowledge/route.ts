import { embedTexts } from "@/lib/openai/client";
import {
  getKnowledgeStats,
  listKnowledgeChunks,
  listKnowledgeDocuments,
  searchKnowledge,
} from "@/lib/rag/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

export async function GET(request: Request) {
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
  const query = url.searchParams.get("q");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);

  if (query) {
    const queryEmbedding = (await embedTexts([query]))?.[0];
    return Response.json({
      results: await searchKnowledge(query, { limit, queryEmbedding, tenantId: context.tenantId }),
      stats: await getKnowledgeStats({ tenantId: context.tenantId }),
    });
  }

  const [documents, chunks, stats] = await Promise.all([
    listKnowledgeDocuments(limit, { tenantId: context.tenantId }),
    listKnowledgeChunks(limit, { tenantId: context.tenantId }),
    getKnowledgeStats({ tenantId: context.tenantId }),
  ]);

  return Response.json({ documents, chunks, stats });
}
