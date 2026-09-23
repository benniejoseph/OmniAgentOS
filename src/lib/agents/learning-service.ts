import "server-only";

import {
  completeAgentLearningCycle,
  listDueAgentLearningTargets,
  readAgentDailyLearningStatus,
} from "@/lib/agents/learning-store";
import { resolveAgentIdentityForExecution } from "@/lib/agents/identity-store";
import type { AgentDailyLearningStatusV1 } from "@/lib/agents/learning-contracts";
import { hasDatabaseUrl } from "@/lib/db/client";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export type DailyAgentLearningResult = Readonly<{
  available: boolean;
  targets: number;
  completed: number;
  duplicates: number;
  noOpCompletions: number;
  actionableCycles: number;
  observationsRecorded: number;
  actionableEvidenceCount: number;
  failed: number;
  modelInvocations: 0;
  behaviorChanges: 0;
  authorityChanges: 0;
  adaptationActivations: 0;
  results: readonly Readonly<{
    agentId: string;
    definitionVersion: number;
    localDate: string;
    status: "completed" | "duplicate" | "failed";
    outcome?: "actionable_evidence_recorded" | "no_actionable_evidence";
    receiptSha256?: string;
    failureSha256?: string;
  }>[];
}>;

export async function getAgentDailyLearningStatus(input: {
  tenantId: string;
  actorId: string;
  agentId: string;
}): Promise<AgentDailyLearningStatusV1> {
  const identity = await resolveAgentIdentityForExecution({
    tenantId: input.tenantId,
    actorId: input.actorId,
    agentId: input.agentId,
  });
  if (
    identity.definition.tenantId !== input.tenantId ||
    identity.definition.logicalAgentId !== input.agentId ||
    identity.principal.controllerActorId !== identity.definition.ownerActorId ||
    identity.principal.logicalAgentId !== identity.definition.logicalAgentId
  ) {
    throw new Error("Agent learning identity scope could not be verified.");
  }
  return readAgentDailyLearningStatus({
    tenantId: identity.definition.tenantId,
    ownerActorId: identity.definition.ownerActorId,
    agentId: identity.definition.logicalAgentId,
    definitionVersion: identity.definition.definitionVersion,
    definitionSha256: identity.definition.definitionSha256,
  });
}

/**
 * Folds the most recently closed local day into immutable evidence receipts.
 * This service deliberately has no model dependency and no write path into
 * Agent definitions, principals, grants, tools, context, or budgets.
 */
export async function processDailyAgentLearningCyclesForTenant(input: {
  tenantId: string;
  executingPrincipalId: string;
  executingPrincipalType: "user" | "system";
  now?: Date;
  limit?: number;
  abortSignal?: AbortSignal;
}): Promise<DailyAgentLearningResult> {
  if (!hasDatabaseUrl()) return emptyResult(false);
  const now = input.now || new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Daily Agent learning clock is invalid.");
  }
  const recordedAt = now.toISOString();
  const targets = await listDueAgentLearningTargets({
    tenantId: input.tenantId,
    now: recordedAt,
    limit: input.limit,
    systemMaintenance: input.executingPrincipalType === "system",
  });
  const results: Array<DailyAgentLearningResult["results"][number]> = [];
  let completed = 0;
  let duplicates = 0;
  let noOpCompletions = 0;
  let actionableCycles = 0;
  let observationsRecorded = 0;
  let actionableEvidenceCount = 0;
  let failed = 0;

  for (const target of targets) {
    if (input.abortSignal?.aborted) break;
    try {
      const stored = await completeAgentLearningCycle({
        target,
        executingPrincipalType: input.executingPrincipalType,
        executingPrincipalId: input.executingPrincipalId,
        recordedAt,
      });
      if (stored.status === "completed") {
        completed += 1;
        if (stored.cycle.outcome === "no_actionable_evidence") {
          noOpCompletions += 1;
        } else {
          actionableCycles += 1;
        }
        observationsRecorded += stored.cycle.observationCount;
        actionableEvidenceCount += stored.cycle.actionableEvidenceCount;
      } else {
        duplicates += 1;
      }
      results.push(Object.freeze({
        agentId: target.agentId,
        definitionVersion: target.definitionVersion,
        localDate: target.localDate,
        status: stored.status,
        outcome: stored.cycle.outcome,
        receiptSha256: stored.cycle.receiptSha256,
      }));
    } catch (error) {
      failed += 1;
      const failureSha256 = sourceContractSha256({
        agentId: target.agentId,
        definitionVersion: target.definitionVersion,
        definitionSha256: target.definitionSha256,
        localDate: target.localDate,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      results.push(Object.freeze({
        agentId: target.agentId,
        definitionVersion: target.definitionVersion,
        localDate: target.localDate,
        status: "failed",
        failureSha256,
      }));
      console.error(JSON.stringify({
        level: "error",
        msg: "agent_daily_learning_cycle_failed",
        tenantId: input.tenantId,
        agentId: target.agentId,
        definitionVersion: target.definitionVersion,
        localDate: target.localDate,
        failureSha256,
      }));
    }
  }

  return Object.freeze({
    available: true,
    targets: targets.length,
    completed,
    duplicates,
    noOpCompletions,
    actionableCycles,
    observationsRecorded,
    actionableEvidenceCount,
    failed,
    modelInvocations: 0,
    behaviorChanges: 0,
    authorityChanges: 0,
    adaptationActivations: 0,
    results: Object.freeze(results),
  });
}

function emptyResult(available: boolean): DailyAgentLearningResult {
  return Object.freeze({
    available,
    targets: 0,
    completed: 0,
    duplicates: 0,
    noOpCompletions: 0,
    actionableCycles: 0,
    observationsRecorded: 0,
    actionableEvidenceCount: 0,
    failed: 0,
    modelInvocations: 0,
    behaviorChanges: 0,
    authorityChanges: 0,
    adaptationActivations: 0,
    results: Object.freeze([]),
  });
}
