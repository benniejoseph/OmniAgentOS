import { createHash } from "node:crypto";

import { z } from "zod";

export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_SCHEMA_VERSION =
  1 as const;
export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTATION_SCHEMA_VERSION =
  1 as const;
export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTATION_BUNDLE_SCHEMA_VERSION =
  1 as const;

export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_ACTION =
  "create_held_membership_management_authority" as const;
export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_STATE =
  "held" as const;
export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_SIGNATURE_ALGORITHM =
  "ed25519" as const;

export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS =
  Object.freeze([
    "organization_custodian",
    "independent_reviewer",
  ] as const);

export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_MAX_VALIDITY_WINDOW_MS =
  15 * 60 * 1_000;

export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_PREIMAGE_DOMAIN =
  "asael.memory.membership_management_bootstrap_decision" as const;
export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_PREIMAGE_VERSION =
  1 as const;
export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_SIGNATURE_MESSAGE =
  "canonical_decision_preimage_v1" as const;

/**
 * The signed coordinates and their canonical serialization order. Operational
 * recording attribution and held-lifecycle placeholders are deliberately not
 * signed coordinates.
 */
export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_PREIMAGE_FIELD_ORDER =
  Object.freeze([
    "governanceDecisionId",
    "databaseIdentityId",
    "tenantId",
    "subjectActorId",
    "granteeActorId",
    "managementAuthorityId",
    "authorityGeneration",
    "decisionAction",
    "ceremonyPolicyId",
    "ceremonyPolicyVersion",
    "trustManifestSha256",
    "decisionNonceSha256",
    "evidenceSha256",
    "notBefore",
    "expiresAt",
  ] as const);

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

/**
 * The v57 database identity is a logical lineage coordinate preserved across a
 * restore. Its shape does not prove one physical database instance and cannot,
 * by itself, prevent replay into a clone.
 */
export const memoryMembershipManagementBootstrapDatabaseIdentityIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{32}$/,
    "Expected the exact lowercase logical database identity.",
  );

export const memoryMembershipManagementBootstrapLowercaseSha256Schema = z
  .string()
  .regex(
    /^[0-9a-f]{64}$/,
    "Expected a lowercase hexadecimal SHA-256 digest.",
  );

export const memoryMembershipManagementBootstrapCanonicalTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "Expected a canonical UTC timestamp with millisecond precision.",
  )
  .refine(isCanonicalTimestamp, {
    message: "Expected a valid canonical UTC timestamp.",
  });

const positiveSafeGenerationSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

const positiveSmallintSchema = z.number().int().min(1).max(32_767);

export const memoryMembershipManagementBootstrapAttesterSlotSchema = z.enum(
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS,
);

const canonicalEd25519SignatureSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{85}[AQgw]$/,
    "Expected a canonical 86-character unpadded base64url Ed25519 signature.",
  );

const signedDecisionCoordinateShape = {
  governanceDecisionId: opaqueIdSchema,
  databaseIdentityId:
    memoryMembershipManagementBootstrapDatabaseIdentityIdSchema,
  tenantId: opaqueIdSchema,
  subjectActorId: canonicalActorIdSchema,
  granteeActorId: canonicalActorIdSchema,
  managementAuthorityId: opaqueIdSchema,
  authorityGeneration: positiveSafeGenerationSchema,
  decisionAction: z.literal(
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_ACTION,
  ),
  ceremonyPolicyId: opaqueIdSchema,
  ceremonyPolicyVersion: positiveSmallintSchema,
  trustManifestSha256:
    memoryMembershipManagementBootstrapLowercaseSha256Schema,
  decisionNonceSha256:
    memoryMembershipManagementBootstrapLowercaseSha256Schema,
  evidenceSha256: memoryMembershipManagementBootstrapLowercaseSha256Schema,
  notBefore: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
  expiresAt: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
};

export const memoryMembershipManagementBootstrapDecisionSignedCoordinatesV1Schema =
  z
    .object(signedDecisionCoordinateShape)
    .strict()
    .superRefine(requireBoundedValidityWindow);

export type MemoryMembershipManagementBootstrapDecisionSignedCoordinatesV1 =
  Readonly<
    z.infer<
      typeof memoryMembershipManagementBootstrapDecisionSignedCoordinatesV1Schema
    >
  >;

const decisionRecordShape = {
  schemaVersion: z.literal(
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_SCHEMA_VERSION,
  ),
  tenantId: opaqueIdSchema,
  governanceDecisionId: opaqueIdSchema,
  databaseIdentityId:
    memoryMembershipManagementBootstrapDatabaseIdentityIdSchema,
  subjectActorId: canonicalActorIdSchema,
  granteeActorId: canonicalActorIdSchema,
  managementAuthorityId: opaqueIdSchema,
  authorityGeneration: positiveSafeGenerationSchema,
  decisionAction: z.literal(
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_ACTION,
  ),
  ceremonyPolicyId: opaqueIdSchema,
  ceremonyPolicyVersion: positiveSmallintSchema,
  trustManifestSha256:
    memoryMembershipManagementBootstrapLowercaseSha256Schema,
  decisionNonceSha256:
    memoryMembershipManagementBootstrapLowercaseSha256Schema,
  evidenceSha256: memoryMembershipManagementBootstrapLowercaseSha256Schema,
  decisionSha256: memoryMembershipManagementBootstrapLowercaseSha256Schema,
  notBefore: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
  expiresAt: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
  state: z.literal(MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_STATE),
  lifecycleRevision: z.literal(0),
  recordedByActorId: canonicalActorIdSchema,
  recordedAt: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
  verifiedByActorId: z.null(),
  verifiedAt: z.null(),
  consumedByActorId: z.null(),
  consumedAt: z.null(),
  revokedByActorId: z.null(),
  revokedAt: z.null(),
};

/**
 * Strict metadata-only mirror of one v57 decision row. It models only held
 * revision 0 and does not prove that the row exists, was authorized, or may be
 * consumed.
 */
export const memoryMembershipManagementBootstrapDecisionRecordV1Schema = z
  .object(decisionRecordShape)
  .strict()
  .superRefine(requireDecisionRecordWindow);

export type MemoryMembershipManagementBootstrapDecisionRecordV1 = Readonly<
  z.infer<typeof memoryMembershipManagementBootstrapDecisionRecordV1Schema>
>;

const decisionBuildInputShape = {
  tenantId: opaqueIdSchema,
  governanceDecisionId: opaqueIdSchema,
  databaseIdentityId:
    memoryMembershipManagementBootstrapDatabaseIdentityIdSchema,
  subjectActorId: canonicalActorIdSchema,
  granteeActorId: canonicalActorIdSchema,
  managementAuthorityId: opaqueIdSchema,
  authorityGeneration: positiveSafeGenerationSchema,
  ceremonyPolicyId: opaqueIdSchema,
  ceremonyPolicyVersion: positiveSmallintSchema,
  trustManifestSha256:
    memoryMembershipManagementBootstrapLowercaseSha256Schema,
  decisionNonceSha256:
    memoryMembershipManagementBootstrapLowercaseSha256Schema,
  evidenceSha256: memoryMembershipManagementBootstrapLowercaseSha256Schema,
  decisionSha256: memoryMembershipManagementBootstrapLowercaseSha256Schema,
  notBefore: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
  expiresAt: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
  recordedByActorId: canonicalActorIdSchema,
  recordedAt: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
};

export const buildMemoryMembershipManagementBootstrapDecisionRecordV1InputSchema =
  z
    .object(decisionBuildInputShape)
    .strict()
    .superRefine(requireDecisionRecordWindow);

export type BuildMemoryMembershipManagementBootstrapDecisionRecordV1Input =
  z.infer<
    typeof buildMemoryMembershipManagementBootstrapDecisionRecordV1InputSchema
  >;

const decisionBuildComputedDigestInputShape = {
  tenantId: opaqueIdSchema,
  governanceDecisionId: opaqueIdSchema,
  databaseIdentityId:
    memoryMembershipManagementBootstrapDatabaseIdentityIdSchema,
  subjectActorId: canonicalActorIdSchema,
  granteeActorId: canonicalActorIdSchema,
  managementAuthorityId: opaqueIdSchema,
  authorityGeneration: positiveSafeGenerationSchema,
  ceremonyPolicyId: opaqueIdSchema,
  ceremonyPolicyVersion: positiveSmallintSchema,
  trustManifestSha256:
    memoryMembershipManagementBootstrapLowercaseSha256Schema,
  decisionNonceSha256:
    memoryMembershipManagementBootstrapLowercaseSha256Schema,
  evidenceSha256: memoryMembershipManagementBootstrapLowercaseSha256Schema,
  notBefore: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
  expiresAt: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
  recordedByActorId: canonicalActorIdSchema,
  recordedAt: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
};

export const buildMemoryMembershipManagementBootstrapDecisionRecordWithComputedSha256V1InputSchema =
  z
    .object(decisionBuildComputedDigestInputShape)
    .strict()
    .superRefine(requireDecisionRecordWindow);

export type BuildMemoryMembershipManagementBootstrapDecisionRecordWithComputedSha256V1Input =
  z.infer<
    typeof buildMemoryMembershipManagementBootstrapDecisionRecordWithComputedSha256V1InputSchema
  >;

const attestationRecordShape = {
  schemaVersion: z.literal(
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTATION_SCHEMA_VERSION,
  ),
  tenantId: opaqueIdSchema,
  governanceDecisionId: opaqueIdSchema,
  decisionSha256: memoryMembershipManagementBootstrapLowercaseSha256Schema,
  attesterSlot: memoryMembershipManagementBootstrapAttesterSlotSchema,
  attesterKeyId: opaqueIdSchema,
  signatureAlgorithm: z.literal(
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_SIGNATURE_ALGORITHM,
  ),
  signatureBase64url: canonicalEd25519SignatureSchema,
  attestedAt: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
};

/**
 * A standalone attestation can validate only its own structural encoding. Its
 * time is checked against a decision window by the structural binding helper.
 */
export const memoryMembershipManagementBootstrapAttestationRecordV1Schema = z
  .object(attestationRecordShape)
  .strict();

export type MemoryMembershipManagementBootstrapAttestationRecordV1 = Readonly<
  z.infer<typeof memoryMembershipManagementBootstrapAttestationRecordV1Schema>
>;

const attestationBuildInputShape = {
  tenantId: opaqueIdSchema,
  governanceDecisionId: opaqueIdSchema,
  decisionSha256: memoryMembershipManagementBootstrapLowercaseSha256Schema,
  attesterSlot: memoryMembershipManagementBootstrapAttesterSlotSchema,
  attesterKeyId: opaqueIdSchema,
  signatureBase64url: canonicalEd25519SignatureSchema,
  attestedAt: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
};

export const buildMemoryMembershipManagementBootstrapAttestationRecordV1InputSchema =
  z.object(attestationBuildInputShape).strict();

export type BuildMemoryMembershipManagementBootstrapAttestationRecordV1Input =
  z.infer<
    typeof buildMemoryMembershipManagementBootstrapAttestationRecordV1InputSchema
  >;

const attestationBundleShape = {
  schemaVersion: z.literal(
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTATION_BUNDLE_SCHEMA_VERSION,
  ),
  tenantId: opaqueIdSchema,
  governanceDecisionId: opaqueIdSchema,
  decisionSha256: memoryMembershipManagementBootstrapLowercaseSha256Schema,
  attestations: z.tuple([
    memoryMembershipManagementBootstrapAttestationRecordV1Schema,
    memoryMembershipManagementBootstrapAttestationRecordV1Schema,
  ]),
};

/**
 * A structurally complete two-slot evidence shape. Completion is not signature
 * validity, key trust, human independence, authority, or permission.
 */
export const memoryMembershipManagementBootstrapAttestationBundleV1Schema = z
  .object(attestationBundleShape)
  .strict()
  .superRefine(requireCanonicalAttestationBundle);

export type MemoryMembershipManagementBootstrapAttestationBundleV1 = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  governanceDecisionId: string;
  decisionSha256: string;
  attestations: readonly [
    MemoryMembershipManagementBootstrapAttestationRecordV1,
    MemoryMembershipManagementBootstrapAttestationRecordV1,
  ];
}>;

export type MemoryMembershipManagementBootstrapDecisionDigestAssertionV1 =
  Readonly<{
    decisionSha256: string;
    computedDecisionSha256: string;
    matches: true;
  }>;

export type MemoryMembershipManagementBootstrapAttestationDecisionBindingV1 =
  Readonly<{
    tenantId: string;
    governanceDecisionId: string;
    decisionSha256: string;
    notBefore: string;
    expiresAt: string;
    attesterSlot: MemoryMembershipManagementBootstrapAttestationRecordV1["attesterSlot"];
    attestedAt: string;
  }>;

export function parseMemoryMembershipManagementBootstrapDecisionRecordV1(
  value: unknown,
): MemoryMembershipManagementBootstrapDecisionRecordV1 {
  return freezeFlat(
    memoryMembershipManagementBootstrapDecisionRecordV1Schema.parse(value),
  );
}

export function buildMemoryMembershipManagementBootstrapDecisionRecordV1(
  input: BuildMemoryMembershipManagementBootstrapDecisionRecordV1Input,
): MemoryMembershipManagementBootstrapDecisionRecordV1 {
  const parsed =
    buildMemoryMembershipManagementBootstrapDecisionRecordV1InputSchema.parse(
      input,
    );

  return parseMemoryMembershipManagementBootstrapDecisionRecordV1({
    schemaVersion:
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_SCHEMA_VERSION,
    tenantId: parsed.tenantId,
    governanceDecisionId: parsed.governanceDecisionId,
    databaseIdentityId: parsed.databaseIdentityId,
    subjectActorId: parsed.subjectActorId,
    granteeActorId: parsed.granteeActorId,
    managementAuthorityId: parsed.managementAuthorityId,
    authorityGeneration: parsed.authorityGeneration,
    decisionAction: MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_ACTION,
    ceremonyPolicyId: parsed.ceremonyPolicyId,
    ceremonyPolicyVersion: parsed.ceremonyPolicyVersion,
    trustManifestSha256: parsed.trustManifestSha256,
    decisionNonceSha256: parsed.decisionNonceSha256,
    evidenceSha256: parsed.evidenceSha256,
    decisionSha256: parsed.decisionSha256,
    notBefore: parsed.notBefore,
    expiresAt: parsed.expiresAt,
    state: MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_STATE,
    lifecycleRevision: 0,
    recordedByActorId: parsed.recordedByActorId,
    recordedAt: parsed.recordedAt,
    verifiedByActorId: null,
    verifiedAt: null,
    consumedByActorId: null,
    consumedAt: null,
    revokedByActorId: null,
    revokedAt: null,
  });
}

export function buildMemoryMembershipManagementBootstrapDecisionRecordWithComputedSha256V1(
  input: BuildMemoryMembershipManagementBootstrapDecisionRecordWithComputedSha256V1Input,
): MemoryMembershipManagementBootstrapDecisionRecordV1 {
  const parsed =
    buildMemoryMembershipManagementBootstrapDecisionRecordWithComputedSha256V1InputSchema.parse(
      input,
    );
  const signedCoordinates =
    memoryMembershipManagementBootstrapDecisionSignedCoordinatesV1Schema.parse({
      governanceDecisionId: parsed.governanceDecisionId,
      databaseIdentityId: parsed.databaseIdentityId,
      tenantId: parsed.tenantId,
      subjectActorId: parsed.subjectActorId,
      granteeActorId: parsed.granteeActorId,
      managementAuthorityId: parsed.managementAuthorityId,
      authorityGeneration: parsed.authorityGeneration,
      decisionAction: MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_ACTION,
      ceremonyPolicyId: parsed.ceremonyPolicyId,
      ceremonyPolicyVersion: parsed.ceremonyPolicyVersion,
      trustManifestSha256: parsed.trustManifestSha256,
      decisionNonceSha256: parsed.decisionNonceSha256,
      evidenceSha256: parsed.evidenceSha256,
      notBefore: parsed.notBefore,
      expiresAt: parsed.expiresAt,
    });

  return buildMemoryMembershipManagementBootstrapDecisionRecordV1({
    ...parsed,
    decisionSha256:
      memoryMembershipManagementBootstrapDecisionSha256V1(signedCoordinates),
  });
}

export function parseMemoryMembershipManagementBootstrapAttestationRecordV1(
  value: unknown,
): MemoryMembershipManagementBootstrapAttestationRecordV1 {
  return freezeFlat(
    memoryMembershipManagementBootstrapAttestationRecordV1Schema.parse(value),
  );
}

export function buildMemoryMembershipManagementBootstrapAttestationRecordV1(
  input: BuildMemoryMembershipManagementBootstrapAttestationRecordV1Input,
): MemoryMembershipManagementBootstrapAttestationRecordV1 {
  const parsed =
    buildMemoryMembershipManagementBootstrapAttestationRecordV1InputSchema.parse(
      input,
    );

  return parseMemoryMembershipManagementBootstrapAttestationRecordV1({
    schemaVersion:
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTATION_SCHEMA_VERSION,
    ...parsed,
    signatureAlgorithm:
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_SIGNATURE_ALGORITHM,
  });
}

export function parseMemoryMembershipManagementBootstrapAttestationBundleV1(
  decisionValue: unknown,
  value: unknown,
): MemoryMembershipManagementBootstrapAttestationBundleV1 {
  const decision =
    parseMemoryMembershipManagementBootstrapDecisionRecordV1(decisionValue);
  assertMemoryMembershipManagementBootstrapDecisionSha256V1(decision);
  const parsed =
    memoryMembershipManagementBootstrapAttestationBundleV1Schema.parse(value);
  for (const attestation of parsed.attestations) {
    assertMemoryMembershipManagementBootstrapAttestationDecisionBindingV1(
      decision,
      attestation,
    );
  }
  const attestations = Object.freeze([
    freezeFlat(parsed.attestations[0]),
    freezeFlat(parsed.attestations[1]),
  ]) as readonly [
    MemoryMembershipManagementBootstrapAttestationRecordV1,
    MemoryMembershipManagementBootstrapAttestationRecordV1,
  ];

  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    tenantId: parsed.tenantId,
    governanceDecisionId: parsed.governanceDecisionId,
    decisionSha256: parsed.decisionSha256,
    attestations,
  });
}

/**
 * Serializes the signed decision coordinates as:
 *
 *   uint32-be(domain UTF-8 byte length) || domain UTF-8 bytes ||
 *   uint32-be(preimage version) || uint32-be(field count) ||
 *   for each fixed-order field:
 *     uint32-be(field-name UTF-8 byte length) || field-name UTF-8 bytes ||
 *     uint32-be(value UTF-8 byte length) || value UTF-8 bytes
 *
 * Integer values use their canonical unsigned base-10 spelling. The function
 * returns a newly allocated mutable Uint8Array on every call; no byte buffer is
 * cached or shared. A future Ed25519 verifier must verify the signature over
 * these exact bytes, not over the hexadecimal decisionSha256 string or a
 * second hash. decisionSha256 remains the durable equality coordinate.
 */
export function canonicalMemoryMembershipManagementBootstrapDecisionPreimageV1(
  value: unknown,
): Uint8Array {
  const coordinates = parseSignedDecisionCoordinates(value);
  const encoder = new TextEncoder();
  const domainBytes = encoder.encode(
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_PREIMAGE_DOMAIN,
  );
  const fields =
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_PREIMAGE_FIELD_ORDER.map(
      (fieldName) => ({
        nameBytes: encoder.encode(fieldName),
        valueBytes: encoder.encode(String(coordinates[fieldName])),
      }),
    );
  const byteLength = fields.reduce(
    (total, field) =>
      total + 4 + field.nameBytes.byteLength + 4 + field.valueBytes.byteLength,
    4 + domainBytes.byteLength + 4 + 4,
  );
  const output = new Uint8Array(byteLength);
  let offset = 0;

  offset = writeUint32Be(output, offset, domainBytes.byteLength);
  output.set(domainBytes, offset);
  offset += domainBytes.byteLength;
  offset = writeUint32Be(
    output,
    offset,
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_PREIMAGE_VERSION,
  );
  offset = writeUint32Be(output, offset, fields.length);

  for (const field of fields) {
    offset = writeUint32Be(output, offset, field.nameBytes.byteLength);
    output.set(field.nameBytes, offset);
    offset += field.nameBytes.byteLength;
    offset = writeUint32Be(output, offset, field.valueBytes.byteLength);
    output.set(field.valueBytes, offset);
    offset += field.valueBytes.byteLength;
  }

  if (offset !== output.byteLength) {
    throw new Error("Bootstrap governance decision preimage framing failed.");
  }

  return output;
}

export function memoryMembershipManagementBootstrapDecisionSha256V1(
  value: unknown,
): string {
  return createHash("sha256")
    .update(
      canonicalMemoryMembershipManagementBootstrapDecisionPreimageV1(value),
    )
    .digest("hex");
}

/**
 * Asserts a record digest or an explicitly supplied digest against the
 * canonical preimage. This does not authenticate either attestation signature.
 */
export function assertMemoryMembershipManagementBootstrapDecisionSha256V1(
  value: unknown,
  suppliedDecisionSha256?: unknown,
): MemoryMembershipManagementBootstrapDecisionDigestAssertionV1 {
  const recordResult =
    memoryMembershipManagementBootstrapDecisionRecordV1Schema.safeParse(value);
  const coordinates = recordResult.success
    ? pickSignedDecisionCoordinates(recordResult.data)
    : memoryMembershipManagementBootstrapDecisionSignedCoordinatesV1Schema.parse(
        value,
      );
  const recordDigest = recordResult.success
    ? recordResult.data.decisionSha256
    : undefined;
  const suppliedDigest = suppliedDecisionSha256 === undefined
    ? undefined
    : memoryMembershipManagementBootstrapLowercaseSha256Schema.parse(
        suppliedDecisionSha256,
      );

  if (recordDigest === undefined && suppliedDigest === undefined) {
    throw new Error(
      "A decisionSha256 is required when asserting signed coordinates.",
    );
  }
  if (
    recordDigest !== undefined &&
    suppliedDigest !== undefined &&
    recordDigest !== suppliedDigest
  ) {
    throw new Error(
      "Caller-supplied decisionSha256 does not match the decision record.",
    );
  }

  const decisionSha256 = suppliedDigest ?? recordDigest;
  if (decisionSha256 === undefined) {
    throw new Error("Bootstrap governance decision digest is unavailable.");
  }
  const computedDecisionSha256 =
    memoryMembershipManagementBootstrapDecisionSha256V1(coordinates);
  if (decisionSha256 !== computedDecisionSha256) {
    throw new Error(
      "Bootstrap governance decisionSha256 does not match its canonical preimage.",
    );
  }

  return Object.freeze({
    decisionSha256,
    computedDecisionSha256,
    matches: true as const,
  });
}

/**
 * Proves only tenant, decision-ID, decision-digest, and half-open-window
 * equality between one attestation and one held decision. It deliberately does
 * not prove key trust, signature validity, human independence, same-tenant
 * authority, or that databaseIdentityId names one physical database instance.
 */
export function assertMemoryMembershipManagementBootstrapAttestationDecisionBindingV1(
  decisionValue: unknown,
  attestationValue: unknown,
): MemoryMembershipManagementBootstrapAttestationDecisionBindingV1 {
  const decision =
    parseMemoryMembershipManagementBootstrapDecisionRecordV1(decisionValue);
  const attestation =
    parseMemoryMembershipManagementBootstrapAttestationRecordV1(
      attestationValue,
    );

  assertCoordinateEqual(decision, attestation, "tenantId");
  assertCoordinateEqual(decision, attestation, "governanceDecisionId");
  assertCoordinateEqual(decision, attestation, "decisionSha256");

  const attestedAt = Date.parse(attestation.attestedAt);
  if (
    attestedAt < Date.parse(decision.notBefore) ||
    attestedAt >= Date.parse(decision.expiresAt)
  ) {
    throw new Error(
      "Bootstrap governance attestation is outside the decision's half-open validity window.",
    );
  }

  return Object.freeze({
    tenantId: decision.tenantId,
    governanceDecisionId: decision.governanceDecisionId,
    decisionSha256: decision.decisionSha256,
    notBefore: decision.notBefore,
    expiresAt: decision.expiresAt,
    attesterSlot: attestation.attesterSlot,
    attestedAt: attestation.attestedAt,
  });
}

/**
 * Builds an exactly two-slot, stable-order, deeply frozen evidence bundle.
 * Structural completion is not governance approval: this helper neither
 * resolves keys nor verifies signatures, authority, or human independence.
 */
export function buildMemoryMembershipManagementBootstrapAttestationBundleV1(
  decisionValue: unknown,
  attestationValues: unknown,
): MemoryMembershipManagementBootstrapAttestationBundleV1 {
  const decision =
    parseMemoryMembershipManagementBootstrapDecisionRecordV1(decisionValue);
  const values = z.array(z.unknown()).length(2).parse(attestationValues);
  const attestations = values.map((value) => {
    const attestation =
      parseMemoryMembershipManagementBootstrapAttestationRecordV1(value);
    assertMemoryMembershipManagementBootstrapAttestationDecisionBindingV1(
      decision,
      attestation,
    );
    return attestation;
  });
  const slotRank = new Map(
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS.map(
      (slot, index) => [slot, index] as const,
    ),
  );
  attestations.sort(
    (left, right) =>
      (slotRank.get(left.attesterSlot) ?? Number.MAX_SAFE_INTEGER) -
      (slotRank.get(right.attesterSlot) ?? Number.MAX_SAFE_INTEGER),
  );

  return parseMemoryMembershipManagementBootstrapAttestationBundleV1(
    decision,
    {
      schemaVersion:
        MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTATION_BUNDLE_SCHEMA_VERSION,
      tenantId: decision.tenantId,
      governanceDecisionId: decision.governanceDecisionId,
      decisionSha256: decision.decisionSha256,
      attestations,
    },
  );
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function requireBoundedValidityWindow(
  value: { notBefore: string; expiresAt: string },
  context: z.RefinementCtx,
) {
  const notBefore = Date.parse(value.notBefore);
  const expiresAt = Date.parse(value.expiresAt);

  if (expiresAt <= notBefore) {
    context.addIssue({
      code: "custom",
      message: "Validity window must be nonempty.",
      path: ["expiresAt"],
    });
  } else if (
    expiresAt - notBefore >
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_MAX_VALIDITY_WINDOW_MS
  ) {
    context.addIssue({
      code: "custom",
      message: "Validity window cannot exceed 15 minutes.",
      path: ["expiresAt"],
    });
  }
}

function requireDecisionRecordWindow(
  value: { notBefore: string; expiresAt: string; recordedAt: string },
  context: z.RefinementCtx,
) {
  requireBoundedValidityWindow(value, context);

  const recordedAt = Date.parse(value.recordedAt);
  if (
    recordedAt < Date.parse(value.notBefore) ||
    recordedAt >= Date.parse(value.expiresAt)
  ) {
    context.addIssue({
      code: "custom",
      message: "recordedAt must fall inside the half-open validity window.",
      path: ["recordedAt"],
    });
  }
}

function requireCanonicalAttestationBundle(
  bundle: {
    schemaVersion: 1;
    tenantId: string;
    governanceDecisionId: string;
    decisionSha256: string;
    attestations: [
      MemoryMembershipManagementBootstrapAttestationRecordV1,
      MemoryMembershipManagementBootstrapAttestationRecordV1,
    ];
  },
  context: z.RefinementCtx,
) {
  const [custodian, reviewer] = bundle.attestations;

  if (
    custodian.attesterSlot !==
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS[0]
  ) {
    context.addIssue({
      code: "custom",
      message: "The organization custodian attestation must be first.",
      path: ["attestations", 0, "attesterSlot"],
    });
  }
  if (
    reviewer.attesterSlot !==
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS[1]
  ) {
    context.addIssue({
      code: "custom",
      message: "The independent reviewer attestation must be second.",
      path: ["attestations", 1, "attesterSlot"],
    });
  }
  if (custodian.attesterKeyId === reviewer.attesterKeyId) {
    context.addIssue({
      code: "custom",
      message: "The two attester slots must use distinct key IDs.",
      path: ["attestations", 1, "attesterKeyId"],
    });
  }

  for (const [index, attestation] of bundle.attestations.entries()) {
    for (const field of [
      "tenantId",
      "governanceDecisionId",
      "decisionSha256",
    ] as const) {
      if (attestation[field] !== bundle[field]) {
        context.addIssue({
          code: "custom",
          message: `Attestation does not match bundle ${field}.`,
          path: ["attestations", index, field],
        });
      }
    }
  }
}

function parseSignedDecisionCoordinates(
  value: unknown,
): MemoryMembershipManagementBootstrapDecisionSignedCoordinatesV1 {
  const recordResult =
    memoryMembershipManagementBootstrapDecisionRecordV1Schema.safeParse(value);
  return recordResult.success
    ? pickSignedDecisionCoordinates(recordResult.data)
    : memoryMembershipManagementBootstrapDecisionSignedCoordinatesV1Schema.parse(
        value,
      );
}

function pickSignedDecisionCoordinates(
  record: MemoryMembershipManagementBootstrapDecisionRecordV1,
): MemoryMembershipManagementBootstrapDecisionSignedCoordinatesV1 {
  return memoryMembershipManagementBootstrapDecisionSignedCoordinatesV1Schema.parse(
    {
      governanceDecisionId: record.governanceDecisionId,
      databaseIdentityId: record.databaseIdentityId,
      tenantId: record.tenantId,
      subjectActorId: record.subjectActorId,
      granteeActorId: record.granteeActorId,
      managementAuthorityId: record.managementAuthorityId,
      authorityGeneration: record.authorityGeneration,
      decisionAction: record.decisionAction,
      ceremonyPolicyId: record.ceremonyPolicyId,
      ceremonyPolicyVersion: record.ceremonyPolicyVersion,
      trustManifestSha256: record.trustManifestSha256,
      decisionNonceSha256: record.decisionNonceSha256,
      evidenceSha256: record.evidenceSha256,
      notBefore: record.notBefore,
      expiresAt: record.expiresAt,
    },
  );
}

function writeUint32Be(
  output: Uint8Array,
  offset: number,
  value: number,
): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("Canonical frame length is outside uint32 range.");
  }
  new DataView(output.buffer, output.byteOffset + offset, 4).setUint32(
    0,
    value,
    false,
  );
  return offset + 4;
}

function assertCoordinateEqual<
  TField extends "tenantId" | "governanceDecisionId" | "decisionSha256",
>(
  decision: Pick<
    MemoryMembershipManagementBootstrapDecisionRecordV1,
    TField
  >,
  attestation: Pick<
    MemoryMembershipManagementBootstrapAttestationRecordV1,
    TField
  >,
  field: TField,
) {
  if (decision[field] !== attestation[field]) {
    throw new Error(
      `Bootstrap governance attestation binding mismatch at ${field}.`,
    );
  }
}

function freezeFlat<T extends Record<string, unknown>>(value: T): T {
  return Object.freeze({ ...value }) as T;
}
