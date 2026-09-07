import {
  approvalGrantBindsRequest,
  approvalGrantClaimV1Schema,
  approvalGrantV1Schema,
  type ApprovalGrantClaimV1,
  type ApprovalGrantRequest,
  type ApprovalGrantV1,
} from "@/lib/approval-grants/contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { toolInputSha256 } from "@/lib/tools/execution-scope";
import { toolApprovalFingerprint } from "@/lib/tools/fingerprint";
import type { ToolDefinition } from "@/lib/tools/types";

export type ApprovalGrantClaimEvidence = Readonly<{
  grant: ApprovalGrantV1;
  claim: ApprovalGrantClaimV1;
}>;

export function approvalGrantToolContractSha256(tool: ToolDefinition) {
  return canonicalJsonSha256({
    version: "p9.4-tool-contract:1",
    approvalFingerprint: toolApprovalFingerprint(tool),
  });
}

/**
 * The whole validated input is part of the target boundary. This is stricter
 * than a connector identifier alone: changing payload content, resource ID,
 * endpoint, or method always requires another reviewed grant.
 */
export function approvalGrantTargetSha256(
  tool: ToolDefinition,
  input: Record<string, unknown>,
) {
  return canonicalJsonSha256({
    version: "p9.4-exact-tool-target:1",
    toolId: tool.id,
    inputSha256: toolInputSha256(input),
  });
}

export function approvalGrantExecutionKeySha256(input: {
  tenantId: string;
  ownerActorId: string;
  executionKey: string;
}) {
  return canonicalJsonSha256({
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    executionKey: required(input.executionKey, "execution key"),
  });
}

export function buildToolApprovalGrantRequest(input: {
  tool: ToolDefinition;
  toolInput: Record<string, unknown>;
  executionScope: ExecutionScope;
  planId: string;
  planSha256: string;
}): ApprovalGrantRequest | undefined {
  const { tool, executionScope } = input;
  if (
    (tool.riskLevel !== 1 && tool.riskLevel !== 2) ||
    tool.reversible !== true ||
    !executionScope.initiatingActorId ||
    !executionScope.executingPrincipalId
  ) {
    return undefined;
  }
  return Object.freeze({
    tenantId: executionScope.tenantId,
    ownerActorId: executionScope.initiatingActorId,
    executingPrincipalType: executionScope.executingPrincipalType,
    executingPrincipalId: executionScope.executingPrincipalId,
    planId: required(input.planId, "plan id"),
    planSha256: sha256(input.planSha256, "plan digest"),
    domain: tool.category,
    actionClass: tool.id,
    toolId: tool.id,
    toolContractSha256: approvalGrantToolContractSha256(tool),
    targetSha256: approvalGrantTargetSha256(tool, input.toolInput),
    riskLevel: tool.riskLevel,
    reversible: true,
  });
}

export function approvalGrantClaimAuthorizes(input: {
  evidence: ApprovalGrantClaimEvidence;
  request: ApprovalGrantRequest;
  executionKey: string;
  now?: Date;
}) {
  const grant = approvalGrantV1Schema.parse(input.evidence.grant);
  const claim = approvalGrantClaimV1Schema.parse(input.evidence.claim);
  const now = input.now || new Date();
  const expectedExecutionKeySha256 = approvalGrantExecutionKeySha256({
    tenantId: input.request.tenantId,
    ownerActorId: input.request.ownerActorId,
    executionKey: input.executionKey,
  });
  return approvalGrantBindsRequest(grant, input.request) &&
    grant.state !== "revoked" &&
    grant.state !== "expired" &&
    Date.parse(grant.issuedAt) <= Date.parse(claim.claimedAt) &&
    Date.parse(claim.claimedAt) < Date.parse(grant.expiresAt) &&
    now.getTime() < Date.parse(grant.expiresAt) &&
    claim.grantId === grant.grantId &&
    claim.grantBindingSha256 === grant.bindingSha256 &&
    claim.tenantId === grant.tenantId &&
    claim.ownerActorId === grant.ownerActorId &&
    claim.executionKeySha256 === expectedExecutionKeySha256 &&
    claim.useOrdinal <= grant.usedUses &&
    claim.useOrdinal <= grant.maxUses;
}

function sha256(value: string, label: string) {
  const normalized = value.trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`Approval grant ${label} must be a lowercase SHA-256 digest.`);
  }
  return normalized;
}

function required(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Approval grant ${label} is required.`);
  return normalized;
}
