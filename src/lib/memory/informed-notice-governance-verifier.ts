import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

import { z } from "zod";

import {
  MEMORY_INFORMED_NOTICE_REVIEW_SLOTS,
  parseMemoryInformedNoticeApprovalBatchV1,
  type MemoryInformedNoticeApprovalBatchV1,
  type MemoryInformedNoticeReviewEvidenceV1,
} from "@/lib/memory/informed-notice-governance-contracts";

export const MEMORY_INFORMED_NOTICE_REVIEW_SIGNATURE_ALGORITHM =
  "ed25519" as const;
export const MEMORY_INFORMED_NOTICE_REVIEW_ATTESTATION_SCHEMA_VERSION =
  1 as const;
export const MEMORY_INFORMED_NOTICE_TRUST_MANIFEST_SCHEMA_VERSION = 1 as const;
export const MEMORY_INFORMED_NOTICE_TRUST_MANIFEST_PREIMAGE_DOMAIN =
  "asael.memory.informed_notice_trust_manifest" as const;
export const MEMORY_INFORMED_NOTICE_TRUST_MANIFEST_PREIMAGE_VERSION = 1 as const;
export const MEMORY_INFORMED_NOTICE_REVIEW_SIGNATURE_PREIMAGE_DOMAIN =
  "asael.memory.informed_notice_review" as const;
export const MEMORY_INFORMED_NOTICE_REVIEW_SIGNATURE_PREIMAGE_VERSION =
  1 as const;
export const MEMORY_INFORMED_NOTICE_GOVERNANCE_VERIFICATION_SCHEMA_VERSION =
  1 as const;

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const canonicalActorIdSchema = opaqueIdSchema.regex(
  /^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);
const lowercaseSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const requiredUnknownSchema = z.unknown().refine((value) => value !== undefined);
const canonicalSignatureSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{85}[AQgw]$/)
  .refine(isCanonicalEd25519Signature);
const canonicalPublicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
  .refine(isCanonicalEd25519PublicKey);

const attestationBaseShape = {
  schemaVersion: z.literal(
    MEMORY_INFORMED_NOTICE_REVIEW_ATTESTATION_SCHEMA_VERSION,
  ),
  approvalBatchId: opaqueIdSchema,
  batchSha256: lowercaseSha256Schema,
  governancePolicyId: opaqueIdSchema,
  governancePolicyVersion: z.number().int().min(1).max(32_767),
  reviewId: opaqueIdSchema,
  reviewerActorId: canonicalActorIdSchema,
  reviewedAt: canonicalTimestampSchema,
  attesterKeyId: opaqueIdSchema,
  signatureAlgorithm: z.literal(
    MEMORY_INFORMED_NOTICE_REVIEW_SIGNATURE_ALGORITHM,
  ),
  signatureBase64url: canonicalSignatureSchema,
};

const legalReviewAttestationV1Schema = z
  .object({
    ...attestationBaseShape,
    reviewSlot: z.literal(MEMORY_INFORMED_NOTICE_REVIEW_SLOTS[0]),
  })
  .strict();
const privacyReviewAttestationV1Schema = z
  .object({
    ...attestationBaseShape,
    reviewSlot: z.literal(MEMORY_INFORMED_NOTICE_REVIEW_SLOTS[1]),
  })
  .strict();

export const memoryInformedNoticeReviewAttestationV1Schema = z.union([
  legalReviewAttestationV1Schema,
  privacyReviewAttestationV1Schema,
]);

const trustKeyBaseShape = {
  attesterKeyId: opaqueIdSchema,
  controllerActorId: canonicalActorIdSchema,
  signatureAlgorithm: z.literal(
    MEMORY_INFORMED_NOTICE_REVIEW_SIGNATURE_ALGORITHM,
  ),
  publicKeyBase64url: canonicalPublicKeySchema,
  notBefore: canonicalTimestampSchema,
  expiresAt: canonicalTimestampSchema,
  revokedAt: canonicalTimestampSchema.nullable(),
};
const legalTrustKeyV1Schema = z
  .object({
    ...trustKeyBaseShape,
    reviewSlot: z.literal(MEMORY_INFORMED_NOTICE_REVIEW_SLOTS[0]),
  })
  .strict()
  .superRefine(requireValidKeyWindow);
const privacyTrustKeyV1Schema = z
  .object({
    ...trustKeyBaseShape,
    reviewSlot: z.literal(MEMORY_INFORMED_NOTICE_REVIEW_SLOTS[1]),
  })
  .strict()
  .superRefine(requireValidKeyWindow);

export const memoryInformedNoticeTrustManifestV1Schema = z
  .object({
    schemaVersion: z.literal(
      MEMORY_INFORMED_NOTICE_TRUST_MANIFEST_SCHEMA_VERSION,
    ),
    manifestId: opaqueIdSchema,
    manifestRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    governancePolicyId: opaqueIdSchema,
    governancePolicyVersion: z.number().int().min(1).max(32_767),
    issuedAt: canonicalTimestampSchema,
    notBefore: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
    keys: z.tuple([legalTrustKeyV1Schema, privacyTrustKeyV1Schema]),
  })
  .strict()
  .superRefine(requireValidManifest);

export const memoryInformedNoticeGovernanceVerifierInputV1Schema = z
  .object({
    trustedManifestSha256: lowercaseSha256Schema,
    observedAt: canonicalTimestampSchema,
    batch: requiredUnknownSchema,
    attestations: z.tuple([requiredUnknownSchema, requiredUnknownSchema]),
    trustManifest: requiredUnknownSchema,
  })
  .strict();

export type MemoryInformedNoticeReviewAttestationV1 = Readonly<
  z.infer<typeof memoryInformedNoticeReviewAttestationV1Schema>
>;
export type MemoryInformedNoticeTrustManifestV1 = Readonly<
  z.infer<typeof memoryInformedNoticeTrustManifestV1Schema>
>;

export type MemoryInformedNoticeGovernanceVerificationV1 = Readonly<{
  schemaVersion: typeof MEMORY_INFORMED_NOTICE_GOVERNANCE_VERIFICATION_SCHEMA_VERSION;
  verificationKind: "offline_external_trust_manifest_v1";
  approvalBatchId: string;
  batchSha256: string;
  governancePolicyId: string;
  governancePolicyVersion: number;
  noticeCount: number;
  trustManifestId: string;
  trustManifestRevision: number;
  trustManifestSha256: string;
  trustManifestIssuedAt: string;
  observedAt: string;
  manifestDigestBound: true;
  batchDigestValid: true;
  attestations: readonly [
    Readonly<{
      reviewSlot: "legal_reviewer";
      reviewId: string;
      reviewerActorId: string;
      reviewedAt: string;
      attesterKeyId: string;
      publicKeySha256: string;
      signatureValid: true;
    }>,
    Readonly<{
      reviewSlot: "privacy_reviewer";
      reviewId: string;
      reviewerActorId: string;
      reviewedAt: string;
      attesterKeyId: string;
      publicKeySha256: string;
      signatureValid: true;
    }>,
  ];
  authorityGranted: false;
  runtimeAccepted: false;
}>;

export function canonicalMemoryInformedNoticeTrustManifestPreimageV1(
  value: unknown,
): Uint8Array {
  const manifest = memoryInformedNoticeTrustManifestV1Schema.parse(value);
  const fields: Array<readonly [string, string]> = [
    ["schemaVersion", String(manifest.schemaVersion)],
    ["manifestId", manifest.manifestId],
    ["manifestRevision", String(manifest.manifestRevision)],
    ["governancePolicyId", manifest.governancePolicyId],
    ["governancePolicyVersion", String(manifest.governancePolicyVersion)],
    ["issuedAt", manifest.issuedAt],
    ["notBefore", manifest.notBefore],
    ["expiresAt", manifest.expiresAt],
  ];
  for (const [index, key] of manifest.keys.entries()) {
    const prefix = `keys.${index}`;
    fields.push(
      [`${prefix}.reviewSlot`, key.reviewSlot],
      [`${prefix}.attesterKeyId`, key.attesterKeyId],
      [`${prefix}.controllerActorId`, key.controllerActorId],
      [`${prefix}.signatureAlgorithm`, key.signatureAlgorithm],
      [`${prefix}.publicKeyBase64url`, key.publicKeyBase64url],
      [`${prefix}.notBefore`, key.notBefore],
      [`${prefix}.expiresAt`, key.expiresAt],
      [`${prefix}.revokedAt`, key.revokedAt ?? "null"],
    );
  }
  return framePreimage(
    MEMORY_INFORMED_NOTICE_TRUST_MANIFEST_PREIMAGE_DOMAIN,
    MEMORY_INFORMED_NOTICE_TRUST_MANIFEST_PREIMAGE_VERSION,
    fields,
  );
}

export function memoryInformedNoticeTrustManifestSha256V1(value: unknown) {
  return sha256Bytes(canonicalMemoryInformedNoticeTrustManifestPreimageV1(value));
}

export function canonicalMemoryInformedNoticeReviewSignaturePreimageV1(
  value: unknown,
): Uint8Array {
  const attestation = memoryInformedNoticeReviewAttestationV1Schema.parse(value);
  return framePreimage(
    MEMORY_INFORMED_NOTICE_REVIEW_SIGNATURE_PREIMAGE_DOMAIN,
    MEMORY_INFORMED_NOTICE_REVIEW_SIGNATURE_PREIMAGE_VERSION,
    [
      ["schemaVersion", String(attestation.schemaVersion)],
      ["approvalBatchId", attestation.approvalBatchId],
      ["batchSha256", attestation.batchSha256],
      ["governancePolicyId", attestation.governancePolicyId],
      ["governancePolicyVersion", String(attestation.governancePolicyVersion)],
      ["reviewSlot", attestation.reviewSlot],
      ["reviewId", attestation.reviewId],
      ["reviewerActorId", attestation.reviewerActorId],
      ["reviewedAt", attestation.reviewedAt],
      ["attesterKeyId", attestation.attesterKeyId],
      ["signatureAlgorithm", attestation.signatureAlgorithm],
    ],
  );
}

/**
 * Verifies an exact notice batch against an independently anchored two-key
 * manifest. The anchor digest and observation time are caller assertions; the
 * caller must obtain them from rollback-protected infrastructure. Success is
 * evidence only and grants no database or runtime authority.
 */
export function verifyMemoryInformedNoticeGovernanceV1(
  value: unknown,
): MemoryInformedNoticeGovernanceVerificationV1 {
  const input = memoryInformedNoticeGovernanceVerifierInputV1Schema.parse(value);
  const trustedManifestSha256 = input.trustedManifestSha256;
  const observedAt = input.observedAt;
  const batch = parseMemoryInformedNoticeApprovalBatchV1(input.batch);
  const manifest = memoryInformedNoticeTrustManifestV1Schema.parse(
    input.trustManifest,
  );
  const attestations = [
    legalReviewAttestationV1Schema.parse(input.attestations[0]),
    privacyReviewAttestationV1Schema.parse(input.attestations[1]),
  ] as const;

  const manifestSha256 = memoryInformedNoticeTrustManifestSha256V1(manifest);
  if (!constantTimeSha256Equal(manifestSha256, trustedManifestSha256)) {
    throw new Error("Informed-notice trust-manifest digest binding failed.");
  }
  requireEqual("governance policy ID", manifest.governancePolicyId, batch.governancePolicyId);
  requireEqual(
    "governance policy version",
    manifest.governancePolicyVersion,
    batch.governancePolicyVersion,
  );
  requireInsideWindow("observation manifest", observedAt, manifest.notBefore, manifest.expiresAt);

  const verified = attestations.map((attestation, index) => {
    const review = batch.reviews[index]!;
    const key = manifest.keys[index]!;
    requireReviewBinding(attestation, review, batch);
    requireEqual("review key slot", key.reviewSlot, attestation.reviewSlot);
    requireEqual("review key ID", key.attesterKeyId, attestation.attesterKeyId);
    requireEqual("review key actor", key.controllerActorId, attestation.reviewerActorId);
    requireInsideWindow("review manifest", attestation.reviewedAt, manifest.notBefore, manifest.expiresAt);
    requireInsideWindow("review key", attestation.reviewedAt, key.notBefore, key.expiresAt);
    requireInsideWindow("observation key", observedAt, key.notBefore, key.expiresAt);
    if (Date.parse(attestation.reviewedAt) > Date.parse(observedAt)) {
      throw new Error("Informed-notice review follows the observation time.");
    }
    if (key.revokedAt !== null && Date.parse(key.revokedAt) <= Date.parse(observedAt)) {
      throw new Error("Informed-notice review key is revoked at observation time.");
    }
    const valid = verifyDetachedEd25519(
      canonicalMemoryInformedNoticeReviewSignaturePreimageV1(attestation),
      attestation.signatureBase64url,
      key.publicKeyBase64url,
    );
    if (!valid) {
      throw new Error("Informed-notice review signature verification failed.");
    }
    return Object.freeze({
      reviewSlot: attestation.reviewSlot,
      reviewId: attestation.reviewId,
      reviewerActorId: attestation.reviewerActorId,
      reviewedAt: attestation.reviewedAt,
      attesterKeyId: attestation.attesterKeyId,
      publicKeySha256: sha256Bytes(Buffer.from(key.publicKeyBase64url, "base64url")),
      signatureValid: true as const,
    });
  });

  return Object.freeze({
    schemaVersion:
      MEMORY_INFORMED_NOTICE_GOVERNANCE_VERIFICATION_SCHEMA_VERSION,
    verificationKind: "offline_external_trust_manifest_v1",
    approvalBatchId: batch.approvalBatchId,
    batchSha256: batch.batchSha256,
    governancePolicyId: batch.governancePolicyId,
    governancePolicyVersion: batch.governancePolicyVersion,
    noticeCount: batch.notices.length,
    trustManifestId: manifest.manifestId,
    trustManifestRevision: manifest.manifestRevision,
    trustManifestSha256: manifestSha256,
    trustManifestIssuedAt: manifest.issuedAt,
    observedAt,
    manifestDigestBound: true,
    batchDigestValid: true,
    attestations: Object.freeze(verified) as MemoryInformedNoticeGovernanceVerificationV1["attestations"],
    authorityGranted: false,
    runtimeAccepted: false,
  });
}

function requireReviewBinding(
  attestation: MemoryInformedNoticeReviewAttestationV1,
  review: MemoryInformedNoticeReviewEvidenceV1,
  batch: MemoryInformedNoticeApprovalBatchV1,
) {
  const bindings = [
    ["approval batch ID", attestation.approvalBatchId, batch.approvalBatchId],
    ["batch digest", attestation.batchSha256, batch.batchSha256],
    ["policy ID", attestation.governancePolicyId, batch.governancePolicyId],
    ["policy version", attestation.governancePolicyVersion, batch.governancePolicyVersion],
    ["review slot", attestation.reviewSlot, review.reviewSlot],
    ["review ID", attestation.reviewId, review.reviewId],
    ["reviewer actor", attestation.reviewerActorId, review.reviewerActorId],
    ["review timestamp", attestation.reviewedAt, review.reviewedAt],
  ] as const;
  for (const [label, actual, expected] of bindings) {
    requireEqual(label, actual, expected);
  }
}

function requireValidManifest(
  manifest: z.infer<typeof memoryInformedNoticeTrustManifestV1Schema>,
  context: z.RefinementCtx,
) {
  if (Date.parse(manifest.issuedAt) > Date.parse(manifest.notBefore)) {
    context.addIssue({ code: "custom", message: "Manifest issuedAt follows notBefore.", path: ["issuedAt"] });
  }
  if (Date.parse(manifest.expiresAt) <= Date.parse(manifest.notBefore)) {
    context.addIssue({ code: "custom", message: "Manifest window is empty.", path: ["expiresAt"] });
  }
  const [legal, privacy] = manifest.keys;
  for (const field of ["attesterKeyId", "controllerActorId", "publicKeyBase64url"] as const) {
    if (legal[field] === privacy[field]) {
      context.addIssue({ code: "custom", message: `Manifest ${field} values must be distinct.`, path: ["keys", 1, field] });
    }
  }
}

function requireValidKeyWindow(
  key: { notBefore: string; expiresAt: string; revokedAt: string | null },
  context: z.RefinementCtx,
) {
  const start = Date.parse(key.notBefore);
  const end = Date.parse(key.expiresAt);
  if (end <= start) {
    context.addIssue({ code: "custom", message: "Key window is empty.", path: ["expiresAt"] });
  }
  if (key.revokedAt !== null) {
    const revoked = Date.parse(key.revokedAt);
    if (revoked < start || revoked >= end) {
      context.addIssue({ code: "custom", message: "Key revocation is outside its window.", path: ["revokedAt"] });
    }
  }
}

function requireInsideWindow(label: string, value: string, start: string, end: string) {
  const time = Date.parse(value);
  if (time < Date.parse(start) || time >= Date.parse(end)) {
    throw new Error(`Informed-notice ${label} is outside its half-open validity window.`);
  }
}

function requireEqual(label: string, actual: string | number, expected: string | number) {
  if (actual !== expected) {
    throw new Error(`Informed-notice ${label} binding failed.`);
  }
}

function framePreimage(
  domain: string,
  version: number,
  fields: readonly (readonly [string, string])[],
) {
  const encoder = new TextEncoder();
  const domainBytes = encoder.encode(domain);
  const encoded = fields.map(([name, value]) => ({
    name: encoder.encode(name),
    value: encoder.encode(value),
  }));
  const length = encoded.reduce(
    (total, field) => total + 8 + field.name.byteLength + field.value.byteLength,
    4 + domainBytes.byteLength + 8,
  );
  const output = new Uint8Array(length);
  let offset = writeUint32Be(output, 0, domainBytes.byteLength);
  output.set(domainBytes, offset);
  offset += domainBytes.byteLength;
  offset = writeUint32Be(output, offset, version);
  offset = writeUint32Be(output, offset, encoded.length);
  for (const field of encoded) {
    offset = writeUint32Be(output, offset, field.name.byteLength);
    output.set(field.name, offset);
    offset += field.name.byteLength;
    offset = writeUint32Be(output, offset, field.value.byteLength);
    output.set(field.value, offset);
    offset += field.value.byteLength;
  }
  if (offset !== output.byteLength) {
    throw new Error("Informed-notice governance preimage framing failed.");
  }
  return output;
}

function verifyDetachedEd25519(message: Uint8Array, signature: string, publicKey: string) {
  try {
    const subjectPublicKeyInfo = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(publicKey, "base64url"),
    ]);
    const key = createPublicKey({ key: subjectPublicKeyInfo, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" &&
      verifySignature(null, message, key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function isCanonicalEd25519Signature(value: string) {
  return isCanonicalBase64urlBytes(value, 64);
}

function isCanonicalEd25519PublicKey(value: string) {
  return isCanonicalBase64urlBytes(value, 32);
}

function isCanonicalBase64urlBytes(value: string, expectedLength: number) {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === expectedLength && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function sha256Bytes(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeSha256Equal(left: string, right: string) {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function writeUint32Be(target: Uint8Array, offset: number, value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error("Informed-notice governance preimage length is invalid.");
  }
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
  return offset + 4;
}
