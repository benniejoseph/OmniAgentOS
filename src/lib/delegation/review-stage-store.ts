import { z } from "zod";

import {
  parseDelegationExecutionContractV2,
  type DelegationExecutionContractV2,
} from "@/lib/delegation/execution-contract";
import { executionScopeFromDelegationContract } from "@/lib/delegation/runtime";
import {
  DYNAMIC_DELEGATION_REVIEW_POLICY_ID,
  DYNAMIC_DELEGATION_REVIEW_POLICY_SHA256,
  partitionDynamicDelegationLifecycleBudget,
} from "@/lib/delegation/runtime-policy";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import type { OperationJobRecord } from "@/lib/operations/job-queue";
import {
  RUN_BUDGET_DIMENSIONS,
  createRunBudgetState,
  reserveRunBudget,
  runBudgetCountersV1Schema,
  settleModelTurnBudget,
} from "@/lib/runs/budgets";
import {
  deriveExecutionScope,
  executionScopesEqual,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(240);
const timestamp = z.string().datetime({ offset: true });
const measured = z.number().int().min(0).max(1_000_000_000_000);
const stageSchema = z.enum(["review_initial", "correction", "review_final"]);
const estimateSchema = z.object({ tokens: measured.min(1), costMicrousd: measured }).strict();
const actualSchema = z.object({ tokens: measured.optional(), costMicrousd: measured.optional() }).strict();

export type DelegationReviewStage = z.infer<typeof stageSchema>;
export const DELEGATION_REVIEW_STAGE_EVENT_TYPES = Object.freeze({
  claimed: "delegation.review_stage.claimed",
  completed: "delegation.review_stage.completed",
});

export const delegationReviewStageClaimSchema = z.object({
  id,
  stage: stageSchema,
  executionId: id,
  contractSha256: sha256,
  requestSha256: sha256,
  runtimeAssignmentSha256: sha256,
  jobId: id,
  jobAttempt: measured.min(1),
  leaseOwnerSha256: sha256,
  predecessorReceiptSha256: sha256.nullable(),
  stageBudget: runBudgetCountersV1Schema,
  reserved: estimateSchema,
  startedAt: timestamp,
  deadlineAt: timestamp,
}).strict();

export const delegationStageReviewReceiptSchema = z.object({
  proposalSha256: sha256,
  acceptanceChecksSha256: sha256,
  modelReceiptSha256: sha256,
  usageReceiptSha256: sha256,
  score: z.number().min(0).max(1),
  passed: z.boolean(),
  note: z.string().max(2_000),
}).strict();

export const delegationStageCorrectionReceiptSchema = z.object({
  previousProposalSha256: sha256,
  proposalSha256: sha256,
  modelReceiptSha256: sha256,
  usageReceiptSha256: sha256,
}).strict();

export const delegationReviewStageCompletionSchema = z.object({
  claimId: id,
  claimSha256: sha256,
  stage: stageSchema,
  outcome: z.enum(["passed", "changes_required", "revised", "failed"]),
  receiptSha256: sha256,
  reviewReceipt: delegationStageReviewReceiptSchema.optional(),
  correctionReceipt: delegationStageCorrectionReceiptSchema.optional(),
  actual: actualSchema,
  settled: runBudgetCountersV1Schema,
  exceededDimensions: z.array(z.enum(RUN_BUDGET_DIMENSIONS)).max(RUN_BUDGET_DIMENSIONS.length),
  completedAt: timestamp,
}).strict();

export type DelegationReviewStageClaim = z.infer<typeof delegationReviewStageClaimSchema>;
export type DelegationReviewStageCompletion = z.infer<typeof delegationReviewStageCompletionSchema>;
export type DelegationStageReviewReceipt = z.infer<typeof delegationStageReviewReceiptSchema>;
export type DelegationStageCorrectionReceipt = z.infer<typeof delegationStageCorrectionReceiptSchema>;
export type DelegationReviewStages = Partial<Record<DelegationReviewStage, {
  claim: DelegationReviewStageClaim;
  completion?: DelegationReviewStageCompletion;
}>>;

type StageAuthority = {
  executionScope: ExecutionScope;
  contract: DelegationExecutionContractV2;
};
type StageWorkerAuthority = StageAuthority & { job: OperationJobRecord };
type StageSql = ReturnType<typeof getSql>;

export class DelegationReviewStageConflictError extends Error {
  readonly code = "delegation_review_stage_conflict";
  constructor(message: string) {
    super(message);
    this.name = "DelegationReviewStageConflictError";
  }
}

/**
 * The root ledger already reserved every slice. This journal consumes each
 * slice at most once, before its external model call. An existing claim is
 * never permission to retry: its provider outcome may be unknown.
 */
export async function claimDelegationReviewStage(input: StageWorkerAuthority & {
  stage: DelegationReviewStage;
  requestSha256: string;
  estimated: { tokens: number; costMicrousd: number };
}): Promise<DelegationReviewStageClaim> {
  const stage = stageSchema.parse(input.stage);
  const requestSha256 = sha256.parse(input.requestSha256);
  const estimated = estimateSchema.parse(input.estimated);
  return withStageAuthority(input, async (sql) => {
    const now = await lockRunningWorker(sql, input);
    const stages = await readStages(sql, input.contract);
    if (stages[stage]) {
      throw conflict("A claimed delegation review stage cannot be executed again.");
    }
    const predecessor = requirePredecessor(stages, stage);
    const budget = stageBudget(input.contract, stage);
    reserveRunBudget(createRunBudgetState(budget, { startedAt: now }), {
      modelTurns: 1,
      ...estimated,
    }, Date.parse(now));
    const claim = delegationReviewStageClaimSchema.parse({
      id: stageEventId(input.contract, stage, "claimed"),
      stage,
      executionId: input.contract.delegateIdentity.runId,
      contractSha256: input.contract.contractSha256,
      requestSha256,
      runtimeAssignmentSha256: stage === "correction"
        ? input.contract.runtimeAssignment.assignmentSha256
        : input.contract.verifier.runtimeAssignment.assignmentSha256,
      jobId: input.job.id,
      jobAttempt: input.job.attempt,
      leaseOwnerSha256: canonicalJsonSha256(input.job.leaseOwner),
      predecessorReceiptSha256: predecessor?.receiptSha256 ?? null,
      stageBudget: budget,
      reserved: estimated,
      startedAt: now,
      deadlineAt: new Date(Math.min(
        Date.parse(input.contract.deadline.completeBy),
        Date.parse(now) + budget.wallTimeMs,
      )).toISOString(),
    });
    await appendStageEvent(sql, input, "claimed", { claim });
    return claim;
  });
}

/** Actual use is durable even when it exceeds its estimate; it is never refunded at root. */
export async function completeDelegationReviewStage(input: StageWorkerAuthority & {
  claim: DelegationReviewStageClaim;
  outcome: DelegationReviewStageCompletion["outcome"];
  receiptSha256: string;
  reviewReceipt?: DelegationStageReviewReceipt;
  correctionReceipt?: DelegationStageCorrectionReceipt;
  actual?: { tokens?: number; costMicrousd?: number };
}): Promise<DelegationReviewStageCompletion> {
  const claim = delegationReviewStageClaimSchema.parse(input.claim);
  const actual = actualSchema.parse(input.actual ?? {});
  const completion = await withStageAuthority(input, async (sql) => {
    const now = await lockRunningWorker(sql, input, true);
    const stages = await readStages(sql, input.contract);
    const persisted = stages[claim.stage];
    if (!persisted || canonicalJsonSha256(persisted.claim) !== canonicalJsonSha256(claim) ||
        claim.jobId !== input.job.id || claim.jobAttempt !== input.job.attempt ||
        claim.leaseOwnerSha256 !== canonicalJsonSha256(input.job.leaseOwner)) {
      throw conflict("Delegation review completion does not match its durable claim.");
    }
    const reviewReceipt = input.reviewReceipt
      ? delegationStageReviewReceiptSchema.parse(input.reviewReceipt) : undefined;
    const correctionReceipt = input.correctionReceipt
      ? delegationStageCorrectionReceiptSchema.parse(input.correctionReceipt) : undefined;
    validateOutcome(input.outcome, claim.stage, input.receiptSha256,
      reviewReceipt, correctionReceipt, stages);
    if (persisted.completion) {
      const previous = persisted.completion;
      if (previous.outcome !== input.outcome || previous.receiptSha256 !== input.receiptSha256 ||
          canonicalJsonSha256(previous.actual) !== canonicalJsonSha256(actual) ||
          canonicalJsonSha256(previous.reviewReceipt ?? null) !== canonicalJsonSha256(reviewReceipt ?? null) ||
          canonicalJsonSha256(previous.correctionReceipt ?? null) !== canonicalJsonSha256(correctionReceipt ?? null)) {
        throw conflict("Delegation review completion retry changed its receipt.");
      }
      return previous;
    }
    const { settled, exceededDimensions } = settleStage(claim, actual, now);
    const completed = delegationReviewStageCompletionSchema.parse({
      claimId: claim.id,
      claimSha256: canonicalJsonSha256(claim),
      stage: claim.stage,
      outcome: input.outcome,
      receiptSha256: input.receiptSha256,
      ...(reviewReceipt ? { reviewReceipt } : {}),
      ...(correctionReceipt ? { correctionReceipt } : {}),
      actual,
      settled,
      exceededDimensions,
      completedAt: now,
    });
    await appendStageEvent(sql, input, "completed", { completion: completed });
    return completed;
  });
  if (completion.exceededDimensions.length) {
    throw conflict(`Delegation review stage exceeded its reserved ${completion.exceededDimensions.join(", ")} budget.`);
  }
  return completion;
}

/** Receipt reads confer no continuation or retry authority. */
export async function getDelegationReviewStages(input: StageAuthority): Promise<DelegationReviewStages> {
  return withStageAuthority(input, async (sql) => {
    await lockExecution(sql, input, false);
    return readStages(sql, input.contract);
  });
}

function requirePredecessor(stages: DelegationReviewStages, stage: DelegationReviewStage) {
  if (stage === "review_initial") {
    if (Object.keys(stages).length) throw conflict("Delegation review stages are out of order.");
    return undefined;
  }
  const previous = stages[stage === "correction" ? "review_initial" : "correction"]?.completion;
  if (!previous || previous.exceededDimensions.length ||
      previous.outcome !== (stage === "correction" ? "changes_required" : "revised")) {
    throw conflict("Delegation review stage lacks its exact successful predecessor.");
  }
  return previous;
}

function validateOutcome(
  outcome: DelegationReviewStageCompletion["outcome"], stage: DelegationReviewStage,
  receiptSha256: string, review: DelegationStageReviewReceipt | undefined,
  correction: DelegationStageCorrectionReceipt | undefined, stages: DelegationReviewStages,
) {
  sha256.parse(receiptSha256);
  if (outcome === "failed") {
    if (review || correction) throw conflict("A failed review stage cannot contain a successful receipt.");
    return;
  }
  if (stage === "correction") {
    if (outcome !== "revised" || !correction || review ||
        canonicalJsonSha256(correction) !== receiptSha256 ||
        correction.previousProposalSha256 !== stages.review_initial?.completion?.reviewReceipt?.proposalSha256) {
      throw conflict("Delegation correction receipt does not match the rejected proposal.");
    }
  } else if (!review || correction ||
      !["passed", "changes_required"].includes(outcome) ||
      review.passed !== (outcome === "passed") ||
      (review.passed && review.score < 0.8) ||
      canonicalJsonSha256(review) !== receiptSha256 ||
      (stage === "review_final" && review.proposalSha256 !== stages.correction?.completion?.correctionReceipt?.proposalSha256)) {
    throw conflict("Delegation review receipt does not match its proposal or verdict.");
  }
}

function stageBudget(contract: DelegationExecutionContractV2, stage: DelegationReviewStage) {
  const partition = partitionDynamicDelegationLifecycleBudget(contract.budgets);
  const budget = stage === "correction" ? partition.correction
    : stage === "review_final" ? partition.finalVerifier : partition.verifier;
  if (!budget || partition.policyVersion !== "reviewed_correction") {
    throw conflict("This delegation contract does not authorize reviewed correction.");
  }
  return budget;
}

async function withStageAuthority<T>(input: StageAuthority, work: (sql: StageSql) => Promise<T>): Promise<T> {
  if (!hasDatabaseUrl()) throw conflict("Delegation review stages require canonical database authority.");
  const contract = parseDelegationExecutionContractV2(input.contract);
  if (contract.verifier.verifierPolicyId !== DYNAMIC_DELEGATION_REVIEW_POLICY_ID ||
      contract.verifier.verifierPolicySha256 !== DYNAMIC_DELEGATION_REVIEW_POLICY_SHA256 ||
      !executionScopesEqual(input.executionScope, executionScopeFromDelegationContract(contract))) {
    throw conflict("Delegation review authority does not match its immutable contract.");
  }
  stageBudget(contract, "review_initial");
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(contract.lineage.tenantId, [contract.lineage.initiatingActorId],
    () => getSql().transaction(work) as Promise<T>);
}

async function lockExecution(sql: StageSql, input: StageAuthority, running: boolean) {
  const contract = input.contract;
  const rows = await sql`
    SELECT state, contract_sha256, budget_limits_sha256, child_run_id, delegate_principal_id,
      clock_timestamp() AS stage_now, complete_by > clock_timestamp() AS deadline_active
    FROM omni_delegation_executions
    WHERE tenant_id = ${contract.lineage.tenantId}
      AND owner_actor_id = ${contract.lineage.initiatingActorId}
      AND execution_id = ${contract.delegateIdentity.runId}
    LIMIT 1 FOR UPDATE
  `;
  const row = rows[0];
  if (!row || row.contract_sha256 !== contract.contractSha256 ||
      row.budget_limits_sha256 !== canonicalJsonSha256(contract.budgets) ||
      row.child_run_id !== contract.delegateIdentity.runId ||
      row.delegate_principal_id !== contract.delegateIdentity.principalId ||
      (running && row.state !== "running")) {
    throw conflict("Delegation review execution is unavailable or no longer running.");
  }
  return row;
}

async function lockRunningWorker(sql: StageSql, input: StageWorkerAuthority, settling = false) {
  const row = await lockExecution(sql, input, true);
  if (!settling && row.deadline_active !== true) throw conflict("Delegation review deadline expired.");
  const contract = input.contract;
  // Match cancellation's execution → child run → delivery lock order.
  const runs = await sql`
    SELECT status FROM omni_agent_runs
    WHERE tenant_id = ${contract.lineage.tenantId}
      AND owner_actor_id = ${contract.lineage.initiatingActorId}
      AND id = ${contract.delegateIdentity.runId}
      AND agent_id = ${contract.delegateIdentity.logicalAgentId}
    LIMIT 1 FOR UPDATE
  `;
  if (!runs[0] || !["running", "resuming"].includes(String(runs[0].status))) {
    throw conflict("Delegation review requires the active child run.");
  }
  const jobs = await sql`
    SELECT payload FROM omni_operation_jobs
    WHERE tenant_id = ${contract.lineage.tenantId} AND id = ${input.job.id}
      AND type = 'agent.execute' AND status = 'running'
      AND lease_owner = ${input.job.leaseOwner || ""}
      AND lease_expires_at > clock_timestamp() AND attempt = ${input.job.attempt}
    LIMIT 1 FOR UPDATE
  `;
  const payload = jobs[0]?.payload as Record<string, unknown> | undefined;
  if (!input.job.leaseOwner || !payload || payload.actorId !== contract.lineage.initiatingActorId ||
      payload.executionId !== contract.delegateIdentity.runId || payload.runId !== contract.delegateIdentity.runId ||
      payload.agentId !== contract.delegateIdentity.logicalAgentId || payload.contractSha256 !== contract.contractSha256 ||
      payload.contextCapsuleSha256 !== contract.contextCapsule.capsuleSha256 ||
      payload.runtimeAssignmentSha256 !== contract.runtimeAssignment.assignmentSha256 ||
      canonicalJsonSha256(payload.executionScope) !== canonicalJsonSha256(input.executionScope)) {
    throw conflict("Delegation review worker lost its exact queue lease or envelope.");
  }
  const nowRows = await sql`SELECT clock_timestamp() AS stage_now`;
  const clock = nowRows[0]?.stage_now;
  const now = clock instanceof Date ? clock.toISOString() : new Date(String(clock)).toISOString();
  if (!settling && Date.parse(now) >= Date.parse(contract.deadline.completeBy)) {
    throw conflict("Delegation review deadline expired while acquiring its authority.");
  }
  return now;
}

async function readStages(sql: StageSql, contract: DelegationExecutionContractV2): Promise<DelegationReviewStages> {
  const rows = await sql`
    SELECT id, type, payload, correlation_id, causation_id FROM omni_events
    WHERE tenant_id = ${contract.lineage.tenantId} AND actor_id = ${contract.lineage.initiatingActorId}
      AND stream_id = ${`delegation-execution:${contract.delegationId}`}
      AND type IN ('delegation.review_stage.claimed', 'delegation.review_stage.completed')
    ORDER BY seq ASC LIMIT 7
  `;
  if (rows.length > 6) throw conflict("Delegation review journal has unexpected stage records.");
  const stages: DelegationReviewStages = {};
  for (const row of rows) {
    const payload = mapTokenCounterKey(row.payload, "tokenCount", "tokens") as Record<string, unknown>;
    if (payload.schemaVersion !== 1 || payload.contractSha256 !== contract.contractSha256) {
      throw conflict("Delegation review journal contract binding is invalid.");
    }
    if (row.type === DELEGATION_REVIEW_STAGE_EVENT_TYPES.claimed) {
      const claim = delegationReviewStageClaimSchema.parse(payload.claim);
      assertStageEventScope(row, payload, contract, claim.stage, "claimed");
      if (row.id !== stageEventId(contract, claim.stage, "claimed") || claim.id !== row.id ||
          claim.executionId !== contract.delegateIdentity.runId || claim.contractSha256 !== contract.contractSha256 || stages[claim.stage]) {
        throw conflict("Delegation review journal contains a conflicting claim.");
      }
      const predecessor = requirePredecessor(stages, claim.stage);
      if (claim.predecessorReceiptSha256 !== (predecessor?.receiptSha256 ?? null) ||
          canonicalJsonSha256(claim.stageBudget) !== canonicalJsonSha256(stageBudget(contract, claim.stage)) ||
          claim.runtimeAssignmentSha256 !== (claim.stage === "correction"
            ? contract.runtimeAssignment.assignmentSha256 : contract.verifier.runtimeAssignment.assignmentSha256) ||
          Date.parse(claim.startedAt) < Date.parse(contract.deadline.createdAt) ||
          Date.parse(claim.deadlineAt) > Date.parse(contract.deadline.completeBy) ||
          Date.parse(claim.deadlineAt) <= Date.parse(claim.startedAt) ||
          Date.parse(claim.deadlineAt) - Date.parse(claim.startedAt) > claim.stageBudget.wallTimeMs) {
        throw conflict("Delegation review journal budget or predecessor differs.");
      }
      reserveRunBudget(createRunBudgetState(claim.stageBudget, { startedAt: claim.startedAt }), {
        modelTurns: 1, ...claim.reserved,
      }, Date.parse(claim.startedAt));
      stages[claim.stage] = { claim };
    } else {
      const completion = delegationReviewStageCompletionSchema.parse(payload.completion);
      assertStageEventScope(row, payload, contract, completion.stage, "completed");
      const entry = stages[completion.stage];
      if (!entry || entry.completion || row.id !== stageEventId(contract, completion.stage, "completed") ||
          completion.claimId !== entry.claim.id || completion.claimSha256 !== canonicalJsonSha256(entry.claim)) {
        throw conflict("Delegation review journal contains an unmatched completion.");
      }
      validateOutcome(completion.outcome, completion.stage, completion.receiptSha256,
        completion.reviewReceipt, completion.correctionReceipt, stages);
      const settlement = settleStage(entry.claim, completion.actual, completion.completedAt);
      if (canonicalJsonSha256(settlement.settled) !== canonicalJsonSha256(completion.settled) ||
          canonicalJsonSha256(settlement.exceededDimensions) !== canonicalJsonSha256(completion.exceededDimensions)) {
        throw conflict("Delegation review usage settlement differs from its claimed slice.");
      }
      entry.completion = completion;
    }
  }
  return stages;
}

function stageEventId(contract: DelegationExecutionContractV2, stage: DelegationReviewStage, kind: "claimed" | "completed") {
  return `delegation-review-stage:${canonicalJsonSha256({
    tenantId: contract.lineage.tenantId,
    executionId: contract.delegateIdentity.runId,
    contractSha256: contract.contractSha256,
    stage,
  })}:${kind}`;
}

async function appendStageEvent(sql: StageSql, input: StageAuthority, kind: "claimed" | "completed",
  data: { claim: DelegationReviewStageClaim } | { completion: DelegationReviewStageCompletion }) {
  const stage = "claim" in data ? data.claim.stage : data.completion.stage;
  // The shared event redactor reserves bare `tokens` for credentials. Preserve
  // these typed numeric counters using its established tokenCount metadata key.
  const payload = mapTokenCounterKey({
    schemaVersion: 1, contractSha256: input.contract.contractSha256, ...data,
  }, "tokens", "tokenCount") as Record<string, unknown>;
  const event = await appendScopedDomainEvent({
    id: stageEventId(input.contract, stage, kind),
    streamId: `delegation-execution:${input.contract.delegationId}`,
    type: DELEGATION_REVIEW_STAGE_EVENT_TYPES[kind],
    executionScope: deriveExecutionScope(input.executionScope, {
      purpose: `delegation.review_stage.${stage}.${kind}.v1`,
    }),
    payload,
  }, { sql });
  // Redaction/truncation must never silently invalidate a sealed receipt.
  const { _executionScope: _scope, ...persisted } = event.payload;
  if (canonicalJsonSha256(persisted) !== canonicalJsonSha256(payload)) {
    throw conflict("Delegation review receipt could not be recorded without alteration.");
  }
}

function conflict(message: string) { return new DelegationReviewStageConflictError(message); }

function settleStage(claim: DelegationReviewStageClaim, actual: z.infer<typeof actualSchema>, now: string) {
  if (Date.parse(now) < Date.parse(claim.startedAt)) {
    throw conflict("Delegation review stage time cannot move backwards.");
  }
  const reserved = reserveRunBudget(createRunBudgetState(claim.stageBudget, {
    startedAt: claim.startedAt,
  }), { modelTurns: 1, ...claim.reserved }, Date.parse(claim.startedAt));
  const settled = settleModelTurnBudget(reserved, { ...claim.reserved, retries: 0 }, {
    ...actual, retries: 0,
  }).used;
  settled.wallTimeMs = Date.parse(now) - Date.parse(claim.startedAt);
  const exceededDimensions = RUN_BUDGET_DIMENSIONS.filter((dimension) =>
    settled[dimension] > claim.stageBudget[dimension] ||
    (dimension === "wallTimeMs" && Date.parse(now) > Date.parse(claim.deadlineAt))
  );
  return { settled, exceededDimensions };
}

function assertStageEventScope(row: Record<string, unknown>, payload: Record<string, unknown>,
  contract: DelegationExecutionContractV2, stage: DelegationReviewStage, kind: "claimed" | "completed") {
  const scope = parsePersistedExecutionScope(payload._executionScope);
  const expected = deriveExecutionScope(executionScopeFromDelegationContract(contract), {
    purpose: `delegation.review_stage.${stage}.${kind}.v1`,
  });
  if (!scope || !executionScopesEqual(scope, expected) || row.correlation_id !== expected.correlationId ||
      (row.causation_id || null) !== expected.causationId) {
    throw conflict("Delegation review journal scope does not match its immutable child.");
  }
}

function mapTokenCounterKey(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapTokenCounterKey(item, from, to));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key === from ? to : key,
    mapTokenCounterKey(item, from, to),
  ]));
}
