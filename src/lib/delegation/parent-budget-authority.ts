import { z } from "zod";

import {
  RUN_BUDGET_DIMENSIONS,
  remainingRunBudget,
  runBudgetCountersV1Schema,
  runBudgetStateV1Schema,
  type RunBudgetCountersV1,
  type RunBudgetStateV1,
} from "@/lib/runs/budgets";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import {
  canonicalJsonSha256,
  idempotencyKeySha256,
} from "@/lib/tools/effect-receipt";
import { governedToolExecutionId } from "@/lib/tools/execution-id";

export const PARENT_DELEGATION_BUDGET_AUTHORITY_VERSION =
  "parent-delegation-budget-authority:1" as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const authorityBodySchema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(PARENT_DELEGATION_BUDGET_AUTHORITY_VERSION),
  tenantId: idSchema,
  initiatingActorId: idSchema,
  parentExecutionId: idSchema,
  parentPrincipalId: idSchema,
  idempotencyKeySha256: sha256Schema,
  reservedAt: z.string().datetime({ offset: true }),
  parentBudgetLimits: runBudgetCountersV1Schema,
  parentBudgetUsedBefore: runBudgetCountersV1Schema,
  parentBudgetRemainingBefore: runBudgetCountersV1Schema,
  childRootReservation: runBudgetCountersV1Schema,
  parentToolReservation: runBudgetCountersV1Schema,
  parentBudgetUsedAfter: runBudgetCountersV1Schema,
  parentBudgetRemainingAfter: runBudgetCountersV1Schema,
  harnessBudgetSha256: sha256Schema,
  reservationSha256: sha256Schema,
}).strict();

export const parentDelegationBudgetAuthorityV1Schema = authorityBodySchema
  .extend({ authoritySha256: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const { authoritySha256, ...body } = value;
    if (canonicalJsonSha256(body) !== authoritySha256) {
      context.addIssue({
        code: "custom",
        path: ["authoritySha256"],
        message: "Parent delegation budget authority digest is invalid.",
      });
    }
    if (
      value.harnessBudgetSha256 !==
        canonicalJsonSha256(value.parentBudgetLimits) ||
      value.reservationSha256 !== canonicalJsonSha256({
        childRootReservation: value.childRootReservation,
        parentToolReservation: value.parentToolReservation,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["reservationSha256"],
        message: "Parent delegation budget reservation binding is invalid.",
      });
    }
    for (const dimension of RUN_BUDGET_DIMENSIONS) {
      if (
        value.parentBudgetRemainingBefore[dimension] !==
          value.parentBudgetLimits[dimension] -
            value.parentBudgetUsedBefore[dimension] ||
        value.parentBudgetUsedAfter[dimension] !==
          value.parentBudgetUsedBefore[dimension] +
            value.parentToolReservation[dimension] ||
        value.parentBudgetRemainingAfter[dimension] !==
          value.parentBudgetLimits[dimension] -
            value.parentBudgetUsedAfter[dimension] ||
        value.parentToolReservation[dimension] <
          value.childRootReservation[dimension]
      ) {
        context.addIssue({
          code: "custom",
          path: ["parentBudgetUsedAfter", dimension],
          message: "Parent delegation budget counters do not reconcile.",
        });
      }
    }
  });

export type ParentDelegationBudgetAuthorityV1 = Readonly<
  z.infer<typeof parentDelegationBudgetAuthorityV1Schema>
>;

/**
 * The governed executor persists an idempotent tool intent before dispatching
 * a first-party application mutation. The application service therefore sees
 * the durable execution ID, not the model loop's raw call key. Bind the live
 * parent reservation to that exact identity so the bridge crosses the intent
 * boundary without widening authority.
 */
export function parentDelegationAppServiceIdempotencyKey(input: {
  tenantId: string;
  toolCallIdempotencyKey: string;
}) {
  return governedToolExecutionId(
    input.tenantId,
    input.toolCallIdempotencyKey,
  );
}

/**
 * Builds the in-process authority bridge after the parent loop has made its
 * non-refundable reservation. The bridge contains counters and digests only;
 * it carries no prompt, model output, credential, or private reasoning.
 */
export function buildParentDelegationBudgetAuthorityV1(input: {
  parentExecutionScope: ExecutionScope;
  idempotencyKey: string;
  before: RunBudgetStateV1;
  after: RunBudgetStateV1;
  childRootReservation: RunBudgetCountersV1;
  parentToolReservation: RunBudgetCountersV1;
  reservedAt?: string;
}): ParentDelegationBudgetAuthorityV1 {
  const scope = input.parentExecutionScope;
  if (
    scope.executingPrincipalType !== "agent" ||
    !scope.initiatingActorId ||
    !scope.executingPrincipalId ||
    scope.delegationId !== null ||
    scope.correlationId.length === 0
  ) {
    throw new Error(
      "A root identity-bound Agent scope is required to reserve child authority.",
    );
  }
  const before = runBudgetStateV1Schema.parse(input.before);
  const after = runBudgetStateV1Schema.parse(input.after);
  const childRootReservation = runBudgetCountersV1Schema.parse(
    input.childRootReservation,
  );
  const parentToolReservation = runBudgetCountersV1Schema.parse(
    input.parentToolReservation,
  );
  if (
    canonicalJsonSha256(before.limits) !== canonicalJsonSha256(after.limits) ||
    before.startedAt !== after.startedAt
  ) {
    throw new Error("The parent budget changed while reserving a child.");
  }
  const reservedAt = input.reservedAt || new Date().toISOString();
  const body = authorityBodySchema.parse({
    schemaVersion: 1,
    version: PARENT_DELEGATION_BUDGET_AUTHORITY_VERSION,
    tenantId: scope.tenantId,
    initiatingActorId: scope.initiatingActorId,
    parentExecutionId: scope.correlationId,
    parentPrincipalId: scope.executingPrincipalId,
    idempotencyKeySha256: idempotencyKeySha256({
      tenantId: scope.tenantId,
      idempotencyKey: input.idempotencyKey,
    }),
    reservedAt,
    parentBudgetLimits: before.limits,
    parentBudgetUsedBefore: before.used,
    parentBudgetRemainingBefore: remainingRunBudget(
      before,
      Date.parse(reservedAt),
    ),
    childRootReservation,
    parentToolReservation,
    parentBudgetUsedAfter: after.used,
    parentBudgetRemainingAfter: remainingRunBudget(
      after,
      Date.parse(reservedAt),
    ),
    harnessBudgetSha256: canonicalJsonSha256(before.limits),
    reservationSha256: canonicalJsonSha256({
      childRootReservation,
      parentToolReservation,
    }),
  });
  return deepFreeze(parentDelegationBudgetAuthorityV1Schema.parse({
    ...body,
    authoritySha256: canonicalJsonSha256(body),
  }));
}

const activeAuthorities = new Map<string, ParentDelegationBudgetAuthorityV1>();

/** Makes exactly one live parent-loop reservation visible to the app tool. */
export async function withParentDelegationBudgetAuthority<T>(
  authority: ParentDelegationBudgetAuthorityV1 | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!authority) return operation();
  const parsed = parentDelegationBudgetAuthorityV1Schema.parse(authority);
  const key = authorityKey(parsed);
  const current = activeAuthorities.get(key);
  if (current && current.authoritySha256 !== parsed.authoritySha256) {
    throw new Error(
      "A delegation idempotency key already has another parent budget reservation.",
    );
  }
  activeAuthorities.set(key, parsed);
  try {
    return await operation();
  } finally {
    if (activeAuthorities.get(key)?.authoritySha256 === parsed.authoritySha256) {
      activeAuthorities.delete(key);
    }
  }
}

export function resolveParentDelegationBudgetAuthority(input: {
  tenantId: string;
  actorId: string;
  parentExecutionId: string;
  parentPrincipalId: string;
  idempotencyKey: string;
  explicit?: ParentDelegationBudgetAuthorityV1;
}) {
  const keySha256 = idempotencyKeySha256({
    tenantId: input.tenantId,
    idempotencyKey: input.idempotencyKey,
  });
  const candidate = input.explicit || activeAuthorities.get(authorityKey({
    tenantId: input.tenantId,
    initiatingActorId: input.actorId,
    parentExecutionId: input.parentExecutionId,
    idempotencyKeySha256: keySha256,
  }));
  if (!candidate) {
    throw new Error(
      "Dynamic delegation requires a live parent-loop budget reservation.",
    );
  }
  const parsed = parentDelegationBudgetAuthorityV1Schema.parse(candidate);
  if (
    parsed.tenantId !== input.tenantId ||
    parsed.initiatingActorId !== input.actorId ||
    parsed.parentExecutionId !== input.parentExecutionId ||
    parsed.parentPrincipalId !== input.parentPrincipalId ||
    parsed.idempotencyKeySha256 !== keySha256
  ) {
    throw new Error(
      "The parent-loop budget reservation does not match this delegation.",
    );
  }
  return parsed;
}

function authorityKey(input: Pick<
  ParentDelegationBudgetAuthorityV1,
  | "tenantId"
  | "initiatingActorId"
  | "parentExecutionId"
  | "idempotencyKeySha256"
>) {
  return [
    input.tenantId,
    input.initiatingActorId,
    input.parentExecutionId,
    input.idempotencyKeySha256,
  ].join("\0");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
