import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { requestEntityAccessFromSecurityContext } from "@/lib/entities/request-access";
import { readEntityRegistry } from "@/lib/entities/store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { projectReadableMemoryOverview } from "@/lib/memory/readable-overview";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import {
  listAttributedMemoryDeletionReceipts,
  listMemories,
  listMemoryReconciliationReviews,
} from "@/lib/memory/store";
import { listRetrievalTraces } from "@/lib/rag/context-engine";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";

export const readableMemoryServiceInputSchema = z.object({
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

export async function showReadableMemoryService(
  caller: AppServiceCaller,
  input: z.input<typeof readableMemoryServiceInputSchema>,
) {
  const value = readableMemoryServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.memory.readable.show"),
  );
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(
    caller.context,
  );
  const correlationId = caller.executionScope?.correlationId ||
    `readable_memory_${randomUUID()}`;
  const memoryAccess = requestMemoryAccessFromSecurityContext(caller.context, {
    purposeId: MEMORY_PURPOSE_IDS.read,
    auditPurpose: "app.memory.readable.show",
    correlationId,
  });
  const entityAccess = requestEntityAccessFromSecurityContext(caller.context, {
    purposeId: "entity.read.v1",
    correlationId,
  });

  const [legacyMemories, privateMemories, legacyReviews, privateReviews] =
    await Promise.all([
      listMemories({
        tenantId: caller.context.tenantId,
        includeInactive: true,
        limit: value.limit,
      }),
      memoryAccess
        ? listMemories({
            tenantId: caller.context.tenantId,
            includeInactive: true,
            limit: value.limit,
            accessScope: memoryAccess.databaseAccessScope,
          })
        : Promise.resolve([]),
      listMemoryReconciliationReviews({
        tenantId: caller.context.tenantId,
        status: "all",
        limit: value.limit,
      }),
      memoryAccess
        ? listMemoryReconciliationReviews({
            tenantId: caller.context.tenantId,
            status: "all",
            limit: value.limit,
            accessScope: memoryAccess.databaseAccessScope,
          })
        : Promise.resolve([]),
    ]);
  const [traces, deletionReceipts, registry] = await Promise.all([
    listRetrievalTraces(value.limit, {
      tenantId: caller.context.tenantId,
      accessScope: memoryAccess?.databaseAccessScope,
    }),
    listAttributedMemoryDeletionReceipts({
      tenantId: caller.context.tenantId,
      initiatingActorIds: actorBinding?.readableOwnerActorIds || [
        caller.context.actorId,
      ],
      limit: value.limit,
    }),
    entityAccess
      ? readEntityRegistry(entityAccess).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  const memories = mergeById(legacyMemories, privateMemories, value.limit);
  const reviews = mergeById(legacyReviews, privateReviews, value.limit);
  const overview = projectReadableMemoryOverview({
    memories,
    reviews,
    traces,
    deletionReceipts,
    entityCounts: registry ? {
      people: registry.entities.filter((entity) =>
        entity.entityTypeId === "person"
      ).length,
      projects: registry.entities.filter((entity) =>
        entity.entityTypeId === "project"
      ).length,
    } : undefined,
    limit: value.limit,
  });
  return completeAppServiceCall(authorized, { overview }, {
    resourceCount: overview.claims.length,
  });
}

function mergeById<T extends { id: string }>(
  legacy: readonly T[],
  scoped: readonly T[],
  limit: number,
) {
  return [...new Map(
    [...legacy, ...scoped].map((item) => [item.id, item] as const),
  ).values()].slice(0, limit);
}
