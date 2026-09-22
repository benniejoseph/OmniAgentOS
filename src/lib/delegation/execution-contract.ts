import { createHash } from "node:crypto";
import { z } from "zod";

import {
  parseAgentRunIdentityPinV1,
  type AgentRunIdentityPinV1,
} from "@/lib/agents/identity-contracts";
import {
  delegationContextCapsuleV1Schema,
  parseDelegationContextCapsuleV1,
  type DelegationContextCapsuleV1,
} from "@/lib/delegation/context-capsule";
import type { DelegationContractV1 } from "@/lib/delegation/contracts";
import {
  RUN_BUDGET_DIMENSIONS,
  narrowRunBudgetLimits,
  runBudgetCountersV1Schema,
  type RunBudgetCountersV1,
} from "@/lib/runs/budgets";
import { redactSensitive } from "@/lib/security/context";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const DELEGATION_EXECUTION_CONTRACT_SCHEMA_VERSION = 2 as const;
export const DELEGATION_EXECUTION_CONTRACT_VERSION =
  "delegation-execution-contract:2" as const;
export const DELEGATION_RUNTIME_ASSIGNMENT_VERSION =
  "delegation-runtime-assignment:1" as const;
export const DELEGATION_EXECUTION_MAX_DEPTH = 1 as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const positiveVersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const idListSchema = z.array(idSchema).max(64).superRefine(uniqueList);
const boundedTextSchema = z.string().trim().min(3).max(4_000);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string().max(8_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema).max(128),
  z.record(z.string().min(1).max(160), jsonValueSchema),
]));

const agentIdentityBindingSchema = z.object({
  runId: idSchema,
  tenantId: idSchema,
  actorId: idSchema,
  logicalAgentId: idSchema,
  definitionId: idSchema,
  definitionVersion: positiveVersionSchema,
  definitionVersionId: idSchema,
  definitionSha256: sha256Schema,
  principalId: idSchema,
  principalGeneration: positiveVersionSchema,
  principalVersionId: idSchema,
  principalSha256: sha256Schema,
  identityPinSha256: sha256Schema,
}).strict();

const runtimeAssignmentBodySchema = z.object({
  version: z.literal(DELEGATION_RUNTIME_ASSIGNMENT_VERSION),
  executionId: idSchema,
  providerId: idSchema,
  modelId: idSchema,
  modelTier: z.enum(["fast", "reasoning"]),
  reasoningProfileId: idSchema,
  normalizedReasoningEffort: z.enum([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]),
  routingPolicyId: idSchema,
  routingPolicySha256: sha256Schema,
  assignedAt: timestampSchema,
  credentialMaterialIncluded: z.literal(false),
}).strict();

export const delegationRuntimeAssignmentReceiptV1Schema =
  runtimeAssignmentBodySchema.extend({
    assignmentId: idSchema,
    assignmentSha256: sha256Schema,
  }).strict().superRefine((assignment, context) => {
    const { assignmentId, assignmentSha256, ...body } = assignment;
    if (
      assignmentId !== `delegation-runtime:${assignmentSha256}` ||
      canonicalJsonSha256(body) !== assignmentSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["assignmentSha256"],
        message: "Delegation runtime assignment integrity is invalid.",
      });
    }
    if (containsSensitiveText(body)) {
      context.addIssue({
        code: "custom",
        path: ["credentialMaterialIncluded"],
        message: "Delegation runtime assignments cannot contain credential material.",
      });
    }
  });

const acceptanceCriterionReferenceSchema = z.object({
  criterionId: idSchema,
  statement: z.string().trim().min(3).max(500),
  criterionSha256: sha256Schema,
  verificationMethod: z.enum([
    "schema",
    "evidence",
    "governed_receipt",
    "parent_verifier",
  ]),
  required: z.literal(true),
}).strict().superRefine((criterion, context) => {
  if (criterion.criterionSha256 !== canonicalJsonSha256({
    statement: criterion.statement,
  })) {
    context.addIssue({
      code: "custom",
      path: ["criterionSha256"],
      message: "Delegation acceptance criterion digest is invalid.",
    });
  }
});

const acceptanceReferenceBodySchema = z.object({
  acceptanceId: idSchema,
  criteria: z.array(acceptanceCriterionReferenceSchema)
    .min(1).max(24)
    .superRefine((values, context) => {
      uniqueList(values.map((value) => value.criterionId), context);
    }),
}).strict();

const acceptanceReferenceSchema = acceptanceReferenceBodySchema.extend({
  acceptanceSha256: sha256Schema,
}).strict().superRefine((acceptance, context) => {
  const { acceptanceSha256, ...body } = acceptance;
  if (canonicalJsonSha256(body) !== acceptanceSha256) {
    context.addIssue({
      code: "custom",
      path: ["acceptanceSha256"],
      message: "Delegation acceptance reference digest is invalid.",
    });
  }
});

const outputReferenceBodySchema = z.object({
  outputContractId: idSchema,
  schemaId: idSchema,
  schemaVersion: positiveVersionSchema,
  schema: jsonValueSchema,
  schemaSha256: sha256Schema,
  artifactKinds: z.array(z.enum([
    "analysis",
    "result",
    "verification",
    "report",
    "memory",
    "control",
    "code",
    "media",
  ])).min(1).max(8).superRefine(uniqueList),
  maxArtifacts: z.number().int().min(1).max(32),
  maxBytes: z.number().int().min(1).max(25_000_000),
}).strict();

const outputReferenceSchema = outputReferenceBodySchema.extend({
  outputContractSha256: sha256Schema,
}).strict().superRefine((output, context) => {
  const { outputContractSha256, ...body } = output;
  if (canonicalJsonSha256(body) !== outputContractSha256) {
    context.addIssue({
      code: "custom",
      path: ["outputContractSha256"],
      message: "Delegation output contract digest is invalid.",
    });
  }
  if (output.schemaSha256 !== canonicalJsonSha256(output.schema)) {
    context.addIssue({
      code: "custom",
      path: ["schemaSha256"],
      message: "Delegation output schema digest is invalid.",
    });
  }
  if (!safeOutputSchema(output.schema)) {
    context.addIssue({
      code: "custom",
      path: ["schema"],
      message: "Delegation output schema is not closed and bounded.",
    });
  }
});

const verifierReferenceBodySchema = z.object({
  verifierContractId: idSchema,
  verifierPolicyId: idSchema,
  verifierPolicySha256: sha256Schema,
  identity: agentIdentityBindingSchema,
  runtimeAssignment: delegationRuntimeAssignmentReceiptV1Schema,
  method: z.enum([
    "deterministic_schema_and_evidence",
    "agent_then_deterministic",
  ]),
  requiredEvidenceKinds: z.array(z.enum([
    "artifact_digest",
    "model_receipt",
    "tool_receipt",
    "acceptance_check",
  ])).min(1).max(4).superRefine(uniqueList),
  acceptanceThreshold: z.number().min(0.5).max(1),
  completionDisposition: z.literal("proposed_only"),
  parentAcceptanceRequired: z.literal(true),
}).strict();

const verifierReferenceSchema = verifierReferenceBodySchema.extend({
  verifierContractSha256: sha256Schema,
}).strict().superRefine((verifier, context) => {
  const { verifierContractSha256, ...body } = verifier;
  if (canonicalJsonSha256(body) !== verifierContractSha256) {
    context.addIssue({
      code: "custom",
      path: ["verifierContractSha256"],
      message: "Delegation verifier reference digest is invalid.",
    });
  }
});

const skillGrantSchema = z.object({
  capabilityGrantId: idSchema,
  skillId: idSchema,
  skillVersion: positiveVersionSchema,
  skillVersionId: idSchema,
  skillSha256: sha256Schema,
}).strict();

const mcpGrantSchema = z.object({
  capabilityGrantId: idSchema,
  serverId: idSchema,
  serverVersionId: idSchema,
  serverContractSha256: sha256Schema,
  governedToolIds: idListSchema,
  connectorTargetIds: idListSchema,
}).strict();

const pluginGrantSchema = z.object({
  capabilityGrantId: idSchema,
  installationId: idSchema,
  installationRevision: positiveVersionSchema,
  installationSha256: sha256Schema,
  pluginId: idSchema,
  pluginVersion: z.string().trim().min(1).max(80),
  manifestSha256: sha256Schema,
  componentIds: idListSchema,
}).strict();

const grantsSchema = z.object({
  grantRequestSha256: sha256Schema,
  contextGrantIds: idListSchema,
  capabilityGrantIds: idListSchema,
  governedToolIds: idListSchema,
  connectorTargets: idListSchema,
  skills: z.array(skillGrantSchema).max(50),
  mcpServers: z.array(mcpGrantSchema).max(32),
  plugins: z.array(pluginGrantSchema).max(32),
}).strict().superRefine((grants, context) => {
  uniqueList(grants.skills.map((grant) => grant.skillId), context);
  uniqueList(grants.mcpServers.map((grant) => grant.serverId), context);
  uniqueList(grants.plugins.map((grant) => grant.installationId), context);
});

const resourceClaimSchema = z.object({
  claimId: idSchema,
  resourceType: z.enum([
    "repository_path",
    "artifact",
    "document",
    "workspace_object",
    "external_object",
  ]),
  resourceId: idSchema,
  mode: z.enum(["exclusive", "shared_read"]),
  authorityGrantId: idSchema,
  baseRevisionSha256: sha256Schema.nullable(),
}).strict().superRefine((claim, context) => {
  if (claim.mode === "shared_read" && claim.baseRevisionSha256 === null) {
    context.addIssue({
      code: "custom",
      path: ["baseRevisionSha256"],
      message: "Shared-read resource claims require an exact revision digest.",
    });
  }
});

const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5),
  backoffMs: z.array(z.number().int().min(0).max(60_000)).max(4),
  retryableReasons: z.array(z.enum([
    "transient_provider",
    "transient_tool",
    "lease_lost",
  ])).max(3).superRefine(uniqueList),
  neverRetryReasons: z.tuple([
    z.literal("authority_denied"),
    z.literal("contract_invalid"),
    z.literal("canceled"),
    z.literal("deadline_expired"),
  ]),
}).strict();

const executionContractBodySchema = z.object({
  schemaVersion: z.literal(DELEGATION_EXECUTION_CONTRACT_SCHEMA_VERSION),
  version: z.literal(DELEGATION_EXECUTION_CONTRACT_VERSION),
  delegationId: idSchema,
  mode: z.enum(["isolated", "fork", "team"]),
  lineage: z.object({
    tenantId: idSchema,
    initiatingActorId: idSchema,
    rootExecutionId: idSchema,
    rootPrincipalId: idSchema,
    parentExecutionId: idSchema,
    parentPrincipalId: idSchema,
    parentDelegationId: z.null(),
    depth: z.literal(DELEGATION_EXECUTION_MAX_DEPTH),
    maxDepth: z.literal(DELEGATION_EXECUTION_MAX_DEPTH),
    workspaceId: idSchema.nullable(),
    projectId: idSchema.nullable(),
    workItemId: idSchema.nullable(),
    correlationSha256: sha256Schema,
  }).strict(),
  delegatorIdentity: agentIdentityBindingSchema,
  delegateIdentity: agentIdentityBindingSchema,
  runtimeAssignment: delegationRuntimeAssignmentReceiptV1Schema,
  contextCapsule: delegationContextCapsuleV1Schema,
  purpose: z.string().trim().min(3).max(500),
  objective: boundedTextSchema,
  idempotencyKeySha256: sha256Schema,
  acceptance: acceptanceReferenceSchema,
  output: outputReferenceSchema,
  verifier: verifierReferenceSchema,
  grants: grantsSchema,
  resourceClaims: z.array(resourceClaimSchema).max(64).superRefine((claims, context) => {
    uniqueList(claims.map((claim) => claim.claimId), context);
    uniqueList(claims.map((claim) => `${claim.resourceType}:${claim.resourceId}`), context);
  }),
  budgets: runBudgetCountersV1Schema,
  deadline: z.object({
    createdAt: timestampSchema,
    acceptBy: timestampSchema,
    completeBy: timestampSchema,
  }).strict(),
  cancellation: z.object({
    cancelable: z.literal(true),
    signalId: idSchema,
    allowedInitiators: z.tuple([
      z.literal("parent"),
      z.literal("owner"),
      z.literal("system"),
    ]),
    acknowledgementDeadlineMs: z.number().int().min(100).max(60_000),
  }).strict(),
  retry: retryPolicySchema,
  authorityBoundary: z.object({
    credentialMaterialIncluded: z.literal(false),
    messageContentGrantsAuthority: z.literal(false),
    retrievedDataGrantsAuthority: z.literal(false),
    capabilityMetadataGrantsAuthority: z.literal(false),
    authoritySource: z.literal("attenuated_parent_v1_grants_only"),
  }).strict(),
}).strict();

export const delegationExecutionContractV2Schema =
  executionContractBodySchema.extend({
    contractId: idSchema,
    contractSha256: sha256Schema,
  }).strict().superRefine((contract, context) => {
    const { contractId, contractSha256, ...body } = contract;
    if (
      contractId !== `delegation-execution-contract:${contractSha256}` ||
      canonicalJsonSha256(body) !== contractSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["contractSha256"],
        message: "Delegation execution contract integrity is invalid.",
      });
    }
    validateContractBindings(contract, context);
    if (containsSensitiveText(body)) {
      context.addIssue({
        code: "custom",
        path: ["authorityBoundary"],
        message: "Delegation execution contracts cannot contain credential material.",
      });
    }
  });

export type DelegationRuntimeAssignmentReceiptV1 = Readonly<
  z.infer<typeof delegationRuntimeAssignmentReceiptV1Schema>
>;
export type DelegationExecutionContractV2 = Readonly<
  z.infer<typeof delegationExecutionContractV2Schema>
>;
export type DelegationExecutionParentAuthorityV1 = Readonly<{
  grants: DelegationContractV1["grants"];
  budgets: RunBudgetCountersV1;
  completeBy: string;
}>;

export function buildDelegationRuntimeAssignmentReceiptV1(
  input: Omit<
    z.input<typeof runtimeAssignmentBodySchema>,
    "version" | "credentialMaterialIncluded"
  >,
): DelegationRuntimeAssignmentReceiptV1 {
  const body = runtimeAssignmentBodySchema.parse({
    ...input,
    version: DELEGATION_RUNTIME_ASSIGNMENT_VERSION,
    credentialMaterialIncluded: false,
  });
  const assignmentSha256 = canonicalJsonSha256(body);
  return parseDelegationRuntimeAssignmentReceiptV1({
    ...body,
    assignmentId: `delegation-runtime:${assignmentSha256}`,
    assignmentSha256,
  });
}

export function parseDelegationRuntimeAssignmentReceiptV1(
  value: unknown,
): DelegationRuntimeAssignmentReceiptV1 {
  return deepFreeze(delegationRuntimeAssignmentReceiptV1Schema.parse(value));
}

export function buildDelegationExecutionContractV2(input: {
  delegationId: string;
  mode: DelegationExecutionContractV2["mode"];
  lineage: DelegationExecutionContractV2["lineage"];
  delegatorIdentityPin: AgentRunIdentityPinV1;
  delegateIdentityPin: AgentRunIdentityPinV1;
  runtimeAssignment: DelegationRuntimeAssignmentReceiptV1;
  contextCapsule: DelegationContextCapsuleV1;
  purpose: string;
  objective: string;
  idempotencyKeySha256: string;
  acceptance: Omit<DelegationExecutionContractV2["acceptance"], "acceptanceSha256">;
  output: Omit<
    DelegationExecutionContractV2["output"],
    "schemaSha256" | "outputContractSha256"
  >;
  verifier: Omit<
    DelegationExecutionContractV2["verifier"],
    "identity" | "runtimeAssignment" | "verifierContractSha256"
  > & {
    identityPin: AgentRunIdentityPinV1;
    runtimeAssignment: DelegationRuntimeAssignmentReceiptV1;
  };
  grants: DelegationExecutionContractV2["grants"];
  resourceClaims?: DelegationExecutionContractV2["resourceClaims"];
  parentAuthority: DelegationExecutionParentAuthorityV1;
  budgets: RunBudgetCountersV1;
  deadline: DelegationExecutionContractV2["deadline"];
  cancellation: DelegationExecutionContractV2["cancellation"];
  retry: DelegationExecutionContractV2["retry"];
}): DelegationExecutionContractV2 {
  const delegatorPin = parseAgentRunIdentityPinV1(input.delegatorIdentityPin);
  const delegatePin = parseAgentRunIdentityPinV1(input.delegateIdentityPin);
  const runtimeAssignment = parseDelegationRuntimeAssignmentReceiptV1(
    input.runtimeAssignment,
  );
  const contextCapsule = parseDelegationContextCapsuleV1(input.contextCapsule);

  assertAttenuatedGrants(input.parentAuthority.grants, input.grants);
  assertExplicitCapabilityBindings(input.grants, delegatorPin, delegatePin);
  assertResourceClaimAuthority(input.resourceClaims || [], input.grants);
  const budgets = narrowRunBudgetLimits(input.parentAuthority.budgets, input.budgets);
  for (const dimension of RUN_BUDGET_DIMENSIONS) {
    if (budgets[dimension] !== input.budgets[dimension]) {
      throw new Error(`Delegated ${dimension} budget is not exact.`);
    }
  }
  if (Date.parse(input.deadline.completeBy) > Date.parse(input.parentAuthority.completeBy)) {
    throw new Error("Delegation deadline cannot exceed its parent deadline.");
  }

  const acceptanceBody = acceptanceReferenceBodySchema.parse(input.acceptance);
  const acceptance = acceptanceReferenceSchema.parse({
    ...acceptanceBody,
    acceptanceSha256: canonicalJsonSha256(acceptanceBody),
  });
  const outputWithoutDigests = {
    ...input.output,
    schemaSha256: canonicalJsonSha256(input.output.schema),
  };
  const outputBody = outputReferenceBodySchema.parse(outputWithoutDigests);
  const output = outputReferenceSchema.parse({
    ...outputBody,
    outputContractSha256: canonicalJsonSha256(outputBody),
  });
  const { identityPin: verifierIdentityPin, ...verifierInput } = input.verifier;
  const verifierBody = verifierReferenceBodySchema.parse({
    ...verifierInput,
    identity: bindAgentIdentity(verifierIdentityPin),
    runtimeAssignment: parseDelegationRuntimeAssignmentReceiptV1(
      input.verifier.runtimeAssignment,
    ),
  });
  const verifier = verifierReferenceSchema.parse({
    ...verifierBody,
    verifierContractSha256: canonicalJsonSha256(verifierBody),
  });
  const body = executionContractBodySchema.parse({
    schemaVersion: DELEGATION_EXECUTION_CONTRACT_SCHEMA_VERSION,
    version: DELEGATION_EXECUTION_CONTRACT_VERSION,
    delegationId: input.delegationId,
    mode: input.mode,
    lineage: input.lineage,
    delegatorIdentity: bindAgentIdentity(delegatorPin),
    delegateIdentity: bindAgentIdentity(delegatePin),
    runtimeAssignment,
    contextCapsule,
    purpose: input.purpose,
    objective: input.objective,
    idempotencyKeySha256: input.idempotencyKeySha256,
    acceptance,
    output,
    verifier,
    grants: input.grants,
    resourceClaims: input.resourceClaims || [],
    budgets,
    deadline: input.deadline,
    cancellation: input.cancellation,
    retry: input.retry,
    authorityBoundary: {
      credentialMaterialIncluded: false,
      messageContentGrantsAuthority: false,
      retrievedDataGrantsAuthority: false,
      capabilityMetadataGrantsAuthority: false,
      authoritySource: "attenuated_parent_v1_grants_only",
    },
  });
  const contractSha256 = canonicalJsonSha256(body);
  return parseDelegationExecutionContractV2({
    ...body,
    contractId: `delegation-execution-contract:${contractSha256}`,
    contractSha256,
  });
}

export function parseDelegationExecutionContractV2(
  value: unknown,
): DelegationExecutionContractV2 {
  return deepFreeze(delegationExecutionContractV2Schema.parse(value));
}

function bindAgentIdentity(pinValue: AgentRunIdentityPinV1) {
  const pin = parseAgentRunIdentityPinV1(pinValue);
  return agentIdentityBindingSchema.parse({
    runId: pin.runId,
    tenantId: pin.tenantId,
    actorId: pin.actorId,
    logicalAgentId: pin.logicalAgentId,
    definitionId: pin.definitionId,
    definitionVersion: pin.definitionVersion,
    definitionVersionId: pin.definitionVersionId,
    definitionSha256: pin.definitionSha256,
    principalId: pin.principalId,
    principalGeneration: pin.principalGeneration,
    principalVersionId: pin.principalVersionId,
    principalSha256: pin.principalSha256,
    identityPinSha256: pin.pinSha256,
  });
}

function validateContractBindings(
  contract: z.infer<typeof executionContractBodySchema>,
  context: z.RefinementCtx,
) {
  const { lineage } = contract;
  if (
    lineage.depth !== 1 ||
    lineage.maxDepth !== DELEGATION_EXECUTION_MAX_DEPTH ||
    lineage.parentDelegationId !== null ||
    lineage.rootExecutionId !== lineage.parentExecutionId ||
    lineage.rootPrincipalId !== lineage.parentPrincipalId
  ) {
    context.addIssue({
      code: "custom",
      path: ["lineage"],
      message: "Delegation execution lineage exceeds the initial one-level boundary.",
    });
  }
  if (
    contract.delegatorIdentity.runId !== lineage.parentExecutionId ||
    contract.delegatorIdentity.principalId !== lineage.parentPrincipalId ||
    contract.delegateIdentity.runId === lineage.parentExecutionId ||
    contract.delegatorIdentity.tenantId !== lineage.tenantId ||
    contract.delegateIdentity.tenantId !== lineage.tenantId ||
    contract.verifier.identity.tenantId !== lineage.tenantId ||
    contract.delegatorIdentity.actorId !== lineage.initiatingActorId ||
    contract.delegateIdentity.actorId !== lineage.initiatingActorId ||
    contract.verifier.identity.actorId !== lineage.initiatingActorId
  ) {
    context.addIssue({
      code: "custom",
      path: ["delegatorIdentity"],
      message: "Delegation Agent identities are not bound to their exact executions.",
    });
  }
  if (
    contract.verifier.runtimeAssignment.executionId !==
      contract.verifier.identity.runId
  ) {
    context.addIssue({
      code: "custom",
      path: ["verifier", "runtimeAssignment"],
      message: "Delegation verifier runtime is not bound to its exact identity.",
    });
  }
  if (
    contract.runtimeAssignment.executionId !== contract.delegateIdentity.runId ||
    contract.contextCapsule.mode !== contract.mode ||
    contract.contextCapsule.scope.tenantId !== lineage.tenantId ||
    contract.contextCapsule.scope.initiatingActorId !== lineage.initiatingActorId ||
    contract.contextCapsule.scope.rootExecutionId !== lineage.rootExecutionId ||
    contract.contextCapsule.scope.rootPrincipalId !== lineage.rootPrincipalId ||
    contract.contextCapsule.scope.parentExecutionId !== lineage.parentExecutionId ||
    contract.contextCapsule.scope.parentPrincipalId !== lineage.parentPrincipalId ||
    contract.contextCapsule.scope.delegationId !== contract.delegationId
  ) {
    context.addIssue({
      code: "custom",
      path: ["contextCapsule"],
      message: "Delegation runtime or context is not bound to the execution lineage.",
    });
  }
  const contextGrants = new Set(contract.grants.contextGrantIds);
  const selectedReferences = [
    ...contract.contextCapsule.selection.contextRefs,
    ...contract.contextCapsule.selection.evidenceRefs,
    ...contract.contextCapsule.selection.artifactRefs,
  ];
  if (selectedReferences.some((reference) => !contextGrants.has(reference.contextGrantId))) {
    context.addIssue({
      code: "custom",
      path: ["contextCapsule", "selection"],
      message: "Delegation context references exceed the explicit context grants.",
    });
  }
  const capabilityGrants = new Set(contract.grants.capabilityGrantIds);
  const governedTools = new Set(contract.grants.governedToolIds);
  const connectorTargets = new Set(contract.grants.connectorTargets);
  if (
    contract.grants.skills.some((grant) => !capabilityGrants.has(grant.capabilityGrantId)) ||
    contract.grants.plugins.some((grant) => !capabilityGrants.has(grant.capabilityGrantId)) ||
    contract.grants.mcpServers.some((grant) =>
      !capabilityGrants.has(grant.capabilityGrantId) ||
      grant.governedToolIds.some((toolId) => !governedTools.has(toolId)) ||
      grant.connectorTargetIds.some((targetId) => !connectorTargets.has(targetId))
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["grants"],
      message: "Explicit Skill, MCP, or Plugin grants exceed the contract capability boundary.",
    });
  }
  if (contract.resourceClaims.some((claim) =>
    claim.mode === "exclusive"
      ? !capabilityGrants.has(claim.authorityGrantId)
      : !contextGrants.has(claim.authorityGrantId)
  )) {
    context.addIssue({
      code: "custom",
      path: ["resourceClaims"],
      message: "Delegation resource claims exceed the contract grant boundary.",
    });
  }
  const createdAt = Date.parse(contract.deadline.createdAt);
  const acceptBy = Date.parse(contract.deadline.acceptBy);
  const completeBy = Date.parse(contract.deadline.completeBy);
  if (!(createdAt <= acceptBy && acceptBy < completeBy)) {
    context.addIssue({
      code: "custom",
      path: ["deadline"],
      message: "Delegation deadlines must be strictly ordered.",
    });
  }
  if (
    contract.retry.backoffMs.length !== contract.retry.maxAttempts - 1 ||
    contract.retry.maxAttempts > contract.budgets.retries + 1 ||
    contract.budgets.agents < 1
  ) {
    context.addIssue({
      code: "custom",
      path: ["retry"],
      message: "Delegation retry and Agent budgets are inconsistent.",
    });
  }
}

function assertAttenuatedGrants(
  parent: DelegationContractV1["grants"],
  child: DelegationExecutionContractV2["grants"],
) {
  for (const key of [
    "contextGrantIds",
    "capabilityGrantIds",
    "governedToolIds",
    "connectorTargets",
  ] as const) {
    const allowed = new Set(parent[key]);
    if (child[key].some((value) => !allowed.has(value))) {
      throw new Error(`Delegated ${key} cannot exceed parent V1 authority.`);
    }
  }
}

function assertExplicitCapabilityBindings(
  grants: DelegationExecutionContractV2["grants"],
  delegatorPin: AgentRunIdentityPinV1,
  delegatePin: AgentRunIdentityPinV1,
) {
  const capabilities = new Set(grants.capabilityGrantIds);
  const tools = new Set(grants.governedToolIds);
  const connectors = new Set(grants.connectorTargets);
  const declaredSkills = new Map(
    delegatorPin.skillPins.map((skill) => [skill.skillId, skill]),
  );
  const delegateSkills = new Map(
    delegatePin.skillPins.map((skill) => [skill.skillId, skill]),
  );
  const pluginBackedSkillIds = new Set(grants.plugins.flatMap((plugin) =>
    plugin.componentIds.map((componentId) =>
      pluginSkillIdForBinding(plugin.installationId, componentId)
    )
  ));
  for (const skill of grants.skills) {
    const declared = declaredSkills.get(skill.skillId);
    const delegateDeclared = delegateSkills.get(skill.skillId);
    const compatibleParent = Boolean(declared) &&
      declared!.skillVersion === skill.skillVersion &&
      declared!.skillVersionId === skill.skillVersionId &&
      declared!.skillSha256 === skill.skillSha256;
    const compatibleDelegate = Boolean(delegateDeclared) &&
      delegateDeclared!.skillVersion === skill.skillVersion &&
      delegateDeclared!.skillVersionId === skill.skillVersionId &&
      delegateDeclared!.skillSha256 === skill.skillSha256;
    const pluginBacked = pluginBackedSkillIds.has(skill.skillId);
    if (
      !capabilities.has(skill.capabilityGrantId) ||
      (!pluginBacked && (!compatibleParent || !compatibleDelegate))
    ) {
      throw new Error(
        "Delegated Skill grant is not pinned to compatible parent and delegate authority.",
      );
    }
  }
  for (const server of grants.mcpServers) {
    if (
      !capabilities.has(server.capabilityGrantId) ||
      server.governedToolIds.some((toolId) => !tools.has(toolId)) ||
      server.connectorTargetIds.some((targetId) => !connectors.has(targetId))
    ) {
      throw new Error("Delegated MCP grant exceeds the explicit capability boundary.");
    }
  }
  for (const plugin of grants.plugins) {
    const projectedSkillIds = plugin.componentIds.map((componentId) =>
      pluginSkillIdForBinding(plugin.installationId, componentId)
    );
    if (
      !capabilities.has(plugin.capabilityGrantId) ||
      projectedSkillIds.some((skillId) =>
        !grants.skills.some((skill) => skill.skillId === skillId)
      )
    ) {
      throw new Error("Delegated Plugin grant exceeds the explicit capability boundary.");
    }
  }
}

function pluginSkillIdForBinding(
  installationId: string,
  componentId: string,
) {
  if (!componentId.startsWith("skill:") || componentId.length <= 6) {
    throw new Error(
      "Delegated Plugin grants may activate only exact Skill components.",
    );
  }
  const key = componentId.slice(6);
  return `plugin.skill.${createHash("sha256")
    .update(`${installationId}:${key}`, "utf8")
    .digest("hex")
    .slice(0, 40)}`;
}

function assertResourceClaimAuthority(
  claims: readonly DelegationExecutionContractV2["resourceClaims"][number][],
  grants: DelegationExecutionContractV2["grants"],
) {
  const contextGrants = new Set(grants.contextGrantIds);
  const capabilityGrants = new Set(grants.capabilityGrantIds);
  for (const claim of claims) {
    const allowed = claim.mode === "exclusive"
      ? capabilityGrants.has(claim.authorityGrantId)
      : contextGrants.has(claim.authorityGrantId);
    if (!allowed) {
      throw new Error(
        `Delegated ${claim.mode} resource claim exceeds its explicit grant boundary.`,
      );
    }
  }
}

function safeOutputSchema(value: JsonValue) {
  const serialized = JSON.stringify(value);
  if (serialized.length > 16_000 || !isRecord(value)) return false;
  if (value.type !== "object" || value.additionalProperties !== false) return false;
  let nodes = 0;
  function visit(node: JsonValue, depth: number): boolean {
    nodes += 1;
    if (nodes > 500 || depth > 12) return false;
    if (!node || typeof node !== "object") return true;
    if (Array.isArray(node)) return node.every((item) => visit(item, depth + 1));
    if ("$ref" in node || "$dynamicRef" in node || node.format === "password") {
      return false;
    }
    if (node.type === "object" && node.additionalProperties !== false) return false;
    const properties = node.properties;
    if (properties && (!isRecord(properties) || Object.keys(properties).some(sensitiveName))) {
      return false;
    }
    return Object.values(node).every((item) => visit(item, depth + 1));
  }
  return visit(value, 0);
}

function sensitiveName(value: string) {
  return /authorization|cookie|credential|password|private.?key|secret|(?:api|access|refresh).?token/i.test(value);
}

function containsSensitiveText(value: unknown): boolean {
  if (typeof value === "string") return redactSensitive(value) !== value;
  if (Array.isArray(value)) return value.some(containsSensitiveText);
  return Boolean(value) && typeof value === "object" &&
    Object.values(value as Record<string, unknown>).some(containsSensitiveText);
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueList(values: readonly unknown[], context: z.RefinementCtx) {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Values must be unique." });
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
