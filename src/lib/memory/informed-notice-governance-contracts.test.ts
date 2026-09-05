import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MEMORY_INFORMED_NOTICE_APPROVAL_PREIMAGE_DOMAIN,
  MEMORY_INFORMED_NOTICE_APPROVAL_PREIMAGE_VERSION,
  buildMemoryInformedNoticeApprovalBatchWithComputedSha256V1,
  canonicalMemoryInformedNoticeApprovalBatchPreimageV1,
  memoryInformedNoticeApprovalBatchSha256V1,
  parseMemoryInformedNoticeApprovalBatchV1,
  type BuildMemoryInformedNoticeApprovalBatchWithComputedSha256V1Input,
} from "@/lib/memory/informed-notice-governance-contracts";

const LEGAL_ACTOR_ID = "actor:11111111-1111-4111-8111-111111111111";
const PRIVACY_ACTOR_ID = "actor:22222222-2222-4222-8222-222222222222";
const LEGAL_REVIEWED_AT = "2026-09-05T10:00:00.000Z";
const PRIVACY_REVIEWED_AT = "2026-09-05T10:01:00.000Z";

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function input(): BuildMemoryInformedNoticeApprovalBatchWithComputedSha256V1Input {
  const firstText = "Asael may use saved preferences to personalize responses.";
  const secondText = "Asael may retrieve saved information when you ask a question.";
  return {
    schemaVersion: 1,
    approvalBatchId: "notice-approval-batch:2026-09-05",
    governancePolicyId: "notice-governance:legal-privacy-review",
    governancePolicyVersion: 1,
    decisionNonceSha256: "a".repeat(64),
    evidenceSha256: "b".repeat(64),
    notices: [
      {
        recordSchemaVersion: 1,
        purposeId: "memory.personalization.v1",
        noticeContractId: "notice:personalization",
        noticeContractVersion: 1,
        localeId: "en-US",
        noticeText: firstText,
        noticeSha256: sha256(firstText),
      },
      {
        recordSchemaVersion: 1,
        purposeId: "memory.retrieve.v1",
        noticeContractId: "notice:retrieval",
        noticeContractVersion: 1,
        localeId: "en-US",
        noticeText: secondText,
        noticeSha256: sha256(secondText),
      },
    ],
    reviews: [
      {
        schemaVersion: 1,
        approvalBatchId: "notice-approval-batch:2026-09-05",
        governancePolicyId: "notice-governance:legal-privacy-review",
        governancePolicyVersion: 1,
        reviewSlot: "legal_reviewer",
        reviewId: "notice-review:legal:2026-09-05",
        reviewerActorId: LEGAL_ACTOR_ID,
        reviewedAt: LEGAL_REVIEWED_AT,
      },
      {
        schemaVersion: 1,
        approvalBatchId: "notice-approval-batch:2026-09-05",
        governancePolicyId: "notice-governance:legal-privacy-review",
        governancePolicyVersion: 1,
        reviewSlot: "privacy_reviewer",
        reviewId: "notice-review:privacy:2026-09-05",
        reviewerActorId: PRIVACY_ACTOR_ID,
        reviewedAt: PRIVACY_REVIEWED_AT,
      },
    ],
  };
}

describe("informed-notice governance contracts", () => {
  it("builds a deeply frozen batch whose reviews bind the computed digest", () => {
    const batch =
      buildMemoryInformedNoticeApprovalBatchWithComputedSha256V1(input());

    expect(batch.batchSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(batch.reviews.map((review) => review.batchSha256)).toEqual([
      batch.batchSha256,
      batch.batchSha256,
    ]);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.notices)).toBe(true);
    expect(batch.notices.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(batch.reviews)).toBe(true);
    expect(batch.reviews.every(Object.isFrozen)).toBe(true);
  });

  it("uses a domain-separated deterministic preimage that pins exact wording", () => {
    const original = input();
    const first = canonicalMemoryInformedNoticeApprovalBatchPreimageV1(original);
    const reorderedObject = {
      notices: original.notices.map((notice) => ({ ...notice })),
      evidenceSha256: original.evidenceSha256,
      decisionNonceSha256: original.decisionNonceSha256,
      governancePolicyVersion: original.governancePolicyVersion,
      governancePolicyId: original.governancePolicyId,
      approvalBatchId: original.approvalBatchId,
      schemaVersion: original.schemaVersion,
    };
    const second = canonicalMemoryInformedNoticeApprovalBatchPreimageV1(
      reorderedObject,
    );

    expect(Buffer.from(first)).toEqual(Buffer.from(second));
    expect(Buffer.from(first).includes(Buffer.from(original.notices[0]!.noticeText))).toBe(
      true,
    );
    expect(MEMORY_INFORMED_NOTICE_APPROVAL_PREIMAGE_DOMAIN).toBe(
      "asael.memory.informed_notice_approval_batch",
    );
    expect(MEMORY_INFORMED_NOTICE_APPROVAL_PREIMAGE_VERSION).toBe(1);

    const changedText = `${original.notices[0]!.noticeText} Updated.`;
    const changed = {
      ...original,
      notices: [
        {
          ...original.notices[0]!,
          noticeText: changedText,
          noticeSha256: sha256(changedText),
        },
        original.notices[1]!,
      ],
    };
    expect(memoryInformedNoticeApprovalBatchSha256V1(changed)).not.toBe(
      memoryInformedNoticeApprovalBatchSha256V1(original),
    );
  });

  it("requires exact UTF-8 digests and standing-consent notice coordinates", () => {
    const original = input();
    const invalidNotices = [
      { ...original.notices[0]!, noticeSha256: "c".repeat(64) },
      { ...original.notices[0]!, purposeId: "memory.export.v1" },
      { ...original.notices[0]!, purposeId: "memory.forget.v1" },
      { ...original.notices[0]!, localeId: "en_US" },
      { ...original.notices[0]!, noticeText: ` ${original.notices[0]!.noticeText}` },
      { ...original.notices[0]!, noticeContractVersion: 0 },
      { ...original.notices[0]!, credentials: "forbidden" },
    ];

    for (const notice of invalidNotices) {
      expect(() =>
        canonicalMemoryInformedNoticeApprovalBatchPreimageV1({
          ...original,
          notices: [notice, original.notices[1]],
        }),
      ).toThrow();
    }
  });

  it("rejects duplicate or noncanonical contract ordering", () => {
    const original = input();
    for (const notices of [
      [original.notices[1], original.notices[0]],
      [original.notices[0], { ...original.notices[0] }],
    ]) {
      expect(() =>
        canonicalMemoryInformedNoticeApprovalBatchPreimageV1({
          ...original,
          notices,
        }),
      ).toThrow();
    }
  });

  it("requires two distinct, exactly bound legal and privacy reviews", () => {
    const batch =
      buildMemoryInformedNoticeApprovalBatchWithComputedSha256V1(input());
    const invalidReviews = [
      [batch.reviews[1], batch.reviews[0]],
      [
        batch.reviews[0],
        { ...batch.reviews[1], reviewerActorId: LEGAL_ACTOR_ID },
      ],
      [
        batch.reviews[0],
        { ...batch.reviews[1], reviewId: batch.reviews[0].reviewId },
      ],
      [
        batch.reviews[0],
        { ...batch.reviews[1], batchSha256: "d".repeat(64) },
      ],
      [
        batch.reviews[0],
        { ...batch.reviews[1], governancePolicyVersion: 2 },
      ],
    ];

    for (const reviews of invalidReviews) {
      expect(() =>
        parseMemoryInformedNoticeApprovalBatchV1({ ...batch, reviews }),
      ).toThrow();
    }
  });

  it("rejects unmodeled authority, narrative, secret, and metadata claims", () => {
    const batch =
      buildMemoryInformedNoticeApprovalBatchWithComputedSha256V1(input());
    for (const field of [
      "authorityGranted",
      "approved",
      "legalOpinion",
      "privacyOpinion",
      "credentials",
      "privateKey",
      "reasoning",
      "metadata",
    ]) {
      expect(() =>
        parseMemoryInformedNoticeApprovalBatchV1({
          ...batch,
          [field]: "forbidden",
        }),
      ).toThrow();
    }
  });
});
