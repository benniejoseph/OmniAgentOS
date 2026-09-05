import { z } from "zod";
import {
  runContractIdSchema,
  runContractSha256Schema,
} from "@/lib/runs/contracts";
import {
  buildEffectReceiptV2,
  type EffectReceiptV2,
} from "@/lib/tools/effect-receipt-v2";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const EFFECT_INTENT_V2_SCHEMA_VERSION = 2 as const;
export const MAX_EFFECT_INTENT_V2_BYTES = 14_000;

const principalTypeSchema = z.enum(["user", "agent", "system"]);
const executionKindSchema = z.enum(["direct", "workflow"]);
const approvalStateSchema = z.enum(["not_required", "approved"]);

const intentBodyShape = {
  schemaVersion: z.literal(EFFECT_INTENT_V2_SCHEMA_VERSION),
  intentKind: z.literal("effect_intent"),
  effectIntentId: runContractIdSchema,
  effectMode: z.literal("live"),
  reversible: z.boolean(),
  executionKind: executionKindSchema,
  executionId: runContractIdSchema,
  tenantId: runContractIdSchema,
  actorId: runContractIdSchema,
  executingPrincipalType: principalTypeSchema,
  executingPrincipalId: runContractIdSchema,
  workflowRunId: runContractIdSchema.nullable(),
  planId: runContractIdSchema.nullable(),
  planSha256: runContractSha256Schema.nullable(),
  planNodeId: runContractIdSchema.nullable(),
  toolId: runContractIdSchema,
  toolContractSha256: runContractSha256Schema,
  approvalState: approvalStateSchema,
  approvalBindingSha256: runContractSha256Schema.nullable(),
  inputSha256: runContractSha256Schema,
  idempotencyKeySha256: runContractSha256Schema,
  targetType: runContractIdSchema,
  targetId: runContractIdSchema,
  expectedTargetStateSha256: runContractSha256Schema,
};

const intentBodyBaseSchema = z.object(intentBodyShape).strict();
const intentIdentitySchema = intentBodyBaseSchema.omit({ effectIntentId: true });

const intentBodySchema = intentBodyBaseSchema.superRefine(validateIntentBody);

const effectIntentV2BaseSchema = z.object({
  ...intentBodyShape,
  effectIntentSha256: runContractSha256Schema,
}).strict();

export const effectIntentV2Schema = effectIntentV2BaseSchema.superRefine(
  (value, context) => {
    const { effectIntentSha256, ...body } = value;
    validateIntentBody(body, context);
    if (effectIntentSha256 !== canonicalJsonSha256(body)) {
      context.addIssue({
        code: "custom",
        path: ["effectIntentSha256"],
        message: "Effect-intent v2 digest does not match its body.",
      });
    }
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_EFFECT_INTENT_V2_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Effect intent v2 exceeds ${MAX_EFFECT_INTENT_V2_BYTES} bytes.`,
      });
    }
  },
);

export type EffectIntentV2 = z.infer<typeof effectIntentV2Schema>;
export type BuildEffectIntentV2Input = Omit<
  z.infer<typeof intentBodySchema>,
  "schemaVersion" | "intentKind" | "effectIntentId"
>;

export function buildEffectIntentV2(
  input: BuildEffectIntentV2Input,
): EffectIntentV2 {
  const identity = intentIdentitySchema.parse({
    ...input,
    schemaVersion: EFFECT_INTENT_V2_SCHEMA_VERSION,
    intentKind: "effect_intent",
  });
  const body = intentBodySchema.parse({
    ...identity,
    effectIntentId: effectIntentV2Id(identity),
  });
  return effectIntentV2Schema.parse({
    ...body,
    effectIntentSha256: canonicalJsonSha256(body),
  });
}

export function parseEffectIntentV2(value: unknown): EffectIntentV2 {
  return effectIntentV2Schema.parse(value);
}

const finalizationEvidenceSchema = z.object({
  providerAcknowledgement: z.enum([
    "first_party_store_commit",
    "provider_response",
    "provider_idempotency_reconciliation",
  ]),
  providerAcknowledgementId: runContractIdSchema,
  providerAcknowledgementSha256: runContractSha256Schema,
  verificationMethod: z.literal("read_after_write"),
  verificationState: z.enum(["verified", "failed", "unverifiable"]),
  verificationReasonCode: z.enum([
    "state_matched",
    "target_missing",
    "state_mismatch",
    "read_failed",
    "read_unavailable",
  ]),
  observedTargetStateSha256: runContractSha256Schema.nullable(),
}).strict();

export type EffectIntentV2FinalizationEvidence = z.infer<
  typeof finalizationEvidenceSchema
>;

/** Finalizes only the exact persisted intent; callers cannot replace bindings. */
export function finalizeEffectIntentV2(
  intentValue: unknown,
  evidenceValue: EffectIntentV2FinalizationEvidence,
): EffectReceiptV2 {
  const intent = parseEffectIntentV2(intentValue);
  const evidence = finalizationEvidenceSchema.parse(evidenceValue);
  return buildEffectReceiptV2({
    effectMode: intent.effectMode,
    reversible: intent.reversible,
    executionKind: intent.executionKind,
    executionId: intent.executionId,
    tenantId: intent.tenantId,
    actorId: intent.actorId,
    executingPrincipalType: intent.executingPrincipalType,
    executingPrincipalId: intent.executingPrincipalId,
    workflowRunId: intent.workflowRunId,
    planId: intent.planId,
    planSha256: intent.planSha256,
    planNodeId: intent.planNodeId,
    toolId: intent.toolId,
    toolContractSha256: intent.toolContractSha256,
    approvalState: intent.approvalState,
    approvalBindingSha256: intent.approvalBindingSha256,
    inputSha256: intent.inputSha256,
    idempotencyKeySha256: intent.idempotencyKeySha256,
    targetType: intent.targetType,
    targetId: intent.targetId,
    providerAcknowledgement: evidence.providerAcknowledgement,
    providerAcknowledgementId: evidence.providerAcknowledgementId,
    providerAcknowledgementSha256: evidence.providerAcknowledgementSha256,
    verificationMethod: evidence.verificationMethod,
    verificationState: evidence.verificationState,
    verificationReasonCode: evidence.verificationReasonCode,
    expectedTargetStateSha256: intent.expectedTargetStateSha256,
    observedTargetStateSha256: evidence.observedTargetStateSha256,
  });
}

function validateIntentBody(
  value: z.infer<typeof intentBodyBaseSchema>,
  context: z.RefinementCtx,
) {
  const { effectIntentId: _effectIntentId, ...identity } = value;
  if (value.effectIntentId !== effectIntentV2Id(identity)) {
    context.addIssue({
      code: "custom",
      path: ["effectIntentId"],
      message: "Effect-intent v2 ID does not match its bound metadata.",
    });
  }
  const workflowFields = [
    value.workflowRunId,
    value.planId,
    value.planSha256,
    value.planNodeId,
  ];
  if (value.executionKind === "direct" && workflowFields.some((field) => field !== null)) {
    context.addIssue({
      code: "custom",
      path: ["executionKind"],
      message: "A direct effect intent cannot claim workflow plan bindings.",
    });
  }
  if (value.executionKind === "workflow") {
    if (workflowFields.some((field) => field === null)) {
      context.addIssue({
        code: "custom",
        path: ["executionKind"],
        message: "A workflow effect intent requires every workflow plan binding.",
      });
    } else if (
      value.executingPrincipalType !== "system" ||
      value.executingPrincipalId !== `workflow:${value.workflowRunId}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["executingPrincipalId"],
        message: "A workflow effect intent must use its workflow principal.",
      });
    }
  }
  if (
    (value.approvalState === "approved") !==
    (value.approvalBindingSha256 !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["approvalBindingSha256"],
      message: "Effect intent approval state and binding must agree.",
    });
  }
}

function effectIntentV2Id(identity: z.infer<typeof intentIdentitySchema>) {
  return `effect_intent_v2_${canonicalJsonSha256(identity).slice(0, 46)}`;
}
