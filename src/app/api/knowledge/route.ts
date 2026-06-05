import { embedTexts } from "@/lib/openai/client";
import {
  getKnowledgeStats,
  listKnowledgeChunks,
  listKnowledgeDocuments,
  searchKnowledge,
} from "@/lib/rag/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);

  if (query) {
    const queryEmbedding = (await embedTexts([query]))?.[0];
    return Response.json({
      results: await searchKnowledge(query, { limit, queryEmbedding }),
      stats: await getKnowledgeStats(),
    });
  }

  const [documents, chunks, stats] = await Promise.all([
    listKnowledgeDocuments(limit),
    listKnowledgeChunks(limit),
    getKnowledgeStats(),
  ]);

  return Response.json({ documents, chunks, stats });
}
