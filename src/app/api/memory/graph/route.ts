import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import {
  getMemoryGraphStats,
  listMemoryGraphEdges,
  listMemoryGraphNodes,
  rebuildMemoryGraph,
  searchMemoryGraph,
} from "@/lib/memory/graph";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const rebuildSchema = z.object({
  source: z.string().min(1).max(80).optional(),
  memoryLimit: z.number().int().min(1).max(2000).optional(),
  traceLimit: z.number().int().min(1).max(1000).optional(),
}).strict();

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().slice(0, 4_000);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, {
    max: 100,
  });

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory_graph",
      metadata: query ? { queryLength: query.length, limit } : { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  if (query) {
    return Response.json({
      results: await searchMemoryGraph(query, {
        tenantId: context.tenantId,
        limit: Math.min(limit, 24),
      }),
      stats: await getMemoryGraphStats({ tenantId: context.tenantId }),
    });
  }

  const [nodes, edges, stats] = await Promise.all([
    listMemoryGraphNodes(limit, { tenantId: context.tenantId }),
    listMemoryGraphEdges(limit * 2, { tenantId: context.tenantId }),
    getMemoryGraphStats({ tenantId: context.tenantId }),
  ]);

  return Response.json({ nodes, edges, stats });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = rebuildSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid memory graph rebuild request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "memory_graph",
      metadata: {
        source: parsed.data.source,
        memoryLimit: parsed.data.memoryLimit,
        traceLimit: parsed.data.traceLimit,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const result = await rebuildMemoryGraph({
    tenantId: context.tenantId,
    source: parsed.data.source || "api",
    memoryLimit: parsed.data.memoryLimit,
    traceLimit: parsed.data.traceLimit,
  });

  return Response.json(result, { status: 201 });
}
