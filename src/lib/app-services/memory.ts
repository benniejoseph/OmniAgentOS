import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import type { DatabaseMemoryAccessScope } from "@/lib/db/memory-access-scope";
import { projectExplicitMemoryEntities } from "@/lib/entities/extraction";
import { retireEntityMemoryLineage } from "@/lib/entities/store";
import {
  buildUserPrivateMemoryAccessBindingV1,
  MEMORY_PURPOSE_IDS,
} from "@/lib/memory/access-binding";
import {
  publicMemoryDeletionReceiptV1,
  type MemoryDeletionReceiptV1,
} from "@/lib/memory/deletion-receipt";
import {
  indexMemoryGraphRecords,
  indexUserPrivateMemoryGraphRecords,
  queueMemoryGraphRebuild,
} from "@/lib/memory/graph";
import {
  memoryLifecycleActionSchema,
  memoryLifecyclePolicyV1,
  memoryRetrievalPriorityMultiplier,
} from "@/lib/memory/lifecycle";
import {
  MemoryLifecycleConflictError,
  setMemoryLifecycle,
} from "@/lib/memory/maintenance-store";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import {
  correctMemory,
  forgetMemoryWithReceipt,
  getMemory,
  getMemoryDeletionReceipt,
  listMemories,
  listThreadMemories,
  previewMemoryDeletion,
  saveMemory,
  saveMemoryWithCommitStatus,
  searchMemories,
} from "@/lib/memory/store";
import {
  memoryFormationReasonLabel,
  memoryTierPolicy,
  resolveMemoryTier,
} from "@/lib/memory/tier-policy";
import type { MemoryRecord, MemoryType } from "@/lib/memory/types";
import { embedTexts } from "@/lib/openai/client";
import { rerankRetrievalCandidates } from "@/lib/rag/learned-reranker";
import { embedRetrievalTexts } from "@/lib/rag/retrieval-embedding";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import { deriveExecutionScope } from "@/lib/security/execution-scope";
import { getOwnedThread } from "@/lib/threads/store";
import type { AiUsageScope } from "@/lib/usage/types";

export const memoryListServiceInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  threadId: z.string().trim().min(1).max(200).optional(),
}).strict();

export const memorySearchServiceInputSchema = z.object({
  query: z.string().trim().min(1).max(4_000),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();

export const memoryIdServiceInputSchema = z.object({
  id: z.string().trim().min(1).max(200),
}).strict();

export const memoryWriteServiceInputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  content: z.string().min(1).max(200_000),
  type: z.enum([
    "preference",
    "fact",
    "episode",
    "procedure",
    "knowledge",
    "decision",
    "task",
  ]).optional(),
  tier: z.enum([
    "working",
    "episodic",
    "semantic",
    "procedural",
    "preference",
    "decision",
    "commitment",
    "summary",
  ]).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
}).strict();

export const memoryCorrectionServiceBodySchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  content: z.string().min(1).max(200_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  validTo: z.string().datetime().optional(),
  contradiction: z.boolean().optional(),
}).strict().refine(
  (correction) => Object.values(correction).some(
    (value) => value !== undefined,
  ),
  { message: "At least one correction field is required." },
);

export const memoryCorrectServiceInputSchema = z.object({
  id: z.string().trim().min(1).max(200),
  correction: memoryCorrectionServiceBodySchema,
}).strict();

export const memoryLifecycleServiceInputSchema = z.object({
  id: z.string().trim().min(1).max(200),
  action: memoryLifecycleActionSchema,
}).strict();

export const memoryForgetServiceInputSchema = z.object({
  id: z.string().trim().min(1).max(200),
  expectedReceiptManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

type MemoryServiceOptions = Readonly<{
  abortSignal?: AbortSignal;
  usageScope?: AiUsageScope;
}>;

type MemoryWriteServiceOptions = MemoryServiceOptions & Readonly<{
  storageProfile?: "user_private" | "governed_effect";
  effectTargetId?: string;
}>;

export class AppServiceEffectReceiptFinalizationError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "The application effect may have completed, but its receipt could not be finalized.",
      options,
    );
    this.name = "AppServiceEffectReceiptFinalizationError";
  }
}

export async function listMemoryService(
  caller: AppServiceCaller,
  input: z.input<typeof memoryListServiceInputSchema>,
) {
  const value = memoryListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("memory.list"),
  );
  const access = memoryAccess(caller, MEMORY_PURPOSE_IDS.read, "app.memory.list");
  if (value.threadId) {
    const thread = await getOwnedThread(value.threadId, {
      tenantId: caller.context.tenantId,
      actorId: caller.context.actorId,
      requestActorBinding:
        canonicalRequestActorBindingFromSecurityContext(caller.context),
    });
    if (!thread) {
      return completeAppServiceCall(authorized, {
        memories: [],
        threadFound: false,
      }, { resourceCount: 0 });
    }
    const [legacy, scoped] = await Promise.all([
      listThreadMemories(thread.id, {
        tenantId: caller.context.tenantId,
        limit: value.limit,
      }),
      access
        ? listThreadMemories(thread.id, {
            tenantId: caller.context.tenantId,
            limit: value.limit,
            accessScope: access.databaseAccessScope,
          })
        : Promise.resolve([]),
    ]);
    const memories = mergeMemoryRecords(legacy, scoped, value.limit)
      .map(publicMemoryServiceRecord);
    return completeAppServiceCall(authorized, {
      memories,
      threadFound: true,
    }, { resourceCount: memories.length });
  }
  const [legacy, scoped] = await Promise.all([
    listMemories({
      tenantId: caller.context.tenantId,
      includeInactive: true,
      limit: value.limit,
    }),
    access
      ? listMemories({
          tenantId: caller.context.tenantId,
          includeInactive: true,
          limit: value.limit,
          accessScope: access.databaseAccessScope,
        })
      : Promise.resolve([]),
  ]);
  const memories = mergeMemoryRecords(legacy, scoped, value.limit)
    .map(publicMemoryServiceRecord);
  return completeAppServiceCall(authorized, { memories }, {
    resourceCount: memories.length,
  });
}

export async function searchMemoryService(
  caller: AppServiceCaller,
  input: z.input<typeof memorySearchServiceInputSchema>,
  options: MemoryServiceOptions = {},
) {
  const value = memorySearchServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("memory.search"),
  );
  const safeQuery = String(redactSensitive(value.query));
  const embeddingResult = await embedRetrievalTexts([safeQuery], {
    abortSignal: options.abortSignal,
    usageScope: options.usageScope || defaultUsageScope(
      caller,
      "embedding",
      "app.memory.search",
    ),
  });
  const access = memoryAccess(
    caller,
    MEMORY_PURPOSE_IDS.retrieve,
    "app.memory.search",
  );
  const searchOptions = {
    limit: value.limit,
    queryEmbedding: embeddingResult.vectors[0],
    queryEmbeddingSpaceId: embeddingResult.receipt.spaceId,
    tenantId: caller.context.tenantId,
  };
  const [legacy, scoped] = await Promise.all([
    searchMemories(safeQuery, searchOptions),
    access
      ? searchMemories(safeQuery, {
          ...searchOptions,
          accessScope: access.databaseAccessScope,
        })
      : Promise.resolve([]),
  ]);
  const merged = mergeMemorySearchResults(legacy, scoped, value.limit);
  const reranked = rerankRetrievalCandidates(
    safeQuery,
    merged.map((result) => ({
      value: result,
      text: `${result.record.title}\n${result.record.content}`,
      baseScore: result.score,
      freshnessScore: 0,
    })),
  );
  const results = reranked.results.map(({ value: result, score }) => ({
    score,
    baseScore: result.score,
    reasons: result.reasons,
    record: publicMemoryServiceRecord(result.record),
  }));
  return completeAppServiceCall(authorized, {
    results,
    retrieval: {
      embedding: embeddingResult.receipt,
      reranker: reranked.receipt,
    },
  }, { resourceCount: results.length });
}

export async function inspectMemoryService(
  caller: AppServiceCaller,
  input: z.input<typeof memoryIdServiceInputSchema>,
) {
  const value = memoryIdServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("memory.inspect"),
  );
  const access = memoryAccess(caller, MEMORY_PURPOSE_IDS.read, "app.memory.inspect");
  const memory = await getReadableMemory(caller, value.id, access?.databaseAccessScope);
  return completeAppServiceCall(authorized, {
    memory: memory ? publicMemoryServiceRecord(memory) : null,
    operationReceipt: memory
      ? {
          operation: "inspect" as const,
          memoryId: memory.id,
          scope: publicMemoryScope(memory),
          claimStatus: memory.claimStatus || "active",
          retrievalEligible:
            (memory.claimStatus || "active") === "active" &&
            !memory.archivedAt,
        }
      : null,
  }, { resourceCount: memory ? 1 : 0 });
}

export async function previewMemoryForgetService(
  caller: AppServiceCaller,
  input: z.input<typeof memoryIdServiceInputSchema>,
) {
  const value = memoryIdServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("memory.forget.preview"),
  );
  const access = memoryAccess(
    caller,
    MEMORY_PURPOSE_IDS.forget,
    "app.memory.forget.preview",
  );
  const scoped = access
    ? await previewMemoryDeletion(value.id, {
        tenantId: caller.context.tenantId,
        accessScope: access.databaseAccessScope,
      })
    : null;
  const preview = scoped || await previewMemoryDeletion(value.id, {
    tenantId: caller.context.tenantId,
  });
  return completeAppServiceCall(authorized, {
    preview,
    operationReceipt: preview
      ? {
          operation: "forget_preview" as const,
          memoryId: preview.memory.id,
          expectedReceiptManifestSha256:
            preview.expectedReceiptManifestSha256,
          state: preview.state,
          guarantee: preview.guarantee,
          irreversible: true as const,
        }
      : null,
  }, { resourceCount: preview ? 1 : 0 });
}

export async function writeMemoryService(
  caller: AppServiceCaller,
  input: z.input<typeof memoryWriteServiceInputSchema>,
  options: MemoryWriteServiceOptions = {},
) {
  const value = redactSensitive(
    memoryWriteServiceInputSchema.parse(input),
  ) as z.output<typeof memoryWriteServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("memory.write"),
  );
  const embedding = (await embedTexts(
    [`${value.title}\n\n${value.content}`],
    options.abortSignal,
    options.usageScope || defaultUsageScope(
      caller,
      "embedding",
      "app.memory.write",
    ),
  ))?.[0];
  const governedEffect = options.storageProfile === "governed_effect";
  const access = governedEffect
    ? undefined
    : memoryAccess(caller, MEMORY_PURPOSE_IDS.write, "app.memory.write");
  const accessBinding = access
    ? buildUserPrivateMemoryAccessBindingV1({
        tenantId: caller.context.tenantId,
        ownerActorId: access.actorBinding.canonicalActorId,
        originPurpose: "app.memory.write",
      })
    : undefined;
  const memoryInput: Parameters<typeof saveMemory>[0] = {
    ...value,
    id: options.effectTargetId,
    tenantId: caller.context.tenantId,
    type: value.type as MemoryType | undefined,
    tags: value.tags || (governedEffect ? ["tool-execution"] : undefined),
    importance: value.importance ?? (governedEffect ? 0.5 : undefined),
    source: governedEffect ? "tool-executor" : "manual",
    scope: accessBinding ? "user" : "workspace",
    assertedBy: governedEffect ? "system" : "user",
    embedding,
    accessBinding,
    databaseAccessScope: access?.databaseAccessScope,
    executionScope: access?.executionScope || caller.executionScope,
  };
  const committed = options.effectTargetId
    ? await saveMemoryWithCommitStatus(memoryInput)
    : { record: await saveMemory(memoryInput), inserted: undefined };
  const record = committed.record;
  let entityProjection:
    | {
        candidateCount: number;
        createdCount: number;
        linkedCount: number;
        reviewRequiredCount: number;
      }
    | undefined;
  if (record.accessBinding && access) {
    await indexUserPrivateMemoryGraphRecords([record], "memory.manual", {
      tenantId: caller.context.tenantId,
      accessScope: access.databaseAccessScope,
    });
    const projected = await projectExplicitMemoryEntities({
      memory: record,
      executionScope: access.executionScope,
    });
    entityProjection = {
      candidateCount: projected.extraction.candidates.length,
      createdCount: projected.createdEntityIds.length,
      linkedCount: projected.linkedEntityIds.length,
      reviewRequiredCount: projected.reviewResolutionIds.length,
    };
  } else if (!record.accessBinding && !governedEffect) {
    await indexMemoryGraphRecords([record], "memory.manual");
  }
  const data = {
    record: publicMemoryServiceRecord(record),
    entityProjection,
    ...(committed.inserted === undefined
      ? {}
      : { __effectCommitInserted: committed.inserted }),
  };
  return completeAppServiceCall(authorized, data);
}

export async function correctMemoryService(
  caller: AppServiceCaller,
  input: z.input<typeof memoryCorrectServiceInputSchema>,
  options: MemoryServiceOptions & { projectionSource?: "manual" | "tool" } = {},
) {
  const { id, correction } = redactSensitive(
    memoryCorrectServiceInputSchema.parse(input),
  ) as z.output<typeof memoryCorrectServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("memory.correct"),
  );
  const readAccess = memoryAccess(caller, MEMORY_PURPOSE_IDS.read, "app.memory.correct.read");
  const correctionAccess = memoryAccess(caller, MEMORY_PURPOSE_IDS.correct, "app.memory.correct");
  const scopedExisting = readAccess
    ? await getMemory(id, {
        tenantId: caller.context.tenantId,
        accessScope: readAccess.databaseAccessScope,
      })
    : null;
  const existing = scopedExisting || await getMemory(id, {
    tenantId: caller.context.tenantId,
  });
  if (!existing || existing.claimStatus === "forgotten") {
    return completeAppServiceCall(authorized, { correction: null }, {
      resourceCount: 0,
    });
  }
  if (scopedExisting && !correctionAccess) {
    throw new Error("Private memory correction scope is unavailable.");
  }
  const embedding = (await embedTexts(
    [
      `${correction.title ?? existing.title}\n\n${
        correction.content ?? existing.content
      }`,
    ],
    options.abortSignal,
    options.usageScope || defaultUsageScope(
      caller,
      "embedding",
      "app.memory.correct",
    ),
  ))?.[0] || existing.embedding;
  const result = await correctMemory(id, { ...correction, embedding }, {
    tenantId: caller.context.tenantId,
    actorId: scopedExisting
      ? correctionAccess?.actorBinding.canonicalActorId
      : caller.context.actorId,
    accessScope: scopedExisting
      ? correctionAccess?.databaseAccessScope
      : undefined,
    executionScope: scopedExisting
      ? correctionAccess?.executionScope
      : caller.executionScope,
  });
  if (!result) {
    return completeAppServiceCall(authorized, { correction: null }, {
      resourceCount: 0,
    });
  }
  if (result.review?.status === "pending") {
    // Contradiction candidates cannot enter recall before a review decision.
  } else if (result.corrected.accessBinding && correctionAccess) {
    await indexUserPrivateMemoryGraphRecords(
      [result.corrected],
      options.projectionSource === "tool"
        ? "memory.tool.correct"
        : "memory.manual.correct",
      {
        tenantId: caller.context.tenantId,
        accessScope: correctionAccess.databaseAccessScope,
      },
    );
    await projectExplicitMemoryEntities({
      memory: result.corrected,
      executionScope: correctionAccess.executionScope,
    });
    await retireEntityMemoryLineage({
      tenantId: caller.context.tenantId,
      ownerActorId: correctionAccess.actorBinding.canonicalActorId,
      memoryIds: [result.previous.id],
      executionScope: deriveExecutionScope(correctionAccess.executionScope, {
        purpose: "memory.correct.v1",
      }),
    });
  } else if (!result.corrected.accessBinding) {
    await queueMemoryGraphRebuild({ tenantId: caller.context.tenantId });
  }
  return completeAppServiceCall(authorized, {
    correction: {
      previous: publicMemoryServiceRecord(result.previous),
      corrected: publicMemoryServiceRecord(result.corrected),
      ...(result.review
        ? { review: publicMemoryReconciliationReview(result.review) }
        : {}),
    },
    operationReceipt: {
      operation: correction.contradiction
        ? "propose_contradiction" as const
        : "correct" as const,
      previousMemoryId: result.previous.id,
      correctedMemoryId: result.corrected.id,
      previousClaimStatus: result.previous.claimStatus,
      reviewRequired: result.review?.status === "pending",
    },
  }, { resourceCount: 2 });
}

export async function updateMemoryLifecycleService(
  caller: AppServiceCaller,
  input: z.input<typeof memoryLifecycleServiceInputSchema>,
) {
  const value = memoryLifecycleServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("memory.lifecycle"),
  );
  const readAccess = memoryAccess(caller, MEMORY_PURPOSE_IDS.read, "app.memory.lifecycle.read");
  const maintenanceAccess = memoryAccess(
    caller,
    MEMORY_PURPOSE_IDS.maintenance,
    "app.memory.lifecycle.update",
  );
  const scopedMemory = readAccess
    ? await getMemory(value.id, {
        tenantId: caller.context.tenantId,
        accessScope: readAccess.databaseAccessScope,
      })
    : null;
  const memory = scopedMemory || await getMemory(value.id, {
    tenantId: caller.context.tenantId,
  });
  if (!memory) {
    return completeAppServiceCall(authorized, { lifecycle: null, memory: null }, {
      resourceCount: 0,
    });
  }
  if (scopedMemory && !maintenanceAccess) {
    throw new Error("Private memory maintenance scope is unavailable.");
  }
  try {
    const lifecycle = await setMemoryLifecycle(memory, value.action, {
      tenantId: caller.context.tenantId,
      accessScope: scopedMemory
        ? maintenanceAccess?.databaseAccessScope
        : undefined,
      executionScope: scopedMemory
        ? maintenanceAccess!.executionScope
        : caller.executionScope!,
    });
    if (!lifecycle) {
      return completeAppServiceCall(authorized, {
        lifecycle: null,
        memory: null,
      }, { resourceCount: 0 });
    }
    const refreshed = scopedMemory && readAccess
      ? await getMemory(value.id, {
          tenantId: caller.context.tenantId,
          accessScope: readAccess.databaseAccessScope,
        })
      : await getMemory(value.id, { tenantId: caller.context.tenantId });
    return completeAppServiceCall(authorized, {
      lifecycle,
      memory: refreshed ? publicMemoryServiceRecord(refreshed) : null,
      operationReceipt: {
        operation: `lifecycle_${value.action}`,
        memoryId: value.id,
        action: value.action,
        historicalTruthChanged: false,
        permanentDeletion: false,
      },
    });
  } catch (error) {
    if (error instanceof MemoryLifecycleConflictError) {
      throw new Error(error.message);
    }
    throw error;
  }
}

export async function forgetMemoryService(
  caller: AppServiceCaller,
  input: z.input<typeof memoryForgetServiceInputSchema>,
) {
  const value = memoryForgetServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("memory.forget"),
  );
  const access = memoryAccess(caller, MEMORY_PURPOSE_IDS.forget, "app.memory.forget");
  let result: Awaited<ReturnType<typeof forgetMemoryWithReceipt>>;
  try {
    const scoped = access
      ? await forgetMemoryWithReceipt(value.id, {
          tenantId: caller.context.tenantId,
          expectedDescendantManifestSha256:
            value.expectedReceiptManifestSha256,
          executionScope: access.executionScope,
          accessScope: access.databaseAccessScope,
        })
      : null;
    result = scoped || await forgetMemoryWithReceipt(value.id, {
      tenantId: caller.context.tenantId,
      expectedDescendantManifestSha256:
        value.expectedReceiptManifestSha256,
      executionScope: caller.executionScope!,
    });
  } catch (error) {
    let committedReceipt: MemoryDeletionReceiptV1 | null;
    try {
      committedReceipt = await getMemoryDeletionReceipt(value.id, {
        tenantId: caller.context.tenantId,
        accessScope: access?.databaseAccessScope,
      });
    } catch (receiptLookupError) {
      throw new AppServiceEffectReceiptFinalizationError({
        cause: receiptLookupError,
      });
    }
    if (committedReceipt) {
      throw new AppServiceEffectReceiptFinalizationError({ cause: error });
    }
    throw error;
  }
  if (!result) {
    return completeAppServiceCall(authorized, { forgotten: null }, {
      resourceCount: 0,
    });
  }
  return completeAppServiceCall(authorized, {
    forgotten: {
      id: value.id,
      record: publicMemoryServiceRecord(result.memory),
      deletionGuarantee: result.deletionGuarantee,
      deletionDisposition: result.deletionDisposition,
      deletionReceipt: result.receipt
        ? publicMemoryDeletionReceiptV1(result.receipt)
        : null,
      invalidatedAgentRunCount: result.invalidatedAgentRunCount,
      invalidatedWorkflowRunCount: result.invalidatedWorkflowRunCount,
      invalidatedDailyBriefCount: result.invalidatedDailyBriefCount,
      affectedEntityCount: result.affectedEntityCount,
      retiredEntityCount: result.retiredEntityCount,
      retiredEntityAliasCount: result.retiredEntityAliasCount,
    },
    operationReceipt: {
      operation: "forget" as const,
      memoryId: value.id,
      expectedReceiptManifestSha256: value.expectedReceiptManifestSha256,
      deletionDisposition: result.deletionDisposition,
      deletionReceiptSha256: result.receipt?.receiptSha256 || null,
      irreversible: true as const,
    },
  });
}

export function prepareMemoryExportService(caller: AppServiceCaller) {
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("memory.export"),
  );
  if (!memoryAccess(caller, MEMORY_PURPOSE_IDS.export, "app.memory.export")) {
    throw new Error("Portable export requires an authenticated user session.");
  }
  return completeAppServiceCall(authorized, {
    ready: true,
    downloadUrl: "/api/data/export",
    archiveFormat: "asael-portable-archive",
    archiveVersion: 2,
    includes: [
      "knowledge",
      "memories",
      "threads",
      "today",
      "projects",
      "connections_reauthorization_metadata",
      "skills",
      "agents",
    ],
    excludes: [
      "credentials",
      "secrets",
      "embeddings",
      "provider_cursors",
      "operational_audit_content",
      "original_assets",
    ],
    operationReceipt: {
      operation: "prepare_portable_export",
      scope: "exact_owner",
      contentCopiedIntoAgentTranscript: false,
      encryptedAssetExportRequiresSettings: true,
    },
  });
}

/** Internal governed-effect readback; never registered as an agent operation. */
export function readMemoryEffectRecord(
  id: string,
  tenantId: string,
) {
  return getMemory(id, { tenantId });
}

/** Internal governed-effect reconciliation; never registered as an agent operation. */
export async function readMemoryDeletionReconciliation(input: {
  caller: AppServiceCaller;
  id: string;
}) {
  const access = memoryAccess(
    input.caller,
    MEMORY_PURPOSE_IDS.forget,
    "app.memory.forget.reconcile",
  );
  const options = {
    tenantId: input.caller.context.tenantId,
    accessScope: access?.databaseAccessScope,
  };
  const receipt = await getMemoryDeletionReceipt(input.id, options);
  if (!receipt) return { receipt: null, memory: null };
  const memory = await getMemory(input.id, options);
  return { receipt, memory };
}

export function publicMemoryServiceRecord(memory: MemoryRecord) {
  const {
    embedding: _embedding,
    accessBinding: _accessBinding,
    ...record
  } = memory;
  void _embedding;
  void _accessBinding;
  const tier = resolveMemoryTier(memory.tier, memory.type || "fact");
  const policy = memoryTierPolicy(tier);
  const now = Date.now();
  const retentionExpired = Boolean(
    memory.retentionExpiresAt && Date.parse(memory.retentionExpiresAt) <= now,
  );
  const temporallyInvalid = Boolean(
    (memory.validFrom && Date.parse(memory.validFrom) > now) ||
      (memory.validTo && Date.parse(memory.validTo) <= now),
  );
  return {
    ...record,
    tier,
    access: publicMemoryScope(memory),
    tierPolicyVersion: policy.version,
    explainability: {
      why: memoryFormationReasonLabel(
        memory.formationReason || "legacy_record",
      ),
      source: memory.source,
      scope: memory.scope,
      confidence: memory.confidence ?? 0.7,
      lastUsedAt: memory.lastUsedAt || null,
      useCount: memory.useCount || 0,
      validity: memory.archivedAt
        ? "archived"
        : retentionExpired
        ? "retention_expired"
        : temporallyInvalid
          ? "outside_validity_interval"
          : memory.claimStatus || "active",
      validFrom: memory.validFrom || null,
      validTo: memory.validTo || null,
      retentionExpiresAt: memory.retentionExpiresAt || null,
      policy,
      lifecycle: {
        policyVersion: memoryLifecyclePolicyV1.version,
        pinned: Boolean(memory.pinnedAt),
        pinnedAt: memory.pinnedAt || null,
        archived: Boolean(memory.archivedAt),
        archivedAt: memory.archivedAt || null,
        archiveReason: memory.archiveReason || null,
        duplicateOfMemoryId: memory.duplicateOfMemoryId || null,
        retrievalPriorityMultiplier:
          memoryRetrievalPriorityMultiplier(memory),
        historicalTruthChanged: false,
      },
    },
  };
}

function memoryAccess(
  caller: AppServiceCaller,
  purposeId: string,
  auditPurpose: string,
) {
  return requestMemoryAccessFromSecurityContext(caller.context, {
    purposeId,
    auditPurpose,
    correlationId:
      caller.executionScope?.correlationId || caller.idempotencyKey || crypto.randomUUID(),
  });
}

async function getReadableMemory(
  caller: AppServiceCaller,
  id: string,
  accessScope: DatabaseMemoryAccessScope | undefined,
) {
  const scoped = accessScope
    ? await getMemory(id, {
        tenantId: caller.context.tenantId,
        accessScope,
      })
    : null;
  return scoped || getMemory(id, { tenantId: caller.context.tenantId });
}

function publicMemoryScope(memory: MemoryRecord) {
  const binding = memory.accessBinding;
  if (!binding) {
    return {
      visibility: memory.scope === "user"
        ? "user_legacy"
        : memory.scope === "project"
          ? "project_legacy"
          : "workspace_legacy",
      sensitivity: "legacy_unspecified",
      scope: memory.scope,
    };
  }
  return {
    visibility: binding.visibility,
    sensitivity: binding.sensitivity,
    scope: memory.scope,
    owner: binding.visibility === "user_private" ? "current_user" : undefined,
    agentId: binding.ownerAgentId,
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    missionId: binding.missionId,
  };
}

function publicMemoryReconciliationReview(review: NonNullable<
  Awaited<ReturnType<typeof correctMemory>>
>["review"]) {
  if (!review) return undefined;
  const {
    ownerActorId: _ownerActorId,
    resolvedBy: _resolvedBy,
    candidate,
    existing,
    ...publicReview
  } = review;
  void _ownerActorId;
  void _resolvedBy;
  return {
    ...publicReview,
    candidate: publicMemoryServiceRecord(candidate),
    ...(existing ? { existing: publicMemoryServiceRecord(existing) } : {}),
  };
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

function defaultUsageScope(
  caller: AppServiceCaller,
  operation: "embedding",
  purpose: string,
): AiUsageScope {
  const sourceId = caller.idempotencyKey ||
    caller.executionScope?.correlationId || crypto.randomUUID();
  return {
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    sourceStreamId: `app-service:${sourceId}`,
    operation,
    purpose,
    correlationId: caller.executionScope?.correlationId || sourceId,
    causationId: caller.executionScope?.causationId || undefined,
    executionScope: caller.executionScope,
    credentialSource: "deployment_environment",
  };
}
