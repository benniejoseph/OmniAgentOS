import { z } from "zod";
import {
  getMemoryGraphStats,
  listMemoryGraphEdges,
  listMemoryGraphNodes,
  rebuildMemoryGraph,
  searchMemoryGraph,
} from "@/lib/memory/graph";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const rebuildSchema = z.object({
  source: z.string().min(1).max(80).optional(),
  memoryLimit: z.number().int().min(1).max(2000).optional(),
  traceLimit: z.number().int().min(1).max(1000).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);

  try {
    await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory_graph",
      metadata: query ? { query, limit } : { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  if (query) {
    return Response.json({
      results: await searchMemoryGraph(query, { limit: Math.min(limit, 24) }),
      stats: await getMemoryGraphStats(),
    });
  }

  const [nodes, edges, stats] = await Promise.all([
    listMemoryGraphNodes(limit),
    listMemoryGraphEdges(limit * 2),
    getMemoryGraphStats(),
  ]);

  return Response.json({ nodes, edges, stats });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = rebuildSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid memory graph rebuild request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "memory_graph",
      metadata: parsed.data,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const result = await rebuildMemoryGraph({
    source: parsed.data.source || "api",
    memoryLimit: parsed.data.memoryLimit,
    traceLimit: parsed.data.traceLimit,
  });

  return Response.json(result, { status: 201 });
}
