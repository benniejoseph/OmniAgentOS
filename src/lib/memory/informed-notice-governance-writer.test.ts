import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import { describe, expect, it, vi } from "vitest";

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
import {
  persistApprovedMemoryInformedNoticeBatchV1,
  type MemoryInformedNoticeGovernanceWriterSql,
} from "@/lib/memory/informed-notice-governance-writer";

const RECORDER_ACTOR_ID = "actor:00000000-0000-4000-8000-000000000001";
const LEGAL_ACTOR_ID = "actor:11111111-1111-4111-8111-111111111111";
const PRIVACY_ACTOR_ID = "actor:22222222-2222-4222-8222-222222222222";
const INDEPENDENCE_ACTOR_ID =
  "actor:33333333-3333-4333-8333-333333333333";
const OBSERVED_AT = "2026-09-05T10:30:00.000Z";
const PLACEHOLDER_SIGNATURE = "A".repeat(86);

type KeyPair = Readonly<{
  privateKey: KeyObject;
  publicKeyBase64url: string;
}>;

describe("approved informed-notice governance writer", () => {
  it("persists exact reviewed evidence and notice copy in one supplied transaction", async () => {
    const value = fixture();
    const { sql, calls } = fakeWriterSql(value);

    const result = await persistApprovedMemoryInformedNoticeBatchV1(
      writerInput(value),
      sql,
    );

    expect(result).toMatchObject({
      noticeCount: 1,
      recordedAt: OBSERVED_AT,
      replayed: false,
      authorityGranted: false,
      runtimeAccepted: false,
      verification: {
        batchDigestValid: true,
        manifestDigestBound: true,
        authorityGranted: false,
        runtimeAccepted: false,
      },
    });
    expect(calls.map((call) => call.label)).toEqual([
      "lock",
      "table_lock",
      "preflight",
      "clock",
      "batch_insert",
      "contract_insert",
      "attestation_insert",
      "attestation_insert",
      "catalog_insert",
      "completeness",
    ]);
    expect(calls[2]?.text).toContain("version = 67");
    expect(calls[2]?.text).toContain("persistence_holds_removed");
    expect(calls[2]?.text).toContain(
      "omni_actor_memory_notice_receipts_issuance_hold_check",
    );
    expect(calls[4]?.params).toContain(RECORDER_ACTOR_ID);
    expect(calls[5]?.params).toContain(value.batch.notices[0]!.noticeText);
    expect(calls[6]?.params).toContain(
      value.attestations[0].signatureBase64url,
    );
  });

  it("rejects a non-transaction client before trust or database work", async () => {
    const value = fixture();
    const { sql, calls } = fakeWriterSql(value, {
      transactionScoped: false,
    });
    const resolveTrustedAnchor = vi.fn(async () => value.anchor);

    await expect(
      persistApprovedMemoryInformedNoticeBatchV1(
        { ...writerInput(value), resolveTrustedAnchor },
        sql,
      ),
    ).rejects.toThrow(/existing database transaction/i);
    expect(resolveTrustedAnchor).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("fails closed while the v55 or v66 persistence holds remain", async () => {
    const value = fixture();
    const { sql, calls } = fakeWriterSql(value, { preflightReady: false });

    await expect(
      persistApprovedMemoryInformedNoticeBatchV1(writerInput(value), sql),
    ).rejects.toThrow(/preflight failed closed/i);
    expect(calls.map((call) => call.label)).toEqual([
      "lock",
      "table_lock",
      "preflight",
    ]);
  });

  it("rejects self-asserted trust and non-independent review before writing", async () => {
    const value = fixture();
    const first = fakeWriterSql(value);
    await expect(
      persistApprovedMemoryInformedNoticeBatchV1(
        {
          ...writerInput(value),
          resolveTrustedAnchor: async () => ({
            ...value.anchor,
            trustedManifestSha256: "f".repeat(64),
          }),
        },
        first.sql,
      ),
    ).rejects.toThrow(/manifest digest binding/i);
    expect(first.calls.map((call) => call.label)).toEqual([
      "lock",
      "table_lock",
      "preflight",
    ]);

    const second = fakeWriterSql(value);
    await expect(
      persistApprovedMemoryInformedNoticeBatchV1(
        {
          ...writerInput(value),
          resolveTrustedAnchor: async () => ({
            ...value.anchor,
            independenceReviewedByActorId: LEGAL_ACTOR_ID,
          }),
        },
        second.sql,
      ),
    ).rejects.toThrow(/distinct from both notice reviewers/i);
    expect(second.calls).toEqual([]);
  });

  it("replays an exact committed batch but rejects changed persisted coordinates", async () => {
    const value = fixture();
    const replay = fakeWriterSql(value, { replay: true });
    const result = await persistApprovedMemoryInformedNoticeBatchV1(
      writerInput(value),
      replay.sql,
    );
    expect(result.replayed).toBe(true);
    expect(replay.calls.map((call) => call.label)).toEqual([
      "lock",
      "table_lock",
      "preflight",
      "clock",
      "batch_insert",
      "batch_select",
      "contract_insert",
      "contract_select",
      "attestation_insert",
      "attestation_select",
      "attestation_insert",
      "attestation_select",
      "catalog_insert",
      "catalog_select",
      "completeness",
    ]);

    const changed = fakeWriterSql(value, { changedBatch: true });
    await expect(
      persistApprovedMemoryInformedNoticeBatchV1(writerInput(value), changed.sql),
    ).rejects.toThrow(/approval batch binding changed/i);
    expect(changed.calls.map((call) => call.label)).toEqual([
      "lock",
      "table_lock",
      "preflight",
      "clock",
      "batch_insert",
    ]);
  });
});

function writerInput(value: ReturnType<typeof fixture>) {
  return {
    governanceScope: {
      schemaVersion: 1,
      scopeKind: "global_memory_informed_notice_governance",
      initiatingActorId: RECORDER_ACTOR_ID,
      executingPrincipalType: "user",
      executingPrincipalId: RECORDER_ACTOR_ID,
      correlationId: "correlation:notice-governance-writer",
      purpose: "memory.maintenance.v1",
    } as const,
    batch: value.batch,
    attestations: value.attestations,
    trustManifest: value.manifest,
    resolveTrustedAnchor: async () => value.anchor,
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function batchInput(): BuildMemoryInformedNoticeApprovalBatchWithComputedSha256V1Input {
  const text = "Asael may retrieve saved information when you ask a question.";
  return {
    schemaVersion: 1,
    approvalBatchId: "notice-approval-batch:writer",
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
        approvalBatchId: "notice-approval-batch:writer",
        governancePolicyId: "notice-governance:legal-privacy-review",
        governancePolicyVersion: 3,
        reviewSlot: "legal_reviewer",
        reviewId: "notice-review:legal:writer",
        reviewerActorId: LEGAL_ACTOR_ID,
        reviewedAt: "2026-09-05T10:00:00.000Z",
      },
      {
        schemaVersion: 1,
        approvalBatchId: "notice-approval-batch:writer",
        governancePolicyId: "notice-governance:legal-privacy-review",
        governancePolicyVersion: 3,
        reviewSlot: "privacy_reviewer",
        reviewId: "notice-review:privacy:writer",
        reviewerActorId: PRIVACY_ACTOR_ID,
        reviewedAt: "2026-09-05T10:01:00.000Z",
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
    manifestId: "notice-trust-manifest:writer",
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
        expiresAt: "2026-09-05T11:30:00.000Z",
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
        expiresAt: "2026-09-05T11:30:00.000Z",
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
    manifest,
    attestations,
    anchor: Object.freeze({
      schemaVersion: 1 as const,
      anchorKind: "externally_reviewed_trust_manifest_v1" as const,
      manifestId: manifest.manifestId,
      manifestRevision: manifest.manifestRevision,
      governancePolicyId: manifest.governancePolicyId,
      governancePolicyVersion: manifest.governancePolicyVersion,
      trustedManifestSha256,
      independenceReviewId: "notice-independence-review:writer",
      independenceReviewedByActorId: INDEPENDENCE_ACTOR_ID,
      independenceReviewedAt: "2026-09-05T10:05:00.000Z",
      humanIndependenceReviewed: true as const,
    }),
  };
}

function fakeWriterSql(
  value: ReturnType<typeof fixture>,
  options: {
    transactionScoped?: boolean;
    preflightReady?: boolean;
    replay?: boolean;
    changedBatch?: boolean;
  } = {},
) {
  const calls: Array<{ label: string; text: string; params: unknown[] }> = [];
  const verification = verifyMemoryInformedNoticeGovernanceV1({
    trustedManifestSha256: value.anchor.trustedManifestSha256,
    observedAt: OBSERVED_AT,
    batch: value.batch,
    attestations: value.attestations,
    trustManifest: value.manifest,
  });
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT current_user")) {
      calls.push({ label: "preflight", text: normalized, params });
      const ready = options.preflightReady !== false;
      return [
        {
          schema_owner: ready,
          system_scope: true,
          observed_at: OBSERVED_AT,
          v67_schema_valid: true,
          persistence_holds_removed: ready,
          catalog_hold_removed: ready,
          downstream_holds_valid: true,
          relations_valid: true,
          anchor_review_valid: true,
          owner_only: true,
        },
      ];
    }
    if (normalized.startsWith("SELECT pg_advisory_xact_lock")) {
      calls.push({ label: "lock", text: normalized, params });
      return [{}];
    }
    if (normalized.startsWith("LOCK TABLE")) {
      calls.push({ label: "table_lock", text: normalized, params });
      return [];
    }
    if (normalized === "SELECT statement_timestamp() AS observed_at") {
      calls.push({ label: "clock", text: normalized, params });
      return [{ observed_at: OBSERVED_AT }];
    }
    if (
      normalized.startsWith(
        "INSERT INTO omni_memory_informed_notice_approval_batches",
      )
    ) {
      calls.push({ label: "batch_insert", text: normalized, params });
      if (options.replay) return [];
      return [batchRow(value, verification, options.changedBatch)];
    }
    if (
      normalized.startsWith(
        "SELECT * FROM omni_memory_informed_notice_approval_batches",
      )
    ) {
      calls.push({ label: "batch_select", text: normalized, params });
      return [batchRow(value, verification, options.changedBatch)];
    }
    if (
      normalized.startsWith(
        "INSERT INTO omni_memory_informed_notice_approval_contracts",
      )
    ) {
      calls.push({ label: "contract_insert", text: normalized, params });
      return options.replay ? [] : [contractRow(params)];
    }
    if (
      normalized.startsWith(
        "SELECT * FROM omni_memory_informed_notice_approval_contracts",
      )
    ) {
      calls.push({ label: "contract_select", text: normalized, params });
      return [contractRow([
        1,
        value.batch.approvalBatchId,
        value.batch.batchSha256,
        params[1],
        1,
        value.batch.notices[0]!.purposeId,
        value.batch.notices[0]!.noticeContractId,
        value.batch.notices[0]!.noticeContractVersion,
        value.batch.notices[0]!.localeId,
        value.batch.notices[0]!.noticeText,
        value.batch.notices[0]!.noticeSha256,
      ])];
    }
    if (
      normalized.startsWith(
        "INSERT INTO omni_memory_informed_notice_review_attestations",
      )
    ) {
      calls.push({ label: "attestation_insert", text: normalized, params });
      return options.replay ? [] : [attestationRow(params)];
    }
    if (
      normalized.startsWith(
        "SELECT * FROM omni_memory_informed_notice_review_attestations",
      )
    ) {
      calls.push({ label: "attestation_select", text: normalized, params });
      const index = params[1] === "legal_reviewer" ? 0 : 1;
      const attestation = value.attestations[index];
      return [attestationRow([
        attestation.schemaVersion,
        value.batch.approvalBatchId,
        value.batch.batchSha256,
        value.batch.governancePolicyId,
        value.batch.governancePolicyVersion,
        verification.trustManifestSha256,
        value.manifest.issuedAt,
        OBSERVED_AT,
        attestation.reviewSlot,
        attestation.reviewId,
        attestation.reviewerActorId,
        attestation.reviewedAt,
        attestation.attesterKeyId,
        verification.attestations[index]!.publicKeySha256,
        attestation.signatureAlgorithm,
        attestation.signatureBase64url,
      ])];
    }
    if (
      normalized.startsWith(
        "INSERT INTO omni_memory_informed_notice_contracts",
      )
    ) {
      calls.push({ label: "catalog_insert", text: normalized, params });
      return options.replay ? [] : [catalogRow(params)];
    }
    if (
      normalized.startsWith(
        "SELECT * FROM omni_memory_informed_notice_contracts",
      )
    ) {
      calls.push({ label: "catalog_select", text: normalized, params });
      const notice = value.batch.notices[0]!;
      return [catalogRow([
        notice.recordSchemaVersion,
        notice.purposeId,
        notice.noticeContractId,
        notice.noticeContractVersion,
        notice.localeId,
        notice.noticeText,
        notice.noticeSha256,
      ])];
    }
    if (normalized.startsWith("SELECT (SELECT count(*)::int")) {
      calls.push({ label: "completeness", text: normalized, params });
      return [
        {
          contract_count: value.batch.notices.length,
          attestation_count: 2,
          catalog_match_count: value.batch.notices.length,
        },
      ];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  });
  const callable = vi.fn(async () => []) as unknown as
    MemoryInformedNoticeGovernanceWriterSql;
  Object.assign(callable, {
    query,
    unsafe: vi.fn(async () => []),
    transaction: vi.fn(),
    transactionScoped: options.transactionScoped !== false,
  });
  return { sql: callable, calls };
}

function batchRow(
  value: ReturnType<typeof fixture>,
  verification: ReturnType<typeof verifyMemoryInformedNoticeGovernanceV1>,
  changed = false,
) {
  return {
    schema_version: value.batch.schemaVersion,
    approval_batch_id: value.batch.approvalBatchId,
    batch_sha256: changed ? "f".repeat(64) : value.batch.batchSha256,
    governance_policy_id: value.batch.governancePolicyId,
    governance_policy_version: value.batch.governancePolicyVersion,
    decision_nonce_sha256: value.batch.decisionNonceSha256,
    evidence_sha256: value.batch.evidenceSha256,
    notice_count: value.batch.notices.length,
    verification_kind: verification.verificationKind,
    trust_manifest_id: value.manifest.manifestId,
    trust_manifest_revision: value.manifest.manifestRevision,
    trust_manifest_sha256: verification.trustManifestSha256,
    trust_manifest_issued_at: value.manifest.issuedAt,
    observed_at: OBSERVED_AT,
    recorded_by_actor_id: RECORDER_ACTOR_ID,
    independence_review_id: value.anchor.independenceReviewId,
    independence_reviewed_by_actor_id:
      value.anchor.independenceReviewedByActorId,
    independence_reviewed_at: value.anchor.independenceReviewedAt,
    human_independence_reviewed: true,
    recorded_at: OBSERVED_AT,
  };
}

function contractRow(params: unknown[]) {
  const names = [
    "schema_version",
    "approval_batch_id",
    "batch_sha256",
    "notice_ordinal",
    "record_schema_version",
    "purpose_id",
    "notice_contract_id",
    "notice_contract_version",
    "locale_id",
    "notice_text",
    "notice_sha256",
  ];
  return Object.fromEntries(names.map((name, index) => [name, params[index]]));
}

function attestationRow(params: unknown[]) {
  const names = [
    "schema_version",
    "approval_batch_id",
    "batch_sha256",
    "governance_policy_id",
    "governance_policy_version",
    "trust_manifest_sha256",
    "trust_manifest_issued_at",
    "observed_at",
    "review_slot",
    "review_id",
    "reviewer_actor_id",
    "reviewed_at",
    "attester_key_id",
    "public_key_sha256",
    "signature_algorithm",
    "signature_base64url",
  ];
  return Object.fromEntries(names.map((name, index) => [name, params[index]]));
}

function catalogRow(params: unknown[]) {
  const names = [
    "schema_version",
    "purpose_id",
    "notice_contract_id",
    "notice_contract_version",
    "locale_id",
    "notice_text",
    "notice_sha256",
  ];
  return {
    ...Object.fromEntries(names.map((name, index) => [name, params[index]])),
    created_at: OBSERVED_AT,
  };
}
