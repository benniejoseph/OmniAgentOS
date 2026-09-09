import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { projectExplicitMemoryEntities } from "@/lib/entities/extraction";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import {
  indexUserPrivateMemoryGraphRecords,
} from "@/lib/memory/graph";
import {
  LegacyMemoryOwnershipConflictError,
  migrateLegacyDurableMemoryOwnership,
  previewLegacyDurableMemoryOwnership,
} from "@/lib/memory/legacy-ownership";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { listMemories } from "@/lib/memory/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const migrationSchema = z.object({
  action: z.literal("enroll_current_user"),
  expectedManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const privateHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory_ownership",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const preview = await previewLegacyDurableMemoryOwnership({
    tenantId: context.tenantId,
  });
  return Response.json({ preview }, { headers: privateHeaders });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = migrationSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid legacy memory ownership request.",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateHeaders });
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "memory_ownership",
      metadata: { action: parsed.data.action },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const correlationId = request.headers.get("x-correlation-id")?.trim() ||
    `memory_owner_enrollment_${randomUUID()}`;
  const readAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.read,
    auditPurpose: "api.memory.owner_enrollment.read",
    correlationId,
  });
  const writeAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.write,
    auditPurpose: "api.memory.owner_enrollment.write",
    correlationId,
  });
  if (!readAccess || !writeAccess) {
    return Response.json({
      error: "Canonical user ownership is unavailable for this session.",
    }, { status: 409, headers: privateHeaders });
  }

  try {
    const migration = await migrateLegacyDurableMemoryOwnership({
      tenantId: context.tenantId,
      ownerActorId: writeAccess.actorBinding.canonicalActorId,
      expectedManifestSha256: parsed.data.expectedManifestSha256,
      executionScope: writeAccess.executionScope,
    });
    const activeRecords = migration.migratedCount
      ? (await listMemories({
          tenantId: context.tenantId,
          limit: Math.min(Math.max(migration.migratedCount, 1), 10_000),
          accessScope: readAccess.databaseAccessScope,
        })).filter((memory) => migration.recordIds.includes(memory.id))
      : [];
    const graphProjection = activeRecords.length
      ? await indexUserPrivateMemoryGraphRecords(
          activeRecords,
          "memory.legacy_owner_enrollment",
          {
            tenantId: context.tenantId,
            accessScope: writeAccess.databaseAccessScope,
          },
        )
      : { indexedMemoryCount: 0, nodeCount: 0, edgeCount: 0 };
    const entityEligible = activeRecords.filter((memory) =>
      memory.assertedBy === "user" &&
      (
        memory.source === "manual" ||
        memory.source === "user-assertion" ||
        memory.source.startsWith("correction:")
      )
    );
    let entityCandidates = 0;
    let entityRecords = 0;
    let entityReviews = 0;
    for (const memory of entityEligible) {
      const projection = await projectExplicitMemoryEntities({
        memory,
        executionScope: writeAccess.executionScope,
      });
      entityCandidates += projection.extraction.candidates.length;
      entityRecords += projection.createdEntityIds.length +
        projection.linkedEntityIds.length;
      entityReviews += projection.reviewResolutionIds.length;
    }

    return Response.json({
      migration: {
        preview: migration.preview,
        migratedCount: migration.migratedCount,
        activeCount: activeRecords.length,
        reviewCount: migration.reviewCount,
        traceCount: migration.traceCount,
        removedGraphNodeCount: migration.removedGraphNodeCount,
        removedGraphEdgeCount: migration.removedGraphEdgeCount,
      },
      graphProjection,
      entityProjection: {
        eligibleMemoryCount: entityEligible.length,
        candidateCount: entityCandidates,
        linkedOrCreatedCount: entityRecords,
        reviewRequiredCount: entityReviews,
      },
    }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof LegacyMemoryOwnershipConflictError) {
      return Response.json({ error: error.message }, {
        status: 409,
        headers: privateHeaders,
      });
    }
    throw error;
  }
}
