import { z } from "zod";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const ingestSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  source: z.string().optional(),
  sourceType: z.enum(["text", "url", "file", "api", "manual"]).optional(),
  tags: z.array(z.string()).optional(),
});

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = ingestSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid document", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "knowledge",
      metadata: body,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const result = await ingestTextDocument(parsed.data);
  return Response.json(
    {
      document: result.document,
      chunks: result.chunks,
      memories: result.memories,
      count: result.chunks.length,
    },
    { status: 201 },
  );
}
