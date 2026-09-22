import { z } from "zod";

import { redactSensitive } from "@/lib/security/context";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const DELEGATION_CONTEXT_CAPSULE_SCHEMA_VERSION = 1 as const;
export const DELEGATION_CONTEXT_CAPSULE_VERSION =
  "delegation-context-capsule:1" as const;
export const DELEGATION_CONTEXT_MAX_SELECTED_BYTES = 2_000_000;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const mediaTypeSchema = z.string().trim().min(3).max(120).regex(
  /^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/,
);
const selectedByteCountSchema = z.number().int().min(0).max(512_000);

export const delegationModeSchema = z.enum(["isolated", "fork", "team"]);
export type DelegationMode = z.infer<typeof delegationModeSchema>;

const contextReferenceSchema = z.object({
  contextRefId: idSchema,
  sourceKind: z.enum([
    "conversation_summary",
    "memory",
    "knowledge",
    "document",
    "workspace_state",
    "run_state",
  ]),
  sourceId: idSchema,
  revisionId: idSchema.nullable(),
  contentSha256: sha256Schema,
  contextGrantId: idSchema,
  trust: z.enum(["trusted_first_party", "untrusted_retrieved"]),
  selectedByteCount: selectedByteCountSchema,
}).strict();

const evidenceReferenceSchema = z.object({
  evidenceRefId: idSchema,
  evidenceId: idSchema,
  sourceId: idSchema,
  snapshotSha256: sha256Schema,
  authorizationDecisionSha256: sha256Schema,
  contextGrantId: idSchema,
  trust: z.enum(["trusted_first_party", "untrusted_retrieved"]),
  selectedByteCount: selectedByteCountSchema,
}).strict();

const artifactReferenceSchema = z.object({
  artifactRefId: idSchema,
  artifactId: idSchema,
  artifactVersionId: idSchema,
  contentSha256: sha256Schema,
  mediaType: mediaTypeSchema,
  contextGrantId: idSchema,
  selectedByteCount: selectedByteCountSchema,
}).strict();

const transcriptTurnReferenceSchema = z.object({
  sequence: z.number().int().min(0).max(255),
  turnId: idSchema,
  role: z.enum(["system", "user", "assistant", "tool"]),
  contentSha256: sha256Schema,
  selectedByteCount: selectedByteCountSchema,
}).strict();

const excludedParentTranscriptSchema = z.object({
  included: z.literal(false),
  manifestId: z.null(),
  manifestSha256: z.null(),
  turns: z.tuple([]),
}).strict();

const includedParentTranscriptSchema = z.object({
  included: z.literal(true),
  manifestId: idSchema,
  manifestSha256: sha256Schema,
  turns: z.array(transcriptTurnReferenceSchema).min(1).max(128),
}).strict().superRefine((manifest, context) => {
  const sequence = manifest.turns.map((turn) => turn.sequence);
  if (sequence.some((value, index) => value !== index)) {
    context.addIssue({
      code: "custom",
      path: ["turns"],
      message: "Parent transcript turns must be an exact zero-based sequence.",
    });
  }
  if (new Set(manifest.turns.map((turn) => turn.turnId)).size !== manifest.turns.length) {
    context.addIssue({
      code: "custom",
      path: ["turns"],
      message: "Parent transcript turn references must be unique.",
    });
  }
  const { manifestSha256, ...body } = manifest;
  if (canonicalJsonSha256(body) !== manifestSha256) {
    context.addIssue({
      code: "custom",
      path: ["manifestSha256"],
      message: "Parent transcript manifest digest is invalid.",
    });
  }
});

const parentTranscriptSchema = z.discriminatedUnion("included", [
  excludedParentTranscriptSchema,
  includedParentTranscriptSchema,
]);

const selectionSchema = z.object({
  contextRefs: z.array(contextReferenceSchema).max(64),
  evidenceRefs: z.array(evidenceReferenceSchema).max(64),
  artifactRefs: z.array(artifactReferenceSchema).max(32),
}).strict().superRefine((selection, context) => {
  requireUnique(selection.contextRefs.map((reference) => reference.contextRefId), context);
  requireUnique(selection.evidenceRefs.map((reference) => reference.evidenceRefId), context);
  requireUnique(selection.artifactRefs.map((reference) => reference.artifactRefId), context);
});

const contextCapsuleBodySchema = z.object({
  schemaVersion: z.literal(DELEGATION_CONTEXT_CAPSULE_SCHEMA_VERSION),
  version: z.literal(DELEGATION_CONTEXT_CAPSULE_VERSION),
  mode: delegationModeSchema,
  scope: z.object({
    tenantId: idSchema,
    initiatingActorId: idSchema,
    rootExecutionId: idSchema,
    rootPrincipalId: idSchema,
    parentExecutionId: idSchema,
    parentPrincipalId: idSchema,
    delegationId: idSchema,
  }).strict(),
  selection: selectionSchema,
  selectionSha256: sha256Schema,
  parentTranscript: parentTranscriptSchema,
  dataBoundary: z.object({
    contentByReferenceOnly: z.literal(true),
    credentialMaterialIncluded: z.literal(false),
    messagesGrantAuthority: z.literal(false),
    retrievedDataGrantsAuthority: z.literal(false),
    authoritySource: z.literal("delegation_execution_contract_only"),
  }).strict(),
}).strict();

export const delegationContextCapsuleV1Schema = contextCapsuleBodySchema.extend({
  capsuleId: idSchema,
  capsuleSha256: sha256Schema,
}).strict().superRefine((capsule, context) => {
  const { capsuleId, capsuleSha256, ...body } = capsule;
  if (
    capsuleId !== `delegation-context:${capsuleSha256}` ||
    canonicalJsonSha256(body) !== capsuleSha256
  ) {
    context.addIssue({
      code: "custom",
      path: ["capsuleSha256"],
      message: "Delegation context capsule integrity is invalid.",
    });
  }
  if (capsule.selectionSha256 !== canonicalJsonSha256(capsule.selection)) {
    context.addIssue({
      code: "custom",
      path: ["selectionSha256"],
      message: "Delegation context selection digest is invalid.",
    });
  }
  if (capsule.parentTranscript.included && capsule.mode !== "fork") {
    context.addIssue({
      code: "custom",
      path: ["parentTranscript"],
      message: "Only fork delegation may receive an exact parent transcript manifest.",
    });
  }
  if (selectedByteCount(capsule) > DELEGATION_CONTEXT_MAX_SELECTED_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["selection"],
      message: "Delegation context selection exceeds its bounded byte budget.",
    });
  }
  if (containsSensitiveText(body)) {
    context.addIssue({
      code: "custom",
      path: ["dataBoundary"],
      message: "Delegation context capsules cannot contain credential material.",
    });
  }
});

export type DelegationContextCapsuleV1 = Readonly<
  z.infer<typeof delegationContextCapsuleV1Schema>
>;
export type DelegationContextReferenceV1 = Readonly<
  z.infer<typeof contextReferenceSchema>
>;
export type DelegationEvidenceReferenceV1 = Readonly<
  z.infer<typeof evidenceReferenceSchema>
>;
export type DelegationArtifactReferenceV1 = Readonly<
  z.infer<typeof artifactReferenceSchema>
>;
export type DelegationTranscriptTurnReferenceV1 = Readonly<
  z.infer<typeof transcriptTurnReferenceSchema>
>;

export function buildDelegationContextCapsuleV1(input: {
  mode: DelegationMode;
  scope: DelegationContextCapsuleV1["scope"];
  contextRefs?: readonly DelegationContextReferenceV1[];
  evidenceRefs?: readonly DelegationEvidenceReferenceV1[];
  artifactRefs?: readonly DelegationArtifactReferenceV1[];
  parentTranscript?: Readonly<{
    manifestId: string;
    turns: readonly DelegationTranscriptTurnReferenceV1[];
  }>;
}): DelegationContextCapsuleV1 {
  if (input.parentTranscript && input.mode !== "fork") {
    throw new Error(
      "Only fork delegation may receive an exact parent transcript manifest.",
    );
  }
  const selection = selectionSchema.parse({
    contextRefs: input.contextRefs || [],
    evidenceRefs: input.evidenceRefs || [],
    artifactRefs: input.artifactRefs || [],
  });
  const parentTranscript = input.parentTranscript
    ? includedTranscript(input.parentTranscript)
    : {
        included: false as const,
        manifestId: null,
        manifestSha256: null,
        turns: [] as [],
      };
  const body = contextCapsuleBodySchema.parse({
    schemaVersion: DELEGATION_CONTEXT_CAPSULE_SCHEMA_VERSION,
    version: DELEGATION_CONTEXT_CAPSULE_VERSION,
    mode: input.mode,
    scope: input.scope,
    selection,
    selectionSha256: canonicalJsonSha256(selection),
    parentTranscript,
    dataBoundary: {
      contentByReferenceOnly: true,
      credentialMaterialIncluded: false,
      messagesGrantAuthority: false,
      retrievedDataGrantsAuthority: false,
      authoritySource: "delegation_execution_contract_only",
    },
  });
  const capsuleSha256 = canonicalJsonSha256(body);
  return parseDelegationContextCapsuleV1({
    ...body,
    capsuleId: `delegation-context:${capsuleSha256}`,
    capsuleSha256,
  });
}

export function parseDelegationContextCapsuleV1(
  value: unknown,
): DelegationContextCapsuleV1 {
  return deepFreeze(delegationContextCapsuleV1Schema.parse(value));
}

function includedTranscript(input: Readonly<{
  manifestId: string;
  turns: readonly DelegationTranscriptTurnReferenceV1[];
}>) {
  const body = {
    included: true as const,
    manifestId: input.manifestId,
    turns: [...input.turns],
  };
  return {
    ...body,
    manifestSha256: canonicalJsonSha256(body),
  };
}

function selectedByteCount(capsule: z.infer<typeof contextCapsuleBodySchema>) {
  const selectedReferences = [
    ...capsule.selection.contextRefs,
    ...capsule.selection.evidenceRefs,
    ...capsule.selection.artifactRefs,
    ...(capsule.parentTranscript.included ? capsule.parentTranscript.turns : []),
  ];
  return selectedReferences.reduce(
    (total, reference) => total + reference.selectedByteCount,
    0,
  );
}

function containsSensitiveText(value: unknown): boolean {
  if (typeof value === "string") return redactSensitive(value) !== value;
  if (Array.isArray(value)) return value.some(containsSensitiveText);
  return Boolean(value) && typeof value === "object" &&
    Object.values(value as Record<string, unknown>).some(containsSensitiveText);
}

function requireUnique(values: readonly string[], context: z.RefinementCtx) {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Context references must be unique." });
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
