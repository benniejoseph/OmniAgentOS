import { z } from "zod";
import {
  runContractIdSchema,
  runContractSha256Schema,
} from "@/lib/runs/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const EFFECT_RECEIPT_V2_SCHEMA_VERSION = 2 as const;
export const MAX_EFFECT_RECEIPT_V2_BYTES = 20_000;
export const MAX_EFFECT_RECEIPT_V2_EVENT_BYTES = 10_000;

const principalTypeSchema = z.enum(["user", "agent", "system"]);
const executionKindSchema = z.enum(["direct", "workflow"]);
const approvalStateSchema = z.enum(["not_required", "approved"]);
const providerAcknowledgementSchema = z.enum([
  "first_party_store_commit",
  "provider_response",
  "provider_idempotency_reconciliation",
]);
const verificationStateSchema = z.enum(["verified", "failed", "unverifiable"]);
const verificationReasonSchema = z.enum([
  "state_matched",
  "target_missing",
  "state_mismatch",
  "read_failed",
  "read_unavailable",
]);

const bodyShape = {
  schemaVersion: z.literal(EFFECT_RECEIPT_V2_SCHEMA_VERSION),
  receiptKind: z.literal("effect_receipt"),
  effectReceiptId: runContractIdSchema,
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
  providerAcknowledgement: providerAcknowledgementSchema,
  providerAcknowledgementId: runContractIdSchema,
  providerAcknowledgementSha256: runContractSha256Schema,
  verificationMethod: z.literal("read_after_write"),
  verificationState: verificationStateSchema,
  verificationReasonCode: verificationReasonSchema,
  expectedTargetStateSha256: runContractSha256Schema,
  observedTargetStateSha256: runContractSha256Schema.nullable(),
};

const bodyBaseSchema = z.object(bodyShape).strict();
const identitySchema = bodyBaseSchema.omit({ effectReceiptId: true });

export const effectReceiptBodyV2Schema = bodyBaseSchema.superRefine(
  validateBody,
);

const receiptBaseSchema = z.object({
  ...bodyShape,
  receiptSha256: runContractSha256Schema,
}).strict();

export const effectReceiptV2Schema = receiptBaseSchema.superRefine(
  (value, context) => {
    const { receiptSha256, ...body } = value;
    validateBody(body, context);
    if (receiptSha256 !== canonicalJsonSha256(body)) {
      context.addIssue({
        code: "custom",
        path: ["receiptSha256"],
        message: "Effect-receipt v2 digest does not match its body.",
      });
    }
    addByteLimit(value, MAX_EFFECT_RECEIPT_V2_BYTES, "Effect receipt v2", context);
  },
);

export type EffectReceiptV2 = z.infer<typeof effectReceiptV2Schema>;
export type BuildEffectReceiptV2Input = Omit<
  z.infer<typeof effectReceiptBodyV2Schema>,
  "schemaVersion" | "receiptKind" | "effectReceiptId"
>;

export function buildEffectReceiptV2(
  input: BuildEffectReceiptV2Input,
): EffectReceiptV2 {
  const identity = identitySchema.parse({
    ...input,
    schemaVersion: EFFECT_RECEIPT_V2_SCHEMA_VERSION,
    receiptKind: "effect_receipt",
  });
  const body = effectReceiptBodyV2Schema.parse({
    ...identity,
    effectReceiptId: effectReceiptV2Id(identity),
  });
  return effectReceiptV2Schema.parse({
    ...body,
    receiptSha256: canonicalJsonSha256(body),
  });
}

const bindingExpectationSchema = z.object({
  effectReceiptId: runContractIdSchema.optional(),
  receiptSha256: runContractSha256Schema.optional(),
  executionId: runContractIdSchema.optional(),
  tenantId: runContractIdSchema.optional(),
  actorId: runContractIdSchema.optional(),
  executingPrincipalType: principalTypeSchema.optional(),
  executingPrincipalId: runContractIdSchema.optional(),
  workflowRunId: runContractIdSchema.nullable().optional(),
  planId: runContractIdSchema.nullable().optional(),
  planSha256: runContractSha256Schema.nullable().optional(),
  planNodeId: runContractIdSchema.nullable().optional(),
  toolId: runContractIdSchema.optional(),
  toolContractSha256: runContractSha256Schema.optional(),
  approvalBindingSha256: runContractSha256Schema.nullable().optional(),
  inputSha256: runContractSha256Schema.optional(),
  idempotencyKeySha256: runContractSha256Schema.optional(),
  targetType: runContractIdSchema.optional(),
  targetId: runContractIdSchema.optional(),
}).strict();

export type EffectReceiptV2BindingExpectation = z.infer<
  typeof bindingExpectationSchema
>;

export function parseEffectReceiptV2(
  value: unknown,
  expectedBindings?: EffectReceiptV2BindingExpectation,
): EffectReceiptV2 | undefined {
  if (value === undefined) return undefined;
  const parsed = effectReceiptV2Schema.parse(value);
  if (!expectedBindings) return parsed;
  const expected = bindingExpectationSchema.parse(expectedBindings);
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (parsed[field as keyof EffectReceiptV2] !== expectedValue) {
      throw new Error(`Effect receipt v2 is bound to a different ${field}.`);
    }
  }
  return parsed;
}

const eventPayloadSchema = z.object({
  schemaVersion: z.literal(EFFECT_RECEIPT_V2_SCHEMA_VERSION),
  payloadKind: z.literal("effect_receipt"),
  effectReceiptId: runContractIdSchema,
  effectReceiptSha256: runContractSha256Schema,
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
  providerAcknowledgement: providerAcknowledgementSchema,
  providerAcknowledgementSha256: runContractSha256Schema,
  verificationMethod: z.literal("read_after_write"),
  verificationState: verificationStateSchema,
  verificationReasonCode: verificationReasonSchema,
  expectedTargetStateSha256: runContractSha256Schema,
  observedTargetStateSha256: runContractSha256Schema.nullable(),
}).strict().superRefine((value, context) => {
  addByteLimit(value, MAX_EFFECT_RECEIPT_V2_EVENT_BYTES, "Effect-receipt v2 event", context);
});

export type EffectReceiptV2EventPayload = z.infer<typeof eventPayloadSchema>;

export function buildEffectReceiptV2EventPayload(
  value: EffectReceiptV2,
): EffectReceiptV2EventPayload {
  const receipt = effectReceiptV2Schema.parse(value);
  return eventPayloadSchema.parse({
    schemaVersion: receipt.schemaVersion,
    payloadKind: "effect_receipt",
    effectReceiptId: receipt.effectReceiptId,
    effectReceiptSha256: receipt.receiptSha256,
    effectMode: receipt.effectMode,
    reversible: receipt.reversible,
    executionKind: receipt.executionKind,
    executionId: receipt.executionId,
    tenantId: receipt.tenantId,
    actorId: receipt.actorId,
    executingPrincipalType: receipt.executingPrincipalType,
    executingPrincipalId: receipt.executingPrincipalId,
    workflowRunId: receipt.workflowRunId,
    planId: receipt.planId,
    planSha256: receipt.planSha256,
    planNodeId: receipt.planNodeId,
    toolId: receipt.toolId,
    toolContractSha256: receipt.toolContractSha256,
    approvalState: receipt.approvalState,
    approvalBindingSha256: receipt.approvalBindingSha256,
    inputSha256: receipt.inputSha256,
    idempotencyKeySha256: receipt.idempotencyKeySha256,
    targetType: receipt.targetType,
    targetId: receipt.targetId,
    providerAcknowledgement: receipt.providerAcknowledgement,
    providerAcknowledgementSha256: receipt.providerAcknowledgementSha256,
    verificationMethod: receipt.verificationMethod,
    verificationState: receipt.verificationState,
    verificationReasonCode: receipt.verificationReasonCode,
    expectedTargetStateSha256: receipt.expectedTargetStateSha256,
    observedTargetStateSha256: receipt.observedTargetStateSha256,
  });
}

function validateBody(
  value: z.infer<typeof bodyBaseSchema>,
  context: z.RefinementCtx,
) {
  const { effectReceiptId: _effectReceiptId, ...identity } = value;
  if (value.effectReceiptId !== effectReceiptV2Id(identity)) {
    context.addIssue({
      code: "custom",
      path: ["effectReceiptId"],
      message: "Effect-receipt v2 ID does not match its bound metadata.",
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
      message: "A direct effect cannot claim workflow plan bindings.",
    });
  }
  if (value.executionKind === "workflow") {
    if (workflowFields.some((field) => field === null)) {
      context.addIssue({
        code: "custom",
        path: ["executionKind"],
        message: "A workflow effect requires every workflow plan binding.",
      });
    } else if (
      value.executingPrincipalType !== "system" ||
      value.executingPrincipalId !== `workflow:${value.workflowRunId}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["executingPrincipalId"],
        message: "A workflow effect must execute as its bound workflow principal.",
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
      message: "Approval state and approval binding must agree.",
    });
  }

  if (value.verificationState === "verified") {
    if (
      value.verificationReasonCode !== "state_matched" ||
      value.observedTargetStateSha256 === null ||
      value.observedTargetStateSha256 !== value.expectedTargetStateSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["verificationState"],
        message: "Verified effect state must exactly match the expected target.",
      });
    }
  } else if (value.verificationState === "failed") {
    const missing = value.verificationReasonCode === "target_missing" &&
      value.observedTargetStateSha256 === null;
    const mismatched = value.verificationReasonCode === "state_mismatch" &&
      value.observedTargetStateSha256 !== null &&
      value.observedTargetStateSha256 !== value.expectedTargetStateSha256;
    if (!missing && !mismatched) {
      context.addIssue({
        code: "custom",
        path: ["verificationState"],
        message: "Failed effect verification requires missing or mismatched state.",
      });
    }
  } else if (
    !["read_failed", "read_unavailable"].includes(value.verificationReasonCode) ||
    value.observedTargetStateSha256 !== null
  ) {
    context.addIssue({
      code: "custom",
      path: ["verificationState"],
      message: "Unverifiable effects cannot claim observed target state.",
    });
  }
}

function effectReceiptV2Id(
  identity: z.infer<typeof identitySchema>,
) {
  return `effect_v2_${canonicalJsonSha256(identity).slice(0, 53)}`;
}

function addByteLimit(
  value: unknown,
  limit: number,
  label: string,
  context: z.RefinementCtx,
) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > limit) {
    context.addIssue({ code: "custom", message: `${label} exceeds ${limit} bytes.` });
  }
}
