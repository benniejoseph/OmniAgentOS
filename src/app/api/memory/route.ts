import { randomUUID } from "node:crypto";
import { z } from "zod";
import { projectExplicitMemoryEntities } from "@/lib/entities/extraction";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import {
  indexMemoryGraphRecords,
  indexUserPrivateMemoryGraphRecords,
} from "@/lib/memory/graph";
import {
  buildUserPrivateMemoryAccessBindingV1,
  MEMORY_PURPOSE_IDS,
} from "@/lib/memory/access-binding";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { listMemories, listThreadMemories, saveMemory, searchMemories } from "@/lib/memory/store";
import { embedTexts } from "@/lib/openai/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getOwnedThread } from "@/lib/threads/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const memorySchema = z.object({
  title: z.string().trim().min(1).max(240),
  content: z.string().min(1).max(200_000),
  type: z.enum(["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"]).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
}).strict();

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().slice(0, 4_000);
  const requestedThreadId = url.searchParams.get("threadId");
  const threadId = requestedThreadId?.trim().slice(0, 200);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, {
    max: 100,
  });
  const requestAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: query
      ? MEMORY_PURPOSE_IDS.retrieve
      : MEMORY_PURPOSE_IDS.read,
    auditPurpose: query ? "api.memory.search" : "api.memory.read",
    correlationId: `memory_read_${randomUUID()}`,
  });

  if (requestedThreadId !== null) {
    if (!threadId) {
      return Response.json(
        { error: "A threadId is required." },
        { status: 400, headers: privateNoStoreHeaders },
      );
    }
    const thread = await getOwnedThread(threadId, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
    });
    if (!thread) {
      return Response.json(
        { error: "Thread not found." },
        { status: 404, headers: privateNoStoreHeaders },
      );
    }
    const legacyMemories = await listThreadMemories(thread.id, {
      tenantId: context.tenantId,
      limit: Math.min(Math.max(limit, 1), 100),
    });
    const privateMemories = requestAccess
      ? await listThreadMemories(thread.id, {
          tenantId: context.tenantId,
          limit: Math.min(Math.max(limit, 1), 100),
          accessScope: requestAccess.databaseAccessScope,
        })
      : [];
    return Response.json({
      memories: mergeMemoryRecords(legacyMemories, privateMemories, limit)
        .map(publicMemoryRecord),
    }, { headers: privateNoStoreHeaders });
  }

  if (query) {
    const safeQuery = String(redactSensitive(query));
    const queryEmbedding = (await embedTexts([safeQuery], undefined, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      sourceStreamId: "api:memory",
      operation: "embedding",
      purpose: "api.memory.search",
      credentialSource: "deployment_environment",
    }))?.[0];
    const searchLimit = Math.min(Math.max(limit, 1), 100);
    const legacyResults = await searchMemories(safeQuery, {
      limit: searchLimit,
      queryEmbedding,
      tenantId: context.tenantId,
    });
    const privateResults = requestAccess
      ? await searchMemories(safeQuery, {
          limit: searchLimit,
          queryEmbedding,
          tenantId: context.tenantId,
          accessScope: requestAccess.databaseAccessScope,
        })
      : [];
    return Response.json({
      results: mergeMemorySearchResults(
        legacyResults,
        privateResults,
        searchLimit,
      ).map((result) => ({
        ...result,
        record: publicMemoryRecord(result.record),
      })),
    }, { headers: privateNoStoreHeaders });
  }

  const listLimit = Math.min(Math.max(limit, 1), 100);
  const legacyMemories = await listMemories({
    tenantId: context.tenantId,
    includeInactive: true,
    limit: listLimit,
  });
  const privateMemories = requestAccess
    ? await listMemories({
        tenantId: context.tenantId,
        includeInactive: true,
        limit: listLimit,
        accessScope: requestAccess.databaseAccessScope,
      })
    : [];
  return Response.json({
    memories: mergeMemoryRecords(legacyMemories, privateMemories, listLimit)
      .map(publicMemoryRecord),
  }, { headers: privateNoStoreHeaders });
}

function publicMemoryRecord<T extends { embedding?: number[] }>(record: T) {
  const publicRecord = { ...record };
  delete publicRecord.embedding;
  return publicRecord;
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = memorySchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid memory", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "memory",
      metadata: {
        titleLength: parsed.data.title.length,
        type: parsed.data.type,
        tagCount: parsed.data.tags?.length || 0,
        importance: parsed.data.importance,
        contentLength: parsed.data.content.length,
      },
    });
    const safeMemory = redactSensitive(parsed.data) as typeof parsed.data;
    const embedding = (await embedTexts([
      `${safeMemory.title}\n\n${safeMemory.content}`,
    ], undefined, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      sourceStreamId: "api:memory",
      operation: "embedding",
      purpose: "api.memory.write",
      credentialSource: "deployment_environment",
    }))?.[0];
    const requestAccess = requestMemoryAccessFromSecurityContext(context, {
      purposeId: MEMORY_PURPOSE_IDS.write,
      auditPurpose: "api.memory.write",
      correlationId: `memory_write_${randomUUID()}`,
    });
    const accessBinding = requestAccess
      ? buildUserPrivateMemoryAccessBindingV1({
          tenantId: context.tenantId,
          ownerActorId: requestAccess.actorBinding.canonicalActorId,
          originPurpose: "api.memory.write",
        })
      : undefined;
    const record = await saveMemory({
      ...safeMemory,
      tenantId: context.tenantId,
      source: "manual",
      scope: accessBinding ? "user" : "workspace",
      assertedBy: "user",
      embedding,
      accessBinding,
      databaseAccessScope: requestAccess?.databaseAccessScope,
      executionScope: requestAccess?.executionScope,
    });
    let entityProjection:
      | {
          candidateCount: number;
          createdCount: number;
          linkedCount: number;
          reviewRequiredCount: number;
        }
      | undefined;
    if (record.accessBinding && requestAccess) {
      await indexUserPrivateMemoryGraphRecords([record], "memory.manual", {
        tenantId: context.tenantId,
        accessScope: requestAccess.databaseAccessScope,
      });
      const projected = await projectExplicitMemoryEntities({
        memory: record,
        executionScope: requestAccess.executionScope,
      });
      entityProjection = {
        candidateCount: projected.extraction.candidates.length,
        createdCount: projected.createdEntityIds.length,
        linkedCount: projected.linkedEntityIds.length,
        reviewRequiredCount: projected.reviewResolutionIds.length,
      };
    } else if (!record.accessBinding) {
      await indexMemoryGraphRecords([record], "memory.manual");
    }

    return Response.json(
      { record: publicMemoryRecord(record), entityProjection },
      { status: 201, headers: privateNoStoreHeaders },
    );
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

function mergeMemoryRecords<
  T extends { id: string; updatedAt: string },
>(legacy: T[], scoped: T[], limit: number) {
  return [...new Map(
    [...legacy, ...scoped].map((memory) => [memory.id, memory] as const),
  ).values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

function mergeMemorySearchResults<
  T extends { record: { id: string }; score: number },
>(legacy: T[], scoped: T[], limit: number) {
  return [...new Map(
    [...legacy, ...scoped].map((result) => [result.record.id, result] as const),
  ).values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
