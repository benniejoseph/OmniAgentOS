import { z } from "zod";

import type { DelegationContractV1 } from "@/lib/delegation/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const DELEGATION_TASK_VERSION = "p8.3-delegation-task:1" as const;
export const DELEGATION_TASK_EVENT_VERSION =
  "p8.3-delegation-task-event:1" as const;

export const delegationTaskStateSchema = z.enum([
  "proposed",
  "accepted",
  "working",
  "waiting",
  "challenged",
  "completed_proposed",
  "result_accepted",
  "rejected",
  "canceled",
  "expired",
]);

export type DelegationTaskState = z.infer<typeof delegationTaskStateSchema>;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const idListSchema = z.array(idSchema).max(32).refine(
  (values) => new Set(values).size === values.length,
  "IDs must be unique.",
);
const shaListSchema = z.array(sha256Schema).max(32).refine(
  (values) => new Set(values).size === values.length,
  "Digests must be unique.",
);

const completionProposalSchema = z.object({
  proposalReceiptSha256: sha256Schema,
  acceptanceChecksSha256: sha256Schema,
  artifactSha256s: shaListSchema,
  evidenceIds: idListSchema,
  toolExecutionIds: idListSchema,
  proposedAt: timestampSchema,
}).strict();

const parentEvaluationSchema = z.object({
  evaluatorPrincipalId: idSchema,
  evaluatorAgentId: idSchema,
  evaluatorDefinitionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  verdict: z.enum(["accepted", "rejected"]),
  score: z.number().min(0).max(1),
  proposalReceiptSha256: sha256Schema,
  evaluationSha256: sha256Schema,
  evaluatedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  const { evaluationSha256, ...body } = value;
  if (canonicalJsonSha256(body) !== evaluationSha256) {
    context.addIssue({
      code: "custom",
      path: ["evaluationSha256"],
      message: "Parent evaluation integrity is invalid.",
    });
  }
});

export const delegationTaskV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(DELEGATION_TASK_VERSION),
  taskId: idSchema,
  taskSha256: sha256Schema,
  tenantId: idSchema,
  ownerActorId: idSchema,
  parentExecutionId: idSchema,
  parentPrincipalId: idSchema,
  parentDelegationId: idSchema.nullable(),
  delegationId: idSchema,
  contractId: idSchema,
  contractSha256: sha256Schema,
  delegatePrincipalId: idSchema,
  delegateAgentId: idSchema,
  delegateDefinitionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  verifierAgentId: idSchema,
  verifierDefinitionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  verifierAcceptanceThreshold: z.number().min(0.5).max(1),
  state: delegationTaskStateSchema,
  lifecycleRevision: z.number().int().min(0).max(32),
  proposal: completionProposalSchema.nullable(),
  evaluation: parentEvaluationSchema.nullable(),
  createdAt: timestampSchema,
  acceptBy: timestampSchema,
  completeBy: timestampSchema,
  updatedAt: timestampSchema,
  terminalAt: timestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  const { taskSha256, ...body } = value;
  if (canonicalJsonSha256(body) !== taskSha256) {
    context.addIssue({
      code: "custom",
      path: ["taskSha256"],
      message: "Delegation task integrity is invalid.",
    });
  }
  const terminal = isTerminalDelegationTaskState(value.state);
  if (terminal !== Boolean(value.terminalAt)) {
    context.addIssue({ code: "custom", path: ["terminalAt"], message: "Terminal timestamp is invalid." });
  }
  if (
    ["completed_proposed", "result_accepted", "rejected"].includes(value.state) !==
      Boolean(value.proposal)
  ) {
    context.addIssue({ code: "custom", path: ["proposal"], message: "Completion proposal is invalid." });
  }
  if (
    ["result_accepted", "rejected"].includes(value.state) !== Boolean(value.evaluation)
  ) {
    context.addIssue({ code: "custom", path: ["evaluation"], message: "Parent evaluation is invalid." });
  }
  if (
    (value.state === "result_accepted" && value.evaluation?.verdict !== "accepted") ||
    (value.state === "rejected" && value.evaluation?.verdict !== "rejected")
  ) {
    context.addIssue({ code: "custom", path: ["evaluation", "verdict"], message: "Evaluation verdict does not match state." });
  }
});

export type DelegationTaskV1 = Readonly<z.infer<typeof delegationTaskV1Schema>>;
export type DelegationCompletionProposalV1 = Readonly<
  z.infer<typeof completionProposalSchema>
>;
export type DelegationParentEvaluationV1 = Readonly<
  z.infer<typeof parentEvaluationSchema>
>;

export type DelegationTaskTransition =
  | Readonly<{ to: "accepted" | "working" }>
  | Readonly<{
      to: "waiting";
      reason: "approval_required" | "tool_executing" | "clarification_required" | "dependency";
      toolExecutionId?: string;
    }>
  | Readonly<{ to: "challenged"; reason: string; challengeSha256: string }>
  | Readonly<{
      to: "completed_proposed";
      proposalReceiptSha256: string;
      acceptanceChecksSha256: string;
      artifactSha256s?: readonly string[];
      evidenceIds?: readonly string[];
      toolExecutionIds?: readonly string[];
    }>
  | Readonly<{
      to: "result_accepted" | "rejected";
      evaluatorPrincipalId: string;
      evaluatorAgentId: string;
      evaluatorDefinitionVersion: number;
      score: number;
      evaluationSha256?: string;
    }>
  | Readonly<{
      to: "canceled";
      initiator: "parent" | "owner" | "system";
      reason: string;
    }>
  | Readonly<{ to: "expired" }>;

export const delegationTaskEventV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(DELEGATION_TASK_EVENT_VERSION),
  eventId: idSchema,
  eventSha256: sha256Schema,
  taskId: idSchema,
  tenantId: idSchema,
  ownerActorId: idSchema,
  parentExecutionId: idSchema,
  parentDelegationId: idSchema.nullable(),
  delegationId: idSchema,
  delegatePrincipalId: idSchema,
  delegateAgentId: idSchema,
  delegateDefinitionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  from: delegationTaskStateSchema.nullable(),
  to: delegationTaskStateSchema,
  lifecycleRevision: z.number().int().min(0).max(32),
  detailSha256: sha256Schema,
  toolExecutionIds: idListSchema,
  at: timestampSchema,
}).strict().superRefine((value, context) => {
  const { eventSha256, ...body } = value;
  if (canonicalJsonSha256(body) !== eventSha256) {
    context.addIssue({ code: "custom", path: ["eventSha256"], message: "Delegation event integrity is invalid." });
  }
});

export type DelegationTaskEventV1 = Readonly<
  z.infer<typeof delegationTaskEventV1Schema>
>;

const allowedTransitions: Readonly<Record<DelegationTaskState, readonly DelegationTaskState[]>> = {
  proposed: ["accepted", "rejected", "canceled", "expired"],
  accepted: ["working", "rejected", "canceled", "expired"],
  working: ["waiting", "challenged", "completed_proposed", "rejected", "canceled", "expired"],
  waiting: ["working", "challenged", "rejected", "canceled", "expired"],
  challenged: ["working", "completed_proposed", "rejected", "canceled", "expired"],
  completed_proposed: ["result_accepted", "rejected", "challenged", "canceled", "expired"],
  result_accepted: [],
  rejected: [],
  canceled: [],
  expired: [],
};

export function buildDelegationTaskV1(
  contract: DelegationContractV1,
): DelegationTaskV1 {
  return taskWithDigest({
    schemaVersion: 1,
    version: DELEGATION_TASK_VERSION,
    taskId: `delegation-task:${contract.delegationId}`,
    tenantId: contract.scope.tenantId,
    ownerActorId: contract.scope.initiatingActorId,
    parentExecutionId: contract.scope.parentExecutionId,
    parentPrincipalId: contract.scope.parentPrincipalId,
    parentDelegationId: contract.scope.parentDelegationId,
    delegationId: contract.delegationId,
    contractId: contract.contractId,
    contractSha256: contract.contractSha256,
    delegatePrincipalId: contract.delegate.principalId,
    delegateAgentId: contract.delegate.agentId,
    delegateDefinitionVersion: contract.delegate.definitionVersion,
    verifierAgentId: contract.verifier.agentId,
    verifierDefinitionVersion: contract.verifier.definitionVersion,
    verifierAcceptanceThreshold: contract.verifier.acceptanceThreshold,
    state: "proposed",
    lifecycleRevision: 0,
    proposal: null,
    evaluation: null,
    createdAt: contract.deadline.createdAt,
    acceptBy: contract.deadline.acceptBy,
    completeBy: contract.deadline.completeBy,
    updatedAt: contract.deadline.createdAt,
    terminalAt: null,
  });
}

export function transitionDelegationTaskV1(input: {
  task: DelegationTaskV1;
  transition: DelegationTaskTransition;
  at?: string;
}): Readonly<{ task: DelegationTaskV1; event: DelegationTaskEventV1 }> {
  const current = parseDelegationTaskV1(input.task);
  const at = timestampSchema.parse(input.at || new Date().toISOString());
  const to = input.transition.to;
  if (!allowedTransitions[current.state].includes(to)) {
    throw new Error(`Delegation transition ${current.state} -> ${to} is invalid.`);
  }
  if (Date.parse(at) < Date.parse(current.updatedAt)) {
    throw new Error("Delegation transition time cannot move backwards.");
  }
  if (to === "accepted" && Date.parse(at) >= Date.parse(current.acceptBy)) {
    throw new Error("Delegation acceptance deadline has expired.");
  }
  if (to !== "expired" && Date.parse(at) >= Date.parse(current.completeBy)) {
    throw new Error("Delegation completion deadline has expired.");
  }
  if (to === "expired" && Date.parse(at) < Date.parse(current.completeBy)) {
    throw new Error("Delegation cannot expire before its completion deadline.");
  }

  let proposal = current.proposal;
  let evaluation = current.evaluation;
  if (to === "completed_proposed") {
    if (input.transition.to !== to) throw new Error("Invalid completion proposal.");
    proposal = completionProposalSchema.parse({
      proposalReceiptSha256: input.transition.proposalReceiptSha256,
      acceptanceChecksSha256: input.transition.acceptanceChecksSha256,
      artifactSha256s: [...(input.transition.artifactSha256s || [])],
      evidenceIds: [...(input.transition.evidenceIds || [])],
      toolExecutionIds: [...(input.transition.toolExecutionIds || [])],
      proposedAt: at,
    });
  }
  if (to === "result_accepted" || to === "rejected") {
    if (!proposal || (input.transition.to !== "result_accepted" && input.transition.to !== "rejected")) {
      throw new Error("A parent evaluation requires a completion proposal.");
    }
    if (
      input.transition.evaluatorPrincipalId !== current.parentPrincipalId ||
      input.transition.evaluatorAgentId !== current.verifierAgentId ||
      input.transition.evaluatorDefinitionVersion !== current.verifierDefinitionVersion
    ) {
      throw new Error("Delegation evaluation is not bound to its parent verifier.");
    }
    if (
      to === "result_accepted" &&
      input.transition.score < current.verifierAcceptanceThreshold
    ) {
      throw new Error("An accepted delegation evaluation must meet its threshold.");
    }
    const body = {
      evaluatorPrincipalId: input.transition.evaluatorPrincipalId,
      evaluatorAgentId: input.transition.evaluatorAgentId,
      evaluatorDefinitionVersion: input.transition.evaluatorDefinitionVersion,
      verdict: to === "result_accepted" ? "accepted" as const : "rejected" as const,
      score: input.transition.score,
      proposalReceiptSha256: proposal.proposalReceiptSha256,
      evaluatedAt: at,
    };
    evaluation = parentEvaluationSchema.parse({
      ...body,
      evaluationSha256: input.transition.evaluationSha256 || canonicalJsonSha256(body),
    });
  }

  const terminalAt = isTerminalDelegationTaskState(to) ? at : null;
  const next = taskWithDigest({
    ...withoutTaskDigest(current),
    state: to,
    lifecycleRevision: current.lifecycleRevision + 1,
    proposal,
    evaluation,
    updatedAt: at,
    terminalAt,
  });
  const toolExecutionIds = to === "completed_proposed"
    ? [...(proposal?.toolExecutionIds || [])]
    : input.transition.to === "waiting" && input.transition.toolExecutionId
      ? [input.transition.toolExecutionId]
      : [];
  const detailSha256 = canonicalJsonSha256(transitionDetail(input.transition));
  const eventBody = {
    schemaVersion: 1 as const,
    version: DELEGATION_TASK_EVENT_VERSION,
    eventId: `delegation-event:${current.delegationId}:${next.lifecycleRevision}`,
    taskId: current.taskId,
    tenantId: current.tenantId,
    ownerActorId: current.ownerActorId,
    parentExecutionId: current.parentExecutionId,
    parentDelegationId: current.parentDelegationId,
    delegationId: current.delegationId,
    delegatePrincipalId: current.delegatePrincipalId,
    delegateAgentId: current.delegateAgentId,
    delegateDefinitionVersion: current.delegateDefinitionVersion,
    from: current.state,
    to,
    lifecycleRevision: next.lifecycleRevision,
    detailSha256,
    toolExecutionIds,
    at,
  };
  const event = delegationTaskEventV1Schema.parse({
    ...eventBody,
    eventSha256: canonicalJsonSha256(eventBody),
  });
  return Object.freeze({ task: next, event: deepFreeze(event) });
}

export function initialDelegationTaskEventV1(taskValue: DelegationTaskV1) {
  const task = parseDelegationTaskV1(taskValue);
  const body = {
    schemaVersion: 1 as const,
    version: DELEGATION_TASK_EVENT_VERSION,
    eventId: `delegation-event:${task.delegationId}:0`,
    taskId: task.taskId,
    tenantId: task.tenantId,
    ownerActorId: task.ownerActorId,
    parentExecutionId: task.parentExecutionId,
    parentDelegationId: task.parentDelegationId,
    delegationId: task.delegationId,
    delegatePrincipalId: task.delegatePrincipalId,
    delegateAgentId: task.delegateAgentId,
    delegateDefinitionVersion: task.delegateDefinitionVersion,
    from: null,
    to: "proposed" as const,
    lifecycleRevision: 0,
    detailSha256: task.contractSha256,
    toolExecutionIds: [],
    at: task.createdAt,
  };
  return deepFreeze(delegationTaskEventV1Schema.parse({
    ...body,
    eventSha256: canonicalJsonSha256(body),
  }));
}

export function parseDelegationTaskV1(value: unknown): DelegationTaskV1 {
  return deepFreeze(delegationTaskV1Schema.parse(value));
}

export function isTerminalDelegationTaskState(state: DelegationTaskState) {
  return ["result_accepted", "rejected", "canceled", "expired"].includes(state);
}

function taskWithDigest(
  body: Omit<DelegationTaskV1, "taskSha256">,
): DelegationTaskV1 {
  return parseDelegationTaskV1({ ...body, taskSha256: canonicalJsonSha256(body) });
}

function withoutTaskDigest(task: DelegationTaskV1) {
  const { taskSha256: _taskSha256, ...body } = task;
  void _taskSha256;
  return body;
}

function transitionDetail(transition: DelegationTaskTransition) {
  if (transition.to === "completed_proposed") {
    return {
      to: transition.to,
      proposalReceiptSha256: transition.proposalReceiptSha256,
      acceptanceChecksSha256: transition.acceptanceChecksSha256,
      artifactSha256s: [...(transition.artifactSha256s || [])],
      evidenceIds: [...(transition.evidenceIds || [])],
      toolExecutionIds: [...(transition.toolExecutionIds || [])],
    };
  }
  return transition;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
