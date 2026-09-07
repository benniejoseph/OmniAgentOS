import { z } from "zod";

import type { DelegationContractV1 } from "@/lib/delegation/contracts";
import type { DelegationTaskV1 } from "@/lib/delegation/lifecycle";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const DELEGATION_AUTHORITY_RECEIPT_VERSION =
  "p11.5-delegation-authority:1" as const;

const idSchema = z.string().trim().min(1).max(240);
const idListSchema = z.array(idSchema).max(64).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Authority IDs must be unique." });
  }
});
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const authorityReceiptBodySchema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(DELEGATION_AUTHORITY_RECEIPT_VERSION),
  taskId: idSchema,
  delegationId: idSchema,
  contractId: idSchema,
  contractSha256: sha256Schema,
  purpose: z.string().trim().min(3).max(500),
  scope: z.object({
    workspaceId: idSchema.nullable(),
    projectId: idSchema.nullable(),
    missionId: idSchema.nullable(),
  }).strict(),
  grants: z.object({
    contextGrantIds: idListSchema,
    capabilityGrantIds: idListSchema,
    governedToolIds: idListSchema,
    connectorTargets: idListSchema,
  }).strict(),
  budgets: z.object({
    modelTurns: z.number().int().min(0),
    tokens: z.number().int().min(0),
    costMicrousd: z.number().int().min(0),
    wallTimeMs: z.number().int().min(0),
    toolCalls: z.number().int().min(0),
    browserActions: z.number().int().min(0),
  }).strict(),
  acceptanceCriterionCount: z.number().int().min(1).max(24),
  verifier: z.object({
    agentId: idSchema,
    definitionVersion: z.number().int().min(1),
    method: z.enum([
      "deterministic_schema_and_evidence",
      "agent_then_deterministic",
    ]),
    acceptanceThreshold: z.number().min(0.5).max(1),
    parentAcceptanceRequired: z.literal(true),
  }).strict(),
}).strict();

export const delegationAuthorityReceiptV1Schema = authorityReceiptBodySchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { receiptSha256, ...body } = value;
  if (canonicalJsonSha256(body) !== receiptSha256) {
    context.addIssue({
      code: "custom",
      path: ["receiptSha256"],
      message: "Delegation authority receipt integrity is invalid.",
    });
  }
});

export type DelegationAuthorityReceiptV1 = Readonly<
  z.infer<typeof delegationAuthorityReceiptV1Schema>
>;

export function buildDelegationAuthorityReceiptV1(
  contract: DelegationContractV1,
  task: DelegationTaskV1,
): DelegationAuthorityReceiptV1 {
  if (
    task.contractId !== contract.contractId ||
    task.contractSha256 !== contract.contractSha256 ||
    task.delegationId !== contract.delegationId ||
    task.taskId !== `delegation-task:${contract.delegationId}`
  ) {
    throw new Error("Delegation authority receipt changed its task contract.");
  }
  const body = {
    schemaVersion: 1 as const,
    version: DELEGATION_AUTHORITY_RECEIPT_VERSION,
    taskId: task.taskId,
    delegationId: task.delegationId,
    contractId: contract.contractId,
    contractSha256: contract.contractSha256,
    purpose: contract.purpose,
    scope: {
      workspaceId: contract.scope.workspaceId,
      projectId: contract.scope.projectId,
      missionId: contract.scope.missionId,
    },
    grants: {
      contextGrantIds: [...contract.grants.contextGrantIds],
      capabilityGrantIds: [...contract.grants.capabilityGrantIds],
      governedToolIds: [...contract.grants.governedToolIds],
      connectorTargets: [...contract.grants.connectorTargets],
    },
    budgets: {
      modelTurns: contract.budgets.modelTurns,
      tokens: contract.budgets.tokens,
      costMicrousd: contract.budgets.costMicrousd,
      wallTimeMs: contract.budgets.wallTimeMs,
      toolCalls: contract.budgets.toolCalls,
      browserActions: contract.budgets.browserActions,
    },
    acceptanceCriterionCount: contract.acceptanceCriteria.length,
    verifier: {
      agentId: contract.verifier.agentId,
      definitionVersion: contract.verifier.definitionVersion,
      method: contract.verifier.method,
      acceptanceThreshold: contract.verifier.acceptanceThreshold,
      parentAcceptanceRequired: contract.verifier.parentAcceptanceRequired,
    },
  };
  return delegationAuthorityReceiptV1Schema.parse({
    ...body,
    receiptSha256: canonicalJsonSha256(body),
  });
}

export function parseDelegationAuthorityReceiptV1(value: unknown) {
  return delegationAuthorityReceiptV1Schema.parse(value);
}
