import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

import { z } from "zod";

import {
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS,
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_ACTION,
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_SIGNATURE_ALGORITHM,
  assertMemoryMembershipManagementBootstrapDecisionSha256V1,
  canonicalMemoryMembershipManagementBootstrapDecisionPreimageV1,
  memoryMembershipManagementBootstrapCanonicalTimestampSchema,
  memoryMembershipManagementBootstrapDatabaseIdentityIdSchema,
  memoryMembershipManagementBootstrapLowercaseSha256Schema,
  parseMemoryMembershipManagementBootstrapAttestationBundleV1,
  parseMemoryMembershipManagementBootstrapDecisionRecordV1,
} from "@/lib/memory/bootstrap-governance-contracts";

export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_SCHEMA_VERSION =
  1 as const;
export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_PREIMAGE_DOMAIN =
  "asael.memory.membership_management_bootstrap_trust_manifest" as const;
export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_PREIMAGE_VERSION =
  1 as const;
export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_GOVERNANCE_VERIFICATION_SCHEMA_VERSION =
  1 as const;

/**
 * Null key revocation timestamps are encoded as the literal `null`. The
 * timestamp schema cannot produce that value, so the representation is
 * unambiguous inside the length-delimited frame.
 */
const NULL_REVOCATION_PREIMAGE_VALUE = "null" as const;

export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_PREIMAGE_FIELD_ORDER =
  Object.freeze([
    "schemaVersion",
    "manifestId",
    "manifestRevision",
    "logicalDatabaseIdentityId",
    "tenantId",
    "decisionAction",
    "ceremonyPolicyId",
    "ceremonyPolicyVersion",
    "issuedAt",
    "notBefore",
    "expiresAt",
    "keys.0.attesterSlot",
    "keys.0.attesterKeyId",
    "keys.0.controllerActorId",
    "keys.0.signatureAlgorithm",
    "keys.0.publicKeyBase64url",
    "keys.0.notBefore",
    "keys.0.expiresAt",
    "keys.0.revokedAt",
    "keys.1.attesterSlot",
    "keys.1.attesterKeyId",
    "keys.1.controllerActorId",
    "keys.1.signatureAlgorithm",
    "keys.1.publicKeyBase64url",
    "keys.1.notBefore",
    "keys.1.expiresAt",
    "keys.1.revokedAt",
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

const positiveSafeIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

const positiveSmallintSchema = z.number().int().min(1).max(32_767);

const requiredUnknownSchema = z.unknown().refine((value) => value !== undefined, {
  message: "Expected a required verifier input value.",
});

const canonicalRawEd25519PublicKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/,
    "Expected a canonical 43-character unpadded base64url Ed25519 public key.",
  )
  .refine(isCanonicalRawEd25519PublicKey, {
    message: "Expected an exact raw 32-byte Ed25519 public key.",
  });

const trustManifestKeyShape = {
  attesterKeyId: opaqueIdSchema,
  controllerActorId: canonicalActorIdSchema,
  signatureAlgorithm: z.literal(
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_SIGNATURE_ALGORITHM,
  ),
  publicKeyBase64url: canonicalRawEd25519PublicKeySchema,
  notBefore: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
  expiresAt: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
  revokedAt:
    memoryMembershipManagementBootstrapCanonicalTimestampSchema.nullable(),
};

const organizationCustodianTrustManifestKeyV1Schema = z
  .object({
    attesterSlot: z.literal(
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS[0],
    ),
    ...trustManifestKeyShape,
  })
  .strict()
  .superRefine(requireValidTrustManifestKeyWindow);

const independentReviewerTrustManifestKeyV1Schema = z
  .object({
    attesterSlot: z.literal(
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS[1],
    ),
    ...trustManifestKeyShape,
  })
  .strict()
  .superRefine(requireValidTrustManifestKeyWindow);

export const memoryMembershipManagementBootstrapTrustManifestV1Schema = z
  .object({
    schemaVersion: z.literal(
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_SCHEMA_VERSION,
    ),
    manifestId: opaqueIdSchema,
    manifestRevision: positiveSafeIntegerSchema,
    logicalDatabaseIdentityId:
      memoryMembershipManagementBootstrapDatabaseIdentityIdSchema,
    tenantId: opaqueIdSchema,
    decisionAction: z.literal(
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_ACTION,
    ),
    ceremonyPolicyId: opaqueIdSchema,
    ceremonyPolicyVersion: positiveSmallintSchema,
    issuedAt: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
    notBefore: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
    expiresAt: memoryMembershipManagementBootstrapCanonicalTimestampSchema,
    keys: z.tuple([
      organizationCustodianTrustManifestKeyV1Schema,
      independentReviewerTrustManifestKeyV1Schema,
    ]),
  })
  .strict()
  .superRefine(requireValidTrustManifest);

export const memoryMembershipManagementBootstrapGovernanceVerifierInputV1Schema =
  z
    .object({
      expectedLogicalDatabaseIdentityId:
        memoryMembershipManagementBootstrapDatabaseIdentityIdSchema,
      trustedManifestSha256:
        memoryMembershipManagementBootstrapLowercaseSha256Schema,
      observedAt:
        memoryMembershipManagementBootstrapCanonicalTimestampSchema,
      decision: requiredUnknownSchema,
      attestationBundle: requiredUnknownSchema,
      trustManifest: requiredUnknownSchema,
    })
    .strict();

export type MemoryMembershipManagementBootstrapTrustManifestKeyV1 = Readonly<{
  attesterSlot:
    (typeof MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS)[number];
  attesterKeyId: string;
  controllerActorId: string;
  signatureAlgorithm: typeof MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_SIGNATURE_ALGORITHM;
  publicKeyBase64url: string;
  notBefore: string;
  expiresAt: string;
  revokedAt: string | null;
}>;

export type MemoryMembershipManagementBootstrapTrustManifestV1 = Readonly<{
  schemaVersion: typeof MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_SCHEMA_VERSION;
  manifestId: string;
  manifestRevision: number;
  logicalDatabaseIdentityId: string;
  tenantId: string;
  decisionAction: typeof MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_ACTION;
  ceremonyPolicyId: string;
  ceremonyPolicyVersion: number;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  keys: readonly [
    MemoryMembershipManagementBootstrapTrustManifestKeyV1,
    MemoryMembershipManagementBootstrapTrustManifestKeyV1,
  ];
}>;

export type MemoryMembershipManagementBootstrapVerifiedAttestationEvidenceV1 =
  Readonly<{
    attesterSlot:
      (typeof MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS)[number];
    attesterKeyId: string;
    controllerActorId: string;
    attestedAt: string;
    publicKeySha256: string;
    signatureValid: true;
  }>;

export type MemoryMembershipManagementBootstrapGovernanceVerificationV1 =
  Readonly<{
    schemaVersion:
      typeof MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_GOVERNANCE_VERIFICATION_SCHEMA_VERSION;
    verificationKind: "offline_external_trust_manifest_v1";
    logicalDatabaseIdentityId: string;
    tenantId: string;
    governanceDecisionId: string;
    decisionSha256: string;
    subjectActorId: string;
    granteeActorId: string;
    managementAuthorityId: string;
    authorityGeneration: number;
    decisionAction: typeof MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_ACTION;
    ceremonyPolicyId: string;
    ceremonyPolicyVersion: number;
    trustManifestId: string;
    trustManifestRevision: number;
    trustManifestSha256: string;
    trustManifestIssuedAt: string;
    observedAt: string;
    manifestDigestBound: true;
    decisionDigestValid: true;
    attestations: readonly [
      MemoryMembershipManagementBootstrapVerifiedAttestationEvidenceV1,
      MemoryMembershipManagementBootstrapVerifiedAttestationEvidenceV1,
    ];
    authorityGranted: false;
    runtimeAccepted: false;
  }>;

/**
 * Parses and deeply freezes one external manifest. Public keys in this parsed
 * input are verification material, not repository-owned or runtime-registered
 * trust roots.
 */
export function parseMemoryMembershipManagementBootstrapTrustManifestV1(
  value: unknown,
): MemoryMembershipManagementBootstrapTrustManifestV1 {
  const parsed =
    memoryMembershipManagementBootstrapTrustManifestV1Schema.parse(value);
  const keys = Object.freeze([
    freezeFlat(parsed.keys[0]),
    freezeFlat(parsed.keys[1]),
  ]) as readonly [
    MemoryMembershipManagementBootstrapTrustManifestKeyV1,
    MemoryMembershipManagementBootstrapTrustManifestKeyV1,
  ];

  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    manifestId: parsed.manifestId,
    manifestRevision: parsed.manifestRevision,
    logicalDatabaseIdentityId: parsed.logicalDatabaseIdentityId,
    tenantId: parsed.tenantId,
    decisionAction: parsed.decisionAction,
    ceremonyPolicyId: parsed.ceremonyPolicyId,
    ceremonyPolicyVersion: parsed.ceremonyPolicyVersion,
    issuedAt: parsed.issuedAt,
    notBefore: parsed.notBefore,
    expiresAt: parsed.expiresAt,
    keys,
  });
}

/**
 * Canonically frames every trust-manifest coordinate. Object property order is
 * irrelevant and JSON serialization is never part of this protocol.
 */
export function canonicalMemoryMembershipManagementBootstrapTrustManifestPreimageV1(
  value: unknown,
): Uint8Array {
  const manifest =
    parseMemoryMembershipManagementBootstrapTrustManifestV1(value);
  const coordinateValues = trustManifestPreimageCoordinateValues(manifest);
  const encoder = new TextEncoder();
  const domainBytes = encoder.encode(
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_PREIMAGE_DOMAIN,
  );
  const fields =
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_PREIMAGE_FIELD_ORDER.map(
      (fieldName) => ({
        nameBytes: encoder.encode(fieldName),
        valueBytes: encoder.encode(coordinateValues[fieldName]),
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
    MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_PREIMAGE_VERSION,
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
    throw new Error(
      "Bootstrap governance trust-manifest preimage framing failed.",
    );
  }

  return output;
}

export function memoryMembershipManagementBootstrapTrustManifestSha256V1(
  value: unknown,
): string {
  return createHash("sha256")
    .update(
      canonicalMemoryMembershipManagementBootstrapTrustManifestPreimageV1(
        value,
      ),
    )
    .digest("hex");
}

/**
 * Pure offline verification of one v1 bootstrap-governance evidence bundle.
 *
 * Security limits are intentional and part of the contract:
 * - `observedAt` is caller-asserted; this function has no trusted clock.
 * - the supplied manifest digest must be independently anchored, current, and
 *   rollback-protected by the caller; a matching self-supplied digest is not a
 *   trust root.
 * - each Ed25519 signature covers only the exact canonical decision preimage;
 *   `attestedAt` remains unsigned and does not prove when signing occurred.
 * - distinct key bytes, key IDs, and controller actor IDs do not prove two
 *   independent humans.
 * - the logical database identity survives restore and cannot prevent replay
 *   into a clone by itself.
 * - successful verification grants no authority and cannot activate runtime
 *   behavior. There is no writer, registry, clock, network, environment, or
 *   serving integration in this module.
 */
export function verifyMemoryMembershipManagementBootstrapGovernanceV1(
  value: unknown,
): MemoryMembershipManagementBootstrapGovernanceVerificationV1 {
  const input =
    memoryMembershipManagementBootstrapGovernanceVerifierInputV1Schema.parse(
      value,
    );
  const decision =
    parseMemoryMembershipManagementBootstrapDecisionRecordV1(input.decision);
  assertMemoryMembershipManagementBootstrapDecisionSha256V1(decision);
  const attestationBundle =
    parseMemoryMembershipManagementBootstrapAttestationBundleV1(
      decision,
      input.attestationBundle,
    );
  const trustManifest =
    parseMemoryMembershipManagementBootstrapTrustManifestV1(
      input.trustManifest,
    );

  const computedManifestSha256 =
    memoryMembershipManagementBootstrapTrustManifestSha256V1(trustManifest);
  const computedMatchesTrusted = constantTimeSha256Equal(
    computedManifestSha256,
    input.trustedManifestSha256,
  );
  const trustedMatchesDecision = constantTimeSha256Equal(
    input.trustedManifestSha256,
    decision.trustManifestSha256,
  );
  if (!computedMatchesTrusted || !trustedMatchesDecision) {
    throw new Error(
      "Bootstrap governance trust-manifest digest binding failed.",
    );
  }

  requireCoordinateEqual(
    "expected logical database identity",
    input.expectedLogicalDatabaseIdentityId,
    decision.databaseIdentityId,
  );
  requireCoordinateEqual(
    "manifest logical database identity",
    trustManifest.logicalDatabaseIdentityId,
    decision.databaseIdentityId,
  );
  requireCoordinateEqual(
    "manifest tenant",
    trustManifest.tenantId,
    decision.tenantId,
  );
  requireCoordinateEqual(
    "manifest decision action",
    trustManifest.decisionAction,
    decision.decisionAction,
  );
  requireCoordinateEqual(
    "manifest ceremony policy ID",
    trustManifest.ceremonyPolicyId,
    decision.ceremonyPolicyId,
  );
  requireCoordinateEqual(
    "manifest ceremony policy version",
    trustManifest.ceremonyPolicyVersion,
    decision.ceremonyPolicyVersion,
  );

  requireWindowCoversDecision(
    "trust manifest",
    trustManifest.notBefore,
    trustManifest.expiresAt,
    decision,
  );
  for (const [index, key] of trustManifest.keys.entries()) {
    requireWindowCoversDecision(
      `trust-manifest key ${index}`,
      key.notBefore,
      key.expiresAt,
      decision,
    );
    if (
      key.revokedAt !== null &&
      Date.parse(key.revokedAt) < Date.parse(decision.expiresAt)
    ) {
      throw new Error(
        `Bootstrap governance trust-manifest key ${index} revokes before the decision expires.`,
      );
    }
  }

  requireInsideHalfOpenWindow(
    "observedAt decision",
    input.observedAt,
    decision.notBefore,
    decision.expiresAt,
  );
  requireInsideHalfOpenWindow(
    "observedAt trust manifest",
    input.observedAt,
    trustManifest.notBefore,
    trustManifest.expiresAt,
  );
  requireTimestampAtOrAfter(
    "observedAt decision recordedAt",
    input.observedAt,
    decision.recordedAt,
  );

  const decisionPreimage =
    canonicalMemoryMembershipManagementBootstrapDecisionPreimageV1(decision);
  const signatureValidity: boolean[] = [];

  for (const [index, key] of trustManifest.keys.entries()) {
    const attestation = attestationBundle.attestations[index];
    requireCoordinateEqual(
      `attestation ${index} slot`,
      attestation.attesterSlot,
      key.attesterSlot,
    );
    requireCoordinateEqual(
      `attestation ${index} key ID`,
      attestation.attesterKeyId,
      key.attesterKeyId,
    );
    requireTimestampAtOrAfter(
      `observedAt attestation ${index}`,
      input.observedAt,
      attestation.attestedAt,
    );
    requireKeyActiveAt(key, attestation.attestedAt, `attestation ${index}`);
    requireKeyActiveAt(key, input.observedAt, `observation ${index}`);
    signatureValidity.push(
      verifyDetachedEd25519(
        decisionPreimage,
        attestation.signatureBase64url,
        key.publicKeyBase64url,
      ),
    );
  }

  if (!signatureValidity.every((valid) => valid)) {
    throw new Error("Bootstrap governance Ed25519 verification failed.");
  }

  const attestations = Object.freeze([
    verifiedAttestationEvidence(
      trustManifest.keys[0],
      attestationBundle.attestations[0].attestedAt,
    ),
    verifiedAttestationEvidence(
      trustManifest.keys[1],
      attestationBundle.attestations[1].attestedAt,
    ),
  ]) as readonly [
    MemoryMembershipManagementBootstrapVerifiedAttestationEvidenceV1,
    MemoryMembershipManagementBootstrapVerifiedAttestationEvidenceV1,
  ];

  return Object.freeze({
    schemaVersion:
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_GOVERNANCE_VERIFICATION_SCHEMA_VERSION,
    verificationKind: "offline_external_trust_manifest_v1" as const,
    logicalDatabaseIdentityId: decision.databaseIdentityId,
    tenantId: decision.tenantId,
    governanceDecisionId: decision.governanceDecisionId,
    decisionSha256: decision.decisionSha256,
    subjectActorId: decision.subjectActorId,
    granteeActorId: decision.granteeActorId,
    managementAuthorityId: decision.managementAuthorityId,
    authorityGeneration: decision.authorityGeneration,
    decisionAction: decision.decisionAction,
    ceremonyPolicyId: decision.ceremonyPolicyId,
    ceremonyPolicyVersion: decision.ceremonyPolicyVersion,
    trustManifestId: trustManifest.manifestId,
    trustManifestRevision: trustManifest.manifestRevision,
    trustManifestSha256: computedManifestSha256,
    trustManifestIssuedAt: trustManifest.issuedAt,
    observedAt: input.observedAt,
    manifestDigestBound: true as const,
    decisionDigestValid: true as const,
    attestations,
    authorityGranted: false as const,
    runtimeAccepted: false as const,
  });
}

function requireValidTrustManifest(
  manifest: {
    issuedAt: string;
    notBefore: string;
    expiresAt: string;
    keys: readonly [
      MemoryMembershipManagementBootstrapTrustManifestKeyV1,
      MemoryMembershipManagementBootstrapTrustManifestKeyV1,
    ];
  },
  context: z.RefinementCtx,
) {
  const issuedAt = Date.parse(manifest.issuedAt);
  const notBefore = Date.parse(manifest.notBefore);
  const expiresAt = Date.parse(manifest.expiresAt);

  if (issuedAt > notBefore) {
    context.addIssue({
      code: "custom",
      message: "Trust manifest issuedAt must not follow notBefore.",
      path: ["issuedAt"],
    });
  }
  if (expiresAt <= notBefore) {
    context.addIssue({
      code: "custom",
      message: "Trust manifest validity window must be nonempty.",
      path: ["expiresAt"],
    });
  }

  const [custodian, reviewer] = manifest.keys;
  if (custodian.attesterKeyId === reviewer.attesterKeyId) {
    context.addIssue({
      code: "custom",
      message: "Trust manifest key IDs must be distinct.",
      path: ["keys", 1, "attesterKeyId"],
    });
  }
  if (custodian.controllerActorId === reviewer.controllerActorId) {
    context.addIssue({
      code: "custom",
      message: "Trust manifest controller actor IDs must be distinct.",
      path: ["keys", 1, "controllerActorId"],
    });
  }
  if (custodian.publicKeyBase64url === reviewer.publicKeyBase64url) {
    context.addIssue({
      code: "custom",
      message: "Trust manifest public keys must be distinct.",
      path: ["keys", 1, "publicKeyBase64url"],
    });
  }
}

function requireValidTrustManifestKeyWindow(
  key: { notBefore: string; expiresAt: string; revokedAt: string | null },
  context: z.RefinementCtx,
) {
  const notBefore = Date.parse(key.notBefore);
  const expiresAt = Date.parse(key.expiresAt);

  if (expiresAt <= notBefore) {
    context.addIssue({
      code: "custom",
      message: "Trust-manifest key validity window must be nonempty.",
      path: ["expiresAt"],
    });
  }
  if (key.revokedAt !== null) {
    const revokedAt = Date.parse(key.revokedAt);
    if (revokedAt < notBefore || revokedAt >= expiresAt) {
      context.addIssue({
        code: "custom",
        message: "Trust-manifest key revokedAt must fall inside its window.",
        path: ["revokedAt"],
      });
    }
  }
}

function trustManifestPreimageCoordinateValues(
  manifest: MemoryMembershipManagementBootstrapTrustManifestV1,
): Record<
  (typeof MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_PREIMAGE_FIELD_ORDER)[number],
  string
> {
  const [custodian, reviewer] = manifest.keys;

  return {
    schemaVersion: String(manifest.schemaVersion),
    manifestId: manifest.manifestId,
    manifestRevision: String(manifest.manifestRevision),
    logicalDatabaseIdentityId: manifest.logicalDatabaseIdentityId,
    tenantId: manifest.tenantId,
    decisionAction: manifest.decisionAction,
    ceremonyPolicyId: manifest.ceremonyPolicyId,
    ceremonyPolicyVersion: String(manifest.ceremonyPolicyVersion),
    issuedAt: manifest.issuedAt,
    notBefore: manifest.notBefore,
    expiresAt: manifest.expiresAt,
    "keys.0.attesterSlot": custodian.attesterSlot,
    "keys.0.attesterKeyId": custodian.attesterKeyId,
    "keys.0.controllerActorId": custodian.controllerActorId,
    "keys.0.signatureAlgorithm": custodian.signatureAlgorithm,
    "keys.0.publicKeyBase64url": custodian.publicKeyBase64url,
    "keys.0.notBefore": custodian.notBefore,
    "keys.0.expiresAt": custodian.expiresAt,
    "keys.0.revokedAt":
      custodian.revokedAt ?? NULL_REVOCATION_PREIMAGE_VALUE,
    "keys.1.attesterSlot": reviewer.attesterSlot,
    "keys.1.attesterKeyId": reviewer.attesterKeyId,
    "keys.1.controllerActorId": reviewer.controllerActorId,
    "keys.1.signatureAlgorithm": reviewer.signatureAlgorithm,
    "keys.1.publicKeyBase64url": reviewer.publicKeyBase64url,
    "keys.1.notBefore": reviewer.notBefore,
    "keys.1.expiresAt": reviewer.expiresAt,
    "keys.1.revokedAt": reviewer.revokedAt ?? NULL_REVOCATION_PREIMAGE_VALUE,
  };
}

function requireInsideHalfOpenWindow(
  label: string,
  timestamp: string,
  notBefore: string,
  expiresAt: string,
) {
  const instant = Date.parse(timestamp);
  if (instant < Date.parse(notBefore) || instant >= Date.parse(expiresAt)) {
    throw new Error(`${label} is outside its half-open validity window.`);
  }
}

function requireWindowCoversDecision(
  label: string,
  notBefore: string,
  expiresAt: string,
  decision: Readonly<{ notBefore: string; expiresAt: string }>,
) {
  if (
    Date.parse(notBefore) > Date.parse(decision.notBefore) ||
    Date.parse(expiresAt) < Date.parse(decision.expiresAt)
  ) {
    throw new Error(
      `Bootstrap governance ${label} does not cover the full decision window.`,
    );
  }
}

function requireTimestampAtOrAfter(
  label: string,
  timestamp: string,
  lowerBound: string,
) {
  if (Date.parse(timestamp) < Date.parse(lowerBound)) {
    throw new Error(`${label} ordering is invalid.`);
  }
}

function requireKeyActiveAt(
  key: MemoryMembershipManagementBootstrapTrustManifestKeyV1,
  timestamp: string,
  label: string,
) {
  requireInsideHalfOpenWindow(
    `${label} key`,
    timestamp,
    key.notBefore,
    key.expiresAt,
  );
  if (
    key.revokedAt !== null &&
    Date.parse(key.revokedAt) <= Date.parse(timestamp)
  ) {
    throw new Error(`${label} key is revoked.`);
  }
}

function requireCoordinateEqual(
  label: string,
  actual: string | number,
  expected: string | number,
) {
  if (actual !== expected) {
    throw new Error(`Bootstrap governance ${label} binding failed.`);
  }
}

function isCanonicalRawEd25519PublicKey(value: string): boolean {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === 32 && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function verifyDetachedEd25519(
  message: Uint8Array,
  signatureBase64url: string,
  publicKeyBase64url: string,
): boolean {
  try {
    const rawPublicKey = Buffer.from(publicKeyBase64url, "base64url");
    const subjectPublicKeyInfo = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      rawPublicKey,
    ]);
    const publicKey = createPublicKey({
      key: subjectPublicKeyInfo,
      format: "der",
      type: "spki",
    });
    if (
      publicKey.type !== "public" ||
      publicKey.asymmetricKeyType !== "ed25519"
    ) {
      return false;
    }
    return verifySignature(
      null,
      message,
      publicKey,
      Buffer.from(signatureBase64url, "base64url"),
    );
  } catch {
    return false;
  }
}

function verifiedAttestationEvidence(
  key: MemoryMembershipManagementBootstrapTrustManifestKeyV1,
  attestedAt: string,
): MemoryMembershipManagementBootstrapVerifiedAttestationEvidenceV1 {
  return Object.freeze({
    attesterSlot: key.attesterSlot,
    attesterKeyId: key.attesterKeyId,
    controllerActorId: key.controllerActorId,
    attestedAt,
    publicKeySha256: sha256Base64urlBytes(key.publicKeyBase64url),
    signatureValid: true as const,
  });
}

function sha256Base64urlBytes(value: string): string {
  return createHash("sha256")
    .update(Buffer.from(value, "base64url"))
    .digest("hex");
}

function constantTimeSha256Equal(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.byteLength === 32 &&
    rightBytes.byteLength === 32 &&
    timingSafeEqual(leftBytes, rightBytes)
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

function freezeFlat<T extends Record<string, unknown>>(value: T): T {
  return Object.freeze({ ...value }) as T;
}
