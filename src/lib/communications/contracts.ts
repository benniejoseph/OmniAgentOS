import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const GOVERNED_COMMUNICATION_VERSION = "p9.14-governed-communication:1" as const;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const optionalReferenceSchema = z.string().trim().min(1).max(240).nullable();

export const personContactPolicySchema = z.object({
  version: z.literal(GOVERNED_COMMUNICATION_VERSION),
  id: z.string().regex(/^contact_policy:[0-9a-f-]{36}$/),
  tenantId: z.string().trim().min(1).max(160),
  ownerActorId: z.string().trim().min(1).max(500),
  personRef: z.string().trim().min(1).max(240),
  displayName: z.string().trim().min(1).max(240),
  channel: z.enum(["email", "message", "voice"]),
  address: z.string().trim().min(3).max(500),
  relationship: z.enum(["personal", "colleague", "customer", "vendor", "other"]),
  allowedPurposes: z.array(z.enum([
    "informational", "coordination", "follow_up", "support", "commercial",
  ])).min(1).max(5),
  allowedDisclosure: z.enum(["public_only", "relationship_context", "confidential"]),
  consent: z.enum(["explicit", "relationship_basis", "unknown"]),
  approvalMode: z.literal("always"),
  senderIdentity: z.literal("connected_account"),
  maxDeliveriesPerDay: z.number().int().min(1).max(50),
  quietHours: z.object({
    enabled: z.boolean(),
    timeZone: z.string().trim().min(1).max(120),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }).strict(),
  status: z.enum(["active", "paused", "opted_out"]),
  optOutReason: z.string().trim().min(1).max(500).nullable(),
  lifecycleRevision: z.number().int().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  policySha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.channel === "email" && !z.string().email().safeParse(value.address).success) {
    context.addIssue({ code: "custom", path: ["address"], message: "Email contact address is invalid." });
  }
  if ((value.status === "opted_out") !== Boolean(value.optOutReason)) {
    context.addIssue({ code: "custom", path: ["optOutReason"], message: "Opt-out state and reason must agree." });
  }
  verifyDigest(value, "policySha256", context);
});

export const communicationIntentSchema = z.object({
  version: z.literal(GOVERNED_COMMUNICATION_VERSION),
  id: z.string().regex(/^communication_intent:[0-9a-f-]{36}$/),
  policyId: z.string().regex(/^contact_policy:[0-9a-f-]{36}$/),
  purpose: z.enum(["informational", "coordination", "follow_up", "support", "commercial"]),
  disclosure: z.enum(["public_only", "relationship_context", "confidential"]),
  requestedByActorId: z.string().trim().min(1).max(500),
  executingAgentId: z.string().trim().min(1).max(240),
  canonicalThreadId: optionalReferenceSchema,
  projectId: optionalReferenceSchema,
  missionId: optionalReferenceSchema,
  runId: optionalReferenceSchema,
  createdAt: timestampSchema,
  intentSha256: sha256Schema,
}).strict().superRefine((value, context) => verifyDigest(value, "intentSha256", context));

export const messageDraftSchema = z.object({
  version: z.literal(GOVERNED_COMMUNICATION_VERSION),
  id: z.string().regex(/^message_draft:[0-9a-f-]{36}$/),
  intentId: z.string().regex(/^communication_intent:[0-9a-f-]{36}$/),
  policyId: z.string().regex(/^contact_policy:[0-9a-f-]{36}$/),
  channel: z.enum(["email", "message", "voice"]),
  recipient: z.string().trim().min(3).max(500),
  subject: z.string().trim().min(1).max(998),
  body: z.string().trim().min(1).max(50_000),
  senderIdentity: z.literal("connected_account"),
  state: z.enum(["ready", "delivering", "delivered", "failed", "canceled"]),
  lifecycleRevision: z.number().int().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  draftSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.channel === "email" && !z.string().email().safeParse(value.recipient).success) {
    context.addIssue({ code: "custom", path: ["recipient"], message: "Draft email recipient is invalid." });
  }
  if (/[\r\n]/.test(value.subject)) {
    context.addIssue({ code: "custom", path: ["subject"], message: "Draft subject cannot contain line breaks." });
  }
  const digest = canonicalJsonSha256({
    version: value.version,
    id: value.id,
    intentId: value.intentId,
    policyId: value.policyId,
    channel: value.channel,
    recipient: value.recipient,
    subject: value.subject,
    body: value.body,
    senderIdentity: value.senderIdentity,
    createdAt: value.createdAt,
  });
  if (value.draftSha256 !== digest) {
    context.addIssue({ code: "custom", path: ["draftSha256"], message: "draftSha256 does not match the immutable draft body." });
  }
});

export const deliveryReceiptSchema = z.object({
  version: z.literal(GOVERNED_COMMUNICATION_VERSION),
  id: z.string().regex(/^delivery_receipt:[0-9a-f-]{36}$/),
  draftId: z.string().regex(/^message_draft:[0-9a-f-]{36}$/),
  draftSha256: sha256Schema,
  provider: z.literal("gmail"),
  providerMessageId: z.string().trim().min(1).max(500),
  externalThreadId: z.string().trim().min(1).max(500),
  providerAcknowledgementSha256: sha256Schema,
  observedTargetStateSha256: sha256Schema,
  outcome: z.literal("delivered_verified"),
  deliveredAt: timestampSchema,
  receiptSha256: sha256Schema,
}).strict().superRefine((value, context) => verifyDigest(value, "receiptSha256", context));

export const conversationLinkSchema = z.object({
  version: z.literal(GOVERNED_COMMUNICATION_VERSION),
  id: z.string().regex(/^conversation_link:[0-9a-f-]{36}$/),
  channel: z.enum(["email", "message", "voice"]),
  externalThreadId: z.string().trim().min(1).max(500),
  canonicalThreadId: optionalReferenceSchema,
  projectId: optionalReferenceSchema,
  missionId: optionalReferenceSchema,
  runId: optionalReferenceSchema,
  draftId: z.string().regex(/^message_draft:[0-9a-f-]{36}$/),
  createdAt: timestampSchema,
  linkSha256: sha256Schema,
}).strict().superRefine((value, context) => verifyDigest(value, "linkSha256", context));

export const inboundCommunicationEnvelopeSchema = z.object({
  version: z.literal(GOVERNED_COMMUNICATION_VERSION),
  id: z.string().regex(/^inbound_communication:[0-9a-f-]{36}$/),
  provider: z.literal("gmail"),
  providerMessageId: z.string().trim().min(1).max(500),
  externalThreadId: z.string().trim().min(1).max(500),
  linkId: z.string().regex(/^conversation_link:[0-9a-f-]{36}$/),
  fromAddressSha256: sha256Schema,
  toAddressSha256: sha256Schema,
  subjectSha256: sha256Schema,
  contentSha256: sha256Schema,
  receivedAt: timestampSchema,
  untrusted: z.literal(true),
  envelopeSha256: sha256Schema,
}).strict().superRefine((value, context) => verifyDigest(value, "envelopeSha256", context));

export type PersonContactPolicy = z.infer<typeof personContactPolicySchema>;
export type CommunicationIntent = z.infer<typeof communicationIntentSchema>;
export type MessageDraft = z.infer<typeof messageDraftSchema>;
export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>;
export type ConversationLink = z.infer<typeof conversationLinkSchema>;
export type InboundCommunicationEnvelope = z.infer<typeof inboundCommunicationEnvelopeSchema>;

function verifyDigest(
  value: Record<string, unknown>,
  field: string,
  context: z.RefinementCtx,
) {
  const { [field]: digest, ...body } = value;
  if (digest !== canonicalJsonSha256(body)) {
    context.addIssue({
      code: "custom",
      path: [field],
      message: `${field} does not match the contract body.`,
    });
  }
}
