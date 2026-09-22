import { z } from "zod";

import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const POLICY_LEASE_SCHEMA_VERSION = 1 as const;
export const POLICY_LEASE_CONSUMPTION_SCHEMA_VERSION = 1 as const;
export const POLICY_LEASE_MAX_TTL_MS = 15 * 60 * 1_000;

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);
const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const policyLeasePrincipalBindingV1Schema = z.object({
  kind: z.enum(["agent", "system"]),
  id: opaqueIdSchema,
  generation: positiveSafeIntegerSchema,
}).strict().superRefine((principal, context) => {
  if (
    (principal.kind === "agent" && !principal.id.startsWith("agent:")) ||
    (principal.kind === "system" && !principal.id.startsWith("service:"))
  ) {
    context.addIssue({
      code: "custom",
      path: ["id"],
      message: "Policy-lease principal kind and ID are inconsistent.",
    });
  }
});

const leaseIdentitySchema = z.object({
  schemaVersion: z.literal(POLICY_LEASE_SCHEMA_VERSION),
  leaseKind: z.literal("policy_lease"),
  executionId: opaqueIdSchema,
  toolId: opaqueIdSchema,
  inputSha256: sha256Schema,
  targetSha256: sha256Schema,
  principal: policyLeasePrincipalBindingV1Schema,
  policySha256: sha256Schema,
  influenceManifestSha256: sha256Schema,
  issuedAt: canonicalTimestampSchema,
  expiresAt: canonicalTimestampSchema,
  maximumUses: z.literal(1),
  leaseGrantsAuthority: z.literal(false),
}).strict().superRefine((lease, context) => {
  const issuedAt = Date.parse(lease.issuedAt);
  const expiresAt = Date.parse(lease.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > POLICY_LEASE_MAX_TTL_MS) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Policy lease expiry must be after issue and within the maximum TTL.",
    });
  }
});

const policyLeaseBodyV1Schema = leaseIdentitySchema.extend({
  leaseId: z.string().regex(/^policy_lease_[a-f0-9]{48}$/),
}).strict().superRefine((lease, context) => {
  const identity = leaseIdentity(lease);
  if (lease.leaseId !== derivedLeaseId(identity)) {
    context.addIssue({
      code: "custom",
      path: ["leaseId"],
      message: "Policy lease ID does not match its immutable binding.",
    });
  }
});

export const policyLeaseV1Schema = policyLeaseBodyV1Schema.extend({
  leaseSha256: sha256Schema,
}).strict().superRefine((lease, context) => {
  const { leaseSha256, ...body } = lease;
  if (leaseSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({
      code: "custom",
      path: ["leaseSha256"],
      message: "Policy lease digest does not match its body.",
    });
  }
});

export type PolicyLeasePrincipalBindingV1 = Readonly<
  z.infer<typeof policyLeasePrincipalBindingV1Schema>
>;
export type PolicyLeaseV1 = Readonly<z.infer<typeof policyLeaseV1Schema>>;

export type BuildPolicyLeaseV1Input = Readonly<{
  executionId: string;
  toolId: string;
  inputSha256: string;
  targetSha256: string;
  principal: PolicyLeasePrincipalBindingV1;
  policySha256: string;
  influenceManifestSha256: string;
  issuedAt: string;
  expiresAt: string;
}>;

export function buildPolicyLeaseV1(input: BuildPolicyLeaseV1Input): PolicyLeaseV1 {
  const identity = leaseIdentitySchema.parse({
    schemaVersion: POLICY_LEASE_SCHEMA_VERSION,
    leaseKind: "policy_lease",
    ...input,
    maximumUses: 1,
    leaseGrantsAuthority: false,
  });
  const body = policyLeaseBodyV1Schema.parse({
    ...identity,
    leaseId: derivedLeaseId(identity),
  });
  return Object.freeze(policyLeaseV1Schema.parse({
    ...body,
    leaseSha256: canonicalJsonSha256(body),
  }));
}

export function parsePolicyLeaseV1(value: unknown): PolicyLeaseV1 {
  return Object.freeze(policyLeaseV1Schema.parse(value));
}

export const policyLeaseConsumptionAttemptV1Schema = z.object({
  executionId: opaqueIdSchema,
  toolId: opaqueIdSchema,
  inputSha256: sha256Schema,
  targetSha256: sha256Schema,
  principal: policyLeasePrincipalBindingV1Schema,
  policySha256: sha256Schema,
  influenceManifestSha256: sha256Schema,
  consumedAt: canonicalTimestampSchema,
}).strict();

export type PolicyLeaseConsumptionAttemptV1 = Readonly<
  z.infer<typeof policyLeaseConsumptionAttemptV1Schema>
>;

const consumptionReceiptBodySchema = z.object({
  schemaVersion: z.literal(POLICY_LEASE_CONSUMPTION_SCHEMA_VERSION),
  receiptKind: z.literal("policy_lease_consumption"),
  leaseId: z.string().regex(/^policy_lease_[a-f0-9]{48}$/),
  leaseSha256: sha256Schema,
  executionId: opaqueIdSchema,
  bindingSha256: sha256Schema,
  consumedAt: canonicalTimestampSchema,
  singleUseConsumed: z.literal(true),
  receiptGrantsAuthority: z.literal(false),
}).strict();

export const policyLeaseConsumptionV1Schema = consumptionReceiptBodySchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((receipt, context) => {
  const { receiptSha256, ...body } = receipt;
  if (receiptSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({
      code: "custom",
      path: ["receiptSha256"],
      message: "Policy-lease consumption digest does not match its body.",
    });
  }
});

export type PolicyLeaseConsumptionV1 = Readonly<
  z.infer<typeof policyLeaseConsumptionV1Schema>
>;

export class PolicyLeaseValidationError extends Error {
  constructor(
    public readonly code:
      | "not_yet_valid"
      | "expired"
      | "binding_mismatch"
      | "already_consumed"
      | "prior_consumption_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "PolicyLeaseValidationError";
  }
}

/**
 * Validates one exact lease consumption and returns a content-free receipt.
 * The caller must later persist that receipt atomically with its effect claim;
 * this pure primitive deliberately provides no concurrency or effect authority.
 */
export function consumePolicyLeaseV1(input: {
  lease: unknown;
  attempt: PolicyLeaseConsumptionAttemptV1;
  priorConsumption?: unknown;
}): PolicyLeaseConsumptionV1 {
  const lease = parsePolicyLeaseV1(input.lease);
  const attempt = policyLeaseConsumptionAttemptV1Schema.parse(input.attempt);

  if (input.priorConsumption !== undefined) {
    const prior = policyLeaseConsumptionV1Schema.parse(input.priorConsumption);
    if (prior.leaseId !== lease.leaseId || prior.leaseSha256 !== lease.leaseSha256) {
      throw new PolicyLeaseValidationError(
        "prior_consumption_mismatch",
        "The prior consumption does not belong to this policy lease.",
      );
    }
    throw new PolicyLeaseValidationError(
      "already_consumed",
      "This policy lease has already been consumed.",
    );
  }

  const consumedAt = Date.parse(attempt.consumedAt);
  if (consumedAt < Date.parse(lease.issuedAt)) {
    throw new PolicyLeaseValidationError(
      "not_yet_valid",
      "The policy lease is not valid before its issue time.",
    );
  }
  if (consumedAt >= Date.parse(lease.expiresAt)) {
    throw new PolicyLeaseValidationError(
      "expired",
      "The policy lease has expired.",
    );
  }

  const expectedBinding = leaseBinding(lease);
  const actualBinding = attemptBinding(attempt);
  if (canonicalJsonSha256(expectedBinding) !== canonicalJsonSha256(actualBinding)) {
    throw new PolicyLeaseValidationError(
      "binding_mismatch",
      "The policy lease does not match this exact execution attempt.",
    );
  }

  const body = consumptionReceiptBodySchema.parse({
    schemaVersion: POLICY_LEASE_CONSUMPTION_SCHEMA_VERSION,
    receiptKind: "policy_lease_consumption",
    leaseId: lease.leaseId,
    leaseSha256: lease.leaseSha256,
    executionId: lease.executionId,
    bindingSha256: canonicalJsonSha256(actualBinding),
    consumedAt: attempt.consumedAt,
    singleUseConsumed: true,
    receiptGrantsAuthority: false,
  });
  return Object.freeze(policyLeaseConsumptionV1Schema.parse({
    ...body,
    receiptSha256: canonicalJsonSha256(body),
  }));
}

function derivedLeaseId(identity: z.infer<typeof leaseIdentitySchema>) {
  return `policy_lease_${canonicalJsonSha256(identity).slice(0, 48)}`;
}

function leaseIdentity(lease: z.infer<typeof policyLeaseBodyV1Schema>) {
  return leaseIdentitySchema.parse({
    schemaVersion: lease.schemaVersion,
    leaseKind: lease.leaseKind,
    executionId: lease.executionId,
    toolId: lease.toolId,
    inputSha256: lease.inputSha256,
    targetSha256: lease.targetSha256,
    principal: lease.principal,
    policySha256: lease.policySha256,
    influenceManifestSha256: lease.influenceManifestSha256,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    maximumUses: lease.maximumUses,
    leaseGrantsAuthority: lease.leaseGrantsAuthority,
  });
}

function leaseBinding(lease: PolicyLeaseV1) {
  return {
    executionId: lease.executionId,
    toolId: lease.toolId,
    inputSha256: lease.inputSha256,
    targetSha256: lease.targetSha256,
    principal: lease.principal,
    policySha256: lease.policySha256,
    influenceManifestSha256: lease.influenceManifestSha256,
  };
}

function attemptBinding(attempt: PolicyLeaseConsumptionAttemptV1) {
  return {
    executionId: attempt.executionId,
    toolId: attempt.toolId,
    inputSha256: attempt.inputSha256,
    targetSha256: attempt.targetSha256,
    principal: attempt.principal,
    policySha256: attempt.policySha256,
    influenceManifestSha256: attempt.influenceManifestSha256,
  };
}
