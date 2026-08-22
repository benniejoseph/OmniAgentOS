import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const ingestSchema = z.object({
  title: z.string().trim().min(1).max(240),
  content: z.string().min(1).max(900_000),
  source: z.string().max(2_000).optional(),
  sourceType: z.enum(["text", "url", "file", "api", "manual"]).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
}).strict();

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = ingestSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid document", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "knowledge",
      metadata: {
        titleLength: parsed.data.title.length,
        hasSource: Boolean(parsed.data.source),
        sourceType: parsed.data.sourceType,
        tagCount: parsed.data.tags?.length || 0,
        contentLength: parsed.data.content.length,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const result = await ingestTextDocument({
    ...parsed.data,
    tenantId: context.tenantId,
  });
  return Response.json(
    {
      document: result.document,
      chunks: result.chunks.map(withoutEmbedding),
      memories: result.memories.map(withoutEmbedding),
      count: result.chunks.length,
    },
    { status: 201 },
  );
}

function withoutEmbedding<T extends { embedding?: number[] }>(record: T) {
  const publicRecord = { ...record };
  delete publicRecord.embedding;
  return publicRecord;
}
