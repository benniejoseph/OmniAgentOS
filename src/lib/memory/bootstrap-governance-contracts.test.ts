import { describe, expect, it } from "vitest";

import {
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS,
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_ACTION,
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_PREIMAGE_DOMAIN,
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_PREIMAGE_FIELD_ORDER,
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_PREIMAGE_VERSION,
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_SIGNATURE_MESSAGE,
  assertMemoryMembershipManagementBootstrapAttestationDecisionBindingV1,
  assertMemoryMembershipManagementBootstrapDecisionSha256V1,
  buildMemoryMembershipManagementBootstrapAttestationBundleV1,
  buildMemoryMembershipManagementBootstrapAttestationRecordV1,
  buildMemoryMembershipManagementBootstrapDecisionRecordV1,
  buildMemoryMembershipManagementBootstrapDecisionRecordWithComputedSha256V1,
  canonicalMemoryMembershipManagementBootstrapDecisionPreimageV1,
  memoryMembershipManagementBootstrapAttestationRecordV1Schema,
  memoryMembershipManagementBootstrapDecisionRecordV1Schema,
  memoryMembershipManagementBootstrapDecisionSha256V1,
  parseMemoryMembershipManagementBootstrapAttestationBundleV1,
  parseMemoryMembershipManagementBootstrapAttestationRecordV1,
  parseMemoryMembershipManagementBootstrapDecisionRecordV1,
  type MemoryMembershipManagementBootstrapAttestationRecordV1,
  type MemoryMembershipManagementBootstrapDecisionRecordV1,
  type MemoryMembershipManagementBootstrapDecisionSignedCoordinatesV1,
} from "@/lib/memory/bootstrap-governance-contracts";

const NOT_BEFORE = "2026-09-05T09:30:00.000Z";
const EXPIRES_AT = "2026-09-05T09:45:00.000Z";
const RECORDED_AT = "2026-09-05T09:30:01.000Z";
const ATTESTED_AT = "2026-09-05T09:31:00.000Z";
const DATABASE_IDENTITY_ID = "0123456789abcdef0123456789abcdef";
const SUBJECT_ACTOR_ID = "actor:11111111-1111-4111-8111-111111111111";
const GRANTEE_ACTOR_ID = "actor:22222222-2222-4222-8222-222222222222";
const RECORDER_ACTOR_ID = "actor:33333333-3333-4333-8333-333333333333";
const OTHER_SUBJECT_ACTOR_ID =
  "actor:44444444-4444-4444-8444-444444444444";
const OTHER_GRANTEE_ACTOR_ID =
  "actor:55555555-5555-4555-8555-555555555555";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SIGNATURE_A = "A".repeat(86);
const SIGNATURE_B = `${"B".repeat(85)}Q`;
const EXPECTED_PREIMAGE_BASE64URL = [
  "AAAANWFzYWVsLm1lbW9yeS5tZW1iZXJzaGlwX21hbmFnZW1lbnRfYm9vdHN0cmFwX2RlY2lzaW9uAAAAAQAAAA8AAAAUZ292",
  "ZXJuYW5jZURlY2lzaW9uSWQAAAAfZ292ZXJuYW5jZS1kZWNpc2lvbjpib290c3RyYXAtMQAAABJkYXRhYmFzZUlkZW50aXR5",
  "SWQAAAAgMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYAAAAIdGVuYW50SWQAAAAVdGVuYW50OmJvb3RzdHJhcC10",
  "ZXN0AAAADnN1YmplY3RBY3RvcklkAAAAKmFjdG9yOjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMQAAAA5n",
  "cmFudGVlQWN0b3JJZAAAACphY3RvcjoyMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIAAAAVbWFuYWdlbWVu",
  "dEF1dGhvcml0eUlkAAAAIG1lbWJlcnNoaXAtYXV0aG9yaXR5OmJvb3RzdHJhcC0xAAAAE2F1dGhvcml0eUdlbmVyYXRpb24A",
  "AAABNwAAAA5kZWNpc2lvbkFjdGlvbgAAACtjcmVhdGVfaGVsZF9tZW1iZXJzaGlwX21hbmFnZW1lbnRfYXV0aG9yaXR5AAAA",
  "EGNlcmVtb255UG9saWN5SWQAAAAkY2VyZW1vbnktcG9saWN5Om1lbWJlcnNoaXAtYm9vdHN0cmFwAAAAFWNlcmVtb255UG9s",
  "aWN5VmVyc2lvbgAAAAEzAAAAE3RydXN0TWFuaWZlc3RTaGEyNTYAAABAYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh",
  "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQAAABNkZWNpc2lvbk5vbmNlU2hhMjU2AAAAQGJiYmJiYmJiYmJi",
  "YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmIAAAAOZXZpZGVuY2VTaGEyNTYA",
  "AABAY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjYwAAAAlu",
  "b3RCZWZvcmUAAAAYMjAyNi0wOS0wNVQwOTozMDowMC4wMDBaAAAACWV4cGlyZXNBdAAAABgyMDI2LTA5LTA1VDA5OjQ1OjAw",
  "LjAwMFo",
].join("");
const EXPECTED_PREIMAGE_SHA256 =
  "4d8fc049199480a678d0ffdd5a33506312f2ce02ad3a052d85e3981c6f4632ef";

function signedCoordinates(): MemoryMembershipManagementBootstrapDecisionSignedCoordinatesV1 {
  return {
    governanceDecisionId: "governance-decision:bootstrap-1",
    databaseIdentityId: DATABASE_IDENTITY_ID,
    tenantId: "tenant:bootstrap-test",
    subjectActorId: SUBJECT_ACTOR_ID,
    granteeActorId: GRANTEE_ACTOR_ID,
    managementAuthorityId: "membership-authority:bootstrap-1",
    authorityGeneration: 7,
    decisionAction: MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_ACTION,
    ceremonyPolicyId: "ceremony-policy:membership-bootstrap",
    ceremonyPolicyVersion: 3,
    trustManifestSha256: SHA_A,
    decisionNonceSha256: SHA_B,
    evidenceSha256: SHA_C,
    notBefore: NOT_BEFORE,
    expiresAt: EXPIRES_AT,
  };
}

function decisionWithComputedDigest(): MemoryMembershipManagementBootstrapDecisionRecordV1 {
  const coordinates = signedCoordinates();
  return buildMemoryMembershipManagementBootstrapDecisionRecordWithComputedSha256V1(
    {
      tenantId: coordinates.tenantId,
      governanceDecisionId: coordinates.governanceDecisionId,
      databaseIdentityId: coordinates.databaseIdentityId,
      subjectActorId: coordinates.subjectActorId,
      granteeActorId: coordinates.granteeActorId,
      managementAuthorityId: coordinates.managementAuthorityId,
      authorityGeneration: coordinates.authorityGeneration,
      ceremonyPolicyId: coordinates.ceremonyPolicyId,
      ceremonyPolicyVersion: coordinates.ceremonyPolicyVersion,
      trustManifestSha256: coordinates.trustManifestSha256,
      decisionNonceSha256: coordinates.decisionNonceSha256,
      evidenceSha256: coordinates.evidenceSha256,
      notBefore: coordinates.notBefore,
      expiresAt: coordinates.expiresAt,
      recordedByActorId: RECORDER_ACTOR_ID,
      recordedAt: RECORDED_AT,
    },
  );
}

function attestation(
  decision: MemoryMembershipManagementBootstrapDecisionRecordV1,
  slot: (typeof MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS)[number],
): MemoryMembershipManagementBootstrapAttestationRecordV1 {
  const custodian = slot === "organization_custodian";
  return buildMemoryMembershipManagementBootstrapAttestationRecordV1({
    tenantId: decision.tenantId,
    governanceDecisionId: decision.governanceDecisionId,
    decisionSha256: decision.decisionSha256,
    attesterSlot: slot,
    attesterKeyId: custodian ? "key:custodian" : "key:reviewer",
    signatureBase64url: custodian ? SIGNATURE_A : SIGNATURE_B,
    attestedAt: ATTESTED_AT,
  });
}

describe("membership-management bootstrap decision contracts", () => {
  it("builds only the held revision-0 v57 record and freezes a copy", () => {
    const record = decisionWithComputedDigest();

    expect(record).toMatchObject({
      schemaVersion: 1,
      decisionAction: "create_held_membership_management_authority",
      state: "held",
      lifecycleRevision: 0,
      verifiedByActorId: null,
      verifiedAt: null,
      consumedByActorId: null,
      consumedAt: null,
      revokedByActorId: null,
      revokedAt: null,
    });
    expect(Object.isFrozen(record)).toBe(true);

    const parsed = parseMemoryMembershipManagementBootstrapDecisionRecordV1({
      ...record,
    });
    expect(parsed).not.toBe(record);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("enforces database lineage, numeric, digest, and fixed lifecycle shapes", () => {
    const record = decisionWithComputedDigest();
    const invalidValues = [
      { ...record, databaseIdentityId: "A".repeat(32) },
      { ...record, databaseIdentityId: "a".repeat(31) },
      { ...record, authorityGeneration: 0 },
      { ...record, authorityGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...record, ceremonyPolicyVersion: 0 },
      { ...record, ceremonyPolicyVersion: 32_768 },
      { ...record, subjectActorId: "person@example.test" },
      { ...record, granteeActorId: GRANTEE_ACTOR_ID.toUpperCase() },
      { ...record, recordedByActorId: "actor:recorder" },
      { ...record, evidenceSha256: "A".repeat(64) },
      { ...record, decisionAction: "activate_membership_authority" },
      { ...record, state: "active" },
      { ...record, lifecycleRevision: 1 },
      { ...record, verifiedByActorId: OTHER_SUBJECT_ACTOR_ID },
    ];

    for (const value of invalidValues) {
      expect(() =>
        parseMemoryMembershipManagementBootstrapDecisionRecordV1(value),
      ).toThrow();
    }
  });

  it("enforces canonical timestamps and the half-open 15-minute window", () => {
    const record = decisionWithComputedDigest();

    expect(() =>
      parseMemoryMembershipManagementBootstrapDecisionRecordV1({
        ...record,
        recordedAt: record.notBefore,
      }),
    ).not.toThrow();
    for (const value of [
      { ...record, expiresAt: record.notBefore },
      { ...record, expiresAt: "2026-09-05T09:45:00.001Z" },
      { ...record, recordedAt: record.expiresAt },
      { ...record, recordedAt: "2026-09-05T09:29:59.999Z" },
      { ...record, notBefore: "2026-09-05T15:00:00.000+05:30" },
      { ...record, notBefore: "2026-09-05T09:30:00Z" },
    ]) {
      expect(() =>
        parseMemoryMembershipManagementBootstrapDecisionRecordV1(value),
      ).toThrow();
    }
  });

  it("rejects extra narrative, secret, identity-role, and metadata fields", () => {
    const record = decisionWithComputedDigest();
    for (const field of [
      "approvalText",
      "credentials",
      "privateKey",
      "reasoning",
      "role",
      "email",
      "metadata",
      "rawEvidence",
    ]) {
      expect(() =>
        parseMemoryMembershipManagementBootstrapDecisionRecordV1({
          ...record,
          [field]: "forbidden",
        }),
      ).toThrow();
    }
  });

  it("uses fixed, byte-framed coordinates and returns fresh preimage bytes", () => {
    const coordinates = signedCoordinates();
    const first =
      canonicalMemoryMembershipManagementBootstrapDecisionPreimageV1(
        coordinates,
      );
    const second =
      canonicalMemoryMembershipManagementBootstrapDecisionPreimageV1(
        Object.fromEntries(Object.entries(coordinates).reverse()),
      );

    expect(first).not.toBe(second);
    expect(Array.from(first)).toEqual(Array.from(second));
    expect(first).toHaveLength(941);
    expect(Buffer.from(first).toString("base64url")).toBe(
      EXPECTED_PREIMAGE_BASE64URL,
    );
    expect(memoryMembershipManagementBootstrapDecisionSha256V1(coordinates))
      .toBe(EXPECTED_PREIMAGE_SHA256);
    expect(MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_SIGNATURE_MESSAGE).toBe(
      "canonical_decision_preimage_v1",
    );

    const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
    const domainLength = view.getUint32(0, false);
    const domain = new TextDecoder().decode(first.slice(4, 4 + domainLength));
    expect(domain).toBe(
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_PREIMAGE_DOMAIN,
    );
    expect(view.getUint32(4 + domainLength, false)).toBe(
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_PREIMAGE_VERSION,
    );
    expect(view.getUint32(8 + domainLength, false)).toBe(
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_PREIMAGE_FIELD_ORDER
        .length,
    );

    first[0] ^= 0xff;
    const third =
      canonicalMemoryMembershipManagementBootstrapDecisionPreimageV1(
        coordinates,
      );
    expect(Array.from(third)).toEqual(Array.from(second));
  });

  it("binds the digest to every signed coordinate, including decision and database IDs", () => {
    const coordinates = signedCoordinates();
    const original =
      memoryMembershipManagementBootstrapDecisionSha256V1(coordinates);
    const mutations = [
      { ...coordinates, governanceDecisionId: "governance-decision:renamed" },
      { ...coordinates, databaseIdentityId: "f".repeat(32) },
      { ...coordinates, tenantId: "tenant:other" },
      { ...coordinates, subjectActorId: OTHER_SUBJECT_ACTOR_ID },
      { ...coordinates, granteeActorId: OTHER_GRANTEE_ACTOR_ID },
      { ...coordinates, managementAuthorityId: "authority:other" },
      { ...coordinates, authorityGeneration: 8 },
      { ...coordinates, ceremonyPolicyId: "ceremony-policy:other" },
      { ...coordinates, ceremonyPolicyVersion: 4 },
      { ...coordinates, trustManifestSha256: "d".repeat(64) },
      { ...coordinates, decisionNonceSha256: "d".repeat(64) },
      { ...coordinates, evidenceSha256: "d".repeat(64) },
      { ...coordinates, notBefore: "2026-09-05T09:30:01.000Z" },
      { ...coordinates, expiresAt: "2026-09-05T09:44:59.999Z" },
    ];

    for (const mutation of mutations) {
      expect(
        memoryMembershipManagementBootstrapDecisionSha256V1(mutation),
      ).not.toBe(original);
    }
  });

  it("asserts record and caller-supplied digests without verifying signatures", () => {
    const record = decisionWithComputedDigest();
    expect(
      assertMemoryMembershipManagementBootstrapDecisionSha256V1(record),
    ).toEqual({
      decisionSha256: record.decisionSha256,
      computedDecisionSha256: record.decisionSha256,
      matches: true,
    });
    expect(
      assertMemoryMembershipManagementBootstrapDecisionSha256V1(
        signedCoordinates(),
        record.decisionSha256,
      ),
    ).toMatchObject({ matches: true });

    const mismatched = buildMemoryMembershipManagementBootstrapDecisionRecordV1(
      {
        tenantId: record.tenantId,
        governanceDecisionId: record.governanceDecisionId,
        databaseIdentityId: record.databaseIdentityId,
        subjectActorId: record.subjectActorId,
        granteeActorId: record.granteeActorId,
        managementAuthorityId: record.managementAuthorityId,
        authorityGeneration: record.authorityGeneration,
        ceremonyPolicyId: record.ceremonyPolicyId,
        ceremonyPolicyVersion: record.ceremonyPolicyVersion,
        trustManifestSha256: record.trustManifestSha256,
        decisionNonceSha256: record.decisionNonceSha256,
        evidenceSha256: record.evidenceSha256,
        decisionSha256: "f".repeat(64),
        notBefore: record.notBefore,
        expiresAt: record.expiresAt,
        recordedByActorId: record.recordedByActorId,
        recordedAt: record.recordedAt,
      },
    );
    expect(() =>
      assertMemoryMembershipManagementBootstrapDecisionSha256V1(mismatched),
    ).toThrow(/canonical preimage/);
    expect(() =>
      assertMemoryMembershipManagementBootstrapDecisionSha256V1(
        record,
        "f".repeat(64),
      ),
    ).toThrow(/caller-supplied/i);
  });
});

describe("membership-management bootstrap attestation contracts", () => {
  it("accepts only the two fixed slots and canonical Ed25519 encoding", () => {
    const decision = decisionWithComputedDigest();
    const record = attestation(decision, "organization_custodian");

    expect(record).toMatchObject({
      schemaVersion: 1,
      attesterSlot: "organization_custodian",
      signatureAlgorithm: "ed25519",
    });
    expect(record.signatureBase64url).toHaveLength(86);
    expect(Object.isFrozen(record)).toBe(true);

    for (const value of [
      { ...record, attesterSlot: "administrator" },
      { ...record, signatureAlgorithm: "rsa" },
      { ...record, signatureBase64url: "A".repeat(85) },
      { ...record, signatureBase64url: `${"A".repeat(85)}B` },
      { ...record, signatureBase64url: `${"A".repeat(85)}=` },
      { ...record, decisionSha256: "A".repeat(64) },
      { ...record, attestedAt: "2026-09-05T09:31:00Z" },
    ]) {
      expect(() =>
        parseMemoryMembershipManagementBootstrapAttestationRecordV1(value),
      ).toThrow();
    }
  });

  it("strictly rejects prose, credentials, private keys, roles, and metadata", () => {
    const decision = decisionWithComputedDigest();
    const record = attestation(decision, "organization_custodian");
    for (const field of [
      "approvalText",
      "credentials",
      "privateKey",
      "reasoning",
      "role",
      "email",
      "metadata",
    ]) {
      expect(
        memoryMembershipManagementBootstrapAttestationRecordV1Schema.safeParse(
          { ...record, [field]: "forbidden" },
        ).success,
      ).toBe(false);
    }
  });

  it("binds only decision coordinates and the half-open parent window", () => {
    const decision = decisionWithComputedDigest();
    const record = attestation(decision, "organization_custodian");

    expect(
      assertMemoryMembershipManagementBootstrapAttestationDecisionBindingV1(
        decision,
        record,
      ),
    ).toMatchObject({
      tenantId: decision.tenantId,
      governanceDecisionId: decision.governanceDecisionId,
      decisionSha256: decision.decisionSha256,
      attesterSlot: record.attesterSlot,
    });

    for (const changed of [
      { ...record, tenantId: "tenant:other" },
      { ...record, governanceDecisionId: "decision:other" },
      { ...record, decisionSha256: "f".repeat(64) },
      { ...record, attestedAt: "2026-09-05T09:29:59.999Z" },
      { ...record, attestedAt: decision.expiresAt },
    ]) {
      expect(() =>
        assertMemoryMembershipManagementBootstrapAttestationDecisionBindingV1(
          decision,
          changed,
        ),
      ).toThrow();
    }

    expect(() =>
      assertMemoryMembershipManagementBootstrapAttestationDecisionBindingV1(
        decision,
        { ...record, attestedAt: decision.notBefore },
      ),
    ).not.toThrow();
  });

  it("builds an ordered, copied, frozen pair with distinct slots and keys", () => {
    const decision = decisionWithComputedDigest();
    const custodian = attestation(decision, "organization_custodian");
    const reviewer = attestation(decision, "independent_reviewer");
    const bundle =
      buildMemoryMembershipManagementBootstrapAttestationBundleV1(decision, [
        reviewer,
        custodian,
      ]);

    expect(bundle.attestations.map((value) => value.attesterSlot)).toEqual([
      "organization_custodian",
      "independent_reviewer",
    ]);
    expect(bundle.attestations[0]).not.toBe(custodian);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.attestations)).toBe(true);
    expect(bundle.attestations.every(Object.isFrozen)).toBe(true);

    expect(() =>
      buildMemoryMembershipManagementBootstrapAttestationBundleV1(decision, [
        custodian,
      ]),
    ).toThrow();
    expect(() =>
      buildMemoryMembershipManagementBootstrapAttestationBundleV1(decision, [
        custodian,
        { ...reviewer, attesterSlot: "organization_custodian" },
      ]),
    ).toThrow();
    expect(() =>
      buildMemoryMembershipManagementBootstrapAttestationBundleV1(decision, [
        custodian,
        { ...reviewer, attesterKeyId: custodian.attesterKeyId },
      ]),
    ).toThrow();
  });

  it("requires canonical decision bytes without treating signatures as trusted", () => {
    const valid = decisionWithComputedDigest();
    const mismatchedDecision =
      parseMemoryMembershipManagementBootstrapDecisionRecordV1({
        ...valid,
        decisionSha256: "f".repeat(64),
      });
    const mismatchedCustodian = attestation(
      mismatchedDecision,
      "organization_custodian",
    );
    const mismatchedReviewer = attestation(
      mismatchedDecision,
      "independent_reviewer",
    );

    expect(() =>
      buildMemoryMembershipManagementBootstrapAttestationBundleV1(
        mismatchedDecision,
        [mismatchedCustodian, mismatchedReviewer],
      ),
    ).toThrow(/canonical preimage/);

    const custodian = attestation(valid, "organization_custodian");
    const reviewer = attestation(valid, "independent_reviewer");
    const rawBundle = {
      schemaVersion: 1,
      tenantId: valid.tenantId,
      governanceDecisionId: valid.governanceDecisionId,
      decisionSha256: valid.decisionSha256,
      attestations: [custodian, reviewer],
    };
    expect(() =>
      parseMemoryMembershipManagementBootstrapAttestationBundleV1(
        valid,
        rawBundle,
      ),
    ).not.toThrow();

    const shortenedDecision =
      buildMemoryMembershipManagementBootstrapDecisionRecordWithComputedSha256V1(
        {
          tenantId: valid.tenantId,
          governanceDecisionId: valid.governanceDecisionId,
          databaseIdentityId: valid.databaseIdentityId,
          subjectActorId: valid.subjectActorId,
          granteeActorId: valid.granteeActorId,
          managementAuthorityId: valid.managementAuthorityId,
          authorityGeneration: valid.authorityGeneration,
          ceremonyPolicyId: valid.ceremonyPolicyId,
          ceremonyPolicyVersion: valid.ceremonyPolicyVersion,
          trustManifestSha256: valid.trustManifestSha256,
          decisionNonceSha256: valid.decisionNonceSha256,
          evidenceSha256: valid.evidenceSha256,
          notBefore: valid.notBefore,
          expiresAt: ATTESTED_AT,
          recordedByActorId: valid.recordedByActorId,
          recordedAt: valid.recordedAt,
        },
      );
    const shortenedBundle = {
      ...rawBundle,
      decisionSha256: shortenedDecision.decisionSha256,
      attestations: [
        {
          ...custodian,
          decisionSha256: shortenedDecision.decisionSha256,
        },
        {
          ...reviewer,
          decisionSha256: shortenedDecision.decisionSha256,
        },
      ],
    };
    expect(() =>
      parseMemoryMembershipManagementBootstrapAttestationBundleV1(
        shortenedDecision,
        shortenedBundle,
      ),
    ).toThrow(/half-open validity window/);
    expect(() =>
      buildMemoryMembershipManagementBootstrapAttestationBundleV1(valid, [
        custodian,
        reviewer,
      ]),
    ).not.toThrow();
    expect(
      memoryMembershipManagementBootstrapDecisionRecordV1Schema.safeParse(
        mismatchedDecision,
      ).success,
    ).toBe(true);
  });
});
