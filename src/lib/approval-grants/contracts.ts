import { z } from "zod";

import type { ExecutionPrincipalType } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const APPROVAL_GRANT_CONTRACT_VERSION =
  "p9.4-approval-grant:1" as const;
export const APPROVAL_GRANT_CLAIM_VERSION =
  "p9.4-approval-grant-claim:1" as const;
export const APPROVAL_GRANT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const APPROVAL_GRANT_MAX_USES = 100;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const opaqueIdSchema = z.string().trim().min(1).max(500);
const principalTypeSchema = z.enum(["user", "agent", "system"]);
const riskLevelSchema = z.union([z.literal(1), z.literal(2)]);

const approvalGrantBindingBodySchema = z.object({
  version: z.literal(APPROVAL_GRANT_CONTRACT_VERSION),
  grantId: z.string().regex(/^grant:[0-9a-f-]{36}$/),
  tenantId: opaqueIdSchema,
  ownerActorId: opaqueIdSchema,
  approvedByActorId: opaqueIdSchema,
  executingPrincipalType: principalTypeSchema,
  executingPrincipalId: opaqueIdSchema,
  planId: opaqueIdSchema,
  planSha256: sha256Schema,
  domain: opaqueIdSchema,
  actionClass: opaqueIdSchema,
  toolId: opaqueIdSchema,
  toolContractSha256: sha256Schema,
  targetSha256: sha256Schema,
  riskLevel: riskLevelSchema,
  reversible: z.literal(true),
  sourceApprovalId: opaqueIdSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  maxUses: z.number().int().min(1).max(APPROVAL_GRANT_MAX_USES),
}).strict();

export const approvalGrantStateSchema = z.enum([
  "active",
  "exhausted",
  "revoked",
  "expired",
]);

export const approvalGrantV1Schema = approvalGrantBindingBodySchema.extend({
  bindingSha256: sha256Schema,
  usedUses: z.number().int().min(0).max(APPROVAL_GRANT_MAX_USES),
  state: approvalGrantStateSchema,
  lifecycleRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  lastUsedAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
}).strict().superRefine((value, refinement) => {
  if (value.bindingSha256 !== approvalGrantBindingSha256(value)) {
    refinement.addIssue({
      code: "custom",
      path: ["bindingSha256"],
      message: "Approval grant binding digest does not match.",
    });
  }
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > APPROVAL_GRANT_MAX_LIFETIME_MS
  ) {
    refinement.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Approval grants must expire within 24 hours of issue.",
    });
  }
  if (value.usedUses > value.maxUses) {
    refinement.addIssue({
      code: "custom",
      path: ["usedUses"],
      message: "Approval grant use count exceeds its budget.",
    });
  }
  if (value.state === "exhausted" && value.usedUses !== value.maxUses) {
    refinement.addIssue({
      code: "custom",
      path: ["state"],
      message: "Only a fully consumed grant may be exhausted.",
    });
  }
  if (value.state === "active" && value.usedUses >= value.maxUses) {
    refinement.addIssue({
      code: "custom",
      path: ["state"],
      message: "A fully consumed grant cannot remain active.",
    });
  }
  if ((value.state === "revoked") !== Boolean(value.revokedAt)) {
    refinement.addIssue({
      code: "custom",
      path: ["revokedAt"],
      message: "Revocation time must match the revoked state.",
    });
  }
});

const approvalGrantClaimBodySchema = z.object({
  version: z.literal(APPROVAL_GRANT_CLAIM_VERSION),
  claimId: z.string().regex(/^claim:[0-9a-f-]{36}$/),
  grantId: z.string().regex(/^grant:[0-9a-f-]{36}$/),
  grantBindingSha256: sha256Schema,
  tenantId: opaqueIdSchema,
  ownerActorId: opaqueIdSchema,
  executionKeySha256: sha256Schema,
  useOrdinal: z.number().int().min(1).max(APPROVAL_GRANT_MAX_USES),
  claimedAt: timestampSchema,
}).strict();

export const approvalGrantClaimV1Schema = approvalGrantClaimBodySchema.extend({
  claimSha256: sha256Schema,
}).strict().superRefine((value, refinement) => {
  const { claimSha256, ...body } = value;
  if (claimSha256 !== canonicalJsonSha256(body)) {
    refinement.addIssue({
      code: "custom",
      path: ["claimSha256"],
      message: "Approval grant claim digest does not match.",
    });
  }
});

export type ApprovalGrantV1 = z.infer<typeof approvalGrantV1Schema>;
export type ApprovalGrantClaimV1 = z.infer<typeof approvalGrantClaimV1Schema>;
export type ApprovalGrantState = z.infer<typeof approvalGrantStateSchema>;

export type ApprovalGrantRequest = Readonly<{
  tenantId: string;
  ownerActorId: string;
  executingPrincipalType: ExecutionPrincipalType;
  executingPrincipalId: string;
  planId: string;
  planSha256: string;
  domain: string;
  actionClass: string;
  toolId: string;
  toolContractSha256: string;
  targetSha256: string;
  riskLevel: 1 | 2;
  reversible: true;
}>;

export type ApprovalGrantDecision = Readonly<
  | { allowed: true; reason: "exact_grant" }
  | {
      allowed: false;
      reason:
        | "binding_changed"
        | "expired"
        | "budget_exhausted"
        | "inactive";
    }
>;

export function buildApprovalGrantV1(
  input: Omit<ApprovalGrantV1, "bindingSha256">,
) {
  return approvalGrantV1Schema.parse({
    ...input,
    bindingSha256: approvalGrantBindingSha256(input),
  });
}

export function buildApprovalGrantClaimV1(
  input: Omit<ApprovalGrantClaimV1, "claimSha256">,
) {
  return approvalGrantClaimV1Schema.parse({
    ...input,
    claimSha256: canonicalJsonSha256(input),
  });
}

export function approvalGrantBindingSha256(
  input: z.input<typeof approvalGrantBindingBodySchema> | ApprovalGrantV1,
) {
  const {
    bindingSha256: _bindingSha256,
    usedUses: _usedUses,
    state: _state,
    lifecycleRevision: _lifecycleRevision,
    lastUsedAt: _lastUsedAt,
    revokedAt: _revokedAt,
    ...binding
  } = input as ApprovalGrantV1;
  void _bindingSha256;
  void _usedUses;
  void _state;
  void _lifecycleRevision;
  void _lastUsedAt;
  void _revokedAt;
  return canonicalJsonSha256(approvalGrantBindingBodySchema.parse(binding));
}

export function evaluateApprovalGrant(
  grant: ApprovalGrantV1,
  request: ApprovalGrantRequest,
  now = new Date(),
): ApprovalGrantDecision {
  const parsed = approvalGrantV1Schema.parse(grant);
  if (!approvalGrantMatchesRequest(parsed, request)) {
    return Object.freeze({ allowed: false, reason: "binding_changed" });
  }
  if (parsed.state === "expired" || Date.parse(parsed.expiresAt) <= now.getTime()) {
    return Object.freeze({ allowed: false, reason: "expired" });
  }
  if (parsed.state === "exhausted" || parsed.usedUses >= parsed.maxUses) {
    return Object.freeze({ allowed: false, reason: "budget_exhausted" });
  }
  if (parsed.state !== "active") {
    return Object.freeze({ allowed: false, reason: "inactive" });
  }
  return Object.freeze({ allowed: true, reason: "exact_grant" });
}

function approvalGrantMatchesRequest(
  grant: ApprovalGrantV1,
  request: ApprovalGrantRequest,
) {
  return grant.tenantId === request.tenantId &&
    grant.ownerActorId === request.ownerActorId &&
    grant.executingPrincipalType === request.executingPrincipalType &&
    grant.executingPrincipalId === request.executingPrincipalId &&
    grant.planId === request.planId &&
    grant.planSha256 === request.planSha256 &&
    grant.domain === request.domain &&
    grant.actionClass === request.actionClass &&
    grant.toolId === request.toolId &&
    grant.toolContractSha256 === request.toolContractSha256 &&
    grant.targetSha256 === request.targetSha256 &&
    grant.riskLevel === request.riskLevel &&
    request.reversible === true;
}
