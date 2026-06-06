import { z } from "zod";
import { buildContextPack, getContextEngineStats, listRetrievalTraces } from "@/lib/rag/context-engine";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const contextPlanSchema = z.object({
  query: z.string().min(1).max(4000),
  limit: z.number().int().min(1).max(24).optional(),
  persistTrace: z.boolean().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);

  try {
    await authorizeRequest({
      request,
      action: "read",
      resourceType: "retrieval",
      metadata: query ? { query, limit } : { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  if (query) {
    return Response.json({
      pack: await buildContextPack(query, {
        limit: Math.min(limit, 24),
        persistTrace: url.searchParams.get("persistTrace") !== "false",
      }),
      stats: await getContextEngineStats(),
    });
  }

  return Response.json({
    traces: await listRetrievalTraces(limit),
    stats: await getContextEngineStats(),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = contextPlanSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid context plan request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    await authorizeRequest({
      request,
      action: "read",
      resourceType: "retrieval",
      metadata: {
        queryLength: parsed.data.query.length,
        limit: parsed.data.limit || 8,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  return Response.json({
    pack: await buildContextPack(parsed.data.query, {
      limit: parsed.data.limit,
      persistTrace: parsed.data.persistTrace,
    }),
    stats: await getContextEngineStats(),
  });
}
