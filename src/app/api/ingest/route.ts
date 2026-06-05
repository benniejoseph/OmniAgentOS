import { z } from "zod";
import { ingestTextDocument } from "@/lib/rag/retriever";

export const runtime = "nodejs";

const ingestSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  source: z.string().optional(),
  sourceType: z.enum(["text", "url", "file", "api", "manual"]).optional(),
  tags: z.array(z.string()).optional(),
});

export async function POST(request: Request) {
  const parsed = ingestSchema.safeParse(await request.json());

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid document", details: parsed.error.flatten() },
      { status: 400 },
    );
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
