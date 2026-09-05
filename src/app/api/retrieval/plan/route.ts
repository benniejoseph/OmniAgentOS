import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { buildContextPack, getContextEngineStats, listRetrievalTraces } from "@/lib/rag/context-engine";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const contextPlanSchema = z.object({
  query: z.string().min(1).max(4000),
  limit: z.number().int().min(1).max(24).optional(),
  persistTrace: z.boolean().optional(),
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
      resourceType: "retrieval",
      metadata: query ? { queryLength: query.length, limit } : { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  if (query) {
    const requestAccess = requestMemoryAccessFromSecurityContext(context, {
      purposeId: MEMORY_PURPOSE_IDS.retrieve,
      auditPurpose: "api.retrieval.plan",
      correlationId: `retrieval_plan_${randomUUID()}`,
    });
    return Response.json({
      pack: await buildContextPack(query, {
        tenantId: context.tenantId,
        databaseMemoryAccessScope: requestAccess?.databaseAccessScope,
        limit: Math.min(limit, 24),
        persistTrace: url.searchParams.get("persistTrace") !== "false",
        usageScope: {
          tenantId: context.tenantId,
          actorId: context.actorId,
          sourceStreamId: "api:retrieval",
          operation: "embedding",
          purpose: "api.retrieval.plan",
          credentialSource: "deployment_environment",
        },
      }),
      stats: await getContextEngineStats({ tenantId: context.tenantId }),
    });
  }

  return Response.json({
    traces: await listRetrievalTraces(limit, { tenantId: context.tenantId }),
    stats: await getContextEngineStats({ tenantId: context.tenantId }),
  });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = contextPlanSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid context plan request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
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

  const requestAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.retrieve,
    auditPurpose: "api.retrieval.plan",
    correlationId: `retrieval_plan_${randomUUID()}`,
  });
  return Response.json({
    pack: await buildContextPack(parsed.data.query, {
      tenantId: context.tenantId,
      databaseMemoryAccessScope: requestAccess?.databaseAccessScope,
      limit: parsed.data.limit,
      persistTrace: parsed.data.persistTrace,
      usageScope: {
        tenantId: context.tenantId,
        actorId: context.actorId,
        sourceStreamId: "api:retrieval",
        operation: "embedding",
        purpose: "api.retrieval.plan",
        credentialSource: "deployment_environment",
      },
    }),
    stats: await getContextEngineStats({ tenantId: context.tenantId }),
  });
}
