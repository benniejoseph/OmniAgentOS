import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { memoryContentDigest } from "@/lib/memory/content-digest";
import {
  PERSONAL_CONTEXT_NOTICE_CONTRACT_ID,
  PERSONAL_CONTEXT_NOTICE_CONTRACT_VERSION,
  PERSONAL_CONTEXT_NOTICE_SHA256,
  PERSONAL_CONTEXT_NOTICE_TEXT,
  personalContextConsentAuthorityV1Schema,
} from "@/lib/memory/personal-context-consent";

export const PERSONAL_CONTEXT_CONSENT_NATIVE_READ_CONTRACT = "asael-personal-context-consent-read:1" as const;
export const PERSONAL_CONTEXT_CONSENT_NATIVE_DECISION_CONTRACT = "asael-personal-context-consent-decision:1" as const;
export const PERSONAL_CONTEXT_CONSENT_NATIVE_ACCEPTANCE_CONTRACT = "asael-personal-context-consent-acceptance:1" as const;
export const PERSONAL_CONTEXT_CONSENT_NATIVE_READ_PURPOSE = "memory.personal_context_consent.read" as const;
export const PERSONAL_CONTEXT_CONSENT_NATIVE_ACCEPTED_EVENT = "memory.personal_context_consent.decision.accepted" as const;

const tenantSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const ownerSchema = z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const generationSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revisionSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const timestampSchema = z.string().datetime({ offset: true }).refine((value) => new Date(value).toISOString() === value);
const actionSchema = z.enum(["activate", "revoke"]);

const stateShape = {
  state: z.enum(["active", "inactive"]),
  consentGeneration: generationSchema,
  lifecycleRevision: revisionSchema,
};
function validState(value: { state: string; consentGeneration: number; lifecycleRevision: number }) {
  return value.state === "active"
    ? value.consentGeneration > 0 && value.lifecycleRevision === 1
    : value.consentGeneration === 0 ? value.lifecycleRevision === 0 : value.lifecycleRevision === 2;
}
export const personalContextConsentNativeStateSchema = z.object(stateShape).strict().refine(validState, {
  message: "Consent generation, state and revision are inconsistent.",
});
export const personalContextConsentNativeNoticeSchema = z.object({
  contractId: z.literal(PERSONAL_CONTEXT_NOTICE_CONTRACT_ID),
  version: z.literal(PERSONAL_CONTEXT_NOTICE_CONTRACT_VERSION),
  text: z.literal(PERSONAL_CONTEXT_NOTICE_TEXT),
  sha256: z.literal(PERSONAL_CONTEXT_NOTICE_SHA256),
}).strict();

export const personalContextConsentNativeCurrentSchema = z.object({
  contract: z.literal(PERSONAL_CONTEXT_CONSENT_NATIVE_READ_CONTRACT),
  tenantId: tenantSchema,
  ownerActorId: ownerSchema,
  ...stateShape,
  notice: personalContextConsentNativeNoticeSchema,
  authority: personalContextConsentAuthorityV1Schema.nullable(),
  decisionToken: digestSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (!validState(value) || (value.state === "active") !== (value.authority !== null) ||
    (value.authority && (value.authority.tenantId !== value.tenantId ||
      value.authority.actorId !== value.ownerActorId || value.authority.consentGeneration !== value.consentGeneration))) {
    context.addIssue({ code: "custom", message: "Current consent does not match its exact owner and history." });
  }
});

export const personalContextConsentNativeRequestSchema = z.object({
  contract: z.literal(PERSONAL_CONTEXT_CONSENT_NATIVE_DECISION_CONTRACT),
  action: actionSchema,
  noticeSha256: z.literal(PERSONAL_CONTEXT_NOTICE_SHA256),
  expectedState: z.enum(["active", "inactive"]),
  expectedConsentGeneration: generationSchema,
  expectedLifecycleRevision: revisionSchema,
  expectedDecisionToken: digestSchema,
}).strict().refine((value) => validState({
  state: value.expectedState, consentGeneration: value.expectedConsentGeneration, lifecycleRevision: value.expectedLifecycleRevision,
}), { message: "The reviewed consent state is inconsistent." });

export const personalContextConsentNativeAcceptanceSchema = z.object({
  contract: z.literal(PERSONAL_CONTEXT_CONSENT_NATIVE_ACCEPTANCE_CONTRACT),
  id: z.string().regex(/^personal-context-consent-acceptance:[a-f0-9]{64}$/),
  tenantId: tenantSchema,
  ownerActorId: ownerSchema,
  action: actionSchema,
  idempotencyKeySha256: digestSchema,
  requestSha256: digestSchema,
  noticeSha256: z.literal(PERSONAL_CONTEXT_NOTICE_SHA256),
  expectedDecisionToken: digestSchema,
  before: personalContextConsentNativeStateSchema,
  after: personalContextConsentNativeStateSchema,
  acceptedAt: timestampSchema,
  changed: z.boolean(),
}).strict().superRefine((value, context) => {
  const before = value.before, after = value.after;
  const changed = value.action === "activate" ? before.state === "inactive" : before.state === "active";
  const expectedAfter = changed
    ? value.action === "activate"
      ? { state: "active", consentGeneration: before.consentGeneration + 1, lifecycleRevision: 1 }
      : { state: "inactive", consentGeneration: before.consentGeneration, lifecycleRevision: 2 }
    : before;
  if (value.changed !== changed || after.state !== expectedAfter.state ||
    after.consentGeneration !== expectedAfter.consentGeneration || after.lifecycleRevision !== expectedAfter.lifecycleRevision) {
    context.addIssue({ code: "custom", message: "Consent acceptance must bind exactly its accepted transition." });
  }
  if (value.id !== personalContextConsentNativeAcceptanceId(value.tenantId, value.ownerActorId, value.idempotencyKeySha256)) {
    context.addIssue({ code: "custom", message: "Consent acceptance identity is inconsistent." });
  }
});

export type PersonalContextConsentNativeState = z.infer<typeof personalContextConsentNativeStateSchema>;
export type PersonalContextConsentNativeCurrent = z.infer<typeof personalContextConsentNativeCurrentSchema>;
export type PersonalContextConsentNativeRequest = z.infer<typeof personalContextConsentNativeRequestSchema>;
export type PersonalContextConsentNativeAcceptance = z.infer<typeof personalContextConsentNativeAcceptanceSchema>;

export class PersonalContextConsentNativeError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = "PersonalContextConsentNativeError";
  }
}

export function personalContextConsentNativeDecisionToken(input: {
  tenantId: string; ownerActorId: string; state: PersonalContextConsentNativeState;
}) {
  tenantSchema.parse(input.tenantId); ownerSchema.parse(input.ownerActorId);
  const state = personalContextConsentNativeStateSchema.parse(input.state);
  return memoryContentDigest(input.tenantId, JSON.stringify([
    "personal-context-consent-target:1", input.ownerActorId, PERSONAL_CONTEXT_NOTICE_SHA256,
    state.state, state.consentGeneration, state.lifecycleRevision,
  ]));
}

export function personalContextConsentNativeTokensEqual(left: string, right: string) {
  return digestSchema.safeParse(left).success && digestSchema.safeParse(right).success &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function personalContextConsentNativeAcceptanceId(tenantId: string, ownerActorId: string, keySha256: string) {
  tenantSchema.parse(tenantId); ownerSchema.parse(ownerActorId); digestSchema.parse(keySha256);
  return `personal-context-consent-acceptance:${createHash("sha256").update(JSON.stringify([
    "personal-context-consent-acceptance:1", tenantId, ownerActorId, keySha256,
  ])).digest("hex")}`;
}

export function personalContextConsentNativeRequestDigest(input: {
  tenantId: string; ownerActorId: string; request: PersonalContextConsentNativeRequest;
}) {
  tenantSchema.parse(input.tenantId); ownerSchema.parse(input.ownerActorId);
  const value = personalContextConsentNativeRequestSchema.parse(input.request);
  return memoryContentDigest(input.tenantId, JSON.stringify([
    PERSONAL_CONTEXT_CONSENT_NATIVE_DECISION_CONTRACT, input.ownerActorId, value.action, value.noticeSha256,
    value.expectedState, value.expectedConsentGeneration, value.expectedLifecycleRevision, value.expectedDecisionToken,
  ]));
}

export function personalContextConsentNativeIntent(input: {
  tenantId: string; ownerActorId: string; idempotencyKey: string; request: PersonalContextConsentNativeRequest;
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(input.idempotencyKey)) {
    throw new PersonalContextConsentNativeError("personal_context_consent_key_invalid", 400, "A valid Idempotency-Key is required.");
  }
  const parsed = personalContextConsentNativeRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    throw new PersonalContextConsentNativeError("personal_context_consent_request_invalid", 400, "The exact reviewed consent request and current notice are required.");
  }
  const keySha256 = createHash("sha256").update(input.idempotencyKey).digest("hex");
  return {
    request: parsed.data, keySha256,
    requestSha256: personalContextConsentNativeRequestDigest({ ...input, request: parsed.data }),
    acceptanceId: personalContextConsentNativeAcceptanceId(input.tenantId, input.ownerActorId, keySha256),
  };
}
