import { z } from "zod";

import {
  RUN_BUDGET_DIMENSIONS,
  runBudgetCountersV1Schema,
  type RunBudgetCountersV1,
} from "@/lib/runs/budgets";
import { redactSensitive } from "@/lib/security/context";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const DELEGATION_CONTRACT_SCHEMA_VERSION = 1 as const;
export const DELEGATION_CONTRACT_VERSION = "p8.1-delegation-contract:1" as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const positiveVersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const boundedTextSchema = z.string().trim().min(3).max(4_000);
const idListSchema = z.array(idSchema).max(64).superRefine(uniqueList);

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

const delegationArtifactReferenceV1Schema = z.object({
  artifactId: idSchema,
  sourceExecutionId: idSchema,
  name: z.string().trim().min(1).max(160),
  kind: z.enum(["analysis", "result", "verification", "report", "memory", "control"]),
  mediaType: z.string().trim().min(3).max(120),
  contentSha256: sha256Schema,
  byteCount: z.number().int().min(1).max(25_000_000),
  evidenceIds: idListSchema,
}).strict();

const delegationAcceptanceCriterionV1Schema = z.object({
  criterionId: idSchema,
  statement: z.string().trim().min(3).max(1_000),
  verificationMethod: z.enum([
    "schema",
    "evidence",
    "governed_receipt",
    "parent_verifier",
  ]),
  required: z.literal(true),
}).strict();

const delegationOutputContractV1Schema = z.object({
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
  ])).min(1).max(6).superRefine(uniqueList),
  maxArtifacts: z.number().int().min(1).max(32),
  maxBytes: z.number().int().min(1).max(25_000_000),
}).strict();

const delegationGrantBoundaryV1Schema = z.object({
  contextGrantIds: idListSchema,
  capabilityGrantIds: idListSchema,
  governedToolIds: idListSchema,
  connectorTargets: idListSchema,
}).strict();

const delegationRetryPolicyV1Schema = z.object({
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

export const delegationContractV1Schema = z.object({
  schemaVersion: z.literal(DELEGATION_CONTRACT_SCHEMA_VERSION),
  version: z.literal(DELEGATION_CONTRACT_VERSION),
  contractId: idSchema,
  contractSha256: sha256Schema,
  delegationId: idSchema,
  scope: z.object({
    tenantId: idSchema,
    initiatingActorId: idSchema,
    parentExecutionId: idSchema,
    parentPrincipalId: idSchema,
    parentDelegationId: idSchema.nullable(),
    workspaceId: idSchema.nullable(),
    projectId: idSchema.nullable(),
    missionId: idSchema.nullable(),
    correlationSha256: sha256Schema,
  }).strict(),
  delegator: z.object({
    principalId: idSchema,
    agentId: idSchema,
    definitionVersion: positiveVersionSchema,
  }).strict(),
  delegate: z.object({
    principalId: idSchema,
    agentId: idSchema,
    definitionVersion: positiveVersionSchema,
  }).strict(),
  purpose: z.string().trim().min(3).max(500),
  idempotencyKeySha256: sha256Schema,
  objective: boundedTextSchema,
  acceptanceCriteria: z.array(delegationAcceptanceCriterionV1Schema)
    .min(1).max(24)
    .superRefine((values, context) => uniqueBy(values, "criterionId", context)),
  inputArtifacts: z.array(delegationArtifactReferenceV1Schema)
    .max(32)
    .superRefine((values, context) => uniqueBy(values, "artifactId", context)),
  output: delegationOutputContractV1Schema,
  grants: delegationGrantBoundaryV1Schema,
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
  retry: delegationRetryPolicyV1Schema,
  verifier: z.object({
    agentId: idSchema,
    definitionVersion: positiveVersionSchema,
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
  }).strict(),
  dataBoundary: z.object({
    parentTranscriptIncluded: z.literal(false),
    credentialMaterialIncluded: z.literal(false),
    inputArtifactsByReferenceOnly: z.literal(true),
    retrievedContentIsUntrusted: z.literal(true),
  }).strict(),
}).strict().superRefine((value, context) => {
  const { contractId, contractSha256, ...body } = value;
  if (
    contractId !== `delegation-contract:${contractSha256}` ||
    canonicalJsonSha256(body) !== contractSha256
  ) {
    context.addIssue({
      code: "custom",
      path: ["contractSha256"],
      message: "Delegation contract integrity is invalid.",
    });
  }
  const createdAt = Date.parse(value.deadline.createdAt);
  const acceptBy = Date.parse(value.deadline.acceptBy);
  const completeBy = Date.parse(value.deadline.completeBy);
  if (!(createdAt <= acceptBy && acceptBy < completeBy)) {
    context.addIssue({
      code: "custom",
      path: ["deadline"],
      message: "Delegation deadlines must be strictly ordered.",
    });
  }
  if (value.retry.backoffMs.length !== value.retry.maxAttempts - 1) {
    context.addIssue({
      code: "custom",
      path: ["retry", "backoffMs"],
      message: "Delegation retry backoff must cover each retry attempt.",
    });
  }
  if (
    value.retry.maxAttempts > value.budgets.retries + 1 ||
    value.budgets.agents < 1
  ) {
    context.addIssue({
      code: "custom",
      path: ["budgets"],
      message: "Delegation retry and Agent budgets are inconsistent.",
    });
  }
  if (value.output.schemaSha256 !== canonicalJsonSha256(value.output.schema)) {
    context.addIssue({
      code: "custom",
      path: ["output", "schemaSha256"],
      message: "Delegation output schema digest is invalid.",
    });
  }
  if (!safeOutputSchema(value.output.schema)) {
    context.addIssue({
      code: "custom",
      path: ["output", "schema"],
      message: "Delegation output schema is not closed and bounded.",
    });
  }
  if (containsSensitiveText(body)) {
    context.addIssue({
      code: "custom",
      path: ["dataBoundary"],
      message: "Delegation contracts cannot contain credential material.",
    });
  }
});

export type DelegationContractV1 = Readonly<
  z.infer<typeof delegationContractV1Schema>
>;
export type DelegationArtifactReferenceV1 = Readonly<
  z.infer<typeof delegationArtifactReferenceV1Schema>
>;

export function buildDelegationContractV1(input: {
  delegationId: string;
  scope: DelegationContractV1["scope"];
  delegator: DelegationContractV1["delegator"];
  delegate: DelegationContractV1["delegate"];
  purpose: DelegationContractV1["purpose"];
  idempotencyKeySha256: DelegationContractV1["idempotencyKeySha256"];
  objective: string;
  acceptanceCriteria: DelegationContractV1["acceptanceCriteria"];
  inputArtifacts?: DelegationContractV1["inputArtifacts"];
  output: Omit<DelegationContractV1["output"], "schemaSha256">;
  grants: DelegationContractV1["grants"];
  parentAuthority: Readonly<{
    grants: DelegationContractV1["grants"];
    budgets: RunBudgetCountersV1;
    completeBy: string;
  }>;
  budgets: RunBudgetCountersV1;
  deadline: DelegationContractV1["deadline"];
  cancellation: DelegationContractV1["cancellation"];
  retry: DelegationContractV1["retry"];
  verifier: DelegationContractV1["verifier"];
}) {
  assertAttenuatedGrants(input.parentAuthority.grants, input.grants);
  assertAttenuatedBudgets(input.parentAuthority.budgets, input.budgets);
  if (Date.parse(input.deadline.completeBy) > Date.parse(input.parentAuthority.completeBy)) {
    throw new Error("Delegation deadline cannot exceed its parent deadline.");
  }
  const normalized = {
    schemaVersion: DELEGATION_CONTRACT_SCHEMA_VERSION,
    version: DELEGATION_CONTRACT_VERSION,
    delegationId: input.delegationId,
    scope: input.scope,
    delegator: input.delegator,
    delegate: input.delegate,
    purpose: input.purpose,
    idempotencyKeySha256: input.idempotencyKeySha256,
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria,
    inputArtifacts: input.inputArtifacts || [],
    output: {
      ...input.output,
      schemaSha256: canonicalJsonSha256(input.output.schema),
    },
    grants: input.grants,
    budgets: input.budgets,
    deadline: input.deadline,
    cancellation: input.cancellation,
    retry: input.retry,
    verifier: input.verifier,
    dataBoundary: {
      parentTranscriptIncluded: false as const,
      credentialMaterialIncluded: false as const,
      inputArtifactsByReferenceOnly: true as const,
      retrievedContentIsUntrusted: true as const,
    },
  };
  const contractSha256 = canonicalJsonSha256(normalized);
  return parseDelegationContractV1({
    ...normalized,
    contractId: `delegation-contract:${contractSha256}`,
    contractSha256,
  });
}

export function parseDelegationContractV1(value: unknown): DelegationContractV1 {
  return deepFreeze(delegationContractV1Schema.parse(value));
}

function assertAttenuatedGrants(
  parent: DelegationContractV1["grants"],
  child: DelegationContractV1["grants"],
) {
  for (const key of [
    "contextGrantIds",
    "capabilityGrantIds",
    "governedToolIds",
    "connectorTargets",
  ] as const) {
    const allowed = new Set(parent[key]);
    if (child[key].some((value) => !allowed.has(value))) {
      throw new Error(`Delegated ${key} cannot exceed parent authority.`);
    }
  }
}

function assertAttenuatedBudgets(
  parentValue: RunBudgetCountersV1,
  childValue: RunBudgetCountersV1,
) {
  const parent = runBudgetCountersV1Schema.parse(parentValue);
  const child = runBudgetCountersV1Schema.parse(childValue);
  for (const dimension of RUN_BUDGET_DIMENSIONS) {
    if (child[dimension] > parent[dimension]) {
      throw new Error(`Delegated ${dimension} budget cannot exceed parent authority.`);
    }
  }
}

function safeOutputSchema(value: JsonValue) {
  const serialized = JSON.stringify(value);
  if (serialized.length > 16_000 || !value || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const root = value as Record<string, JsonValue>;
  if (root.type !== "object" || root.additionalProperties !== false) return false;
  let nodes = 0;
  function visit(node: JsonValue, depth: number): boolean {
    nodes += 1;
    if (nodes > 500 || depth > 12) return false;
    if (!node || typeof node !== "object") return true;
    if (Array.isArray(node)) return node.every((item) => visit(item, depth + 1));
    if ("$ref" in node || "$dynamicRef" in node || node.format === "password") return false;
    if (node.type === "object" && node.additionalProperties !== false) return false;
    const properties = node.properties;
    if (properties && (!isRecord(properties) || Object.keys(properties).some(sensitiveOutputName))) {
      return false;
    }
    return Object.values(node).every((item) => visit(item, depth + 1));
  }
  return visit(root, 0);
}

function sensitiveOutputName(value: string) {
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

function uniqueBy<T extends Record<K, string>, K extends keyof T>(
  values: readonly T[],
  key: K,
  context: z.RefinementCtx,
) {
  uniqueList(values.map((value) => value[key]), context);
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
