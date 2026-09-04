import { createHash } from "node:crypto";
import { z } from "zod";
import {
  runContractIdSchema,
  runContractSha256Schema,
} from "@/lib/runs/contracts";

/**
 * V1 is deliberately limited to the approved-workflow `memory.write` canary.
 * A later effect or provider requires a new schema version rather than making
 * this contract silently mean more than it did when a receipt was recorded.
 */
export const EFFECT_RECEIPT_SCHEMA_VERSION = 1 as const;
export const MAX_EFFECT_RECEIPT_BYTES = 16_000;
export const MAX_EFFECT_RECEIPT_EVENT_PAYLOAD_BYTES = 8_000;

export const effectProviderAcknowledgementSchema = z.enum([
  "first_party_store_commit",
]);

export const effectVerificationStateSchema = z.enum([
  "verified",
  "failed",
  "unverifiable",
]);

export const effectVerificationReasonCodeSchema = z.enum([
  "state_matched",
  "target_missing",
  "state_mismatch",
  "read_failed",
  "read_unavailable",
]);

const effectReceiptBodyShape = {
  schemaVersion: z.literal(EFFECT_RECEIPT_SCHEMA_VERSION),
  receiptKind: z.literal("effect_receipt"),
  effectReceiptId: runContractIdSchema,
  effectMode: z.literal("live"),
  reversible: z.literal(true),
  executionId: runContractIdSchema,
  tenantId: runContractIdSchema,
  actorId: runContractIdSchema,
  executingPrincipalType: z.literal("system"),
  executingPrincipalId: runContractIdSchema,
  workflowRunId: runContractIdSchema,
  planId: runContractIdSchema,
  planSha256: runContractSha256Schema,
  planNodeId: runContractIdSchema,
  toolId: z.literal("memory.write"),
  toolContractSha256: runContractSha256Schema,
  inputSha256: runContractSha256Schema,
  idempotencyKeySha256: runContractSha256Schema,
  targetType: z.literal("memory"),
  targetId: runContractIdSchema,
  providerAcknowledgement: effectProviderAcknowledgementSchema,
  providerAcknowledgementId: runContractIdSchema,
  providerAcknowledgementSha256: runContractSha256Schema,
  verificationMethod: z.literal("read_after_write"),
  verificationState: effectVerificationStateSchema,
  verificationReasonCode: effectVerificationReasonCodeSchema,
  expectedTargetStateSha256: runContractSha256Schema,
  observedTargetStateSha256: runContractSha256Schema.nullable(),
};

const effectReceiptBodyBaseSchema = z.object(effectReceiptBodyShape).strict();
const effectReceiptIdentityInputSchema = effectReceiptBodyBaseSchema.omit({
  effectReceiptId: true,
});

export const effectReceiptBodyV1Schema = effectReceiptBodyBaseSchema
  .superRefine((value, context) => {
    validateEffectReceiptBody(value, context);
  });

export type EffectReceiptBodyV1 = z.infer<typeof effectReceiptBodyV1Schema>;

const effectReceiptBaseSchema = z.object({
  ...effectReceiptBodyShape,
  receiptSha256: runContractSha256Schema,
}).strict();

export const effectReceiptV1Schema = effectReceiptBaseSchema
  .superRefine((value, context) => {
    const { receiptSha256, ...body } = value;
    validateEffectReceiptBody(body, context);
    if (receiptSha256 !== canonicalJsonSha256(body)) {
      context.addIssue({
        code: "custom",
        message: "Effect-receipt digest does not match its body.",
        path: ["receiptSha256"],
      });
    }
    addJsonByteLimitIssue(
      value,
      MAX_EFFECT_RECEIPT_BYTES,
      context,
      "Effect receipt",
    );
  });

export type EffectReceiptV1 = z.infer<typeof effectReceiptV1Schema>;
export type EffectReceipt = EffectReceiptV1;
export type BuildEffectReceiptV1Input = Omit<
  EffectReceiptBodyV1,
  "schemaVersion" | "receiptKind" | "effectReceiptId"
>;

/** Builds a deterministic, metadata-only receipt for one committed effect. */
export function buildEffectReceiptV1(
  input: BuildEffectReceiptV1Input,
): EffectReceiptV1 {
  const identityInput = effectReceiptIdentityInputSchema.parse({
    ...input,
    schemaVersion: EFFECT_RECEIPT_SCHEMA_VERSION,
    receiptKind: "effect_receipt",
  });
  const body = effectReceiptBodyV1Schema.parse({
    ...identityInput,
    effectReceiptId: derivedEffectReceiptId(identityInput),
  });
  return effectReceiptV1Schema.parse({
    ...body,
    receiptSha256: canonicalJsonSha256(body),
  });
}

export type EffectReceiptBindingExpectationV1 = Partial<Pick<
  EffectReceiptV1,
  | "effectReceiptId"
  | "receiptSha256"
  | "executionId"
  | "tenantId"
  | "actorId"
  | "executingPrincipalType"
  | "executingPrincipalId"
  | "workflowRunId"
  | "planId"
  | "planSha256"
  | "planNodeId"
  | "toolId"
  | "toolContractSha256"
  | "inputSha256"
  | "idempotencyKeySha256"
  | "targetType"
  | "targetId"
>>;

const effectReceiptBindingExpectationV1Schema = z.object({
  effectReceiptId: runContractIdSchema.optional(),
  receiptSha256: runContractSha256Schema.optional(),
  executionId: runContractIdSchema.optional(),
  tenantId: runContractIdSchema.optional(),
  actorId: runContractIdSchema.optional(),
  executingPrincipalType: z.literal("system").optional(),
  executingPrincipalId: runContractIdSchema.optional(),
  workflowRunId: runContractIdSchema.optional(),
  planId: runContractIdSchema.optional(),
  planSha256: runContractSha256Schema.optional(),
  planNodeId: runContractIdSchema.optional(),
  toolId: z.literal("memory.write").optional(),
  toolContractSha256: runContractSha256Schema.optional(),
  inputSha256: runContractSha256Schema.optional(),
  idempotencyKeySha256: runContractSha256Schema.optional(),
  targetType: z.literal("memory").optional(),
  targetId: runContractIdSchema.optional(),
}).strict();

/**
 * Only `undefined` represents a legacy record with no receipt. Any present
 * malformed or cross-bound value fails closed.
 */
export function parseEffectReceiptV1(
  value: unknown,
  expectedBindings?: EffectReceiptBindingExpectationV1,
): EffectReceiptV1 | undefined {
  if (value === undefined) return undefined;
  const parsed = effectReceiptV1Schema.parse(value);
  if (expectedBindings) {
    const expected = effectReceiptBindingExpectationV1Schema.parse(
      expectedBindings,
    );
    for (const [field, expectedValue] of Object.entries(expected)) {
      if (parsed[field as keyof EffectReceiptV1] !== expectedValue) {
        throw new Error(
          `Effect receipt is bound to a different ${bindingLabel(field)}.`,
        );
      }
    }
  }
  return parsed;
}

const effectReceiptEventPayloadBaseSchema = z.object({
  schemaVersion: z.literal(EFFECT_RECEIPT_SCHEMA_VERSION),
  payloadKind: z.literal("effect_receipt"),
  effectReceiptId: runContractIdSchema,
  effectReceiptSha256: runContractSha256Schema,
  effectMode: z.literal("live"),
  reversible: z.literal(true),
  executionId: runContractIdSchema,
  tenantId: runContractIdSchema,
  actorId: runContractIdSchema,
  executingPrincipalType: z.literal("system"),
  executingPrincipalId: runContractIdSchema,
  workflowRunId: runContractIdSchema,
  planId: runContractIdSchema,
  planSha256: runContractSha256Schema,
  planNodeId: runContractIdSchema,
  toolId: z.literal("memory.write"),
  toolContractSha256: runContractSha256Schema,
  inputSha256: runContractSha256Schema,
  idempotencyKeySha256: runContractSha256Schema,
  targetType: z.literal("memory"),
  targetId: runContractIdSchema,
  providerAcknowledgement: effectProviderAcknowledgementSchema,
  providerAcknowledgementSha256: runContractSha256Schema,
  verificationMethod: z.literal("read_after_write"),
  verificationState: effectVerificationStateSchema,
  verificationReasonCode: effectVerificationReasonCodeSchema,
  expectedTargetStateSha256: runContractSha256Schema,
  observedTargetStateSha256: runContractSha256Schema.nullable(),
}).strict();

export const effectReceiptEventPayloadV1Schema =
  effectReceiptEventPayloadBaseSchema.superRefine((value, context) => {
    const receiptResult = effectReceiptV1Schema.safeParse({
      schemaVersion: value.schemaVersion,
      receiptKind: "effect_receipt",
      effectReceiptId: value.effectReceiptId,
      effectMode: value.effectMode,
      reversible: value.reversible,
      executionId: value.executionId,
      tenantId: value.tenantId,
      actorId: value.actorId,
      executingPrincipalType: value.executingPrincipalType,
      executingPrincipalId: value.executingPrincipalId,
      workflowRunId: value.workflowRunId,
      planId: value.planId,
      planSha256: value.planSha256,
      planNodeId: value.planNodeId,
      toolId: value.toolId,
      toolContractSha256: value.toolContractSha256,
      inputSha256: value.inputSha256,
      idempotencyKeySha256: value.idempotencyKeySha256,
      targetType: value.targetType,
      targetId: value.targetId,
      providerAcknowledgement: value.providerAcknowledgement,
      providerAcknowledgementId: value.targetId,
      providerAcknowledgementSha256: value.providerAcknowledgementSha256,
      verificationMethod: value.verificationMethod,
      verificationState: value.verificationState,
      verificationReasonCode: value.verificationReasonCode,
      expectedTargetStateSha256: value.expectedTargetStateSha256,
      observedTargetStateSha256: value.observedTargetStateSha256,
      receiptSha256: value.effectReceiptSha256,
    });
    if (!receiptResult.success) {
      context.addIssue({
        code: "custom",
        message: "Effect-receipt event metadata is inconsistent.",
      });
    }
    addJsonByteLimitIssue(
      value,
      MAX_EFFECT_RECEIPT_EVENT_PAYLOAD_BYTES,
      context,
      "Effect-receipt event payload",
    );
  });

export type EffectReceiptEventPayloadV1 = z.infer<
  typeof effectReceiptEventPayloadV1Schema
>;
export type EffectReceiptEventPayload = EffectReceiptEventPayloadV1;

/** Builds a compact allowlisted event projection; it never spreads a receipt. */
export function buildEffectReceiptEventPayloadV1(
  receipt: EffectReceiptV1,
): EffectReceiptEventPayloadV1 {
  const parsed = effectReceiptV1Schema.parse(receipt);
  return effectReceiptEventPayloadV1Schema.parse({
    schemaVersion: EFFECT_RECEIPT_SCHEMA_VERSION,
    payloadKind: "effect_receipt",
    effectReceiptId: parsed.effectReceiptId,
    effectReceiptSha256: parsed.receiptSha256,
    effectMode: parsed.effectMode,
    reversible: parsed.reversible,
    executionId: parsed.executionId,
    tenantId: parsed.tenantId,
    actorId: parsed.actorId,
    executingPrincipalType: parsed.executingPrincipalType,
    executingPrincipalId: parsed.executingPrincipalId,
    workflowRunId: parsed.workflowRunId,
    planId: parsed.planId,
    planSha256: parsed.planSha256,
    planNodeId: parsed.planNodeId,
    toolId: parsed.toolId,
    toolContractSha256: parsed.toolContractSha256,
    inputSha256: parsed.inputSha256,
    idempotencyKeySha256: parsed.idempotencyKeySha256,
    targetType: parsed.targetType,
    targetId: parsed.targetId,
    providerAcknowledgement: parsed.providerAcknowledgement,
    providerAcknowledgementSha256: parsed.providerAcknowledgementSha256,
    verificationMethod: parsed.verificationMethod,
    verificationState: parsed.verificationState,
    verificationReasonCode: parsed.verificationReasonCode,
    expectedTargetStateSha256: parsed.expectedTargetStateSha256,
    observedTargetStateSha256: parsed.observedTargetStateSha256,
  });
}

/** Lowercase SHA-256 over recursively key-sorted JSON. */
export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

/** Hashes an idempotency identity without retaining or correlating its raw key. */
export function idempotencyKeySha256(input: {
  tenantId: string;
  idempotencyKey: string;
}): string {
  const parsed = z.object({
    tenantId: runContractIdSchema,
    idempotencyKey: z.string().trim().min(1).max(512),
  }).strict().parse(input);
  return createHash("sha256")
    .update(`${parsed.tenantId}\u0000${parsed.idempotencyKey}`, "utf8")
    .digest("hex");
}

export function memoryEffectTargetIdV1(input: Pick<
  EffectReceiptV1,
  | "tenantId"
  | "executionId"
  | "workflowRunId"
  | "planId"
  | "planSha256"
  | "planNodeId"
  | "inputSha256"
  | "idempotencyKeySha256"
>) {
  return `memory_effect_${canonicalJsonSha256({
    tenantId: input.tenantId,
    executionId: input.executionId,
    workflowRunId: input.workflowRunId,
    planId: input.planId,
    planSha256: input.planSha256,
    planNodeId: input.planNodeId,
    inputSha256: input.inputSha256,
    idempotencyKeySha256: input.idempotencyKeySha256,
  }).slice(0, 56)}`;
}

type EffectReceiptBodyBase = z.infer<typeof effectReceiptBodyBaseSchema>;
type EffectReceiptIdentityInput = z.infer<
  typeof effectReceiptIdentityInputSchema
>;

function validateEffectReceiptBody(
  value: EffectReceiptBodyBase,
  context: z.RefinementCtx,
) {
  const { effectReceiptId: _effectReceiptId, ...identityInput } = value;
  if (value.effectReceiptId !== derivedEffectReceiptId(identityInput)) {
    context.addIssue({
      code: "custom",
      message: "Effect-receipt ID does not match its bound metadata.",
      path: ["effectReceiptId"],
    });
  }
  if (value.providerAcknowledgementId !== value.targetId) {
    context.addIssue({
      code: "custom",
      message: "Provider acknowledgement must identify the bound target.",
      path: ["providerAcknowledgementId"],
    });
  }
  if (value.executingPrincipalId !== `workflow:${value.workflowRunId}`) {
    context.addIssue({
      code: "custom",
      message: "The executing principal must be the bound workflow system principal.",
      path: ["executingPrincipalId"],
    });
  }
  if (value.targetId !== memoryEffectTargetIdV1(value)) {
    context.addIssue({
      code: "custom",
      message: "The memory target does not match its deterministic effect binding.",
      path: ["targetId"],
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
        message: "Verified read-after-write evidence must match the expected target state.",
        path: ["verificationState"],
      });
    }
    return;
  }

  if (value.verificationState === "failed") {
    const missingTarget =
      value.verificationReasonCode === "target_missing" &&
      value.observedTargetStateSha256 === null;
    const mismatchedTarget =
      value.verificationReasonCode === "state_mismatch" &&
      value.observedTargetStateSha256 !== null &&
      value.observedTargetStateSha256 !== value.expectedTargetStateSha256;
    if (!missingTarget && !mismatchedTarget) {
      context.addIssue({
        code: "custom",
        message: "Failed read-after-write evidence requires a missing or mismatched target.",
        path: ["verificationState"],
      });
    }
    return;
  }

  if (
    !["read_failed", "read_unavailable"].includes(
      value.verificationReasonCode,
    ) ||
    value.observedTargetStateSha256 !== null
  ) {
    context.addIssue({
      code: "custom",
      message: "Unverifiable read-after-write evidence cannot claim an observed target state.",
      path: ["verificationState"],
    });
  }
}

function derivedEffectReceiptId(input: EffectReceiptIdentityInput): string {
  return `effect_${canonicalJsonSha256(input).slice(0, 56)}`;
}

function canonicalJson(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Effect-receipt hash input is not JSON serializable.");
  }
  if (serialized === undefined) {
    throw new Error("Effect-receipt hash input is not JSON serializable.");
  }
  const parsed = JSON.parse(serialized) as unknown;
  return JSON.stringify(sortJsonForHash(parsed));
}

function sortJsonForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonForHash);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortJsonForHash(record[key])]),
    );
  }
  return value;
}

function addJsonByteLimitIssue(
  value: unknown,
  maxBytes: number,
  context: z.RefinementCtx,
  label: string,
) {
  const serialized = JSON.stringify(value);
  const byteCount = serialized === undefined
    ? Number.POSITIVE_INFINITY
    : new TextEncoder().encode(serialized).byteLength;
  if (byteCount > maxBytes) {
    context.addIssue({
      code: "custom",
      message: `${label} exceeds ${maxBytes} UTF-8 bytes.`,
    });
  }
}

function bindingLabel(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}
