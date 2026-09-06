import { listStreamEvents } from "@/lib/events/store";
import { indexMemoryGraphRecords } from "@/lib/memory/graph";
import {
  saveMemories,
  type CreateMemoryInput,
} from "@/lib/memory/store";
import type { MemoryRecord } from "@/lib/memory/types";
import type { AgentMode } from "@/lib/orchestration/types";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { getToolExecutionsByIds } from "@/lib/tools/audit-store";
import { parseEffectReceiptV1 } from "@/lib/tools/effect-receipt";
import {
  parseEffectReceiptV2,
  type EffectReceiptV2,
} from "@/lib/tools/effect-receipt-v2";
import type { ToolExecutionRecord } from "@/lib/tools/types";

export type ConsolidationResult = {
  summary: string;
  saved: MemoryRecord[];
  skipped: boolean;
  error?: string;
};

/**
 * Compatibility entry point for the background job. Conversation text is no
 * longer a formation source: only exact, verified run evidence is considered.
 */
export async function consolidateAgentRunMemory({
  tenantId,
  executionScope,
  runId,
  threadId,
  abortSignal,
}: {
  tenantId?: string;
  actorId?: string;
  executionScope?: ExecutionScope;
  runId: string;
  threadId?: string;
  mode: AgentMode;
  prompt: string;
  response: string;
  abortSignal?: AbortSignal;
}) {
  const consolidation = await consolidateRunMemory({
    tenantId,
    executionScope,
    runId,
    threadId,
    abortSignal,
  });
  return {
    episode: consolidation.saved[0],
    consolidation,
  };
}

export async function consolidateRunMemory({
  tenantId,
  executionScope,
  runId,
  threadId,
  abortSignal,
}: {
  tenantId?: string;
  actorId?: string;
  executionScope?: ExecutionScope;
  runId: string;
  threadId?: string;
  mode?: AgentMode;
  prompt?: string;
  response?: string;
  abortSignal?: AbortSignal;
}): Promise<ConsolidationResult> {
  const scopedTenantId = tenantId?.trim();
  if (
    !scopedTenantId ||
    !executionScope?.initiatingActorId ||
    executionScope.tenantId !== scopedTenantId
  ) {
    return {
      summary: "Run scope cannot support evidence-based memory formation.",
      saved: [],
      skipped: true,
    };
  }

  try {
    abortSignal?.throwIfAborted();
    const events = await listStreamEvents(`run:${runId}`, {
      tenantId: scopedTenantId,
      limit: 2_000,
    });
    const executionIds = [...new Set(events.flatMap((event) => {
      if (event.type !== "run.tool") return [];
      const executionId = event.payload.executionId;
      return typeof executionId === "string" && executionId.trim()
        ? [executionId.trim()]
        : [];
    }))];
    const executions = await getToolExecutionsByIds(executionIds, {
      tenantId: scopedTenantId,
    });
    const memoryInputs = executions.flatMap((record) => {
      const formed = verifiedEffectMemoryInput({
        record,
        runId,
        threadId,
        executionScope,
      });
      return formed ? [formed] : [];
    });
    if (!memoryInputs.length) {
      return {
        summary: "No verified effects formed durable memory.",
        saved: [],
        skipped: true,
      };
    }

    abortSignal?.throwIfAborted();
    const saved = await saveMemories(memoryInputs);
    abortSignal?.throwIfAborted();
    await indexMemoryGraphRecords(saved, "memory.verified_effect");
    return {
      summary: `${saved.length} verified effect${saved.length === 1 ? "" : "s"} formed durable memory.`,
      saved,
      skipped: false,
    };
  } catch (error) {
    if (abortSignal?.aborted) throw abortSignal.reason || error;
    return {
      summary: "Evidence-based memory formation failed.",
      saved: [],
      skipped: false,
      error: error instanceof Error ? error.message : "Unknown formation error",
    };
  }
}

export function verifiedEffectMemoryInput(input: {
  record: ToolExecutionRecord;
  runId: string;
  threadId?: string;
  executionScope: ExecutionScope;
}): CreateMemoryInput | undefined {
  const { record, executionScope } = input;
  if (
    record.status !== "executed" ||
    record.dryRun ||
    !record.completedAt ||
    !record.effectReceipt ||
    !record.actorId ||
    record.actorId !== executionScope.initiatingActorId ||
    (record.tenantId || "default") !== executionScope.tenantId
  ) {
    return undefined;
  }
  const receipt = verifiedReceipt(record);
  if (!receipt) return undefined;

  return {
    id: `verified_effect_${sourceContractSha256({
      tenantId: executionScope.tenantId,
      effectReceiptId: receipt.effectReceiptId,
    })}`,
    tenantId: executionScope.tenantId,
    type: "episode",
    title: `Verified effect: ${record.toolName}`,
    content: [
      `Tool: ${record.toolId}`,
      `Verified target type: ${receipt.targetType}`,
      `Target identity hash: ${sourceContractSha256({
        targetType: receipt.targetType,
        targetId: receipt.targetId,
      })}`,
      "Outcome: the committed target exactly matched the expected state.",
    ].join("\n"),
    tags: ["verified-effect", record.toolId],
    scope: "workspace",
    source: "effect-receipt",
    importance: 0.75,
    confidence: 1,
    claimStatus: "active",
    assertedBy: "system",
    evidenceRefs: [
      `run:${input.runId}`,
      ...(input.threadId ? [`thread:${input.threadId}`] : []),
      `tool-execution:${record.id}`,
      `effect-receipt:${receipt.effectReceiptId}`,
    ],
    executionScope,
    formationOrigin: "verified_effect",
  };
}

function verifiedReceipt(record: ToolExecutionRecord) {
  if (record.effectReceipt?.schemaVersion === 1) {
    const receipt = parseEffectReceiptV1(record.effectReceipt, {
      executionId: record.id,
      tenantId: record.tenantId || "default",
      actorId: record.actorId,
      toolId: "memory.write",
    });
    return receipt?.verificationState === "verified" ? receipt : undefined;
  }
  const receipt: EffectReceiptV2 | undefined = parseEffectReceiptV2(
    record.effectReceipt,
    {
      executionId: record.id,
      tenantId: record.tenantId || "default",
      actorId: record.actorId,
      toolId: record.toolId,
    },
  );
  return receipt?.verificationState === "verified" ? receipt : undefined;
}

/**
 * Old callers can still reconcile extracted claims, but agent assertions are
 * quarantined as candidates. They cannot be promoted by this helper.
 */
export function reconcileConsolidatedMemoryClaims(
  inputs: CreateMemoryInput[],
  existing: MemoryRecord[],
): CreateMemoryInput[] {
  return inputs.flatMap((input) => {
    const matching = existing
      .filter((record) =>
        record.claimStatus === "active" && record.type === (input.type || "fact")
      )
      .map((record) => ({
        record,
        similarity: claimIdentitySimilarity(record.title, input.title),
      }))
      .filter((candidate) => candidate.similarity >= 0.65)
      .sort((left, right) => right.similarity - left.similarity)[0]?.record;
    if (
      matching &&
      canonicalClaimContent(matching.content) ===
        canonicalClaimContent(input.content)
    ) {
      return [];
    }
    return [{
      ...input,
      claimStatus: "candidate" as const,
      assertedBy: "agent" as const,
      confidence: Math.min(input.confidence ?? 0.5, 0.5),
      tags: normalizeTags([
        ...(input.tags || []),
        "needs-confirmation",
        ...(matching ? ["possible-contradiction"] : []),
      ]),
      ...(matching
        ? {
            contradictionOfId: matching.id,
            evidenceRefs: [
              ...new Set([
                ...(input.evidenceRefs || []),
                `memory:${matching.id}`,
              ]),
            ],
          }
        : {}),
    }];
  });
}

function claimIdentity(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function claimIdentitySimilarity(left: string, right: string) {
  const leftIdentity = claimIdentity(left);
  const rightIdentity = claimIdentity(right);
  if (!leftIdentity || !rightIdentity) return 0;
  if (leftIdentity === rightIdentity) return 1;
  const leftTokens = new Set(leftIdentity.split(" "));
  const rightTokens = new Set(rightIdentity.split(" "));
  const shared = [...leftTokens].filter((token) =>
    rightTokens.has(token)
  ).length;
  return (2 * shared) / (leftTokens.size + rightTokens.size);
}

function canonicalClaimContent(value: string) {
  return value
    .replace(/^Source (run|request):.*$/gim, "")
    .replace(/^Confidence:.*$/gim, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeTags(tags: string[]) {
  return Array.from(new Set(tags.map((tag) =>
    tag.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-").replace(/^-|-$/g, "")
  ).filter(Boolean))).slice(0, 14);
}
