import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseBoundedInteger, parseJsonBody } from "@/lib/http/body";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  memoryClaimFingerprint,
  memoryLifecyclePolicyV1,
  memoryPromotedRecordId,
  memoryPromotionDecisionSchema,
  type MemoryMaintenanceReport,
  type MemoryPromotionReview,
} from "@/lib/memory/lifecycle";
import {
  getMemoryPromotionReview,
  listMemoryPromotionReviews,
  MemoryLifecycleConflictError,
  resolveMemoryPromotionReview,
  runActorMemoryMaintenance,
} from "@/lib/memory/maintenance-store";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { getMemory, listMemories, saveMemory } from "@/lib/memory/store";
import {
  indexUserPrivateMemoryGraphRecords,
  queueMemoryGraphRebuild,
} from "@/lib/memory/graph";
import { projectExplicitMemoryEntities } from "@/lib/entities/extraction";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const runSchema = z.object({ action: z.literal("run") }).strict();
const decisionSchema = z.object({
  action: z.literal("decide_promotion"),
  reviewId: z.string().trim().min(1).max(200),
  decision: memoryPromotionDecisionSchema,
}).strict();
const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory_maintenance",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const requestedStatus = url.searchParams.get("status");
  const status = requestedStatus === "resolved" || requestedStatus === "all"
    ? requestedStatus
    : "pending";
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 100, {
    max: 200,
  });
  const access = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.read,
    auditPurpose: "api.memory.maintenance.read",
    correlationId: `memory_maintenance_read_${randomUUID()}`,
  });
  const [legacy, privateReviews] = await Promise.all([
    listMemoryPromotionReviews({ tenantId: context.tenantId, status, limit }),
    access
      ? listMemoryPromotionReviews({
          tenantId: context.tenantId,
          status,
          limit,
          accessScope: access.databaseAccessScope,
        })
      : Promise.resolve([]),
  ]);
  return Response.json({
    policy: memoryLifecyclePolicyV1,
    reviews: mergeReviews(legacy, privateReviews, limit).map(publicReview),
  }, { headers: privateNoStoreHeaders });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = runSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid memory maintenance request",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "memory_maintenance",
      metadata: { policyVersion: memoryLifecyclePolicyV1.version },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const correlationId = requestCorrelationId(request, "memory_maintenance");
  const readAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.read,
    auditPurpose: "api.memory.maintenance.source.read",
    correlationId,
  });
  const maintenanceAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.maintenance,
    auditPurpose: "api.memory.maintenance.run",
    correlationId,
  });
  const [legacyRecords, privateRecords] = await Promise.all([
    listMemories({
      tenantId: context.tenantId,
      includeInactive: true,
      limit: 5_000,
    }),
    readAccess
      ? listMemories({
          tenantId: context.tenantId,
          includeInactive: true,
          limit: 5_000,
          accessScope: readAccess.databaseAccessScope,
        })
      : Promise.resolve([]),
  ]);
  const results = [];
  if (legacyRecords.length) {
    results.push(await runActorMemoryMaintenance(legacyRecords, {
      tenantId: context.tenantId,
      executionScope: executionScopeFromSecurityContext(context, {
        correlationId,
        purpose: "api.memory.maintenance.run",
      }),
    }));
  }
  if (privateRecords.length && maintenanceAccess) {
    results.push(await runActorMemoryMaintenance(privateRecords, {
      tenantId: context.tenantId,
      accessScope: maintenanceAccess.databaseAccessScope,
      executionScope: maintenanceAccess.executionScope,
    }));
  }
  return Response.json({
    report: combineReports(results.map((result) => result.report)),
    reviews: results.flatMap((result) => result.reviews).map(publicReview),
  }, { headers: privateNoStoreHeaders });
}

async function PATCHHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid memory promotion decision",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "memory_promotion_review",
      resourceId: parsed.data.reviewId,
      metadata: { decision: parsed.data.decision },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const correlationId = requestCorrelationId(request, "memory_promotion");
  const readAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.read,
    auditPurpose: "api.memory.promotion.read",
    correlationId,
  });
  const maintenanceAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.maintenance,
    auditPurpose: "api.memory.promotion.review",
    correlationId,
  });
  let review = readAccess
    ? await getMemoryPromotionReview(parsed.data.reviewId, {
        tenantId: context.tenantId,
        accessScope: readAccess.databaseAccessScope,
      })
    : null;
  let privateReview = Boolean(review);
  if (!review) {
    review = await getMemoryPromotionReview(parsed.data.reviewId, {
      tenantId: context.tenantId,
    });
    privateReview = false;
  }
  if (!review) {
    return Response.json({ error: "Memory promotion review not found." }, {
      status: 404,
      headers: privateNoStoreHeaders,
    });
  }
  if (review.status === "resolved" && review.decision !== parsed.data.decision) {
    return Response.json({
      error: "This promotion review already has a different decision.",
    }, { status: 409, headers: privateNoStoreHeaders });
  }

  let promotedMemory;
  let privateWriteAccess: ReturnType<
    typeof requestMemoryAccessFromSecurityContext
  >;
  if (parsed.data.decision === "promote") {
    const canonical = privateReview && readAccess
      ? await getMemory(review.canonicalMemoryId, {
          tenantId: context.tenantId,
          accessScope: readAccess.databaseAccessScope,
        })
      : await getMemory(review.canonicalMemoryId, {
          tenantId: context.tenantId,
        });
    if (
      !canonical ||
      canonical.claimStatus !== "active" ||
      memoryClaimFingerprint(canonical) !== review.sourceClaimSha256
    ) {
      return Response.json({
        error: "Promotion source lineage is no longer valid.",
      }, { status: 409, headers: privateNoStoreHeaders });
    }
    const writeAccess = privateReview
      ? requestMemoryAccessFromSecurityContext(context, {
          purposeId: MEMORY_PURPOSE_IDS.write,
          auditPurpose: "api.memory.promotion.create",
          correlationId,
        })
      : undefined;
    privateWriteAccess = writeAccess;
    if (privateReview && (!writeAccess || !canonical.accessBinding)) {
      return Response.json({ error: "Private promotion scope is unavailable." }, {
        status: 409,
        headers: privateNoStoreHeaders,
      });
    }
    const promotedAt = new Date().toISOString();
    promotedMemory = await saveMemory({
      id: memoryPromotedRecordId(review.id),
      tenantId: context.tenantId,
      type: "procedure",
      tier: "procedural",
      formationReason: "maintenance_promotion",
      title: canonical.title,
      content: canonical.content,
      tags: canonical.tags,
      scope: canonical.scope,
      source: `memory-promotion:${review.id}`,
      importance: Math.max(0.8, canonical.importance),
      confidence: Math.min(1, (canonical.confidence ?? 0.8) + 0.05),
      claimStatus: "active",
      assertedBy: "user",
      evidenceRefs: review.sourceMemoryIds.map((id) => `memory:${id}`),
      promotedFromTier: "episodic",
      promotedAt,
      embedding: canonical.embedding,
      accessBinding: canonical.accessBinding,
      databaseAccessScope: writeAccess?.databaseAccessScope,
      executionScope: writeAccess?.executionScope ||
        executionScopeFromSecurityContext(context, {
          correlationId,
          purpose: "api.memory.promotion.create",
        }),
    });
    if (
      promotedMemory.formationReason !== "maintenance_promotion" ||
      promotedMemory.promotedFromTier !== "episodic" ||
      promotedMemory.source !== `memory-promotion:${review.id}`
    ) {
      throw new MemoryLifecycleConflictError(
        "The promoted memory id is already bound to different content.",
      );
    }
  }

  try {
    const resolved = await resolveMemoryPromotionReview(
      review.id,
      parsed.data.decision,
      promotedMemory?.id,
      {
        tenantId: context.tenantId,
        accessScope: privateReview
          ? maintenanceAccess?.databaseAccessScope
          : undefined,
        executionScope: privateReview && maintenanceAccess
          ? maintenanceAccess.executionScope
          : executionScopeFromSecurityContext(context, {
              correlationId,
              purpose: "api.memory.promotion.review",
            }),
      },
    );
    if (!resolved) {
      return Response.json({ error: "Memory promotion review not found." }, {
        status: 404,
        headers: privateNoStoreHeaders,
      });
    }
    if (promotedMemory) {
      if (privateReview && privateWriteAccess) {
        await indexUserPrivateMemoryGraphRecords(
          [promotedMemory],
          "memory.maintenance.promotion",
          {
            tenantId: context.tenantId,
            accessScope: privateWriteAccess.databaseAccessScope,
          },
        );
        await projectExplicitMemoryEntities({
          memory: promotedMemory,
          executionScope: privateWriteAccess.executionScope ||
            executionScopeFromSecurityContext(context, {
              correlationId,
              purpose: "api.memory.promotion.entities",
            }),
        });
      } else {
        await queueMemoryGraphRebuild({ tenantId: context.tenantId });
      }
    }
    return Response.json({
      review: publicReview(resolved),
      promotedMemory: promotedMemory ? publicMemory(promotedMemory) : null,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    if (error instanceof MemoryLifecycleConflictError) {
      return Response.json({ error: error.message }, {
        status: 409,
        headers: privateNoStoreHeaders,
      });
    }
    throw error;
  }
}

function mergeReviews(
  legacy: MemoryPromotionReview[],
  privateReviews: MemoryPromotionReview[],
  limit: number,
) {
  return [...new Map(
    [...legacy, ...privateReviews].map((review) => [review.id, review] as const),
  ).values()]
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "pending" ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, limit);
}

function combineReports(reports: MemoryMaintenanceReport[]): MemoryMaintenanceReport {
  const sum = (field: keyof MemoryMaintenanceReport) => reports.reduce(
    (total, report) => total + Number(report[field]),
    0,
  );
  const eligible = sum("eligible");
  const archived = sum("autoArchivedDuplicates");
  const afterPopulation = Math.max(0, eligible - archived);
  const beforeDuplicates = reports.reduce((total, report) =>
    total + Math.round(report.duplicateRateBefore * report.eligible), 0);
  const afterDuplicates = reports.reduce((total, report) =>
    total + Math.round(
      report.duplicateRateAfter *
        Math.max(0, report.eligible - report.autoArchivedDuplicates),
    ), 0);
  return {
    policyVersion: 1,
    scanned: sum("scanned"),
    eligible,
    exactDuplicateGroups: sum("exactDuplicateGroups"),
    autoArchivedDuplicates: archived,
    pinnedDuplicateConflicts: sum("pinnedDuplicateConflicts"),
    promotionReviewsCreated: sum("promotionReviewsCreated"),
    expiredArchived: sum("expiredArchived"),
    duplicateRateBefore: eligible
      ? Number((beforeDuplicates / eligible).toFixed(6))
      : 0,
    duplicateRateAfter: afterPopulation
      ? Number((afterDuplicates / afterPopulation).toFixed(6))
      : 0,
    duplicateRateTarget: 0.01,
  };
}

function publicReview(review: MemoryPromotionReview) {
  const { ownerActorId: _ownerActorId, ...result } = review;
  void _ownerActorId;
  return result;
}

function publicMemory<T extends { embedding?: number[] }>(memory: T) {
  const result = { ...memory };
  delete result.embedding;
  return result;
}

function requestCorrelationId(request: Request, prefix: string) {
  return request.headers.get("x-idempotency-key")?.trim().slice(0, 200) ||
    request.headers.get("x-request-id")?.trim().slice(0, 200) ||
    `${prefix}_${randomUUID()}`;
}
