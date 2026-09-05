import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildMemoryInformedNoticeApprovalBatchWithComputedSha256V1,
  type BuildMemoryInformedNoticeApprovalBatchWithComputedSha256V1Input,
} from "@/lib/memory/informed-notice-governance-contracts";
import {
  MEMORY_INFORMED_NOTICE_REVIEW_SIGNATURE_ALGORITHM,
  canonicalMemoryInformedNoticeReviewSignaturePreimageV1,
  memoryInformedNoticeTrustManifestSha256V1,
  verifyMemoryInformedNoticeGovernanceV1,
  type MemoryInformedNoticeReviewAttestationV1,
  type MemoryInformedNoticeTrustManifestV1,
} from "@/lib/memory/informed-notice-governance-verifier";

const LEGAL_ACTOR_ID = "actor:11111111-1111-4111-8111-111111111111";
const PRIVACY_ACTOR_ID = "actor:22222222-2222-4222-8222-222222222222";
const REVIEWED_AT = [
  "2026-09-05T10:00:00.000Z",
  "2026-09-05T10:01:00.000Z",
] as const;
const OBSERVED_AT = "2026-09-05T10:30:00.000Z";
const PLACEHOLDER_SIGNATURE = "A".repeat(86);

type KeyPair = Readonly<{
  privateKey: KeyObject;
  publicKeyBase64url: string;
}>;

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function batchInput(): BuildMemoryInformedNoticeApprovalBatchWithComputedSha256V1Input {
  const text = "Asael may retrieve saved information when you ask a question.";
  return {
    schemaVersion: 1,
    approvalBatchId: "notice-approval-batch:verifier",
    governancePolicyId: "notice-governance:legal-privacy-review",
    governancePolicyVersion: 3,
    decisionNonceSha256: "a".repeat(64),
    evidenceSha256: "b".repeat(64),
    notices: [
      {
        recordSchemaVersion: 1,
        purposeId: "memory.retrieve.v1",
        noticeContractId: "notice:retrieval",
        noticeContractVersion: 1,
        localeId: "en-US",
        noticeText: text,
        noticeSha256: sha256(text),
      },
    ],
    reviews: [
      {
        schemaVersion: 1,
        approvalBatchId: "notice-approval-batch:verifier",
        governancePolicyId: "notice-governance:legal-privacy-review",
        governancePolicyVersion: 3,
        reviewSlot: "legal_reviewer",
        reviewId: "notice-review:legal:verifier",
        reviewerActorId: LEGAL_ACTOR_ID,
        reviewedAt: REVIEWED_AT[0],
      },
      {
        schemaVersion: 1,
        approvalBatchId: "notice-approval-batch:verifier",
        governancePolicyId: "notice-governance:legal-privacy-review",
        governancePolicyVersion: 3,
        reviewSlot: "privacy_reviewer",
        reviewId: "notice-review:privacy:verifier",
        reviewerActorId: PRIVACY_ACTOR_ID,
        reviewedAt: REVIEWED_AT[1],
      },
    ],
  };
}

function generateKey(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
    throw new Error("Generated Ed25519 key is unavailable.");
  }
  return { privateKey, publicKeyBase64url: jwk.x };
}

function fixture() {
  const batch =
    buildMemoryInformedNoticeApprovalBatchWithComputedSha256V1(batchInput());
  const keys = [generateKey(), generateKey()] as const;
  const manifest: MemoryInformedNoticeTrustManifestV1 = {
    schemaVersion: 1,
    manifestId: "notice-trust-manifest:verifier",
    manifestRevision: 7,
    governancePolicyId: batch.governancePolicyId,
    governancePolicyVersion: batch.governancePolicyVersion,
    issuedAt: "2026-09-05T09:00:00.000Z",
    notBefore: "2026-09-05T09:30:00.000Z",
    expiresAt: "2026-09-05T12:00:00.000Z",
    keys: [
      {
        reviewSlot: "legal_reviewer",
        attesterKeyId: "notice-review-key:legal",
        controllerActorId: LEGAL_ACTOR_ID,
        signatureAlgorithm:
          MEMORY_INFORMED_NOTICE_REVIEW_SIGNATURE_ALGORITHM,
        publicKeyBase64url: keys[0].publicKeyBase64url,
        notBefore: "2026-09-05T09:30:00.000Z",
        expiresAt: "2026-09-05T11:00:00.000Z",
        revokedAt: null,
      },
      {
        reviewSlot: "privacy_reviewer",
        attesterKeyId: "notice-review-key:privacy",
        controllerActorId: PRIVACY_ACTOR_ID,
        signatureAlgorithm:
          MEMORY_INFORMED_NOTICE_REVIEW_SIGNATURE_ALGORITHM,
        publicKeyBase64url: keys[1].publicKeyBase64url,
        notBefore: "2026-09-05T09:30:00.000Z",
        expiresAt: "2026-09-05T11:00:00.000Z",
        revokedAt: null,
      },
    ],
  };
  const buildAttestation = (index: 0 | 1) => {
    const review = batch.reviews[index];
    const unsigned = {
      schemaVersion: 1 as const,
      approvalBatchId: review.approvalBatchId,
      batchSha256: review.batchSha256,
      governancePolicyId: review.governancePolicyId,
      governancePolicyVersion: review.governancePolicyVersion,
      reviewSlot: review.reviewSlot,
      reviewId: review.reviewId,
      reviewerActorId: review.reviewerActorId,
      reviewedAt: review.reviewedAt,
      attesterKeyId: manifest.keys[index]!.attesterKeyId,
      signatureAlgorithm:
        MEMORY_INFORMED_NOTICE_REVIEW_SIGNATURE_ALGORITHM,
      signatureBase64url: PLACEHOLDER_SIGNATURE,
    };
    return {
      ...unsigned,
      signatureBase64url: sign(
        null,
        canonicalMemoryInformedNoticeReviewSignaturePreimageV1(unsigned),
        keys[index]!.privateKey,
      ).toString("base64url"),
    };
  };
  const attestations = [
    buildAttestation(0),
    buildAttestation(1),
  ] as const satisfies readonly [
    MemoryInformedNoticeReviewAttestationV1,
    MemoryInformedNoticeReviewAttestationV1,
  ];
  const trustedManifestSha256 =
    memoryInformedNoticeTrustManifestSha256V1(manifest);
  return {
    batch,
    keys,
    manifest,
    attestations,
    input: {
      trustedManifestSha256,
      observedAt: OBSERVED_AT,
      batch,
      attestations,
      trustManifest: manifest,
    },
  };
}

describe("informed-notice governance verifier", () => {
  it("verifies both exact reviews and returns only non-authorizing evidence", () => {
    const value = fixture();
    const result = verifyMemoryInformedNoticeGovernanceV1(value.input);

    expect(result).toMatchObject({
      schemaVersion: 1,
      verificationKind: "offline_external_trust_manifest_v1",
      approvalBatchId: value.batch.approvalBatchId,
      batchSha256: value.batch.batchSha256,
      noticeCount: 1,
      manifestDigestBound: true,
      batchDigestValid: true,
      authorityGranted: false,
      runtimeAccepted: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.attestations)).toBe(true);
    expect(result.attestations.every(Object.isFrozen)).toBe(true);
    expect(result.attestations.every((item) => item.signatureValid)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("signatureBase64url");
    expect(JSON.stringify(result)).not.toContain("publicKeyBase64url");
  });

  it("rejects an unanchored or policy-drifted manifest", () => {
    const value = fixture();
    expect(() =>
      verifyMemoryInformedNoticeGovernanceV1({
        ...value.input,
        trustedManifestSha256: "f".repeat(64),
      }),
    ).toThrow(/manifest digest/);

    const drifted = { ...value.manifest, governancePolicyVersion: 4 };
    expect(() =>
      verifyMemoryInformedNoticeGovernanceV1({
        ...value.input,
        trustedManifestSha256:
          memoryInformedNoticeTrustManifestSha256V1(drifted),
        trustManifest: drifted,
      }),
    ).toThrow(/policy version/);
  });

  it("rejects a changed notice batch or review binding", () => {
    const value = fixture();
    const changedInput = batchInput();
    const changedText = `${changedInput.notices[0]!.noticeText} Changed.`;
    const changedBatch =
      buildMemoryInformedNoticeApprovalBatchWithComputedSha256V1({
        ...changedInput,
        notices: [
          {
            ...changedInput.notices[0]!,
            noticeText: changedText,
            noticeSha256: sha256(changedText),
          },
        ],
      });
    expect(() =>
      verifyMemoryInformedNoticeGovernanceV1({
        ...value.input,
        batch: changedBatch,
      }),
    ).toThrow(/batch digest/);

    expect(() =>
      verifyMemoryInformedNoticeGovernanceV1({
        ...value.input,
        attestations: [
          value.attestations[0],
          { ...value.attestations[1], reviewId: "notice-review:other" },
        ],
      }),
    ).toThrow(/review ID/);
  });

  it("rejects invalid signatures, keys, or reviewer identities", () => {
    const value = fixture();
    expect(() =>
      verifyMemoryInformedNoticeGovernanceV1({
        ...value.input,
        attestations: [
          value.attestations[0],
          {
            ...value.attestations[1],
            signatureBase64url: value.attestations[0].signatureBase64url,
          },
        ],
      }),
    ).toThrow(/signature/);

    const wrongActorManifest = {
      ...value.manifest,
      keys: [
        value.manifest.keys[0],
        {
          ...value.manifest.keys[1],
          controllerActorId: "actor:33333333-3333-4333-8333-333333333333",
        },
      ],
    };
    expect(() =>
      verifyMemoryInformedNoticeGovernanceV1({
        ...value.input,
        trustedManifestSha256:
          memoryInformedNoticeTrustManifestSha256V1(wrongActorManifest),
        trustManifest: wrongActorManifest,
      }),
    ).toThrow(/key actor/);
  });

  it("enforces half-open manifest/key windows and current revocation", () => {
    const value = fixture();
    expect(() =>
      verifyMemoryInformedNoticeGovernanceV1({
        ...value.input,
        observedAt: value.manifest.expiresAt,
      }),
    ).toThrow(/half-open/);

    const revokedManifest = {
      ...value.manifest,
      keys: [
        {
          ...value.manifest.keys[0],
          revokedAt: "2026-09-05T10:15:00.000Z",
        },
        value.manifest.keys[1],
      ],
    };
    expect(() =>
      verifyMemoryInformedNoticeGovernanceV1({
        ...value.input,
        trustedManifestSha256:
          memoryInformedNoticeTrustManifestSha256V1(revokedManifest),
        trustManifest: revokedManifest,
      }),
    ).toThrow(/revoked/);
  });

  it("rejects noncanonical signatures and unmodeled trust claims", () => {
    const value = fixture();
    expect(() =>
      verifyMemoryInformedNoticeGovernanceV1({
        ...value.input,
        authorityGranted: true,
      }),
    ).toThrow();
    for (const attestation of [
      { ...value.attestations[0], signatureBase64url: "A".repeat(87) },
      { ...value.attestations[0], signatureBase64url: `${value.attestations[0].signatureBase64url}=` },
      { ...value.attestations[0], role: "legal_admin" },
      { ...value.attestations[0], reasoning: "approved because" },
    ]) {
      expect(() =>
        verifyMemoryInformedNoticeGovernanceV1({
          ...value.input,
          attestations: [attestation, value.attestations[1]],
        }),
      ).toThrow();
    }
  });
});
