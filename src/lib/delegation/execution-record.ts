import { z } from "zod";

import {
  delegationExecutionContractV2Schema,
  parseDelegationExecutionContractV2,
  type DelegationExecutionContractV2,
} from "@/lib/delegation/execution-contract";
import {
  runBudgetCountersV1Schema,
  type RunBudgetCountersV1,
} from "@/lib/runs/budgets";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const DELEGATION_EXECUTION_RECORD_VERSION =
  "delegation-execution-record:1" as const;
export const DELEGATION_EXECUTION_EVENT_VERSION =
  "delegation-execution-event:1" as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const uniqueIdListSchema = z.array(idSchema).max(64).refine(
  (values) => new Set(values).size === values.length,
  "IDs must be unique.",
);
const uniqueShaListSchema = z.array(sha256Schema).max(64).refine(
  (values) => new Set(values).size === values.length,
  "Digests must be unique.",
);

export const delegationExecutionStateSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "completed_proposed",
  "verified",
  "rejected",
  "failed",
  "canceled",
  "expired",
]);

export type DelegationExecutionState = z.infer<
  typeof delegationExecutionStateSchema
>;

const acceptanceCheckSchema = z.object({
  criterionId: idSchema,
  passed: z.boolean(),
  evidenceIds: uniqueIdListSchema,
  note: z.string().trim().max(2_000),
}).strict();

const artifactReferenceSchema = z.object({
  artifactId: idSchema,
  artifactSha256: sha256Schema,
  kind: z.enum([
    "analysis",
    "result",
    "verification",
    "report",
    "memory",
    "control",
    "code",
    "media",
  ]),
  mediaType: z.string().trim().min(3).max(120),
  byteCount: z.number().int().min(1).max(25_000_000),
  evidenceIds: uniqueIdListSchema,
}).strict();

export const delegationExecutionResultV1Schema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["completed", "blocked"]),
  summary: z.string().trim().min(1).max(4_000),
  artifacts: z.array(artifactReferenceSchema).max(32),
  acceptanceChecks: z.array(acceptanceCheckSchema).min(1).max(24),
  evidenceIds: uniqueIdListSchema,
  toolExecutionIds: uniqueIdListSchema,
  modelReceiptSha256s: uniqueShaListSchema,
  usageReceiptSha256s: uniqueShaListSchema,
  proposedAt: timestampSchema,
}).strict().superRefine((result, context) => {
  const criterionIds = result.acceptanceChecks.map((item) => item.criterionId);
  if (new Set(criterionIds).size !== criterionIds.length) {
    context.addIssue({
      code: "custom",
      path: ["acceptanceChecks"],
      message: "Delegation acceptance checks must be unique.",
    });
  }
});

export const delegationExecutionVerificationV1Schema = z.object({
  schemaVersion: z.literal(1),
  verifierAgentId: idSchema,
  verifierDefinitionVersion: z.number().int().min(1),
  verifierPrincipalId: idSchema,
  verifierRuntimeAssignmentId: idSchema,
  verifierRuntimeAssignmentSha256: sha256Schema,
  verifierProviderId: idSchema,
  verifierModelId: idSchema,
  verifierModelTier: z.enum(["fast", "reasoning"]),
  verifierModelReceiptSha256: sha256Schema,
  verdict: z.enum(["verified", "rejected"]),
  score: z.number().min(0).max(1),
  resultSha256: sha256Schema,
  acceptanceChecksSha256: sha256Schema,
  evidenceIds: uniqueIdListSchema,
  note: z.string().trim().max(2_000),
  verifiedAt: timestampSchema,
}).strict();

export const delegationExecutionRecordV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(DELEGATION_EXECUTION_RECORD_VERSION),
  tenantId: idSchema,
  executionId: idSchema,
  ownerActorId: idSchema,
  rootExecutionId: idSchema,
  parentExecutionId: idSchema,
  childRunId: idSchema,
  delegationId: idSchema,
  compatibilityTaskId: idSchema.nullable(),
  contractId: idSchema,
  contractSha256: sha256Schema,
  contextCapsuleId: idSchema,
  contextCapsuleSha256: sha256Schema,
  delegateAgentId: idSchema,
  delegatePrincipalId: idSchema,
  runtimeAssignmentId: idSchema,
  runtimeAssignmentSha256: sha256Schema,
  mode: z.enum(["isolated", "fork", "team"]),
  budgetLimits: runBudgetCountersV1Schema,
  budgetLimitsSha256: sha256Schema,
  budgetLedgerRevision: z.number().int().min(1),
  state: delegationExecutionStateSchema,
  lifecycleRevision: z.number().int().min(0),
  contract: delegationExecutionContractV2Schema,
  result: delegationExecutionResultV1Schema.nullable(),
  resultSha256: sha256Schema.nullable(),
  verification: delegationExecutionVerificationV1Schema.nullable(),
  verificationSha256: sha256Schema.nullable(),
  failureCode: idSchema.nullable(),
  createdAt: timestampSchema,
  acceptBy: timestampSchema,
  completeBy: timestampSchema,
  updatedAt: timestampSchema,
  terminalAt: timestampSchema.nullable(),
}).strict().superRefine((record, context) => {
  validateRecordBindings(record, context);
});

export type DelegationExecutionResultV1 = Readonly<
  z.infer<typeof delegationExecutionResultV1Schema>
>;
export type DelegationExecutionVerificationV1 = Readonly<
  z.infer<typeof delegationExecutionVerificationV1Schema>
>;
export type DelegationExecutionRecordV1 = Readonly<
  z.infer<typeof delegationExecutionRecordV1Schema>
>;

export type DelegationExecutionTransition =
  | Readonly<{ to: "running" }>
  | Readonly<{
      to: "waiting";
      reason: "approval_required" | "dependency" | "clarification_required";
    }>
  | Readonly<{
      to: "completed_proposed";
      result: Omit<DelegationExecutionResultV1, "schemaVersion" | "proposedAt">;
    }>
  | Readonly<{
      to: "verified" | "rejected";
      verification: Omit<
        DelegationExecutionVerificationV1,
        "schemaVersion" | "verdict" | "resultSha256" | "verifiedAt"
      >;
    }>
  | Readonly<{ to: "failed"; code: string }>
  | Readonly<{ to: "canceled"; reason: string }>
  | Readonly<{ to: "expired" }>;

export type DelegationExecutionEventV1 = Readonly<{
  schemaVersion: 1;
  version: typeof DELEGATION_EXECUTION_EVENT_VERSION;
  eventId: string;
  eventSha256: string;
  executionId: string;
  delegationId: string;
  rootExecutionId: string;
  parentExecutionId: string;
  childRunId: string;
  delegateAgentId: string;
  from: DelegationExecutionState | null;
  to: DelegationExecutionState;
  lifecycleRevision: number;
  detailSha256: string;
  at: string;
}>;

const allowedTransitions: Readonly<
  Record<DelegationExecutionState, readonly DelegationExecutionState[]>
> = {
  queued: ["running", "failed", "canceled", "expired"],
  running: ["waiting", "completed_proposed", "failed", "canceled", "expired"],
  waiting: ["running", "failed", "canceled", "expired"],
  completed_proposed: ["verified", "rejected", "failed", "canceled", "expired"],
  verified: [],
  rejected: [],
  failed: [],
  canceled: [],
  expired: [],
};

export function buildDelegationExecutionRecordV1(input: {
  contract: DelegationExecutionContractV2;
  budgetLedgerRevision: number;
  compatibilityTaskId?: string | null;
}): DelegationExecutionRecordV1 {
  const contract = parseDelegationExecutionContractV2(input.contract);
  const createdAt = contract.deadline.createdAt;
  return parseDelegationExecutionRecordV1({
    schemaVersion: 1,
    version: DELEGATION_EXECUTION_RECORD_VERSION,
    tenantId: contract.lineage.tenantId,
    executionId: contract.delegateIdentity.runId,
    ownerActorId: contract.lineage.initiatingActorId,
    rootExecutionId: contract.lineage.rootExecutionId,
    parentExecutionId: contract.lineage.parentExecutionId,
    childRunId: contract.delegateIdentity.runId,
    delegationId: contract.delegationId,
    compatibilityTaskId: input.compatibilityTaskId || null,
    contractId: contract.contractId,
    contractSha256: contract.contractSha256,
    contextCapsuleId: contract.contextCapsule.capsuleId,
    contextCapsuleSha256: contract.contextCapsule.capsuleSha256,
    delegateAgentId: contract.delegateIdentity.logicalAgentId,
    delegatePrincipalId: contract.delegateIdentity.principalId,
    runtimeAssignmentId: contract.runtimeAssignment.assignmentId,
    runtimeAssignmentSha256: contract.runtimeAssignment.assignmentSha256,
    mode: contract.mode,
    budgetLimits: contract.budgets,
    budgetLimitsSha256: canonicalJsonSha256(contract.budgets),
    budgetLedgerRevision: input.budgetLedgerRevision,
    state: "queued",
    lifecycleRevision: 0,
    contract,
    result: null,
    resultSha256: null,
    verification: null,
    verificationSha256: null,
    failureCode: null,
    createdAt,
    acceptBy: contract.deadline.acceptBy,
    completeBy: contract.deadline.completeBy,
    updatedAt: createdAt,
    terminalAt: null,
  });
}

export function initialDelegationExecutionEventV1(
  record: DelegationExecutionRecordV1,
): DelegationExecutionEventV1 {
  return executionEvent(record, null, canonicalJsonSha256({
    contractSha256: record.contractSha256,
    contextCapsuleSha256: record.contextCapsuleSha256,
    runtimeAssignmentSha256: record.runtimeAssignmentSha256,
    budgetLimitsSha256: record.budgetLimitsSha256,
  }));
}

export function transitionDelegationExecutionRecordV1(input: {
  record: DelegationExecutionRecordV1;
  transition: DelegationExecutionTransition;
  at?: string;
}) {
  const current = parseDelegationExecutionRecordV1(input.record);
  const transition = input.transition;
  if (!allowedTransitions[current.state].includes(transition.to)) {
    throw new Error(
      `Delegation execution cannot transition from ${current.state} to ${transition.to}.`,
    );
  }
  const at = timestampSchema.parse(input.at || new Date().toISOString());
  if (Date.parse(at) < Date.parse(current.updatedAt)) {
    throw new Error("Delegation execution transition time cannot move backwards.");
  }
  if (transition.to === "running" && current.state === "queued" && Date.parse(at) >= Date.parse(current.acceptBy)) {
    throw new Error("Delegation execution acceptance deadline has expired.");
  }
  if (transition.to === "expired" && Date.parse(at) < Date.parse(current.completeBy)) {
    throw new Error("Delegation execution cannot expire before its deadline.");
  }
  if (transition.to !== "expired" && Date.parse(at) >= Date.parse(current.completeBy)) {
    throw new Error("Delegation execution completion deadline has expired.");
  }

  let result = current.result;
  let resultSha256 = current.resultSha256;
  let verification = current.verification;
  let verificationSha256 = current.verificationSha256;
  let failureCode = current.failureCode;
  if (transition.to === "completed_proposed") {
    result = delegationExecutionResultV1Schema.parse({
      ...transition.result,
      schemaVersion: 1,
      proposedAt: at,
    });
    assertResultMatchesContract(current.contract, result);
    resultSha256 = canonicalJsonSha256(result);
  } else if (transition.to === "verified" || transition.to === "rejected") {
    if (!current.result || !current.resultSha256) {
      throw new Error("Delegation verification requires a completion proposal.");
    }
    verification = delegationExecutionVerificationV1Schema.parse({
      ...transition.verification,
      schemaVersion: 1,
      verdict: transition.to,
      resultSha256: current.resultSha256,
      verifiedAt: at,
    });
    assertVerificationMatchesContract(current.contract, verification, transition.to);
    verificationSha256 = canonicalJsonSha256(verification);
  } else if (transition.to === "failed") {
    failureCode = idSchema.parse(transition.code);
  }
  const terminalAt = isTerminalDelegationExecutionState(transition.to) ? at : null;
  const next = parseDelegationExecutionRecordV1({
    ...current,
    state: transition.to,
    lifecycleRevision: current.lifecycleRevision + 1,
    result,
    resultSha256,
    verification,
    verificationSha256,
    failureCode,
    updatedAt: at,
    terminalAt,
  });
  return Object.freeze({
    record: next,
    event: executionEvent(next, current.state, canonicalJsonSha256(transition)),
  });
}

export function parseDelegationExecutionRecordV1(
  value: unknown,
): DelegationExecutionRecordV1 {
  return deepFreeze(delegationExecutionRecordV1Schema.parse(value));
}

export function isTerminalDelegationExecutionState(
  state: DelegationExecutionState,
) {
  return ["verified", "rejected", "failed", "canceled", "expired"].includes(state);
}

export function zeroDelegationBudgetReservation(): RunBudgetCountersV1 {
  return {
    modelTurns: 0,
    tokens: 0,
    costMicrousd: 0,
    wallTimeMs: 0,
    toolCalls: 0,
    browserActions: 0,
    agents: 0,
    fanOut: 0,
    retries: 0,
    replans: 0,
  };
}

function validateRecordBindings(
  record: z.infer<typeof delegationExecutionRecordV1Schema>,
  context: z.RefinementCtx,
) {
  const contract = record.contract;
  const terminal = isTerminalDelegationExecutionState(record.state);
  const resultRequired = ["completed_proposed", "verified", "rejected"].includes(record.state);
  const verificationRequired = ["verified", "rejected"].includes(record.state);
  if (
    record.executionId !== record.childRunId ||
    record.tenantId !== contract.lineage.tenantId ||
    record.ownerActorId !== contract.lineage.initiatingActorId ||
    record.rootExecutionId !== contract.lineage.rootExecutionId ||
    record.parentExecutionId !== contract.lineage.parentExecutionId ||
    record.childRunId !== contract.delegateIdentity.runId ||
    record.delegationId !== contract.delegationId ||
    record.contractId !== contract.contractId ||
    record.contractSha256 !== contract.contractSha256 ||
    record.contextCapsuleId !== contract.contextCapsule.capsuleId ||
    record.contextCapsuleSha256 !== contract.contextCapsule.capsuleSha256 ||
    record.delegateAgentId !== contract.delegateIdentity.logicalAgentId ||
    record.delegatePrincipalId !== contract.delegateIdentity.principalId ||
    record.runtimeAssignmentId !== contract.runtimeAssignment.assignmentId ||
    record.runtimeAssignmentSha256 !== contract.runtimeAssignment.assignmentSha256 ||
    record.mode !== contract.mode ||
    record.budgetLimitsSha256 !== canonicalJsonSha256(record.budgetLimits) ||
    canonicalJsonSha256(record.budgetLimits) !== canonicalJsonSha256(contract.budgets)
  ) {
    context.addIssue({
      code: "custom",
      path: ["contract"],
      message: "Delegation execution record is not bound to its immutable contract.",
    });
  }
  if (terminal !== Boolean(record.terminalAt)) {
    context.addIssue({ code: "custom", path: ["terminalAt"], message: "Terminal timestamp is invalid." });
  }
  if (resultRequired !== Boolean(record.result && record.resultSha256)) {
    context.addIssue({ code: "custom", path: ["result"], message: "Completion proposal state is invalid." });
  }
  if (verificationRequired !== Boolean(record.verification && record.verificationSha256)) {
    context.addIssue({ code: "custom", path: ["verification"], message: "Verification state is invalid." });
  }
  if (record.result && record.resultSha256 !== canonicalJsonSha256(record.result)) {
    context.addIssue({ code: "custom", path: ["resultSha256"], message: "Result digest is invalid." });
  }
  if (
    record.verification &&
    record.verificationSha256 !== canonicalJsonSha256(record.verification)
  ) {
    context.addIssue({ code: "custom", path: ["verificationSha256"], message: "Verification digest is invalid." });
  }
  if ((record.state === "failed") !== Boolean(record.failureCode)) {
    context.addIssue({ code: "custom", path: ["failureCode"], message: "Failure code is invalid." });
  }
}

function assertResultMatchesContract(
  contract: DelegationExecutionContractV2,
  result: DelegationExecutionResultV1,
) {
  const criteria = new Map(contract.acceptance.criteria.map((criterion) => [
    criterion.criterionId,
    criterion,
  ]));
  if (
    result.acceptanceChecks.length !== criteria.size ||
    result.acceptanceChecks.some((check) => !criteria.has(check.criterionId)) ||
    result.artifacts.length > contract.output.maxArtifacts ||
    result.artifacts.reduce((total, artifact) => total + artifact.byteCount, 0) >
      contract.output.maxBytes ||
    result.artifacts.some((artifact) => !contract.output.artifactKinds.includes(artifact.kind))
  ) {
    throw new Error("Delegation result exceeds its output or acceptance contract.");
  }
}

function assertVerificationMatchesContract(
  contract: DelegationExecutionContractV2,
  verification: DelegationExecutionVerificationV1,
  verdict: "verified" | "rejected",
) {
  if (
    verification.verifierAgentId !== contract.verifier.identity.logicalAgentId ||
    verification.verifierDefinitionVersion !== contract.verifier.identity.definitionVersion ||
    verification.verifierPrincipalId !== contract.verifier.identity.principalId ||
    verification.verifierRuntimeAssignmentId !==
      contract.verifier.runtimeAssignment.assignmentId ||
    verification.verifierRuntimeAssignmentSha256 !==
      contract.verifier.runtimeAssignment.assignmentSha256 ||
    verification.verifierProviderId !==
      contract.verifier.runtimeAssignment.providerId ||
    verification.verifierModelId !== contract.verifier.runtimeAssignment.modelId ||
    verification.verifierModelTier !==
      contract.verifier.runtimeAssignment.modelTier ||
    (verdict === "verified" && verification.score < contract.verifier.acceptanceThreshold)
  ) {
    throw new Error("Delegation verification does not satisfy its verifier contract.");
  }
}

function executionEvent(
  record: DelegationExecutionRecordV1,
  from: DelegationExecutionState | null,
  detailSha256: string,
): DelegationExecutionEventV1 {
  const body = {
    schemaVersion: 1 as const,
    version: DELEGATION_EXECUTION_EVENT_VERSION,
    executionId: record.executionId,
    delegationId: record.delegationId,
    rootExecutionId: record.rootExecutionId,
    parentExecutionId: record.parentExecutionId,
    childRunId: record.childRunId,
    delegateAgentId: record.delegateAgentId,
    from,
    to: record.state,
    lifecycleRevision: record.lifecycleRevision,
    detailSha256,
    at: record.updatedAt,
  };
  const eventSha256 = canonicalJsonSha256(body);
  return deepFreeze({
    ...body,
    eventId: `delegation-execution-event:${eventSha256}`,
    eventSha256,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
