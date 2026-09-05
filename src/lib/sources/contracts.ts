import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * P2.1a contracts are an allowlisted metadata boundary. They intentionally have
 * no field capable of retaining source content, provider payloads, raw external
 * identifiers, credentials, or arbitrary metadata.
 */
export const SOURCE_CONTRACT_SCHEMA_VERSION = 1 as const;
export const MAX_SOURCE_PERMISSION_GRANTS = 128;
export const MAX_SOURCE_PURPOSES = 64;
// A maximum-size ingest currently produces roughly 866 overlapped chunks.
// Keep one bounded contract large enough to represent that complete commit.
export const MAX_EVIDENCE_UNITS_PER_ADAPTER_OUTPUT = 1_024;
export const MAX_SOURCE_ENTITY_BYTES = 32_000;
export const MAX_SOURCE_ADAPTER_OUTPUT_BYTES = 4_000_000;

const sourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export const sourceContractIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(sourceIdPattern, "Expected an opaque ID, not free-form text.");

export const sourceContractSha256Schema = z
  .string()
  .regex(sha256Pattern, "Expected a lowercase hexadecimal SHA-256 digest.");

export const sourceTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => new Date(value).toISOString() === value,
    "Expected a canonical UTC timestamp with millisecond precision.",
  );

const nullableIdSchema = sourceContractIdSchema.nullable();
const nullableTimestampSchema = sourceTimestampSchema.nullable();
const nonNegativeCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveCountSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const mediaTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i);

function canonicalIdList(max: number, minimum: number) {
  return z
    .array(sourceContractIdSchema)
    .min(minimum)
    .max(max)
    .superRefine((ids, context) => {
      const sorted = [...ids].sort();
      ids.forEach((id, index) => {
        if (index > 0 && ids[index - 1] === id) {
          context.addIssue({
            code: "custom",
            message: "IDs must be unique.",
            path: [index],
          });
        }
        if (sorted[index] !== id) {
          context.addIssue({
            code: "custom",
            message: "IDs must use canonical lexical order.",
            path: [index],
          });
        }
      });
    });
}

export const sourceKindSchema = z.enum([
  "document",
  "spreadsheet",
  "presentation",
  "email",
  "calendar_event",
  "message",
  "webpage",
  "image",
  "audio",
  "video",
  "record",
  "file",
  "capture",
]);

export const sourceVisibilitySchema = z.enum([
  "agent_private",
  "user_private",
  "mission_shared",
  "project_shared",
  "workspace_shared",
]);

export const sourceSensitivitySchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

export const extractorIdentityV1Schema = z
  .object({
    extractorId: sourceContractIdSchema,
    extractorVersionId: sourceContractIdSchema,
    extractorConfigSha256: sourceContractSha256Schema,
    modelVersionId: nullableIdSchema,
  })
  .strict();

export type ExtractorIdentityV1 = z.infer<typeof extractorIdentityV1Schema>;

const sourceBindingInputShape = {
  tenantId: sourceContractIdSchema,
  ownerActorId: sourceContractIdSchema,
  workspaceId: nullableIdSchema,
  projectId: nullableIdSchema,
  missionId: nullableIdSchema,
  connectionId: sourceContractIdSchema,
  visibility: sourceVisibilitySchema,
  sensitivity: sourceSensitivitySchema,
  permissionGrantIds: canonicalIdList(MAX_SOURCE_PERMISSION_GRANTS, 1),
  allowedPurposeIds: canonicalIdList(MAX_SOURCE_PURPOSES, 1),
  retentionPolicyId: sourceContractIdSchema,
  retentionExpiresAt: nullableTimestampSchema,
};

const sourceBindingShape = {
  ...sourceBindingInputShape,
  permissionSetSha256: sourceContractSha256Schema,
  purposeSetSha256: sourceContractSha256Schema,
};

const _sourceBindingInputBaseSchema = z.object(sourceBindingInputShape).strict();
type SourceBindingInput = z.infer<typeof _sourceBindingInputBaseSchema>;

const sourceBindingBaseSchema = z.object(sourceBindingShape).strict();
type SourceBindingBase = z.infer<typeof sourceBindingBaseSchema>;

export const sourceBindingV1Schema = sourceBindingBaseSchema
  .superRefine((value, context) => {
    validateScopeReferences(value, context);
    validateBindingDigests(value, context);
  });

export type SourceBindingV1 = SourceBindingBase;

export const textSpanLocatorV1Schema = z
  .object({
    kind: z.literal("text_span"),
    offsetUnit: z.enum(["unicode_code_point", "utf16_code_unit", "utf8_byte"]),
    startOffset: nonNegativeCountSchema,
    endOffsetExclusive: positiveCountSchema,
    containerLength: positiveCountSchema,
    containerSha256: sourceContractSha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endOffsetExclusive <= value.startOffset) {
      context.addIssue({
        code: "custom",
        message: "A text span must have a non-empty exclusive end offset.",
        path: ["endOffsetExclusive"],
      });
    }
    if (value.endOffsetExclusive > value.containerLength) {
      context.addIssue({
        code: "custom",
        message: "A text span cannot exceed its container length.",
        path: ["endOffsetExclusive"],
      });
    }
  });

export const pageLocatorV1Schema = z
  .object({
    kind: z.literal("page"),
    pageNumber: positiveCountSchema,
    pageCount: positiveCountSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.pageCount !== null && value.pageNumber > value.pageCount) {
      context.addIssue({
        code: "custom",
        message: "A page number cannot exceed the document page count.",
        path: ["pageNumber"],
      });
    }
  });

export const sheetRangeLocatorV1Schema = z
  .object({
    kind: z.literal("sheet_range"),
    sheetKeySha256: sourceContractSha256Schema,
    startRow: positiveCountSchema,
    endRowExclusive: positiveCountSchema,
    startColumn: positiveCountSchema,
    endColumnExclusive: positiveCountSchema,
    sheetRowCount: positiveCountSchema.nullable(),
    sheetColumnCount: positiveCountSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endRowExclusive <= value.startRow) {
      context.addIssue({
        code: "custom",
        message: "A sheet range must contain at least one row.",
        path: ["endRowExclusive"],
      });
    }
    if (value.endColumnExclusive <= value.startColumn) {
      context.addIssue({
        code: "custom",
        message: "A sheet range must contain at least one column.",
        path: ["endColumnExclusive"],
      });
    }
    if (
      value.sheetRowCount !== null &&
      value.endRowExclusive > value.sheetRowCount + 1
    ) {
      context.addIssue({
        code: "custom",
        message: "A sheet range cannot exceed the sheet row count.",
        path: ["endRowExclusive"],
      });
    }
    if (
      value.sheetColumnCount !== null &&
      value.endColumnExclusive > value.sheetColumnCount + 1
    ) {
      context.addIssue({
        code: "custom",
        message: "A sheet range cannot exceed the sheet column count.",
        path: ["endColumnExclusive"],
      });
    }
  });

export const slideLocatorV1Schema = z
  .object({
    kind: z.literal("slide"),
    slideNumber: positiveCountSchema,
    slideCount: positiveCountSchema.nullable(),
    elementKeySha256: sourceContractSha256Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.slideCount !== null && value.slideNumber > value.slideCount) {
      context.addIssue({
        code: "custom",
        message: "A slide number cannot exceed the presentation slide count.",
        path: ["slideNumber"],
      });
    }
  });

export const emailSectionLocatorV1Schema = z
  .object({
    kind: z.literal("email_section"),
    section: z.enum(["headers", "subject", "body", "attachment"]),
    sectionIndex: nonNegativeCountSchema,
    partKeySha256: sourceContractSha256Schema.nullable(),
  })
  .strict();

export const imageRegionLocatorV1Schema = z
  .object({
    kind: z.literal("image_region"),
    coordinateUnit: z.literal("pixel"),
    x: nonNegativeCountSchema,
    y: nonNegativeCountSchema,
    width: positiveCountSchema,
    height: positiveCountSchema,
    imageWidth: positiveCountSchema,
    imageHeight: positiveCountSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.x + value.width > value.imageWidth) {
      context.addIssue({
        code: "custom",
        message: "An image region cannot exceed the image width.",
        path: ["width"],
      });
    }
    if (value.y + value.height > value.imageHeight) {
      context.addIssue({
        code: "custom",
        message: "An image region cannot exceed the image height.",
        path: ["height"],
      });
    }
  });

export const mediaTimeRangeLocatorV1Schema = z
  .object({
    kind: z.literal("media_time_range"),
    mediaKind: z.enum(["audio", "video"]),
    startMilliseconds: nonNegativeCountSchema,
    endMillisecondsExclusive: positiveCountSchema,
    durationMilliseconds: positiveCountSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endMillisecondsExclusive <= value.startMilliseconds) {
      context.addIssue({
        code: "custom",
        message: "A media range must have a non-empty exclusive end time.",
        path: ["endMillisecondsExclusive"],
      });
    }
    if (value.endMillisecondsExclusive > value.durationMilliseconds) {
      context.addIssue({
        code: "custom",
        message: "A media range cannot exceed the media duration.",
        path: ["endMillisecondsExclusive"],
      });
    }
  });

export const evidenceLocatorV1Schema = z.discriminatedUnion("kind", [
  textSpanLocatorV1Schema,
  pageLocatorV1Schema,
  sheetRangeLocatorV1Schema,
  slideLocatorV1Schema,
  emailSectionLocatorV1Schema,
  imageRegionLocatorV1Schema,
  mediaTimeRangeLocatorV1Schema,
]);

export type EvidenceLocatorV1 = z.infer<typeof evidenceLocatorV1Schema>;

const sourceObservationShape = {
  sourceCreatedAt: nullableTimestampSchema,
  sourceUpdatedAt: nullableTimestampSchema,
  capturedAt: sourceTimestampSchema,
};

const sourceItemIdentityV1Schema = z
  .object({
    tenantId: sourceContractIdSchema,
    ownerActorId: sourceContractIdSchema,
    workspaceId: nullableIdSchema,
    projectId: nullableIdSchema,
    missionId: nullableIdSchema,
    connectionId: sourceContractIdSchema,
    providerItemKeySha256: sourceContractSha256Schema,
  })
  .strict();

export type SourceItemIdentityV1 = z.infer<
  typeof sourceItemIdentityV1Schema
>;

/**
 * Derives the stable SourceItem identity from its complete tenant, actor,
 * context, connection, and hash-only provider binding. Raw provider IDs are
 * intentionally outside this boundary.
 */
export function deriveSourceItemIdV1(input: SourceItemIdentityV1): string {
  const value = sourceItemIdentityV1Schema.parse(input);
  return `source_item_${sourceContractSha256(value).slice(0, 56)}`;
}

const sourceItemInputSchema = z
  .object({
    ...sourceBindingInputShape,
    sourceKind: sourceKindSchema,
    providerItemKeySha256: sourceContractSha256Schema,
    metadataSha256: sourceContractSha256Schema,
    ...sourceObservationShape,
    extractorIdentity: extractorIdentityV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    validateScopeReferences(value, context);
    validateSourceTimestamps(value, context);
  });

const sourceItemShape = {
  schemaVersion: z.literal(SOURCE_CONTRACT_SCHEMA_VERSION),
  contractKind: z.literal("source_item"),
  sourceItemId: sourceContractIdSchema,
  ...sourceBindingShape,
  sourceKind: sourceKindSchema,
  providerItemKeySha256: sourceContractSha256Schema,
  metadataSha256: sourceContractSha256Schema,
  ...sourceObservationShape,
  extractorIdentity: extractorIdentityV1Schema,
  sourceItemSha256: sourceContractSha256Schema,
};

const sourceItemBaseSchema = z.object(sourceItemShape).strict();
type SourceItemBase = z.infer<typeof sourceItemBaseSchema>;

export const sourceItemV1Schema = sourceItemBaseSchema.superRefine(
  (value, context) => {
    validateScopeReferences(value, context);
    validateBindingDigests(value, context);
    validateSourceTimestamps(value, context);
    if (value.sourceItemId !== derivedSourceItemId(value)) {
      context.addIssue({
        code: "custom",
        message: "Source item ID does not match its scoped provider identity.",
        path: ["sourceItemId"],
      });
    }
    const { sourceItemSha256, ...body } = value;
    if (sourceItemSha256 !== sourceContractSha256(body)) {
      context.addIssue({
        code: "custom",
        message: "Source item digest does not match its body.",
        path: ["sourceItemSha256"],
      });
    }
    addByteLimitIssue(value, MAX_SOURCE_ENTITY_BYTES, context, "Source item");
  },
);

export type SourceItemV1 = SourceItemBase;
export type SourceItem = SourceItemV1;
export type BuildSourceItemV1Input = z.infer<typeof sourceItemInputSchema>;

export function buildSourceItemV1(
  input: BuildSourceItemV1Input,
): SourceItemV1 {
  const parsed = sourceItemInputSchema.parse(input);
  const bodyWithoutId = {
    schemaVersion: SOURCE_CONTRACT_SCHEMA_VERSION,
    contractKind: "source_item" as const,
    ...withBindingDigests(parsed),
  };
  const body = {
    ...bodyWithoutId,
    sourceItemId: derivedSourceItemId(bodyWithoutId),
  };
  return sourceItemV1Schema.parse({
    ...body,
    sourceItemSha256: sourceContractSha256(body),
  });
}

export function parseSourceItemV1(value: unknown): SourceItemV1 {
  return sourceItemV1Schema.parse(value);
}

const sourceRevisionInputSchema = z
  .object({
    ...sourceBindingInputShape,
    sourceItemId: sourceContractIdSchema,
    previousSourceRevisionId: nullableIdSchema,
    sourceKind: sourceKindSchema,
    providerItemKeySha256: sourceContractSha256Schema,
    providerRevisionKeySha256: sourceContractSha256Schema,
    contentSha256: sourceContractSha256Schema,
    contentByteLength: nonNegativeCountSchema,
    mediaType: mediaTypeSchema,
    metadataSha256: sourceContractSha256Schema,
    ...sourceObservationShape,
    extractorIdentity: extractorIdentityV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    validateScopeReferences(value, context);
    validateSourceTimestamps(value, context);
  });

const sourceRevisionShape = {
  schemaVersion: z.literal(SOURCE_CONTRACT_SCHEMA_VERSION),
  contractKind: z.literal("source_revision"),
  sourceRevisionId: sourceContractIdSchema,
  ...sourceBindingShape,
  sourceItemId: sourceContractIdSchema,
  previousSourceRevisionId: nullableIdSchema,
  sourceKind: sourceKindSchema,
  providerItemKeySha256: sourceContractSha256Schema,
  providerRevisionKeySha256: sourceContractSha256Schema,
  contentSha256: sourceContractSha256Schema,
  contentByteLength: nonNegativeCountSchema,
  mediaType: mediaTypeSchema,
  metadataSha256: sourceContractSha256Schema,
  ...sourceObservationShape,
  extractorIdentity: extractorIdentityV1Schema,
  sourceRevisionSha256: sourceContractSha256Schema,
};

const sourceRevisionBaseSchema = z.object(sourceRevisionShape).strict();
type SourceRevisionBase = z.infer<typeof sourceRevisionBaseSchema>;

export const sourceRevisionV1Schema = sourceRevisionBaseSchema.superRefine(
  (value, context) => {
    validateScopeReferences(value, context);
    validateBindingDigests(value, context);
    validateSourceTimestamps(value, context);
    if (value.sourceRevisionId !== derivedSourceRevisionId(value)) {
      context.addIssue({
        code: "custom",
        message: "Source revision ID does not match its immutable identity.",
        path: ["sourceRevisionId"],
      });
    }
    if (value.previousSourceRevisionId === value.sourceRevisionId) {
      context.addIssue({
        code: "custom",
        message: "A source revision cannot precede itself.",
        path: ["previousSourceRevisionId"],
      });
    }
    const { sourceRevisionSha256, ...body } = value;
    if (sourceRevisionSha256 !== sourceContractSha256(body)) {
      context.addIssue({
        code: "custom",
        message: "Source revision digest does not match its body.",
        path: ["sourceRevisionSha256"],
      });
    }
    addByteLimitIssue(value, MAX_SOURCE_ENTITY_BYTES, context, "Source revision");
  },
);

export type SourceRevisionV1 = SourceRevisionBase;
export type SourceRevision = SourceRevisionV1;
export type BuildSourceRevisionV1Input = z.infer<
  typeof sourceRevisionInputSchema
>;

export function buildSourceRevisionV1(
  input: BuildSourceRevisionV1Input,
): SourceRevisionV1 {
  const parsed = sourceRevisionInputSchema.parse(input);
  const bodyWithoutId = {
    schemaVersion: SOURCE_CONTRACT_SCHEMA_VERSION,
    contractKind: "source_revision" as const,
    ...withBindingDigests(parsed),
  };
  const body = {
    ...bodyWithoutId,
    sourceRevisionId: derivedSourceRevisionId(bodyWithoutId),
  };
  return sourceRevisionV1Schema.parse({
    ...body,
    sourceRevisionSha256: sourceContractSha256(body),
  });
}

export function parseSourceRevisionV1(value: unknown): SourceRevisionV1 {
  return sourceRevisionV1Schema.parse(value);
}

const evidenceUnitInputSchema = z
  .object({
    ...sourceBindingInputShape,
    sourceItemId: sourceContractIdSchema,
    sourceRevisionId: sourceContractIdSchema,
    sourceKind: sourceKindSchema,
    providerItemKeySha256: sourceContractSha256Schema,
    evidenceContentSha256: sourceContractSha256Schema,
    evidenceByteLength: nonNegativeCountSchema,
    locator: evidenceLocatorV1Schema,
    ...sourceObservationShape,
    extractedAt: sourceTimestampSchema,
    extractorIdentity: extractorIdentityV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    validateScopeReferences(value, context);
    validateSourceTimestamps(value, context);
  });

const evidenceUnitShape = {
  schemaVersion: z.literal(SOURCE_CONTRACT_SCHEMA_VERSION),
  contractKind: z.literal("evidence_unit"),
  evidenceUnitId: sourceContractIdSchema,
  ...sourceBindingShape,
  sourceItemId: sourceContractIdSchema,
  sourceRevisionId: sourceContractIdSchema,
  sourceKind: sourceKindSchema,
  providerItemKeySha256: sourceContractSha256Schema,
  evidenceContentSha256: sourceContractSha256Schema,
  evidenceByteLength: nonNegativeCountSchema,
  locator: evidenceLocatorV1Schema,
  locatorSha256: sourceContractSha256Schema,
  ...sourceObservationShape,
  extractedAt: sourceTimestampSchema,
  extractorIdentity: extractorIdentityV1Schema,
  evidenceUnitSha256: sourceContractSha256Schema,
};

const evidenceUnitBaseSchema = z.object(evidenceUnitShape).strict();
type EvidenceUnitBase = z.infer<typeof evidenceUnitBaseSchema>;

export const evidenceUnitV1Schema = evidenceUnitBaseSchema.superRefine(
  (value, context) => {
    validateScopeReferences(value, context);
    validateBindingDigests(value, context);
    validateSourceTimestamps(value, context);
    if (value.locatorSha256 !== sourceContractSha256(value.locator)) {
      context.addIssue({
        code: "custom",
        message: "Evidence locator digest does not match its locator.",
        path: ["locatorSha256"],
      });
    }
    if (value.evidenceUnitId !== derivedEvidenceUnitId(value)) {
      context.addIssue({
        code: "custom",
        message: "Evidence unit ID does not match its revision and locator.",
        path: ["evidenceUnitId"],
      });
    }
    const { evidenceUnitSha256, ...body } = value;
    if (evidenceUnitSha256 !== sourceContractSha256(body)) {
      context.addIssue({
        code: "custom",
        message: "Evidence unit digest does not match its body.",
        path: ["evidenceUnitSha256"],
      });
    }
    addByteLimitIssue(value, MAX_SOURCE_ENTITY_BYTES, context, "Evidence unit");
  },
);

export type EvidenceUnitV1 = EvidenceUnitBase;
export type EvidenceUnit = EvidenceUnitV1;
export type BuildEvidenceUnitV1Input = z.infer<
  typeof evidenceUnitInputSchema
>;

export function buildEvidenceUnitV1(
  input: BuildEvidenceUnitV1Input,
): EvidenceUnitV1 {
  const parsed = evidenceUnitInputSchema.parse(input);
  const bodyWithoutId = {
    schemaVersion: SOURCE_CONTRACT_SCHEMA_VERSION,
    contractKind: "evidence_unit" as const,
    ...withBindingDigests(parsed),
    locatorSha256: sourceContractSha256(parsed.locator),
  };
  const body = {
    ...bodyWithoutId,
    evidenceUnitId: derivedEvidenceUnitId(bodyWithoutId),
  };
  return evidenceUnitV1Schema.parse({
    ...body,
    evidenceUnitSha256: sourceContractSha256(body),
  });
}

export function parseEvidenceUnitV1(value: unknown): EvidenceUnitV1 {
  return evidenceUnitV1Schema.parse(value);
}

const adapterIdentityShape = {
  adapterId: sourceContractIdSchema,
  adapterVersionId: sourceContractIdSchema,
  adapterConfigSha256: sourceContractSha256Schema,
  adapterEventKeySha256: sourceContractSha256Schema,
  observedAt: sourceTimestampSchema,
};

const sourceAdapterUpsertInputSchema = z
  .object({
    ...adapterIdentityShape,
    sourceItem: sourceItemV1Schema,
    sourceRevision: sourceRevisionV1Schema,
    evidenceUnits: z
      .array(evidenceUnitV1Schema)
      .max(MAX_EVIDENCE_UNITS_PER_ADAPTER_OUTPUT),
  })
  .strict();

const sourceAdapterUpsertShape = {
  schemaVersion: z.literal(SOURCE_CONTRACT_SCHEMA_VERSION),
  contractKind: z.literal("source_adapter_output"),
  operation: z.literal("upsert"),
  adapterOutputId: sourceContractIdSchema,
  adapterOutputSha256: sourceContractSha256Schema,
  ...adapterIdentityShape,
  ...sourceBindingShape,
  sourceItem: sourceItemV1Schema,
  sourceRevision: sourceRevisionV1Schema,
  evidenceUnits: z
    .array(evidenceUnitV1Schema)
    .max(MAX_EVIDENCE_UNITS_PER_ADAPTER_OUTPUT),
};

const sourceAdapterUpsertBaseSchema = z
  .object(sourceAdapterUpsertShape)
  .strict();
type SourceAdapterUpsertBase = z.infer<
  typeof sourceAdapterUpsertBaseSchema
>;

export const sourceAdapterUpsertV1Schema =
  sourceAdapterUpsertBaseSchema.superRefine((value, context) => {
    validateScopeReferences(value, context);
    validateBindingDigests(value, context);
    validateUpsertBindings(value, context);
    validateAdapterOutputIdentity(value, context);
    addByteLimitIssue(
      value,
      MAX_SOURCE_ADAPTER_OUTPUT_BYTES,
      context,
      "Source adapter output",
    );
  });

export type SourceAdapterUpsertV1 = SourceAdapterUpsertBase;
export type BuildSourceAdapterUpsertV1Input = z.infer<
  typeof sourceAdapterUpsertInputSchema
>;

export function buildSourceAdapterUpsertV1(
  input: BuildSourceAdapterUpsertV1Input,
): SourceAdapterUpsertV1 {
  const parsed = sourceAdapterUpsertInputSchema.parse(input);
  const evidenceUnits = [...parsed.evidenceUnits].sort((left, right) =>
    compareCanonicalIds(left.evidenceUnitId, right.evidenceUnitId),
  );
  const itemBinding = pickBinding(parsed.sourceItem);
  const bodyWithoutId = {
    schemaVersion: SOURCE_CONTRACT_SCHEMA_VERSION,
    contractKind: "source_adapter_output" as const,
    operation: "upsert" as const,
    ...parsed,
    evidenceUnits,
    ...itemBinding,
  };
  const body = {
    ...bodyWithoutId,
    adapterOutputId: derivedAdapterOutputId(bodyWithoutId),
  };
  return sourceAdapterUpsertV1Schema.parse({
    ...body,
    adapterOutputSha256: sourceContractSha256(body),
  });
}

export const adapterDeleteReasonSchema = z.enum([
  "provider_deleted",
  "access_revoked",
  "connection_removed",
  "source_missing",
]);

const sourceAdapterDeleteInputSchema = z
  .object({
    ...adapterIdentityShape,
    ...sourceBindingInputShape,
    sourceItemId: sourceContractIdSchema,
    sourceKind: sourceKindSchema,
    providerItemKeySha256: sourceContractSha256Schema,
    lastKnownSourceRevisionId: nullableIdSchema,
    deleteReason: adapterDeleteReasonSchema,
  })
  .strict()
  .superRefine(validateScopeReferences);

const sourceAdapterDeleteShape = {
  schemaVersion: z.literal(SOURCE_CONTRACT_SCHEMA_VERSION),
  contractKind: z.literal("source_adapter_output"),
  operation: z.literal("delete"),
  adapterOutputId: sourceContractIdSchema,
  adapterOutputSha256: sourceContractSha256Schema,
  ...adapterIdentityShape,
  ...sourceBindingShape,
  sourceItemId: sourceContractIdSchema,
  sourceKind: sourceKindSchema,
  providerItemKeySha256: sourceContractSha256Schema,
  lastKnownSourceRevisionId: nullableIdSchema,
  deleteReason: adapterDeleteReasonSchema,
};

const sourceAdapterDeleteBaseSchema = z
  .object(sourceAdapterDeleteShape)
  .strict();
type SourceAdapterDeleteBase = z.infer<
  typeof sourceAdapterDeleteBaseSchema
>;

export const sourceAdapterDeleteV1Schema =
  sourceAdapterDeleteBaseSchema.superRefine((value, context) => {
    validateScopeReferences(value, context);
    validateBindingDigests(value, context);
    if (value.sourceItemId !== derivedSourceItemId(value)) {
      context.addIssue({
        code: "custom",
        message: "Deleted source item ID does not match its scoped provider identity.",
        path: ["sourceItemId"],
      });
    }
    validateAdapterOutputIdentity(value, context);
    addByteLimitIssue(
      value,
      MAX_SOURCE_ADAPTER_OUTPUT_BYTES,
      context,
      "Source adapter output",
    );
  });

export type SourceAdapterDeleteV1 = SourceAdapterDeleteBase;
export type BuildSourceAdapterDeleteV1Input = z.infer<
  typeof sourceAdapterDeleteInputSchema
>;

export function buildSourceAdapterDeleteV1(
  input: BuildSourceAdapterDeleteV1Input,
): SourceAdapterDeleteV1 {
  const parsed = sourceAdapterDeleteInputSchema.parse(input);
  const bodyWithoutId = {
    schemaVersion: SOURCE_CONTRACT_SCHEMA_VERSION,
    contractKind: "source_adapter_output" as const,
    operation: "delete" as const,
    ...withBindingDigests(parsed),
  };
  const body = {
    ...bodyWithoutId,
    adapterOutputId: derivedAdapterOutputId(bodyWithoutId),
  };
  return sourceAdapterDeleteV1Schema.parse({
    ...body,
    adapterOutputSha256: sourceContractSha256(body),
  });
}

export const sourceAdapterOutputV1Schema = z.discriminatedUnion("operation", [
  sourceAdapterUpsertV1Schema,
  sourceAdapterDeleteV1Schema,
]);

export type SourceAdapterOutputV1 = z.infer<
  typeof sourceAdapterOutputV1Schema
>;
export type SourceAdapterOutput = SourceAdapterOutputV1;

export function parseSourceAdapterOutputV1(
  value: unknown,
): SourceAdapterOutputV1 {
  return sourceAdapterOutputV1Schema.parse(value);
}

/** Lowercase SHA-256 over recursively key-sorted JSON. */
export function sourceContractSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function withBindingDigests<T extends SourceBindingInput>(value: T) {
  return {
    ...value,
    permissionSetSha256: sourceContractSha256(value.permissionGrantIds),
    purposeSetSha256: sourceContractSha256(value.allowedPurposeIds),
  };
}

function pickBinding(value: SourceBindingV1): SourceBindingV1 {
  return sourceBindingV1Schema.parse({
    tenantId: value.tenantId,
    ownerActorId: value.ownerActorId,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    missionId: value.missionId,
    connectionId: value.connectionId,
    visibility: value.visibility,
    sensitivity: value.sensitivity,
    permissionGrantIds: value.permissionGrantIds,
    allowedPurposeIds: value.allowedPurposeIds,
    retentionPolicyId: value.retentionPolicyId,
    retentionExpiresAt: value.retentionExpiresAt,
    permissionSetSha256: value.permissionSetSha256,
    purposeSetSha256: value.purposeSetSha256,
  });
}

function derivedSourceItemId(value: Pick<
  SourceItemV1,
  | "tenantId"
  | "ownerActorId"
  | "workspaceId"
  | "projectId"
  | "missionId"
  | "connectionId"
  | "providerItemKeySha256"
>) {
  return deriveSourceItemIdV1({
    tenantId: value.tenantId,
    ownerActorId: value.ownerActorId,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    missionId: value.missionId,
    connectionId: value.connectionId,
    providerItemKeySha256: value.providerItemKeySha256,
  });
}

type SourceRevisionIdentityInput = Omit<
  SourceRevisionBase,
  "sourceRevisionId" | "sourceRevisionSha256"
> & Partial<
  Pick<SourceRevisionBase, "sourceRevisionId" | "sourceRevisionSha256">
>;

function derivedSourceRevisionId(value: SourceRevisionIdentityInput) {
  const {
    sourceRevisionId: _sourceRevisionId,
    sourceRevisionSha256: _sourceRevisionSha256,
    ...immutableBody
  } = value;
  return `source_revision_${sourceContractSha256(immutableBody).slice(0, 56)}`;
}

type EvidenceUnitIdentityInput = Omit<
  EvidenceUnitBase,
  "evidenceUnitId" | "evidenceUnitSha256"
> & Partial<Pick<EvidenceUnitBase, "evidenceUnitId" | "evidenceUnitSha256">>;

function derivedEvidenceUnitId(value: EvidenceUnitIdentityInput) {
  const {
    evidenceUnitId: _evidenceUnitId,
    evidenceUnitSha256: _evidenceUnitSha256,
    ...immutableBody
  } = value;
  return `evidence_unit_${sourceContractSha256(immutableBody).slice(0, 56)}`;
}

function derivedAdapterOutputId(value: {
  operation: "upsert" | "delete";
  tenantId: string;
  connectionId: string;
  adapterId: string;
  adapterVersionId: string;
  adapterEventKeySha256: string;
}) {
  return `source_adapter_${sourceContractSha256({
    operation: value.operation,
    tenantId: value.tenantId,
    connectionId: value.connectionId,
    adapterId: value.adapterId,
    adapterVersionId: value.adapterVersionId,
    adapterEventKeySha256: value.adapterEventKeySha256,
  }).slice(0, 56)}`;
}

function validateScopeReferences(
  value: Pick<
    SourceBindingInput,
    "workspaceId" | "projectId" | "missionId" | "visibility"
  >,
  context: z.RefinementCtx,
) {
  if (value.visibility === "workspace_shared" && value.workspaceId === null) {
    context.addIssue({
      code: "custom",
      message: "Workspace-shared source data requires a workspace ID.",
      path: ["workspaceId"],
    });
  }
  if (value.visibility === "project_shared" && value.projectId === null) {
    context.addIssue({
      code: "custom",
      message: "Project-shared source data requires a project ID.",
      path: ["projectId"],
    });
  }
  if (value.visibility === "mission_shared" && value.missionId === null) {
    context.addIssue({
      code: "custom",
      message: "Mission-shared source data requires a mission ID.",
      path: ["missionId"],
    });
  }
}

function validateBindingDigests(
  value: SourceBindingV1,
  context: z.RefinementCtx,
) {
  if (
    value.permissionSetSha256 !==
      sourceContractSha256(value.permissionGrantIds)
  ) {
    context.addIssue({
      code: "custom",
      message: "Permission-set digest does not match its grant IDs.",
      path: ["permissionSetSha256"],
    });
  }
  if (value.purposeSetSha256 !== sourceContractSha256(value.allowedPurposeIds)) {
    context.addIssue({
      code: "custom",
      message: "Purpose-set digest does not match its purpose IDs.",
      path: ["purposeSetSha256"],
    });
  }
}

function validateSourceTimestamps(
  value: {
    sourceCreatedAt: string | null;
    sourceUpdatedAt: string | null;
  },
  context: z.RefinementCtx,
) {
  if (
    value.sourceCreatedAt !== null &&
    value.sourceUpdatedAt !== null &&
    value.sourceUpdatedAt < value.sourceCreatedAt
  ) {
    context.addIssue({
      code: "custom",
      message: "Source updated time cannot precede source created time.",
      path: ["sourceUpdatedAt"],
    });
  }
}

function validateUpsertBindings(
  value: SourceAdapterUpsertV1,
  context: z.RefinementCtx,
) {
  const { sourceItem, sourceRevision, evidenceUnits } = value;
  if (!sameBinding(value, sourceItem)) {
    context.addIssue({
      code: "custom",
      message: "Source item binding does not match its adapter output.",
      path: ["sourceItem"],
    });
  }
  if (!sameScopeAndConnection(sourceItem, sourceRevision)) {
    addCrossBindingIssue(context, ["sourceRevision"], "source item");
  }
  if (
    sourceRevision.sourceItemId !== sourceItem.sourceItemId ||
    sourceRevision.sourceKind !== sourceItem.sourceKind ||
    sourceRevision.providerItemKeySha256 !== sourceItem.providerItemKeySha256
  ) {
    context.addIssue({
      code: "custom",
      message: "Source revision does not belong to the supplied source item.",
      path: ["sourceRevision"],
    });
  }
  validateNarrowedPolicy(sourceItem, sourceRevision, context, ["sourceRevision"]);
  validateObservationLineage(sourceItem, sourceRevision, context, ["sourceRevision"]);

  const seenEvidenceIds = new Set<string>();
  evidenceUnits.forEach((evidence, index) => {
    const path: PropertyKey[] = ["evidenceUnits", index];
    if (seenEvidenceIds.has(evidence.evidenceUnitId)) {
      context.addIssue({
        code: "custom",
        message: "Evidence unit IDs must be unique.",
        path,
      });
    }
    seenEvidenceIds.add(evidence.evidenceUnitId);
    if (
      index > 0 &&
      compareCanonicalIds(
        evidenceUnits[index - 1].evidenceUnitId,
        evidence.evidenceUnitId,
      ) > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Evidence units must use canonical ID order.",
        path,
      });
    }
    if (!sameScopeAndConnection(sourceRevision, evidence)) {
      addCrossBindingIssue(context, path, "source revision");
    }
    if (
      evidence.sourceItemId !== sourceItem.sourceItemId ||
      evidence.sourceRevisionId !== sourceRevision.sourceRevisionId ||
      evidence.sourceKind !== sourceRevision.sourceKind ||
      evidence.providerItemKeySha256 !==
        sourceRevision.providerItemKeySha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Evidence unit does not belong to the supplied source revision.",
        path,
      });
    }
    validateNarrowedPolicy(sourceRevision, evidence, context, path);
    validateObservationLineage(sourceRevision, evidence, context, path);
  });
}

function sameScopeAndConnection(
  left: SourceBindingV1,
  right: SourceBindingV1,
) {
  return left.tenantId === right.tenantId &&
    left.ownerActorId === right.ownerActorId &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.missionId === right.missionId &&
    left.connectionId === right.connectionId &&
    left.visibility === right.visibility &&
    left.sensitivity === right.sensitivity;
}

function sameBinding(left: SourceBindingV1, right: SourceBindingV1) {
  return sameScopeAndConnection(left, right) &&
    equalIds(left.permissionGrantIds, right.permissionGrantIds) &&
    equalIds(left.allowedPurposeIds, right.allowedPurposeIds) &&
    left.permissionSetSha256 === right.permissionSetSha256 &&
    left.purposeSetSha256 === right.purposeSetSha256 &&
    left.retentionPolicyId === right.retentionPolicyId &&
    left.retentionExpiresAt === right.retentionExpiresAt;
}

function validateNarrowedPolicy(
  parent: SourceBindingV1,
  child: SourceBindingV1,
  context: z.RefinementCtx,
  path: PropertyKey[],
) {
  if (!isSubset(child.permissionGrantIds, parent.permissionGrantIds)) {
    context.addIssue({
      code: "custom",
      message: "Derived source data cannot broaden permission grants.",
      path,
    });
  }
  if (!isSubset(child.allowedPurposeIds, parent.allowedPurposeIds)) {
    context.addIssue({
      code: "custom",
      message: "Derived source data cannot broaden allowed purposes.",
      path,
    });
  }
  if (child.retentionPolicyId !== parent.retentionPolicyId) {
    context.addIssue({
      code: "custom",
      message: "Derived source data must retain its source retention policy.",
      path,
    });
  }
  if (
    parent.retentionExpiresAt !== null &&
    (child.retentionExpiresAt === null ||
      child.retentionExpiresAt > parent.retentionExpiresAt)
  ) {
    context.addIssue({
      code: "custom",
      message: "Derived source data cannot outlive its source.",
      path,
    });
  }
}

function validateObservationLineage(
  parent: {
    sourceCreatedAt: string | null;
    sourceUpdatedAt: string | null;
    capturedAt: string;
  },
  child: {
    sourceCreatedAt: string | null;
    sourceUpdatedAt: string | null;
    capturedAt: string;
  },
  context: z.RefinementCtx,
  path: PropertyKey[],
) {
  if (
    parent.sourceCreatedAt !== child.sourceCreatedAt ||
    parent.sourceUpdatedAt !== child.sourceUpdatedAt ||
    parent.capturedAt !== child.capturedAt
  ) {
    context.addIssue({
      code: "custom",
      message: "Derived source timestamps must match their source observation.",
      path,
    });
  }
}

function isSubset(child: readonly string[], parent: readonly string[]) {
  const allowed = new Set(parent);
  return child.every((value) => allowed.has(value));
}

function equalIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function compareCanonicalIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addCrossBindingIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  expectedParent: string,
) {
  context.addIssue({
    code: "custom",
    message: `Source scope or connection does not match its ${expectedParent}.`,
    path,
  });
}

function validateAdapterOutputIdentity(
  value: SourceAdapterUpsertV1 | SourceAdapterDeleteV1,
  context: z.RefinementCtx,
) {
  if (value.adapterOutputId !== derivedAdapterOutputId(value)) {
    context.addIssue({
      code: "custom",
      message: "Adapter output ID does not match its event identity.",
      path: ["adapterOutputId"],
    });
  }
  const { adapterOutputSha256, ...body } = value;
  if (adapterOutputSha256 !== sourceContractSha256(body)) {
    context.addIssue({
      code: "custom",
      message: "Adapter output digest does not match its body.",
      path: ["adapterOutputSha256"],
    });
  }
}

function addByteLimitIssue(
  value: unknown,
  limit: number,
  context: z.RefinementCtx,
  label: string,
) {
  const bytes = Buffer.byteLength(canonicalJson(value), "utf8");
  if (bytes > limit) {
    context.addIssue({
      code: "custom",
      message: `${label} exceeds the ${limit}-byte contract limit.`,
    });
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical source-contract JSON requires finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Source contracts require JSON-compatible values.");
}
