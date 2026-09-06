import { z } from "zod";

import {
  parseDelegationContractV1,
  type DelegationContractV1,
} from "@/lib/delegation/contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const DELEGATED_PRINCIPAL_SCHEMA_VERSION = 1 as const;
export const DELEGATED_PRINCIPAL_VERSION =
  "p8.2-delegated-principal:1" as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const grantListSchema = z.array(idSchema).max(64).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Delegated principal grants must be unique." });
  }
});

export const delegatedPrincipalV1Schema = z.object({
  schemaVersion: z.literal(DELEGATED_PRINCIPAL_SCHEMA_VERSION),
  version: z.literal(DELEGATED_PRINCIPAL_VERSION),
  principalId: idSchema,
  principalSha256: sha256Schema,
  tenantId: idSchema,
  initiatingActorId: idSchema,
  parentPrincipalId: idSchema,
  delegationId: idSchema,
  delegationContractSha256: sha256Schema,
  agentId: idSchema,
  definitionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  audience: z.literal("asael-governed-tool-executor"),
  purpose: z.string().trim().min(3).max(500),
  contextGrantIds: grantListSchema,
  capabilityGrantIds: grantListSchema,
  governedToolIds: grantListSchema,
  connectorTargets: grantListSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  canRedelegate: z.literal(false),
  credentialMaterialIncluded: z.literal(false),
}).strict().superRefine((value, context) => {
  const { principalSha256, ...body } = value;
  if (
    principalSha256 !== canonicalJsonSha256(body) ||
    value.principalId !== delegatedPrincipalIdV1({
      delegationId: value.delegationId,
      parentPrincipalId: value.parentPrincipalId,
      agentId: value.agentId,
      definitionVersion: value.definitionVersion,
    })
  ) {
    context.addIssue({
      code: "custom",
      path: ["principalSha256"],
      message: "Delegated principal integrity is invalid.",
    });
  }
  if (Date.parse(value.issuedAt) >= Date.parse(value.expiresAt)) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Delegated principal expiry is invalid.",
    });
  }
});

export type DelegatedPrincipalV1 = Readonly<
  z.infer<typeof delegatedPrincipalV1Schema>
>;

export function delegatedPrincipalIdV1(input: {
  delegationId: string;
  parentPrincipalId: string;
  agentId: string;
  definitionVersion: number;
}) {
  return `delegated-principal:${canonicalJsonSha256(input)}`;
}

export function buildDelegatedPrincipalV1(input: {
  contract: DelegationContractV1;
  parentExecutionScope: ExecutionScope;
}) {
  const contract = parseDelegationContractV1(input.contract);
  const scope = input.parentExecutionScope;
  if (
    scope.tenantId !== contract.scope.tenantId ||
    scope.initiatingActorId !== contract.scope.initiatingActorId ||
    scope.executingPrincipalId !== contract.scope.parentPrincipalId ||
    scope.delegationId !== contract.scope.parentDelegationId ||
    scope.workspaceId !== contract.scope.workspaceId ||
    scope.projectId !== contract.scope.projectId ||
    scope.missionId !== contract.scope.missionId
  ) {
    throw new Error("Delegated principal does not match its parent execution scope.");
  }
  const body = {
    schemaVersion: DELEGATED_PRINCIPAL_SCHEMA_VERSION,
    version: DELEGATED_PRINCIPAL_VERSION,
    principalId: contract.delegate.principalId,
    tenantId: contract.scope.tenantId,
    initiatingActorId: contract.scope.initiatingActorId,
    parentPrincipalId: contract.scope.parentPrincipalId,
    delegationId: contract.delegationId,
    delegationContractSha256: contract.contractSha256,
    agentId: contract.delegate.agentId,
    definitionVersion: contract.delegate.definitionVersion,
    audience: "asael-governed-tool-executor" as const,
    purpose: contract.purpose,
    contextGrantIds: [...contract.grants.contextGrantIds],
    capabilityGrantIds: [...contract.grants.capabilityGrantIds],
    governedToolIds: [...contract.grants.governedToolIds],
    connectorTargets: [...contract.grants.connectorTargets],
    issuedAt: contract.deadline.createdAt,
    expiresAt: contract.deadline.completeBy,
    canRedelegate: false as const,
    credentialMaterialIncluded: false as const,
  };
  return parseDelegatedPrincipalV1({
    ...body,
    principalSha256: canonicalJsonSha256(body),
  });
}

export function parseDelegatedPrincipalV1(value: unknown) {
  return deepFreeze(delegatedPrincipalV1Schema.parse(value));
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
