import { z } from "zod";

import type { DelegationContractV1 } from "@/lib/delegation/contracts";
import {
  DEFAULT_AGENT_RUN_BUDGET_LIMITS,
  RUN_BUDGET_DIMENSIONS,
  runBudgetCountersV1Schema,
  type RunBudgetCountersV1,
} from "@/lib/runs/budgets";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { A2APeerRolloutV1 } from "@/lib/a2a/rollout";

export const A2A_SAFETY_POLICY_VERSION = "p8.7-a2a-safety-policy:1" as const;
export const A2A_SAFETY_RESERVATION_VERSION =
  "p8.7-a2a-safety-reservation:1" as const;

export const EXTERNAL_A2A_BUDGET_LIMITS: RunBudgetCountersV1 = Object.freeze({
  modelTurns: 2,
  tokens: 12_000,
  costMicrousd: 500_000,
  wallTimeMs: 180_000,
  toolCalls: 4,
  browserActions: 0,
  agents: 1,
  fanOut: 0,
  retries: 1,
  replans: 0,
});

export const EXTERNAL_A2A_SAFETY_POLICY = Object.freeze({
  version: A2A_SAFETY_POLICY_VERSION,
  trustTier: "external_untrusted" as const,
  forceMutationApproval: true as const,
  canRedelegate: false as const,
  maxRecursionDepth: 2,
  maxActiveFanOutPerParent: 2,
  maxActiveTasksPerRoot: 6,
  maxReservedCostPerRootMicrousd: 1_000_000,
  maxTaskDurationMs: 300_000,
  progressTimeoutMs: 90_000,
  budgetLimits: EXTERNAL_A2A_BUDGET_LIMITS,
});

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

export const a2aSafetyReservationV1Schema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(A2A_SAFETY_RESERVATION_VERSION),
  safetyId: idSchema,
  safetySha256: sha256Schema,
  tenantId: idSchema,
  ownerActorId: idSchema,
  internalTaskId: idSchema,
  delegationId: idSchema,
  parentDelegationId: idSchema.nullable(),
  rootDelegationId: idSchema,
  peerId: idSchema,
  rolloutId: idSchema,
  rolloutSha256: sha256Schema,
  contractSha256: sha256Schema,
  recursionDepth: z.number().int().min(0).max(2),
  ancestorDelegationIds: z.array(idSchema).max(2),
  peerTrail: z.array(idSchema).min(1).max(3),
  trustTier: z.literal("external_untrusted"),
  forceMutationApproval: z.literal(true),
  canRedelegate: z.literal(false),
  budgets: runBudgetCountersV1Schema,
  maxToolCalls: z.number().int().min(0).max(4),
  deadlineAt: timestampSchema,
  progressTimeoutMs: z.number().int().min(1_000).max(300_000),
  createdAt: timestampSchema,
}).strict().superRefine((value, context) => {
  const { safetyId, safetySha256, ...body } = value;
  if (
    safetySha256 !== canonicalJsonSha256(body) ||
    safetyId !== `a2a-safety:${safetySha256}`
  ) {
    context.addIssue({
      code: "custom",
      path: ["safetySha256"],
      message: "The A2A safety reservation integrity is invalid.",
    });
  }
  if (
    value.ancestorDelegationIds.length !== value.recursionDepth ||
    value.peerTrail.length !== value.recursionDepth + 1 ||
    value.peerTrail.at(-1) !== value.peerId ||
    new Set(value.ancestorDelegationIds).size !== value.ancestorDelegationIds.length ||
    new Set(value.peerTrail).size !== value.peerTrail.length ||
    Date.parse(value.createdAt) >= Date.parse(value.deadlineAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["recursionDepth"],
      message: "The A2A safety lineage or authority window is invalid.",
    });
  }
});

export type A2ASafetyReservationV1 = Readonly<
  z.infer<typeof a2aSafetyReservationV1Schema>
>;

export type A2ASafetyLineageV1 = Readonly<{
  ancestorDelegationIds: readonly string[];
  ancestorPeerIds: readonly string[];
  rootDelegationId: string;
  activeSiblingCount: number;
  activeRootTaskCount: number;
  activeRootReservedCostMicrousd: number;
}>;

export class A2ASafetyError extends Error {
  readonly code = "a2a_safety_denied";

  constructor(
    message: string,
    readonly reason:
      | "budget"
      | "cycle"
      | "deadline"
      | "fan_out"
      | "recursion"
      | "root_budget",
  ) {
    super(message);
    this.name = "A2ASafetyError";
  }
}

export function buildA2ASafetyReservationV1(input: {
  contract: DelegationContractV1;
  internalTaskId: string;
  rollout: A2APeerRolloutV1;
  lineage: A2ASafetyLineageV1;
  createdAt?: string;
}) {
  const createdAt = input.createdAt || new Date().toISOString();
  assertExternalA2ASafety({
    contract: input.contract,
    rollout: input.rollout,
    lineage: input.lineage,
    now: createdAt,
  });
  const body = {
    schemaVersion: 1 as const,
    version: A2A_SAFETY_RESERVATION_VERSION,
    tenantId: input.contract.scope.tenantId,
    ownerActorId: input.contract.scope.initiatingActorId,
    internalTaskId: input.internalTaskId,
    delegationId: input.contract.delegationId,
    parentDelegationId: input.contract.scope.parentDelegationId,
    rootDelegationId: input.lineage.rootDelegationId,
    peerId: input.rollout.peerId,
    rolloutId: input.rollout.rolloutId,
    rolloutSha256: input.rollout.rolloutSha256,
    contractSha256: input.contract.contractSha256,
    recursionDepth: input.lineage.ancestorDelegationIds.length,
    ancestorDelegationIds: [...input.lineage.ancestorDelegationIds],
    peerTrail: [...input.lineage.ancestorPeerIds, input.rollout.peerId],
    trustTier: "external_untrusted" as const,
    forceMutationApproval: true as const,
    canRedelegate: false as const,
    budgets: input.contract.budgets,
    maxToolCalls: Math.min(
      input.contract.budgets.toolCalls,
      EXTERNAL_A2A_SAFETY_POLICY.budgetLimits.toolCalls,
    ),
    deadlineAt: input.contract.deadline.completeBy,
    progressTimeoutMs: Math.min(
      EXTERNAL_A2A_SAFETY_POLICY.progressTimeoutMs,
      input.contract.budgets.wallTimeMs,
    ),
    createdAt,
  };
  const safetySha256 = canonicalJsonSha256(body);
  return parseA2ASafetyReservationV1({
    ...body,
    safetyId: `a2a-safety:${safetySha256}`,
    safetySha256,
  });
}

export function assertExternalA2ASafety(input: {
  contract: DelegationContractV1;
  rollout: A2APeerRolloutV1;
  lineage: A2ASafetyLineageV1;
  now?: string;
}) {
  const { contract, rollout, lineage } = input;
  for (const dimension of RUN_BUDGET_DIMENSIONS) {
    const requested = contract.budgets[dimension];
    const externalLimit = EXTERNAL_A2A_SAFETY_POLICY.budgetLimits[dimension];
    if (requested > externalLimit) {
      throw new A2ASafetyError(
        `External delegation ${dimension} budget exceeds its lower-authority limit.`,
        "budget",
      );
    }
  }
  const nowMs = Date.parse(input.now || new Date().toISOString());
  const createdAtMs = Date.parse(contract.deadline.createdAt);
  const completeByMs = Date.parse(contract.deadline.completeBy);
  const maxDurationMs = Math.min(
    rollout.maxTaskDurationMs,
    EXTERNAL_A2A_SAFETY_POLICY.maxTaskDurationMs,
  );
  if (
    !Number.isFinite(nowMs) ||
    nowMs >= completeByMs ||
    completeByMs - createdAtMs > maxDurationMs
  ) {
    throw new A2ASafetyError(
      "External delegation deadline exceeds its bounded authority window.",
      "deadline",
    );
  }
  if (
    lineage.ancestorDelegationIds.length >
      EXTERNAL_A2A_SAFETY_POLICY.maxRecursionDepth
  ) {
    throw new A2ASafetyError(
      "External delegation recursion depth is exhausted.",
      "recursion",
    );
  }
  if (lineage.ancestorPeerIds.includes(rollout.peerId)) {
    throw new A2ASafetyError(
      "External delegation cycle detected for this peer lineage.",
      "cycle",
    );
  }
  if (
    lineage.activeSiblingCount >=
      EXTERNAL_A2A_SAFETY_POLICY.maxActiveFanOutPerParent
  ) {
    throw new A2ASafetyError(
      "External delegation fan-out is exhausted for this parent.",
      "fan_out",
    );
  }
  if (
    lineage.activeRootTaskCount >=
      EXTERNAL_A2A_SAFETY_POLICY.maxActiveTasksPerRoot ||
    lineage.activeRootReservedCostMicrousd + contract.budgets.costMicrousd >
      EXTERNAL_A2A_SAFETY_POLICY.maxReservedCostPerRootMicrousd
  ) {
    throw new A2ASafetyError(
      "External delegation root budget is exhausted.",
      "root_budget",
    );
  }
  return true;
}

export function externalA2ABudgetLimits(
  rollout: Pick<A2APeerRolloutV1, "maxTaskDurationMs">,
) {
  return runBudgetCountersV1Schema.parse({
    ...EXTERNAL_A2A_BUDGET_LIMITS,
    wallTimeMs: Math.min(
      EXTERNAL_A2A_BUDGET_LIMITS.wallTimeMs,
      rollout.maxTaskDurationMs,
    ),
  });
}

export function parseA2ASafetyReservationV1(value: unknown) {
  return deepFreeze(a2aSafetyReservationV1Schema.parse(value));
}

for (const dimension of RUN_BUDGET_DIMENSIONS) {
  if (
    EXTERNAL_A2A_BUDGET_LIMITS[dimension] >
    DEFAULT_AGENT_RUN_BUDGET_LIMITS[dimension]
  ) {
    throw new Error(`External A2A ${dimension} authority exceeds the local default.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
