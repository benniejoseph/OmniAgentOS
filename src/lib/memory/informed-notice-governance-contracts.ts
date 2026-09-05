import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

export const MEMORY_INFORMED_NOTICE_APPROVAL_BATCH_SCHEMA_VERSION = 1 as const;
export const MEMORY_INFORMED_NOTICE_CONTRACT_RECORD_SCHEMA_VERSION = 1 as const;
export const MEMORY_INFORMED_NOTICE_APPROVAL_PREIMAGE_DOMAIN =
  "asael.memory.informed_notice_approval_batch" as const;
export const MEMORY_INFORMED_NOTICE_APPROVAL_PREIMAGE_VERSION = 1 as const;
export const MEMORY_INFORMED_NOTICE_REVIEW_SLOTS = Object.freeze([
  "legal_reviewer",
  "privacy_reviewer",
] as const);
export const MEMORY_INFORMED_NOTICE_APPROVAL_MAX_CONTRACTS = 64 as const;

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

const standingPurposeIdSchema = opaqueIdSchema.refine(
  (value) =>
    !value.startsWith("memory.export.v") &&
    !value.startsWith("memory.forget.v"),
  "Informed-notice approval is limited to standing-consent purposes.",
);

const localeIdSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
  .refine((value) => value.trim() === value);

const noticeTextSchema = z
  .string()
  .min(1)
  .max(20_000)
  .refine((value) => value.trim() === value);

export const memoryInformedNoticeApprovalContractV1Schema = z
  .object({
    recordSchemaVersion: z.literal(
      MEMORY_INFORMED_NOTICE_CONTRACT_RECORD_SCHEMA_VERSION,
    ),
    purposeId: standingPurposeIdSchema,
    noticeContractId: opaqueIdSchema,
    noticeContractVersion: z.number().int().min(1).max(32_767),
    localeId: localeIdSchema,
    noticeText: noticeTextSchema,
    noticeSha256: lowercaseSha256Schema,
  })
  .strict()
  .superRefine((notice, context) => {
    const expected = sha256Utf8(notice.noticeText);
    if (!constantTimeSha256Equal(expected, notice.noticeSha256)) {
      context.addIssue({
        code: "custom",
        message: "Notice digest does not match the exact UTF-8 notice text.",
        path: ["noticeSha256"],
      });
    }
  });

const approvalBatchCoordinatesShape = {
  schemaVersion: z.literal(
    MEMORY_INFORMED_NOTICE_APPROVAL_BATCH_SCHEMA_VERSION,
  ),
  approvalBatchId: opaqueIdSchema,
  governancePolicyId: opaqueIdSchema,
  governancePolicyVersion: z.number().int().min(1).max(32_767),
  decisionNonceSha256: lowercaseSha256Schema,
  evidenceSha256: lowercaseSha256Schema,
  notices: z
    .array(memoryInformedNoticeApprovalContractV1Schema)
    .min(1)
    .max(MEMORY_INFORMED_NOTICE_APPROVAL_MAX_CONTRACTS),
};

export const memoryInformedNoticeApprovalBatchCoordinatesV1Schema = z
  .object(approvalBatchCoordinatesShape)
  .strict()
  .superRefine(requireCanonicalNoticeOrder);

const reviewEvidenceBaseShape = {
  schemaVersion: z.literal(
    MEMORY_INFORMED_NOTICE_APPROVAL_BATCH_SCHEMA_VERSION,
  ),
  approvalBatchId: opaqueIdSchema,
  batchSha256: lowercaseSha256Schema,
  governancePolicyId: opaqueIdSchema,
  governancePolicyVersion: z.number().int().min(1).max(32_767),
  reviewId: opaqueIdSchema,
  reviewerActorId: canonicalActorIdSchema,
  reviewedAt: canonicalTimestampSchema,
};

const legalReviewEvidenceV1Schema = z
  .object({
    ...reviewEvidenceBaseShape,
    reviewSlot: z.literal(MEMORY_INFORMED_NOTICE_REVIEW_SLOTS[0]),
  })
  .strict();

const privacyReviewEvidenceV1Schema = z
  .object({
    ...reviewEvidenceBaseShape,
    reviewSlot: z.literal(MEMORY_INFORMED_NOTICE_REVIEW_SLOTS[1]),
  })
  .strict();

export const memoryInformedNoticeReviewEvidenceV1Schema = z.union([
  legalReviewEvidenceV1Schema,
  privacyReviewEvidenceV1Schema,
]);

export const memoryInformedNoticeApprovalBatchV1Schema = z
  .object({
    ...approvalBatchCoordinatesShape,
    batchSha256: lowercaseSha256Schema,
    reviews: z.tuple([
      legalReviewEvidenceV1Schema,
      privacyReviewEvidenceV1Schema,
    ]),
  })
  .strict()
  .superRefine((batch, context) => {
    requireCanonicalNoticeOrder(batch, context);

    const computed = memoryInformedNoticeApprovalBatchSha256V1(batch);
    if (!constantTimeSha256Equal(computed, batch.batchSha256)) {
      context.addIssue({
        code: "custom",
        message: "Approval batch digest does not match its exact coordinates.",
        path: ["batchSha256"],
      });
    }

    if (batch.reviews[0].reviewId === batch.reviews[1].reviewId) {
      context.addIssue({
        code: "custom",
        message: "Legal and privacy reviews require distinct review IDs.",
        path: ["reviews", 1, "reviewId"],
      });
    }
    if (
      batch.reviews[0].reviewerActorId ===
      batch.reviews[1].reviewerActorId
    ) {
      context.addIssue({
        code: "custom",
        message: "Legal and privacy reviews require distinct canonical actors.",
        path: ["reviews", 1, "reviewerActorId"],
      });
    }

    for (const [index, review] of batch.reviews.entries()) {
      const bindings = [
        ["approvalBatchId", review.approvalBatchId, batch.approvalBatchId],
        ["batchSha256", review.batchSha256, batch.batchSha256],
        [
          "governancePolicyId",
          review.governancePolicyId,
          batch.governancePolicyId,
        ],
        [
          "governancePolicyVersion",
          review.governancePolicyVersion,
          batch.governancePolicyVersion,
        ],
      ] as const;
      for (const [field, actual, expected] of bindings) {
        if (actual !== expected) {
          context.addIssue({
            code: "custom",
            message: `Review ${field} does not match the approval batch.`,
            path: ["reviews", index, field],
          });
        }
      }
    }
  });

export type MemoryInformedNoticeApprovalContractV1 = Readonly<
  z.infer<typeof memoryInformedNoticeApprovalContractV1Schema>
>;

export type MemoryInformedNoticeApprovalBatchCoordinatesV1 = Readonly<{
  schemaVersion: typeof MEMORY_INFORMED_NOTICE_APPROVAL_BATCH_SCHEMA_VERSION;
  approvalBatchId: string;
  governancePolicyId: string;
  governancePolicyVersion: number;
  decisionNonceSha256: string;
  evidenceSha256: string;
  notices: readonly MemoryInformedNoticeApprovalContractV1[];
}>;

export type MemoryInformedNoticeReviewEvidenceV1 = Readonly<
  z.infer<typeof memoryInformedNoticeReviewEvidenceV1Schema>
>;

export type MemoryInformedNoticeApprovalBatchV1 = Readonly<{
  schemaVersion: typeof MEMORY_INFORMED_NOTICE_APPROVAL_BATCH_SCHEMA_VERSION;
  approvalBatchId: string;
  governancePolicyId: string;
  governancePolicyVersion: number;
  decisionNonceSha256: string;
  evidenceSha256: string;
  notices: readonly MemoryInformedNoticeApprovalContractV1[];
  batchSha256: string;
  reviews: readonly [
    MemoryInformedNoticeReviewEvidenceV1,
    MemoryInformedNoticeReviewEvidenceV1,
  ];
}>;

export type BuildMemoryInformedNoticeApprovalBatchWithComputedSha256V1Input =
  Readonly<{
    schemaVersion: typeof MEMORY_INFORMED_NOTICE_APPROVAL_BATCH_SCHEMA_VERSION;
    approvalBatchId: string;
    governancePolicyId: string;
    governancePolicyVersion: number;
    decisionNonceSha256: string;
    evidenceSha256: string;
    notices: readonly MemoryInformedNoticeApprovalContractV1[];
    reviews: readonly [
      Omit<MemoryInformedNoticeReviewEvidenceV1, "batchSha256">,
      Omit<MemoryInformedNoticeReviewEvidenceV1, "batchSha256">,
    ];
  }>;

/**
 * Hashes exact, length-delimited coordinates rather than JSON serialization.
 * Notice text bytes are included as well as their digest so approval pins the
 * precise wording without relying on later normalization or caller convention.
 */
export function canonicalMemoryInformedNoticeApprovalBatchPreimageV1(
  value: unknown,
): Uint8Array {
  const batch = parseApprovalBatchCoordinates(value);
  const fields: Array<readonly [string, string]> = [
    ["schemaVersion", String(batch.schemaVersion)],
    ["approvalBatchId", batch.approvalBatchId],
    ["governancePolicyId", batch.governancePolicyId],
    ["governancePolicyVersion", String(batch.governancePolicyVersion)],
    ["decisionNonceSha256", batch.decisionNonceSha256],
    ["evidenceSha256", batch.evidenceSha256],
    ["noticeCount", String(batch.notices.length)],
  ];
  for (const [index, notice] of batch.notices.entries()) {
    const prefix = `notices.${index}`;
    fields.push(
      [`${prefix}.recordSchemaVersion`, String(notice.recordSchemaVersion)],
      [`${prefix}.purposeId`, notice.purposeId],
      [`${prefix}.noticeContractId`, notice.noticeContractId],
      [`${prefix}.noticeContractVersion`, String(notice.noticeContractVersion)],
      [`${prefix}.localeId`, notice.localeId],
      [`${prefix}.noticeText`, notice.noticeText],
      [`${prefix}.noticeSha256`, notice.noticeSha256],
    );
  }

  const encoder = new TextEncoder();
  const domain = encoder.encode(MEMORY_INFORMED_NOTICE_APPROVAL_PREIMAGE_DOMAIN);
  const encodedFields = fields.map(([name, value]) => ({
    name: encoder.encode(name),
    value: encoder.encode(value),
  }));
  const length = encodedFields.reduce(
    (total, field) =>
      total + 4 + field.name.byteLength + 4 + field.value.byteLength,
    4 + domain.byteLength + 4 + 4,
  );
  const output = new Uint8Array(length);
  let offset = 0;
  offset = writeUint32Be(output, offset, domain.byteLength);
  output.set(domain, offset);
  offset += domain.byteLength;
  offset = writeUint32Be(
    output,
    offset,
    MEMORY_INFORMED_NOTICE_APPROVAL_PREIMAGE_VERSION,
  );
  offset = writeUint32Be(output, offset, encodedFields.length);
  for (const field of encodedFields) {
    offset = writeUint32Be(output, offset, field.name.byteLength);
    output.set(field.name, offset);
    offset += field.name.byteLength;
    offset = writeUint32Be(output, offset, field.value.byteLength);
    output.set(field.value, offset);
    offset += field.value.byteLength;
  }
  if (offset !== output.byteLength) {
    throw new Error("Informed-notice approval preimage framing failed.");
  }
  return output;
}

export function memoryInformedNoticeApprovalBatchSha256V1(
  value: unknown,
): string {
  return createHash("sha256")
    .update(canonicalMemoryInformedNoticeApprovalBatchPreimageV1(value))
    .digest("hex");
}

export function parseMemoryInformedNoticeApprovalBatchV1(
  value: unknown,
): MemoryInformedNoticeApprovalBatchV1 {
  return freezeBatch(memoryInformedNoticeApprovalBatchV1Schema.parse(value));
}

export function buildMemoryInformedNoticeApprovalBatchWithComputedSha256V1(
  value: BuildMemoryInformedNoticeApprovalBatchWithComputedSha256V1Input,
): MemoryInformedNoticeApprovalBatchV1 {
  const coordinates = parseApprovalBatchCoordinates(value);
  const batchSha256 = memoryInformedNoticeApprovalBatchSha256V1(coordinates);
  return parseMemoryInformedNoticeApprovalBatchV1({
    ...coordinates,
    batchSha256,
    reviews: value.reviews.map((review) => ({
      ...review,
      batchSha256,
    })),
  });
}

function requireCanonicalNoticeOrder(
  batch: { notices: readonly MemoryInformedNoticeApprovalContractV1[] },
  context: z.RefinementCtx,
) {
  const keys = batch.notices.map(noticePrimaryKey);
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index - 1]! >= keys[index]!) {
      context.addIssue({
        code: "custom",
        message:
          "Notice contracts must be unique and sorted by their exact primary coordinates.",
        path: ["notices", index],
      });
    }
  }
}

function parseApprovalBatchCoordinates(value: unknown) {
  const input = z.record(z.string(), z.unknown()).parse(value);
  return memoryInformedNoticeApprovalBatchCoordinatesV1Schema.parse({
    schemaVersion: input.schemaVersion,
    approvalBatchId: input.approvalBatchId,
    governancePolicyId: input.governancePolicyId,
    governancePolicyVersion: input.governancePolicyVersion,
    decisionNonceSha256: input.decisionNonceSha256,
    evidenceSha256: input.evidenceSha256,
    notices: input.notices,
  });
}

function noticePrimaryKey(notice: MemoryInformedNoticeApprovalContractV1) {
  return [
    notice.purposeId,
    notice.noticeContractId,
    String(notice.noticeContractVersion).padStart(5, "0"),
  ].join("\u0000");
}

function freezeBatch(
  batch: z.infer<typeof memoryInformedNoticeApprovalBatchV1Schema>,
): MemoryInformedNoticeApprovalBatchV1 {
  const notices = Object.freeze(
    batch.notices.map((notice) => Object.freeze({ ...notice })),
  );
  const reviews = Object.freeze([
    Object.freeze({ ...batch.reviews[0] }),
    Object.freeze({ ...batch.reviews[1] }),
  ]) as readonly [
    MemoryInformedNoticeReviewEvidenceV1,
    MemoryInformedNoticeReviewEvidenceV1,
  ];
  return Object.freeze({ ...batch, notices, reviews });
}

function sha256Utf8(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeSha256Equal(left: string, right: string) {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function writeUint32Be(target: Uint8Array, offset: number, value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error("Informed-notice approval preimage length is invalid.");
  }
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
  return offset + 4;
}
