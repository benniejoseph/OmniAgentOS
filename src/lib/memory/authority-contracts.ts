import { z } from "zod";

export const MEMORY_AUTHORITY_EVENT_PAYLOAD_SCHEMA_VERSION = 1 as const;
export const MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_RECORD_SCHEMA_VERSION =
  1 as const;
export const MEMORY_MEMBERSHIP_EPOCH_RECORD_SCHEMA_VERSION = 1 as const;
export const MEMORY_PURPOSE_ENTITLEMENT_RECORD_SCHEMA_VERSION = 1 as const;
export const MEMORY_INFORMED_NOTICE_RECEIPT_RECORD_SCHEMA_VERSION = 1 as const;
export const MEMORY_PURPOSE_CONSENT_RECORD_SCHEMA_VERSION = 2 as const;

export const MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES = Object.freeze({
  held: "memory.membership_management_authority.held",
  active: "memory.membership_management_authority.activated",
  revoked: "memory.membership_management_authority.revoked",
} as const);

export const MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES = Object.freeze({
  held: "memory.membership_epoch.held",
  active: "memory.membership_epoch.activated",
  revoked: "memory.membership_epoch.revoked",
} as const);

export const MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES = Object.freeze({
  held: "memory.purpose_entitlement.held",
  active: "memory.purpose_entitlement.activated",
  revoked: "memory.purpose_entitlement.revoked",
} as const);

export const MEMORY_INFORMED_NOTICE_RECEIPT_EVENT_TYPE =
  "memory.informed_notice_receipt.recorded" as const;

export const MEMORY_PURPOSE_CONSENT_EVENT_TYPES = Object.freeze({
  held: "memory.purpose_consent.held",
  granted: "memory.purpose_consent.granted",
  revoked: "memory.purpose_consent.revoked",
} as const);

export const memoryAuthorityEventTypeSchema = z.enum([
  MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES.held,
  MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES.active,
  MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES.revoked,
  MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES.held,
  MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES.active,
  MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES.revoked,
  MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES.held,
  MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES.active,
  MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES.revoked,
  MEMORY_INFORMED_NOTICE_RECEIPT_EVENT_TYPE,
  MEMORY_PURPOSE_CONSENT_EVENT_TYPES.held,
  MEMORY_PURPOSE_CONSENT_EVENT_TYPES.granted,
  MEMORY_PURPOSE_CONSENT_EVENT_TYPES.revoked,
]);

export type MemoryAuthorityEventType = z.infer<
  typeof memoryAuthorityEventTypeSchema
>;

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
    "Expected an exact opaque ID without normalization.",
  );

const canonicalActorIdSchema = opaqueIdSchema.regex(
  /^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  "Expected a canonical auth-user actor ID.",
);

const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => new Date(value).toISOString() === value,
    "Expected a canonical UTC timestamp with millisecond precision.",
  );

const lowercaseSha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase hexadecimal SHA-256 digest.");

const positiveSafeIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

const noticeContractVersionSchema = z.number().int().min(1).max(32_767);

export const memoryAuthorityLifecycleStateSchema = z.enum([
  "held",
  "active",
  "revoked",
]);

export const memoryPurposeConsentLifecycleStateSchema = z.enum([
  "held",
  "granted",
  "revoked",
]);

const payloadEnvelopeShape = {
  schemaVersion: z.literal(MEMORY_AUTHORITY_EVENT_PAYLOAD_SCHEMA_VERSION),
};

const membershipManagementAuthorityRecordBaseSchema = z
  .object({
    schemaVersion: z.literal(
      MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_RECORD_SCHEMA_VERSION,
    ),
    tenantId: opaqueIdSchema,
    subjectActorId: canonicalActorIdSchema,
    granteeActorId: canonicalActorIdSchema,
    managementAuthorityId: opaqueIdSchema,
    authorityGeneration: positiveSafeIntegerSchema,
    createdByActorId: canonicalActorIdSchema,
    createdAt: canonicalTimestampSchema,
    updatedAt: canonicalTimestampSchema,
  })
  .strict();

const membershipManagementAuthorityHeldRecordSchema =
  membershipManagementAuthorityRecordBaseSchema.extend({
    state: z.literal("held"),
    lifecycleRevision: z.literal(0),
    activatedByActorId: z.null(),
    revokedByActorId: z.null(),
    activatedAt: z.null(),
    revokedAt: z.null(),
  });

const membershipManagementAuthorityActiveRecordSchema =
  membershipManagementAuthorityRecordBaseSchema.extend({
    state: z.literal("active"),
    lifecycleRevision: z.literal(1),
    activatedByActorId: canonicalActorIdSchema,
    revokedByActorId: z.null(),
    activatedAt: canonicalTimestampSchema,
    revokedAt: z.null(),
  });

const membershipManagementAuthorityHeldRevokedRecordSchema =
  membershipManagementAuthorityRecordBaseSchema.extend({
    state: z.literal("revoked"),
    lifecycleRevision: z.literal(1),
    activatedByActorId: z.null(),
    revokedByActorId: canonicalActorIdSchema,
    activatedAt: z.null(),
    revokedAt: canonicalTimestampSchema,
  });

const membershipManagementAuthorityActiveRevokedRecordSchema =
  membershipManagementAuthorityRecordBaseSchema.extend({
    state: z.literal("revoked"),
    lifecycleRevision: z.literal(2),
    activatedByActorId: canonicalActorIdSchema,
    revokedByActorId: canonicalActorIdSchema,
    activatedAt: canonicalTimestampSchema,
    revokedAt: canonicalTimestampSchema,
  });

/**
 * Mirrors the lifecycle shapes reserved by the v56 row contract. V56 currently
 * permits only held rows; successful parsing does not prove that a shape is
 * reachable, that a row exists or is current, or that it grants authority.
 */
export const memoryMembershipManagementAuthorityRecordV1Schema = z
  .union([
    membershipManagementAuthorityHeldRecordSchema,
    membershipManagementAuthorityActiveRecordSchema,
    membershipManagementAuthorityHeldRevokedRecordSchema,
    membershipManagementAuthorityActiveRevokedRecordSchema,
  ])
  .superRefine(requireMembershipManagementAuthorityRecordChronology);

export type MemoryMembershipManagementAuthorityRecordV1 = z.infer<
  typeof memoryMembershipManagementAuthorityRecordV1Schema
>;

const membershipManagementAuthorityPayloadBaseSchema = z
  .object({
    ...payloadEnvelopeShape,
    recordSchemaVersion: z.literal(
      MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_RECORD_SCHEMA_VERSION,
    ),
    payloadKind: z.literal("memory_membership_management_authority"),
    tenantId: opaqueIdSchema,
    subjectActorId: canonicalActorIdSchema,
    granteeActorId: canonicalActorIdSchema,
    managementAuthorityId: opaqueIdSchema,
    authorityGeneration: positiveSafeIntegerSchema,
    governanceDecisionId: opaqueIdSchema,
    decisionActorId: canonicalActorIdSchema,
    decisionAt: canonicalTimestampSchema,
  })
  .strict();

const membershipManagementAuthorityHeldPayloadSchema =
  membershipManagementAuthorityPayloadBaseSchema.extend({
    state: z.literal("held"),
    lifecycleRevision: z.literal(0),
  });

const membershipManagementAuthorityActivePayloadSchema =
  membershipManagementAuthorityPayloadBaseSchema.extend({
    state: z.literal("active"),
    lifecycleRevision: z.literal(1),
  });

const membershipManagementAuthorityRevokedPayloadSchema =
  membershipManagementAuthorityPayloadBaseSchema.extend({
    state: z.literal("revoked"),
    lifecycleRevision: z.union([z.literal(1), z.literal(2)]),
  });

/**
 * Records metadata-only lifecycle evidence. `governanceDecisionId` is an
 * opaque cross-record coordinate, not proof that governance approved the
 * transition; even an `active` payload grants no authority by itself.
 */
export const memoryMembershipManagementAuthorityEventPayloadV1Schema =
  z.discriminatedUnion("state", [
    membershipManagementAuthorityHeldPayloadSchema,
    membershipManagementAuthorityActivePayloadSchema,
    membershipManagementAuthorityRevokedPayloadSchema,
  ]);

export type MemoryMembershipManagementAuthorityEventPayloadV1 = z.infer<
  typeof memoryMembershipManagementAuthorityEventPayloadV1Schema
>;

const membershipEpochPayloadBaseSchema = z
  .object({
    ...payloadEnvelopeShape,
    recordSchemaVersion: z.literal(
      MEMORY_MEMBERSHIP_EPOCH_RECORD_SCHEMA_VERSION,
    ),
    payloadKind: z.literal("memory_membership_epoch"),
    tenantId: opaqueIdSchema,
    subjectActorId: canonicalActorIdSchema,
    membershipEpoch: positiveSafeIntegerSchema,
    decisionActorId: canonicalActorIdSchema,
    membershipManagementAuthorityId: opaqueIdSchema,
    decisionAt: canonicalTimestampSchema,
  })
  .strict();

const membershipEpochHeldPayloadSchema = membershipEpochPayloadBaseSchema
  .extend({
    state: z.literal("held"),
    lifecycleRevision: z.literal(0),
  });

const membershipEpochActivePayloadSchema = membershipEpochPayloadBaseSchema
  .extend({
    state: z.literal("active"),
    lifecycleRevision: z.literal(1),
  });

const membershipEpochRevokedPayloadSchema = membershipEpochPayloadBaseSchema
  .extend({
    state: z.literal("revoked"),
    lifecycleRevision: z.union([z.literal(1), z.literal(2)]),
  });

export const memoryMembershipEpochEventPayloadV1Schema =
  z.discriminatedUnion("state", [
    membershipEpochHeldPayloadSchema,
    membershipEpochActivePayloadSchema,
    membershipEpochRevokedPayloadSchema,
  ]);

export type MemoryMembershipEpochEventPayloadV1 = z.infer<
  typeof memoryMembershipEpochEventPayloadV1Schema
>;

const purposeEntitlementPayloadBaseSchema = z
  .object({
    ...payloadEnvelopeShape,
    recordSchemaVersion: z.literal(
      MEMORY_PURPOSE_ENTITLEMENT_RECORD_SCHEMA_VERSION,
    ),
    payloadKind: z.literal("memory_purpose_entitlement"),
    tenantId: opaqueIdSchema,
    purposeId: opaqueIdSchema,
    entitlementGeneration: positiveSafeIntegerSchema,
    decisionActorId: canonicalActorIdSchema,
    decisionMembershipEpoch: positiveSafeIntegerSchema,
    entitlementManagementAuthorityId: opaqueIdSchema,
    decisionAt: canonicalTimestampSchema,
  })
  .strict();

const purposeEntitlementHeldPayloadSchema = purposeEntitlementPayloadBaseSchema
  .extend({
    state: z.literal("held"),
    lifecycleRevision: z.literal(0),
  });

const purposeEntitlementActivePayloadSchema = purposeEntitlementPayloadBaseSchema
  .extend({
    state: z.literal("active"),
    lifecycleRevision: z.literal(1),
  });

const purposeEntitlementRevokedPayloadSchema =
  purposeEntitlementPayloadBaseSchema.extend({
    state: z.literal("revoked"),
    lifecycleRevision: z.union([z.literal(1), z.literal(2)]),
  });

export const memoryPurposeEntitlementEventPayloadV1Schema =
  z.discriminatedUnion("state", [
    purposeEntitlementHeldPayloadSchema,
    purposeEntitlementActivePayloadSchema,
    purposeEntitlementRevokedPayloadSchema,
  ]);

export type MemoryPurposeEntitlementEventPayloadV1 = z.infer<
  typeof memoryPurposeEntitlementEventPayloadV1Schema
>;

const standingConsentPurposeIdSchema = opaqueIdSchema.refine(
  (purposeId) =>
    !purposeId.startsWith("memory.export.v") &&
    !purposeId.startsWith("memory.forget.v"),
  "Export and forget require request-bound evidence, not standing consent.",
);

export const memoryInformedNoticeReceiptEventPayloadV1Schema = z
  .object({
    ...payloadEnvelopeShape,
    recordSchemaVersion: z.literal(
      MEMORY_INFORMED_NOTICE_RECEIPT_RECORD_SCHEMA_VERSION,
    ),
    payloadKind: z.literal("memory_informed_notice_receipt"),
    tenantId: opaqueIdSchema,
    subjectActorId: canonicalActorIdSchema,
    purposeId: standingConsentPurposeIdSchema,
    consentGeneration: positiveSafeIntegerSchema,
    membershipEpoch: positiveSafeIntegerSchema,
    noticeReceiptId: opaqueIdSchema,
    noticeContractId: opaqueIdSchema,
    noticeContractVersion: noticeContractVersionSchema,
    noticeSha256: lowercaseSha256Schema,
    presentedAt: canonicalTimestampSchema,
    acknowledgedByActorId: canonicalActorIdSchema,
    acknowledgedAt: canonicalTimestampSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.acknowledgedByActorId !== payload.subjectActorId) {
      context.addIssue({
        code: "custom",
        message: "An informed-notice acknowledgement must be a self acknowledgement.",
        path: ["acknowledgedByActorId"],
      });
    }
    if (Date.parse(payload.presentedAt) > Date.parse(payload.acknowledgedAt)) {
      context.addIssue({
        code: "custom",
        message: "An informed notice cannot be acknowledged before presentation.",
        path: ["acknowledgedAt"],
      });
    }
  });

export type MemoryInformedNoticeReceiptEventPayloadV1 = z.infer<
  typeof memoryInformedNoticeReceiptEventPayloadV1Schema
>;

const purposeConsentPayloadBaseSchema = z
  .object({
    ...payloadEnvelopeShape,
    recordSchemaVersion: z.literal(
      MEMORY_PURPOSE_CONSENT_RECORD_SCHEMA_VERSION,
    ),
    payloadKind: z.literal("memory_purpose_consent"),
    tenantId: opaqueIdSchema,
    subjectActorId: canonicalActorIdSchema,
    purposeId: standingConsentPurposeIdSchema,
    consentGeneration: positiveSafeIntegerSchema,
    membershipEpoch: positiveSafeIntegerSchema,
    noticeReceiptId: opaqueIdSchema,
    decisionActorId: canonicalActorIdSchema,
    decisionAt: canonicalTimestampSchema,
  })
  .strict();

const purposeConsentHeldPayloadSchema = purposeConsentPayloadBaseSchema.extend({
  state: z.literal("held"),
  lifecycleRevision: z.literal(0),
});

const purposeConsentGrantedPayloadSchema = purposeConsentPayloadBaseSchema
  .extend({
    state: z.literal("granted"),
    lifecycleRevision: z.literal(1),
  })
  .superRefine(requireConsentSelfDecision);

const purposeConsentRevokedPayloadSchema = purposeConsentPayloadBaseSchema
  .extend({
    state: z.literal("revoked"),
    lifecycleRevision: z.union([z.literal(1), z.literal(2)]),
  })
  .superRefine(requireConsentSelfDecision);

export const memoryPurposeConsentEventPayloadV1Schema = z.union([
  purposeConsentHeldPayloadSchema,
  purposeConsentGrantedPayloadSchema,
  purposeConsentRevokedPayloadSchema,
]);

export type MemoryPurposeConsentEventPayloadV1 = z.infer<
  typeof memoryPurposeConsentEventPayloadV1Schema
>;

const membershipManagementAuthorityHeldEventV1Schema = pairedEventSchema(
  MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES.held,
  membershipManagementAuthorityHeldPayloadSchema,
);
const membershipManagementAuthorityActiveEventV1Schema = pairedEventSchema(
  MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES.active,
  membershipManagementAuthorityActivePayloadSchema,
);
const membershipManagementAuthorityRevokedEventV1Schema = pairedEventSchema(
  MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES.revoked,
  membershipManagementAuthorityRevokedPayloadSchema,
);

export const memoryMembershipManagementAuthorityEventV1Schema = z.union([
  membershipManagementAuthorityHeldEventV1Schema,
  membershipManagementAuthorityActiveEventV1Schema,
  membershipManagementAuthorityRevokedEventV1Schema,
]);

export type MemoryMembershipManagementAuthorityEventV1 = z.infer<
  typeof memoryMembershipManagementAuthorityEventV1Schema
>;

const membershipEpochHeldEventV1Schema = pairedEventSchema(
  MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES.held,
  membershipEpochHeldPayloadSchema,
);
const membershipEpochActiveEventV1Schema = pairedEventSchema(
  MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES.active,
  membershipEpochActivePayloadSchema,
);
const membershipEpochRevokedEventV1Schema = pairedEventSchema(
  MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES.revoked,
  membershipEpochRevokedPayloadSchema,
);

export const memoryMembershipEpochEventV1Schema = z.union([
  membershipEpochHeldEventV1Schema,
  membershipEpochActiveEventV1Schema,
  membershipEpochRevokedEventV1Schema,
]);

export type MemoryMembershipEpochEventV1 = z.infer<
  typeof memoryMembershipEpochEventV1Schema
>;

const purposeEntitlementHeldEventV1Schema = pairedEventSchema(
  MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES.held,
  purposeEntitlementHeldPayloadSchema,
);
const purposeEntitlementActiveEventV1Schema = pairedEventSchema(
  MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES.active,
  purposeEntitlementActivePayloadSchema,
);
const purposeEntitlementRevokedEventV1Schema = pairedEventSchema(
  MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES.revoked,
  purposeEntitlementRevokedPayloadSchema,
);

export const memoryPurposeEntitlementEventV1Schema = z.union([
  purposeEntitlementHeldEventV1Schema,
  purposeEntitlementActiveEventV1Schema,
  purposeEntitlementRevokedEventV1Schema,
]);

export type MemoryPurposeEntitlementEventV1 = z.infer<
  typeof memoryPurposeEntitlementEventV1Schema
>;

export const memoryInformedNoticeReceiptEventV1Schema = pairedEventSchema(
  MEMORY_INFORMED_NOTICE_RECEIPT_EVENT_TYPE,
  memoryInformedNoticeReceiptEventPayloadV1Schema,
);

export type MemoryInformedNoticeReceiptEventV1 = z.infer<
  typeof memoryInformedNoticeReceiptEventV1Schema
>;

const purposeConsentHeldEventV1Schema = pairedEventSchema(
  MEMORY_PURPOSE_CONSENT_EVENT_TYPES.held,
  purposeConsentHeldPayloadSchema,
);
const purposeConsentGrantedEventV1Schema = pairedEventSchema(
  MEMORY_PURPOSE_CONSENT_EVENT_TYPES.granted,
  purposeConsentGrantedPayloadSchema,
);
const purposeConsentRevokedEventV1Schema = pairedEventSchema(
  MEMORY_PURPOSE_CONSENT_EVENT_TYPES.revoked,
  purposeConsentRevokedPayloadSchema,
);

export const memoryPurposeConsentEventV1Schema = z.union([
  purposeConsentHeldEventV1Schema,
  purposeConsentGrantedEventV1Schema,
  purposeConsentRevokedEventV1Schema,
]);

export type MemoryPurposeConsentEventV1 = z.infer<
  typeof memoryPurposeConsentEventV1Schema
>;

export const memoryAuthorityEventV1Schema = z.union([
  membershipManagementAuthorityHeldEventV1Schema,
  membershipManagementAuthorityActiveEventV1Schema,
  membershipManagementAuthorityRevokedEventV1Schema,
  membershipEpochHeldEventV1Schema,
  membershipEpochActiveEventV1Schema,
  membershipEpochRevokedEventV1Schema,
  purposeEntitlementHeldEventV1Schema,
  purposeEntitlementActiveEventV1Schema,
  purposeEntitlementRevokedEventV1Schema,
  memoryInformedNoticeReceiptEventV1Schema,
  purposeConsentHeldEventV1Schema,
  purposeConsentGrantedEventV1Schema,
  purposeConsentRevokedEventV1Schema,
]);

export type MemoryAuthorityEventV1 = z.infer<
  typeof memoryAuthorityEventV1Schema
>;

type PayloadEnvelopeKey = "schemaVersion" | "recordSchemaVersion" | "payloadKind";
type BuildPayloadInput<T> = T extends unknown ? Omit<T, PayloadEnvelopeKey> : never;

export type BuildMemoryMembershipManagementAuthorityEventV1Input = Readonly<
  BuildPayloadInput<MemoryMembershipManagementAuthorityEventPayloadV1>
>;
export type BuildMemoryMembershipEpochEventV1Input = Readonly<
  BuildPayloadInput<MemoryMembershipEpochEventPayloadV1>
>;
export type BuildMemoryPurposeEntitlementEventV1Input = Readonly<
  BuildPayloadInput<MemoryPurposeEntitlementEventPayloadV1>
>;
export type BuildMemoryInformedNoticeReceiptEventV1Input = Readonly<
  BuildPayloadInput<MemoryInformedNoticeReceiptEventPayloadV1>
>;
export type BuildMemoryPurposeConsentEventV1Input = Readonly<
  BuildPayloadInput<MemoryPurposeConsentEventPayloadV1>
>;

export function buildMemoryMembershipManagementAuthorityEventV1(
  input: BuildMemoryMembershipManagementAuthorityEventV1Input,
): MemoryMembershipManagementAuthorityEventV1 {
  const payload = parseMemoryMembershipManagementAuthorityEventPayloadV1({
    ...input,
    schemaVersion: MEMORY_AUTHORITY_EVENT_PAYLOAD_SCHEMA_VERSION,
    recordSchemaVersion:
      MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_RECORD_SCHEMA_VERSION,
    payloadKind: "memory_membership_management_authority",
  });
  return parseMemoryMembershipManagementAuthorityEventV1({
    type: MEMORY_MEMBERSHIP_MANAGEMENT_AUTHORITY_EVENT_TYPES[payload.state],
    payload,
  });
}

export function buildMemoryMembershipEpochEventV1(
  input: BuildMemoryMembershipEpochEventV1Input,
): MemoryMembershipEpochEventV1 {
  const payload = parseMemoryMembershipEpochEventPayloadV1({
    ...input,
    schemaVersion: MEMORY_AUTHORITY_EVENT_PAYLOAD_SCHEMA_VERSION,
    recordSchemaVersion: MEMORY_MEMBERSHIP_EPOCH_RECORD_SCHEMA_VERSION,
    payloadKind: "memory_membership_epoch",
  });
  return parseMemoryMembershipEpochEventV1({
    type: MEMORY_MEMBERSHIP_EPOCH_EVENT_TYPES[payload.state],
    payload,
  });
}

export function buildMemoryPurposeEntitlementEventV1(
  input: BuildMemoryPurposeEntitlementEventV1Input,
): MemoryPurposeEntitlementEventV1 {
  const payload = parseMemoryPurposeEntitlementEventPayloadV1({
    ...input,
    schemaVersion: MEMORY_AUTHORITY_EVENT_PAYLOAD_SCHEMA_VERSION,
    recordSchemaVersion: MEMORY_PURPOSE_ENTITLEMENT_RECORD_SCHEMA_VERSION,
    payloadKind: "memory_purpose_entitlement",
  });
  return parseMemoryPurposeEntitlementEventV1({
    type: MEMORY_PURPOSE_ENTITLEMENT_EVENT_TYPES[payload.state],
    payload,
  });
}

export function buildMemoryInformedNoticeReceiptEventV1(
  input: BuildMemoryInformedNoticeReceiptEventV1Input,
): MemoryInformedNoticeReceiptEventV1 {
  const payload = parseMemoryInformedNoticeReceiptEventPayloadV1({
    ...input,
    schemaVersion: MEMORY_AUTHORITY_EVENT_PAYLOAD_SCHEMA_VERSION,
    recordSchemaVersion: MEMORY_INFORMED_NOTICE_RECEIPT_RECORD_SCHEMA_VERSION,
    payloadKind: "memory_informed_notice_receipt",
  });
  return parseMemoryInformedNoticeReceiptEventV1({
    type: MEMORY_INFORMED_NOTICE_RECEIPT_EVENT_TYPE,
    payload,
  });
}

export function buildMemoryPurposeConsentEventV1(
  input: BuildMemoryPurposeConsentEventV1Input,
): MemoryPurposeConsentEventV1 {
  const payload = parseMemoryPurposeConsentEventPayloadV1({
    ...input,
    schemaVersion: MEMORY_AUTHORITY_EVENT_PAYLOAD_SCHEMA_VERSION,
    recordSchemaVersion: MEMORY_PURPOSE_CONSENT_RECORD_SCHEMA_VERSION,
    payloadKind: "memory_purpose_consent",
  });
  return parseMemoryPurposeConsentEventV1({
    type: MEMORY_PURPOSE_CONSENT_EVENT_TYPES[payload.state],
    payload,
  });
}

export function parseMemoryMembershipManagementAuthorityRecordV1(
  value: unknown,
): MemoryMembershipManagementAuthorityRecordV1 {
  return freezeFlat(
    memoryMembershipManagementAuthorityRecordV1Schema.parse(value),
  );
}

export function parseMemoryMembershipManagementAuthorityEventPayloadV1(
  value: unknown,
): MemoryMembershipManagementAuthorityEventPayloadV1 {
  return freezeFlat(
    memoryMembershipManagementAuthorityEventPayloadV1Schema.parse(value),
  );
}

export function parseMemoryMembershipEpochEventPayloadV1(
  value: unknown,
): MemoryMembershipEpochEventPayloadV1 {
  return freezeFlat(memoryMembershipEpochEventPayloadV1Schema.parse(value));
}

export function parseMemoryPurposeEntitlementEventPayloadV1(
  value: unknown,
): MemoryPurposeEntitlementEventPayloadV1 {
  return freezeFlat(memoryPurposeEntitlementEventPayloadV1Schema.parse(value));
}

export function parseMemoryInformedNoticeReceiptEventPayloadV1(
  value: unknown,
): MemoryInformedNoticeReceiptEventPayloadV1 {
  return freezeFlat(
    memoryInformedNoticeReceiptEventPayloadV1Schema.parse(value),
  );
}

export function parseMemoryPurposeConsentEventPayloadV1(
  value: unknown,
): MemoryPurposeConsentEventPayloadV1 {
  return freezeFlat(memoryPurposeConsentEventPayloadV1Schema.parse(value));
}

export function parseMemoryMembershipManagementAuthorityEventV1(
  value: unknown,
): MemoryMembershipManagementAuthorityEventV1 {
  return freezeEvent(
    memoryMembershipManagementAuthorityEventV1Schema.parse(value),
  );
}

export function parseMemoryMembershipEpochEventV1(
  value: unknown,
): MemoryMembershipEpochEventV1 {
  return freezeEvent(memoryMembershipEpochEventV1Schema.parse(value));
}

export function parseMemoryPurposeEntitlementEventV1(
  value: unknown,
): MemoryPurposeEntitlementEventV1 {
  return freezeEvent(memoryPurposeEntitlementEventV1Schema.parse(value));
}

export function parseMemoryInformedNoticeReceiptEventV1(
  value: unknown,
): MemoryInformedNoticeReceiptEventV1 {
  return freezeEvent(memoryInformedNoticeReceiptEventV1Schema.parse(value));
}

export function parseMemoryPurposeConsentEventV1(
  value: unknown,
): MemoryPurposeConsentEventV1 {
  return freezeEvent(memoryPurposeConsentEventV1Schema.parse(value));
}

export function parseMemoryAuthorityEventV1(
  value: unknown,
): MemoryAuthorityEventV1 {
  return freezeEvent(memoryAuthorityEventV1Schema.parse(value));
}

export type MemoryMembershipManagementAuthorityRecordEventBindingV1 = Readonly<{
  tenantId: string;
  subjectActorId: string;
  granteeActorId: string;
  managementAuthorityId: string;
  authorityGeneration: number;
  state: "held" | "active" | "revoked";
  lifecycleRevision: 0 | 1 | 2;
  decisionActorId: string;
  decisionAt: string;
}>;

/**
 * Proves only that one lifecycle event names the exact v56 record coordinates,
 * state, revision, and state-specific decision attribution. It does not prove
 * that the row exists, is current or active, that the governance decision is
 * valid, or that any actor is authorized to change membership.
 */
export function assertMemoryMembershipManagementAuthorityRecordEventBindingV1(
  recordValue: unknown,
  eventValue: unknown,
): MemoryMembershipManagementAuthorityRecordEventBindingV1 {
  const record = parseMemoryMembershipManagementAuthorityRecordV1(recordValue);
  const event = parseMemoryMembershipManagementAuthorityEventV1(eventValue);
  const payload = event.payload;
  const coordinateFields = [
    "tenantId",
    "subjectActorId",
    "granteeActorId",
    "managementAuthorityId",
    "authorityGeneration",
    "state",
    "lifecycleRevision",
  ] as const;

  for (const field of coordinateFields) {
    if (record[field] !== payload[field]) {
      throw new Error(
        `Membership management authority structural binding mismatch at ${field}; ` +
          "coordinate equality does not authorize a membership change.",
      );
    }
  }

  const expectedDecision = record.state === "held"
    ? {
        actorId: record.createdByActorId,
        at: record.createdAt,
      }
    : record.state === "active"
      ? {
          actorId: record.activatedByActorId,
          at: record.activatedAt,
        }
      : {
          actorId: record.revokedByActorId,
          at: record.revokedAt,
        };

  if (payload.decisionActorId !== expectedDecision.actorId) {
    throw new Error(
      "Membership management authority structural binding mismatch at " +
        "decisionActorId; coordinate equality does not authorize a membership change.",
    );
  }
  if (payload.decisionAt !== expectedDecision.at) {
    throw new Error(
      "Membership management authority structural binding mismatch at decisionAt; " +
        "coordinate equality does not authorize a membership change.",
    );
  }

  return Object.freeze({
    tenantId: record.tenantId,
    subjectActorId: record.subjectActorId,
    granteeActorId: record.granteeActorId,
    managementAuthorityId: record.managementAuthorityId,
    authorityGeneration: record.authorityGeneration,
    state: record.state,
    lifecycleRevision: record.lifecycleRevision,
    decisionActorId: payload.decisionActorId,
    decisionAt: payload.decisionAt,
  });
}

export type MemoryConsentReceiptStructuralBindingV1 = Readonly<{
  tenantId: string;
  subjectActorId: string;
  purposeId: string;
  consentGeneration: number;
  membershipEpoch: number;
  noticeReceiptId: string;
}>;

/**
 * Proves only that a consent payload names the receipt's exact six-coordinate
 * identity. This is a structural check, not an authorization decision: it
 * proves no current membership, active epoch, entitlement, consent, or actor
 * authority.
 */
export function assertMemoryConsentReceiptStructuralBindingV1(
  receiptValue: unknown,
  consentValue: unknown,
): MemoryConsentReceiptStructuralBindingV1 {
  const receipt = parseMemoryInformedNoticeReceiptEventPayloadV1(receiptValue);
  const consent = parseMemoryPurposeConsentEventPayloadV1(consentValue);
  const fields = [
    "tenantId",
    "subjectActorId",
    "purposeId",
    "consentGeneration",
    "membershipEpoch",
    "noticeReceiptId",
  ] as const;
  for (const field of fields) {
    if (receipt[field] !== consent[field]) {
      throw new Error(
        `Consent receipt structural binding mismatch at ${field}; ` +
          "tuple equality does not authorize a memory operation.",
      );
    }
  }
  return Object.freeze({
    tenantId: receipt.tenantId,
    subjectActorId: receipt.subjectActorId,
    purposeId: receipt.purposeId,
    consentGeneration: receipt.consentGeneration,
    membershipEpoch: receipt.membershipEpoch,
    noticeReceiptId: receipt.noticeReceiptId,
  });
}

function requireMembershipManagementAuthorityRecordChronology(
  record: {
    state: "held" | "active" | "revoked";
    createdAt: string;
    activatedAt: string | null;
    revokedAt: string | null;
    updatedAt: string;
  },
  context: z.RefinementCtx,
) {
  const createdAt = Date.parse(record.createdAt);
  const activatedAt = record.activatedAt === null
    ? null
    : Date.parse(record.activatedAt);
  const revokedAt = record.revokedAt === null
    ? null
    : Date.parse(record.revokedAt);
  const updatedAt = Date.parse(record.updatedAt);

  if (createdAt > updatedAt) {
    context.addIssue({
      code: "custom",
      message: "A membership management authority cannot predate its creation.",
      path: ["updatedAt"],
    });
  }
  if (activatedAt !== null && createdAt > activatedAt) {
    context.addIssue({
      code: "custom",
      message: "A membership management authority cannot activate before creation.",
      path: ["activatedAt"],
    });
  }
  if (revokedAt !== null && createdAt > revokedAt) {
    context.addIssue({
      code: "custom",
      message: "A membership management authority cannot revoke before creation.",
      path: ["revokedAt"],
    });
  }
  if (
    activatedAt !== null &&
    revokedAt !== null &&
    activatedAt > revokedAt
  ) {
    context.addIssue({
      code: "custom",
      message: "A membership management authority cannot revoke before activation.",
      path: ["revokedAt"],
    });
  }

  const expectedUpdatedAt = record.state === "held"
    ? record.createdAt
    : record.state === "active"
      ? record.activatedAt
      : record.revokedAt;
  if (record.updatedAt !== expectedUpdatedAt) {
    context.addIssue({
      code: "custom",
      message:
        "A membership management authority update timestamp must equal its latest transition.",
      path: ["updatedAt"],
    });
  }
}

function requireConsentSelfDecision(
  payload: {
    subjectActorId: string;
    decisionActorId: string;
  },
  context: z.RefinementCtx,
) {
  if (payload.decisionActorId !== payload.subjectActorId) {
    context.addIssue({
      code: "custom",
      message: "Consent grants and revocations must be self decisions.",
      path: ["decisionActorId"],
    });
  }
}

function pairedEventSchema<
  TType extends MemoryAuthorityEventType,
  TPayload extends z.ZodTypeAny,
>(type: TType, payload: TPayload) {
  return z.object({
    type: z.literal(type),
    payload,
  }).strict();
}

function freezeFlat<T extends Record<string, unknown>>(value: T): T {
  return Object.freeze({ ...value }) as T;
}

function freezeEvent<
  T extends { type: MemoryAuthorityEventType; payload: Record<string, unknown> },
>(value: T): T {
  return Object.freeze({
    ...value,
    payload: freezeFlat(value.payload),
  }) as T;
}
