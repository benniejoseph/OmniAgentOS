import { z } from "zod";
import { indexMemoryGraphRecords } from "@/lib/memory/graph";
import { listMemories, saveMemory, searchMemories } from "@/lib/memory/store";
import { embedTexts } from "@/lib/openai/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const memorySchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  type: z.enum(["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"]).optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  const limit = Number(url.searchParams.get("limit") || 20);

  if (query) {
    const queryEmbedding = (await embedTexts([query]))?.[0];
    return Response.json({
      results: await searchMemories(query, {
        limit: Math.min(Math.max(limit, 1), 100),
        queryEmbedding,
      }),
    });
  }

  return Response.json({ memories: (await listMemories()).slice(0, Math.min(Math.max(limit, 1), 100)) });
}

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = memorySchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid memory", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "memory",
      metadata: body,
    });
    const embedding = (await embedTexts([`${parsed.data.title}\n\n${parsed.data.content}`]))?.[0];
    const record = await saveMemory({
      ...parsed.data,
      source: "manual",
      scope: "workspace",
      embedding,
    });
    await indexMemoryGraphRecords([record], "memory.manual");

    return Response.json({ record }, { status: 201 });
  } catch (error) {
    try {
      return forbiddenResponse(error);
    } catch {
      // fall through to ordinary error handling
    }
    return Response.json(
      {
        error: "Memory write failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
