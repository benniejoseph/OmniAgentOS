import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS,
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_ACTION,
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_SIGNATURE_ALGORITHM,
  buildMemoryMembershipManagementBootstrapAttestationBundleV1,
  buildMemoryMembershipManagementBootstrapAttestationRecordV1,
  buildMemoryMembershipManagementBootstrapDecisionRecordWithComputedSha256V1,
  canonicalMemoryMembershipManagementBootstrapDecisionPreimageV1,
  type MemoryMembershipManagementBootstrapAttestationBundleV1,
  type MemoryMembershipManagementBootstrapDecisionRecordV1,
} from "@/lib/memory/bootstrap-governance-contracts";
import {
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_PREIMAGE_DOMAIN,
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_PREIMAGE_FIELD_ORDER,
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_PREIMAGE_VERSION,
  canonicalMemoryMembershipManagementBootstrapTrustManifestPreimageV1,
  memoryMembershipManagementBootstrapTrustManifestSha256V1,
  memoryMembershipManagementBootstrapTrustManifestV1Schema,
  parseMemoryMembershipManagementBootstrapTrustManifestV1,
  verifyMemoryMembershipManagementBootstrapGovernanceV1,
  type MemoryMembershipManagementBootstrapTrustManifestV1,
} from "@/lib/memory/bootstrap-governance-verifier";

const LOGICAL_DATABASE_IDENTITY_ID = "0123456789abcdef0123456789abcdef";
const OTHER_LOGICAL_DATABASE_IDENTITY_ID =
  "fedcba9876543210fedcba9876543210";
const TENANT_ID = "tenant:bootstrap-verifier";
const SUBJECT_ACTOR_ID = "actor:11111111-1111-4111-8111-111111111111";
const GRANTEE_ACTOR_ID = "actor:22222222-2222-4222-8222-222222222222";
const RECORDED_BY_ACTOR_ID =
  "actor:33333333-3333-4333-8333-333333333333";
const CUSTODIAN_CONTROLLER_ACTOR_ID =
  "actor:44444444-4444-4444-8444-444444444444";
const REVIEWER_CONTROLLER_ACTOR_ID =
  "actor:55555555-5555-4555-8555-555555555555";
const DECISION_NOT_BEFORE = "2026-09-05T09:30:00.000Z";
const DECISION_EXPIRES_AT = "2026-09-05T09:45:00.000Z";
const RECORDED_AT = "2026-09-05T09:30:01.000Z";
const CUSTODIAN_ATTESTED_AT = "2026-09-05T09:31:00.000Z";
const REVIEWER_ATTESTED_AT = "2026-09-05T09:32:00.000Z";
const OBSERVED_AT = "2026-09-05T09:35:00.000Z";
const MANIFEST_ISSUED_AT = "2026-09-05T09:00:00.000Z";
const MANIFEST_NOT_BEFORE = "2026-09-05T09:20:00.000Z";
const MANIFEST_EXPIRES_AT = "2026-09-05T10:00:00.000Z";
const KEY_NOT_BEFORE = "2026-09-05T09:25:00.000Z";
const KEY_EXPIRES_AT = "2026-09-05T09:50:00.000Z";
const EXPECTED_MANIFEST_PREIMAGE_LENGTH = 1_400;
const EXPECTED_MANIFEST_SHA256 =
  "86423bca0d0c2006b4e05995ada62f966a308d31b0ad7b6e40c6b023eabc974e";

// Public keys are the RFC 8032 Ed25519 test-vector keys. The signatures were
// independently precomputed over this suite's exact canonical decision bytes;
// no private key material is stored in the repository.
const FIXED_INTEROP_PUBLIC_KEYS = [
  "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
] as const;
const FIXED_INTEROP_SIGNATURES = [
  "0m54-UMZC0SkNCJEXBE5AgIHwzo25QyuU5pJJ7GUB_fpLck4wEJDQWWfADT1gLgBivfQ19Kk30U1yE16plX-AA",
  "ivkSmOYR5qjyxCxx_jVK5SOi0JWjfhDqRM_5hHt8Qmu7yixTkyfcogxt9jU-3LOOYnAIQKSpHsN-h0wRZwSXBA",
] as const;
const FIXED_INTEROP_MANIFEST_SHA256 =
  "a2bfd402880d98f39544754372e9bbd0af9cfbcb470a25250cd6267f5645a1ab";
const FIXED_INTEROP_DECISION_SHA256 =
  "1635ac000aa794ea89ce2b39400a1c3b61edd428b7f378c36c20af76b8ffb7de";
const FIXED_INTEROP_DECISION_PREIMAGE_LENGTH = 957;

const EXPECTED_MANIFEST_FIELD_ORDER = [
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
] as const;

type EphemeralEd25519Key = Readonly<{
  privateKey: KeyObject;
  publicKeyBase64url: string;
}>;

type SignatureMessageMode = "preimage" | "digest_bytes" | "digest_hex";

type FixtureOptions = Readonly<{
  keyPairs?: readonly [EphemeralEd25519Key, EphemeralEd25519Key];
  trustManifest?: MemoryMembershipManagementBootstrapTrustManifestV1;
  decisionTrustManifestSha256?: string;
  decisionTenantId?: string;
  decisionCeremonyPolicyId?: string;
  decisionCeremonyPolicyVersion?: number;
  attestedAt?: readonly [string, string];
  attesterKeyIds?: readonly [string, string];
  signingKeys?: readonly [EphemeralEd25519Key, EphemeralEd25519Key];
  signatureMessageMode?: SignatureMessageMode;
  signatures?: readonly [string, string];
  observedAt?: string;
}>;

type VerifierFixture = Readonly<{
  keyPairs: readonly [EphemeralEd25519Key, EphemeralEd25519Key];
  trustManifest: MemoryMembershipManagementBootstrapTrustManifestV1;
  trustManifestSha256: string;
  decision: MemoryMembershipManagementBootstrapDecisionRecordV1;
  attestationBundle: MemoryMembershipManagementBootstrapAttestationBundleV1;
  input: Readonly<{
    expectedLogicalDatabaseIdentityId: string;
    trustedManifestSha256: string;
    observedAt: string;
    decision: MemoryMembershipManagementBootstrapDecisionRecordV1;
    attestationBundle: MemoryMembershipManagementBootstrapAttestationBundleV1;
    trustManifest: MemoryMembershipManagementBootstrapTrustManifestV1;
  }>;
}>;

describe("membership-management bootstrap external trust manifest", () => {
  it("strictly validates ordered, distinct Ed25519 key snapshots", () => {
    const keyPairs = generateKeyPairs();
    const manifest = buildTrustManifest(keyPairs);
    const parsed =
      parseMemoryMembershipManagementBootstrapTrustManifestV1(manifest);

    expect(parsed).not.toBe(manifest);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.keys)).toBe(true);
    expect(parsed.keys.every(Object.isFrozen)).toBe(true);

    const invalidManifests = [
      { ...manifest, manifestRevision: 0 },
      { ...manifest, manifestRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...manifest, issuedAt: "2026-09-05T09:20:00.001Z" },
      { ...manifest, expiresAt: manifest.notBefore },
      { ...manifest, keys: [manifest.keys[1], manifest.keys[0]] },
      {
        ...manifest,
        keys: [
          manifest.keys[0],
          {
            ...manifest.keys[1],
            attesterKeyId: manifest.keys[0].attesterKeyId,
          },
        ],
      },
      {
        ...manifest,
        keys: [
          manifest.keys[0],
          {
            ...manifest.keys[1],
            controllerActorId: manifest.keys[0].controllerActorId,
          },
        ],
      },
      {
        ...manifest,
        keys: [
          manifest.keys[0],
          {
            ...manifest.keys[1],
            controllerActorId:
              manifest.keys[1].controllerActorId.toUpperCase(),
          },
        ],
      },
      {
        ...manifest,
        keys: [
          manifest.keys[0],
          {
            ...manifest.keys[1],
            publicKeyBase64url: manifest.keys[0].publicKeyBase64url,
          },
        ],
      },
      {
        ...manifest,
        keys: [
          { ...manifest.keys[0], expiresAt: manifest.keys[0].notBefore },
          manifest.keys[1],
        ],
      },
      {
        ...manifest,
        keys: [
          {
            ...manifest.keys[0],
            revokedAt: manifest.keys[0].expiresAt,
          },
          manifest.keys[1],
        ],
      },
      {
        ...manifest,
        keys: [
          {
            ...manifest.keys[0],
            publicKeyBase64url: `${manifest.keys[0].publicKeyBase64url}=`,
          },
          manifest.keys[1],
        ],
      },
      {
        ...manifest,
        keys: [
          {
            ...manifest.keys[0],
            publicKeyBase64url: nonCanonicalBase64urlAlias(
              manifest.keys[0].publicKeyBase64url,
            ),
          },
          manifest.keys[1],
        ],
      },
      { ...manifest, unexpected: "forbidden" },
      {
        ...manifest,
        keys: [
          { ...manifest.keys[0], unexpected: "forbidden" },
          manifest.keys[1],
        ],
      },
    ];

    for (const invalidManifest of invalidManifests) {
      expect(
        memoryMembershipManagementBootstrapTrustManifestV1Schema.safeParse(
          invalidManifest,
        ).success,
      ).toBe(false);
    }
  });

  it("uses deterministic fixed-order uint32-be framing without object-order dependence", () => {
    const manifest = deterministicHashManifest();
    const first =
      canonicalMemoryMembershipManagementBootstrapTrustManifestPreimageV1(
        manifest,
      );
    const reordered = Object.fromEntries(
      Object.entries({
        ...manifest,
        keys: manifest.keys.map((key) =>
          Object.fromEntries(Object.entries(key).reverse()),
        ),
      }).reverse(),
    );
    const second =
      canonicalMemoryMembershipManagementBootstrapTrustManifestPreimageV1(
        reordered,
      );
    const decoded = decodeCanonicalFrame(first);

    expect(first).not.toBe(second);
    expect(Array.from(first)).toEqual(Array.from(second));
    expect(first).toHaveLength(EXPECTED_MANIFEST_PREIMAGE_LENGTH);
    expect(decoded.domain).toBe(
      "asael.memory.membership_management_bootstrap_trust_manifest",
    );
    expect(decoded.domain).toBe(
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_PREIMAGE_DOMAIN,
    );
    expect(decoded.version).toBe(1);
    expect(decoded.version).toBe(
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_PREIMAGE_VERSION,
    );
    expect(decoded.fields.map(([name]) => name)).toEqual(
      EXPECTED_MANIFEST_FIELD_ORDER,
    );
    expect(
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_MANIFEST_PREIMAGE_FIELD_ORDER,
    ).toEqual(EXPECTED_MANIFEST_FIELD_ORDER);
    expect(Object.fromEntries(decoded.fields)).toMatchObject({
      manifestRevision: "7",
      "keys.0.revokedAt": "null",
      "keys.1.revokedAt": "2026-09-05T09:45:00.000Z",
    });

    const digest =
      memoryMembershipManagementBootstrapTrustManifestSha256V1(manifest);
    expect(digest).toBe(EXPECTED_MANIFEST_SHA256);
    expect(
      memoryMembershipManagementBootstrapTrustManifestSha256V1(reordered),
    ).toBe(digest);
    expect(
      memoryMembershipManagementBootstrapTrustManifestSha256V1({
        ...manifest,
        manifestRevision: 8,
      }),
    ).not.toBe(digest);
    expect(
      memoryMembershipManagementBootstrapTrustManifestSha256V1({
        ...manifest,
        keys: [
          { ...manifest.keys[0], revokedAt: DECISION_EXPIRES_AT },
          manifest.keys[1],
        ],
      }),
    ).not.toBe(digest);

    first[0] ^= 0xff;
    expect(
      Array.from(
        canonicalMemoryMembershipManagementBootstrapTrustManifestPreimageV1(
          manifest,
        ),
      ),
    ).toEqual(Array.from(second));
  });
});

describe("membership-management bootstrap governance verifier", () => {
  it("verifies real signatures and returns frozen non-authorizing evidence", () => {
    const fixture = buildFixture();
    const result =
      verifyMemoryMembershipManagementBootstrapGovernanceV1(fixture.input);

    expect(result).toMatchObject({
      schemaVersion: 1,
      verificationKind: "offline_external_trust_manifest_v1",
      logicalDatabaseIdentityId: LOGICAL_DATABASE_IDENTITY_ID,
      tenantId: TENANT_ID,
      governanceDecisionId: "governance-decision:bootstrap-verifier",
      decisionSha256: fixture.decision.decisionSha256,
      subjectActorId: SUBJECT_ACTOR_ID,
      granteeActorId: GRANTEE_ACTOR_ID,
      managementAuthorityId: "membership-authority:bootstrap-verifier",
      authorityGeneration: 7,
      decisionAction:
        "create_held_membership_management_authority",
      ceremonyPolicyId: "ceremony-policy:bootstrap-verifier",
      ceremonyPolicyVersion: 3,
      trustManifestId: "trust-manifest:bootstrap-verifier",
      trustManifestRevision: 1,
      trustManifestSha256: fixture.trustManifestSha256,
      observedAt: OBSERVED_AT,
      manifestDigestBound: true,
      decisionDigestValid: true,
      authorityGranted: false,
      runtimeAccepted: false,
    });
    expect(result.attestations.map((item) => item.signatureValid)).toEqual([
      true,
      true,
    ]);
    expect(result.attestations[0].publicKeySha256).toBe(
      rawPublicKeySha256(fixture.keyPairs[0].publicKeyBase64url),
    );
    expect(result.attestations[1].publicKeySha256).toBe(
      rawPublicKeySha256(fixture.keyPairs[1].publicKeyBase64url),
    );
    expect(result.attestations[0]).not.toHaveProperty("signatureBase64url");
    expect(result.attestations[0]).not.toHaveProperty("publicKeyBase64url");
    expect(JSON.stringify(result)).not.toContain(
      fixture.attestationBundle.attestations[0].signatureBase64url,
    );
    expect(JSON.stringify(result)).not.toContain(
      fixture.keyPairs[0].publicKeyBase64url,
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.attestations)).toBe(true);
    expect(result.attestations.every(Object.isFrozen)).toBe(true);
  });

  it("pins raw-key SPKI interoperability with fixed public keys and signatures", () => {
    const trustManifest = buildTrustManifestFromPublicKeys(
      FIXED_INTEROP_PUBLIC_KEYS,
    );
    const fixture = buildFixture({
      trustManifest,
      signatures: FIXED_INTEROP_SIGNATURES,
    });

    expect(fixture.trustManifestSha256).toBe(
      FIXED_INTEROP_MANIFEST_SHA256,
    );
    expect(fixture.decision.decisionSha256).toBe(
      FIXED_INTEROP_DECISION_SHA256,
    );
    expect(
      canonicalMemoryMembershipManagementBootstrapDecisionPreimageV1(
        fixture.decision,
      ),
    ).toHaveLength(FIXED_INTEROP_DECISION_PREIMAGE_LENGTH);
    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1(fixture.input),
    ).not.toThrow();
  });

  it("binds computed, external, and decision manifest digests", () => {
    const fixture = buildFixture();

    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1({
        ...fixture.input,
        trustedManifestSha256: "f".repeat(64),
      }),
    ).toThrow(/digest binding/);
    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1({
        ...fixture.input,
        trustManifest: {
          ...fixture.trustManifest,
          manifestId: "trust-manifest:tampered",
        },
      }),
    ).toThrow(/digest binding/);

    const decisionMismatch = buildFixture({
      keyPairs: fixture.keyPairs,
      trustManifest: fixture.trustManifest,
      decisionTrustManifestSha256: "e".repeat(64),
    });
    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1(
        decisionMismatch.input,
      ),
    ).toThrow(/digest binding/);
  });

  it("binds logical database, tenant, fixed action, and ceremony policy coordinates", () => {
    const keyPairs = generateKeyPairs();
    const baseManifest = buildTrustManifest(keyPairs);
    const mutations = [
      {
        ...baseManifest,
        logicalDatabaseIdentityId: OTHER_LOGICAL_DATABASE_IDENTITY_ID,
      },
      { ...baseManifest, tenantId: "tenant:other" },
      { ...baseManifest, ceremonyPolicyId: "ceremony-policy:other" },
      { ...baseManifest, ceremonyPolicyVersion: 4 },
    ];

    for (const mutation of mutations) {
      const manifest =
        parseMemoryMembershipManagementBootstrapTrustManifestV1(mutation);
      const fixture = buildFixture({ keyPairs, trustManifest: manifest });
      expect(() =>
        verifyMemoryMembershipManagementBootstrapGovernanceV1(fixture.input),
      ).toThrow(/binding failed/);
    }

    const fixture = buildFixture({ keyPairs, trustManifest: baseManifest });
    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1({
        ...fixture.input,
        expectedLogicalDatabaseIdentityId:
          OTHER_LOGICAL_DATABASE_IDENTITY_ID,
      }),
    ).toThrow(/expected logical database identity/);
    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1({
        ...fixture.input,
        trustManifest: {
          ...baseManifest,
          decisionAction: "activate_membership_management_authority",
        },
      }),
    ).toThrow();
  });

  it("requires manifest and key snapshots to cover the complete decision window", () => {
    const keyPairs = generateKeyPairs();
    const baseManifest = buildTrustManifest(keyPairs);
    const nonCoveringManifests = [
      { ...baseManifest, notBefore: "2026-09-05T09:30:00.001Z" },
      { ...baseManifest, expiresAt: "2026-09-05T09:44:59.999Z" },
      {
        ...baseManifest,
        keys: [
          {
            ...baseManifest.keys[0],
            notBefore: "2026-09-05T09:30:00.001Z",
          },
          baseManifest.keys[1],
        ],
      },
      {
        ...baseManifest,
        keys: [
          baseManifest.keys[0],
          {
            ...baseManifest.keys[1],
            expiresAt: "2026-09-05T09:44:59.999Z",
          },
        ],
      },
      {
        ...baseManifest,
        keys: [
          {
            ...baseManifest.keys[0],
            revokedAt: "2026-09-05T09:44:59.999Z",
          },
          baseManifest.keys[1],
        ],
      },
    ];

    for (const candidate of nonCoveringManifests) {
      const manifest =
        parseMemoryMembershipManagementBootstrapTrustManifestV1(candidate);
      const fixture = buildFixture({ keyPairs, trustManifest: manifest });
      expect(() =>
        verifyMemoryMembershipManagementBootstrapGovernanceV1(fixture.input),
      ).toThrow(/decision (window|expires)/);
    }

    const boundaryManifest =
      parseMemoryMembershipManagementBootstrapTrustManifestV1({
        ...baseManifest,
        notBefore: DECISION_NOT_BEFORE,
        expiresAt: DECISION_EXPIRES_AT,
        keys: [
          {
            ...baseManifest.keys[0],
            notBefore: DECISION_NOT_BEFORE,
            revokedAt: DECISION_EXPIRES_AT,
          },
          {
            ...baseManifest.keys[1],
            expiresAt: DECISION_EXPIRES_AT,
          },
        ],
      });
    const boundaryFixture = buildFixture({
      keyPairs,
      trustManifest: boundaryManifest,
      observedAt: REVIEWER_ATTESTED_AT,
    });
    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1(
        boundaryFixture.input,
      ),
    ).not.toThrow();
  });

  it("enforces claimed observation ordering and half-open time boundaries", () => {
    const fixture = buildFixture();

    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1({
        ...fixture.input,
        observedAt: DECISION_EXPIRES_AT,
      }),
    ).toThrow(/half-open validity window/);
    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1({
        ...fixture.input,
        observedAt: DECISION_NOT_BEFORE,
      }),
    ).toThrow(/recordedAt ordering/);
    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1({
        ...fixture.input,
        observedAt: "2026-09-05T09:31:30.000Z",
      }),
    ).toThrow(/attestation 1 ordering/);
    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1({
        ...fixture.input,
        observedAt: REVIEWER_ATTESTED_AT,
      }),
    ).not.toThrow();
  });

  it("rejects slot, key, signature, and exact-preimage confusion", () => {
    const fixture = buildFixture();
    const [custodian, reviewer] = fixture.attestationBundle.attestations;

    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1({
        ...fixture.input,
        attestationBundle: {
          ...fixture.attestationBundle,
          attestations: [reviewer, custodian],
        },
      }),
    ).toThrow();

    const wrongKeyId = buildFixture({
      keyPairs: fixture.keyPairs,
      trustManifest: fixture.trustManifest,
      attesterKeyIds: ["key:wrong-custodian", reviewer.attesterKeyId],
    });
    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1(wrongKeyId.input),
    ).toThrow(/key ID/);

    const tamperedSignature = `${
      custodian.signatureBase64url[0] === "A" ? "B" : "A"
    }${custodian.signatureBase64url.slice(1)}`;
    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1({
        ...fixture.input,
        attestationBundle: {
          ...fixture.attestationBundle,
          attestations: [
            { ...custodian, signatureBase64url: tamperedSignature },
            reviewer,
          ],
        },
      }),
    ).toThrow(/Ed25519 verification/);

    const swappedSigners = buildFixture({
      keyPairs: fixture.keyPairs,
      trustManifest: fixture.trustManifest,
      signingKeys: [fixture.keyPairs[1], fixture.keyPairs[0]],
    });
    expect(() =>
      verifyMemoryMembershipManagementBootstrapGovernanceV1(
        swappedSigners.input,
      ),
    ).toThrow(/Ed25519 verification/);

    for (const signatureMessageMode of [
      "digest_bytes",
      "digest_hex",
    ] as const) {
      const confused = buildFixture({
        keyPairs: fixture.keyPairs,
        trustManifest: fixture.trustManifest,
        signatureMessageMode,
      });
      expect(() =>
        verifyMemoryMembershipManagementBootstrapGovernanceV1(confused.input),
      ).toThrow(/Ed25519 verification/);
    }
  });

  it("strictly rejects unknown verifier, manifest, key, decision, and bundle fields", () => {
    const fixture = buildFixture();
    const invalidInputs = [
      { ...fixture.input, unexpected: "forbidden" },
      {
        ...fixture.input,
        trustManifest: { ...fixture.trustManifest, unexpected: "forbidden" },
      },
      {
        ...fixture.input,
        trustManifest: {
          ...fixture.trustManifest,
          keys: [
            { ...fixture.trustManifest.keys[0], unexpected: "forbidden" },
            fixture.trustManifest.keys[1],
          ],
        },
      },
      {
        ...fixture.input,
        decision: { ...fixture.decision, unexpected: "forbidden" },
      },
      {
        ...fixture.input,
        attestationBundle: {
          ...fixture.attestationBundle,
          unexpected: "forbidden",
        },
      },
    ];

    for (const input of invalidInputs) {
      expect(() =>
        verifyMemoryMembershipManagementBootstrapGovernanceV1(input),
      ).toThrow();
    }
  });
});

function generateKeyPairs(): readonly [
  EphemeralEd25519Key,
  EphemeralEd25519Key,
] {
  return [generateEphemeralEd25519Key(), generateEphemeralEd25519Key()];
}

function generateEphemeralEd25519Key(): EphemeralEd25519Key {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  if (
    publicJwk.kty !== "OKP" ||
    publicJwk.crv !== "Ed25519" ||
    typeof publicJwk.x !== "string"
  ) {
    throw new Error("Generated Ed25519 public key was not exportable.");
  }
  return Object.freeze({
    privateKey,
    publicKeyBase64url: publicJwk.x,
  });
}

function buildTrustManifest(
  keyPairs: readonly [EphemeralEd25519Key, EphemeralEd25519Key],
): MemoryMembershipManagementBootstrapTrustManifestV1 {
  return buildTrustManifestFromPublicKeys([
    keyPairs[0].publicKeyBase64url,
    keyPairs[1].publicKeyBase64url,
  ]);
}

function buildTrustManifestFromPublicKeys(
  publicKeys: readonly [string, string],
): MemoryMembershipManagementBootstrapTrustManifestV1 {
  return {
    schemaVersion: 1,
    manifestId: "trust-manifest:bootstrap-verifier",
    manifestRevision: 1,
    logicalDatabaseIdentityId: LOGICAL_DATABASE_IDENTITY_ID,
    tenantId: TENANT_ID,
    decisionAction: MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_DECISION_ACTION,
    ceremonyPolicyId: "ceremony-policy:bootstrap-verifier",
    ceremonyPolicyVersion: 3,
    issuedAt: MANIFEST_ISSUED_AT,
    notBefore: MANIFEST_NOT_BEFORE,
    expiresAt: MANIFEST_EXPIRES_AT,
    keys: [
      {
        attesterSlot:
          MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS[0],
        attesterKeyId: "key:organization-custodian",
        controllerActorId: CUSTODIAN_CONTROLLER_ACTOR_ID,
        signatureAlgorithm:
          MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_SIGNATURE_ALGORITHM,
        publicKeyBase64url: publicKeys[0],
        notBefore: KEY_NOT_BEFORE,
        expiresAt: KEY_EXPIRES_AT,
        revokedAt: null,
      },
      {
        attesterSlot:
          MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS[1],
        attesterKeyId: "key:independent-reviewer",
        controllerActorId: REVIEWER_CONTROLLER_ACTOR_ID,
        signatureAlgorithm:
          MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_SIGNATURE_ALGORITHM,
        publicKeyBase64url: publicKeys[1],
        notBefore: KEY_NOT_BEFORE,
        expiresAt: KEY_EXPIRES_AT,
        revokedAt: null,
      },
    ],
  };
}

function buildFixture(options: FixtureOptions = {}): VerifierFixture {
  const keyPairs = options.keyPairs ?? generateKeyPairs();
  const trustManifest =
    options.trustManifest ?? buildTrustManifest(keyPairs);
  const trustManifestSha256 =
    memoryMembershipManagementBootstrapTrustManifestSha256V1(trustManifest);
  const decision =
    buildMemoryMembershipManagementBootstrapDecisionRecordWithComputedSha256V1(
      {
        tenantId: options.decisionTenantId ?? TENANT_ID,
        governanceDecisionId: "governance-decision:bootstrap-verifier",
        databaseIdentityId: LOGICAL_DATABASE_IDENTITY_ID,
        subjectActorId: SUBJECT_ACTOR_ID,
        granteeActorId: GRANTEE_ACTOR_ID,
        managementAuthorityId: "membership-authority:bootstrap-verifier",
        authorityGeneration: 7,
        ceremonyPolicyId:
          options.decisionCeremonyPolicyId ??
          "ceremony-policy:bootstrap-verifier",
        ceremonyPolicyVersion: options.decisionCeremonyPolicyVersion ?? 3,
        trustManifestSha256:
          options.decisionTrustManifestSha256 ?? trustManifestSha256,
        decisionNonceSha256: "b".repeat(64),
        evidenceSha256: "c".repeat(64),
        notBefore: DECISION_NOT_BEFORE,
        expiresAt: DECISION_EXPIRES_AT,
        recordedByActorId: RECORDED_BY_ACTOR_ID,
        recordedAt: RECORDED_AT,
      },
    );
  const decisionPreimage =
    canonicalMemoryMembershipManagementBootstrapDecisionPreimageV1(decision);
  const message = signatureMessage(
    options.signatureMessageMode ?? "preimage",
    decision,
    decisionPreimage,
  );
  const signingKeys = options.signingKeys ?? keyPairs;
  const attestedAt = options.attestedAt ?? [
    CUSTODIAN_ATTESTED_AT,
    REVIEWER_ATTESTED_AT,
  ];
  const attesterKeyIds = options.attesterKeyIds ?? [
    trustManifest.keys[0].attesterKeyId,
    trustManifest.keys[1].attesterKeyId,
  ];
  const attestations = [0, 1].map((index) =>
    buildMemoryMembershipManagementBootstrapAttestationRecordV1({
      tenantId: decision.tenantId,
      governanceDecisionId: decision.governanceDecisionId,
      decisionSha256: decision.decisionSha256,
      attesterSlot:
        MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_ATTESTER_SLOTS[index],
      attesterKeyId: attesterKeyIds[index],
      signatureBase64url:
        options.signatures?.[index] ??
        sign(null, message, signingKeys[index].privateKey).toString(
          "base64url",
        ),
      attestedAt: attestedAt[index],
    }),
  );
  const attestationBundle =
    buildMemoryMembershipManagementBootstrapAttestationBundleV1(
      decision,
      attestations,
    );
  const input = Object.freeze({
    expectedLogicalDatabaseIdentityId: LOGICAL_DATABASE_IDENTITY_ID,
    trustedManifestSha256: trustManifestSha256,
    observedAt: options.observedAt ?? OBSERVED_AT,
    decision,
    attestationBundle,
    trustManifest,
  });

  return Object.freeze({
    keyPairs,
    trustManifest,
    trustManifestSha256,
    decision,
    attestationBundle,
    input,
  });
}

function signatureMessage(
  mode: SignatureMessageMode,
  decision: MemoryMembershipManagementBootstrapDecisionRecordV1,
  decisionPreimage: Uint8Array,
): Uint8Array {
  if (mode === "digest_bytes") {
    return Buffer.from(decision.decisionSha256, "hex");
  }
  if (mode === "digest_hex") {
    return Buffer.from(decision.decisionSha256, "utf8");
  }
  return decisionPreimage;
}

function deterministicHashManifest(): MemoryMembershipManagementBootstrapTrustManifestV1 {
  const firstPublicKey = Buffer.alloc(32, 1).toString("base64url");
  const secondPublicKey = Buffer.alloc(32, 2).toString("base64url");
  const manifest = buildTrustManifestFromPublicKeys([
    firstPublicKey,
    secondPublicKey,
  ]);
  return {
    ...manifest,
    manifestRevision: 7,
    keys: [
      {
        ...manifest.keys[0],
      },
      {
        ...manifest.keys[1],
        revokedAt: DECISION_EXPIRES_AT,
      },
    ],
  };
}

function decodeCanonicalFrame(bytes: Uint8Array): Readonly<{
  domain: string;
  version: number;
  fields: readonly (readonly [string, string])[];
}> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  const readUint32 = () => {
    const value = view.getUint32(offset, false);
    offset += 4;
    return value;
  };
  const readString = () => {
    const length = readUint32();
    const value = decoder.decode(bytes.slice(offset, offset + length));
    offset += length;
    return value;
  };
  const domain = readString();
  const version = readUint32();
  const fieldCount = readUint32();
  const fields: Array<readonly [string, string]> = [];
  for (let index = 0; index < fieldCount; index += 1) {
    fields.push([readString(), readString()]);
  }
  if (offset !== bytes.byteLength) {
    throw new Error("Canonical manifest test frame has trailing bytes.");
  }
  return Object.freeze({ domain, version, fields: Object.freeze(fields) });
}

function rawPublicKeySha256(publicKeyBase64url: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKeyBase64url, "base64url"))
    .digest("hex");
}

function nonCanonicalBase64urlAlias(value: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastIndex = alphabet.indexOf(value.at(-1) ?? "");
  if (lastIndex < 0 || lastIndex >= alphabet.length - 1) {
    throw new Error("Cannot create a non-canonical base64url alias.");
  }
  const alias = `${value.slice(0, -1)}${alphabet[lastIndex + 1]}`;
  if (!Buffer.from(alias, "base64url").equals(Buffer.from(value, "base64url"))) {
    throw new Error("Constructed base64url value is not an encoding alias.");
  }
  return alias;
}
