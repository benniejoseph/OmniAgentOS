import { z } from "zod";

import {
  parseMemoryInformedNoticeApprovalBatchV1,
  type MemoryInformedNoticeApprovalBatchV1,
} from "@/lib/memory/informed-notice-governance-contracts";
import {
  memoryInformedNoticeReviewAttestationV1Schema,
  memoryInformedNoticeTrustManifestV1Schema,
  verifyMemoryInformedNoticeGovernanceV1,
  type MemoryInformedNoticeGovernanceVerificationV1,
  type MemoryInformedNoticeReviewAttestationV1,
  type MemoryInformedNoticeTrustManifestV1,
} from "@/lib/memory/informed-notice-governance-verifier";

export const MEMORY_INFORMED_NOTICE_GOVERNANCE_WRITER_PURPOSE =
  "memory.maintenance.v1" as const;
export const MEMORY_INFORMED_NOTICE_GLOBAL_GOVERNANCE_SCOPE_SCHEMA_VERSION =
  1 as const;
export const MEMORY_INFORMED_NOTICE_TRUST_ANCHOR_SCHEMA_VERSION = 1 as const;

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

export const memoryInformedNoticeGlobalGovernanceScopeV1Schema = z
  .object({
    schemaVersion: z.literal(
      MEMORY_INFORMED_NOTICE_GLOBAL_GOVERNANCE_SCOPE_SCHEMA_VERSION,
    ),
    scopeKind: z.literal("global_memory_informed_notice_governance"),
    initiatingActorId: canonicalActorIdSchema,
    executingPrincipalType: z.literal("user"),
    executingPrincipalId: canonicalActorIdSchema,
    correlationId: opaqueIdSchema,
    purpose: z.literal(MEMORY_INFORMED_NOTICE_GOVERNANCE_WRITER_PURPOSE),
  })
  .strict()
  .superRefine((scope, context) => {
    if (scope.executingPrincipalId !== scope.initiatingActorId) {
      context.addIssue({
        code: "custom",
        message: "Global notice governance requires the exact initiating human.",
        path: ["executingPrincipalId"],
      });
    }
  });

export const memoryInformedNoticeTrustedAnchorV1Schema = z
  .object({
    schemaVersion: z.literal(
      MEMORY_INFORMED_NOTICE_TRUST_ANCHOR_SCHEMA_VERSION,
    ),
    anchorKind: z.literal("externally_reviewed_trust_manifest_v1"),
    manifestId: opaqueIdSchema,
    manifestRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    governancePolicyId: opaqueIdSchema,
    governancePolicyVersion: z.number().int().min(1).max(32_767),
    trustedManifestSha256: lowercaseSha256Schema,
    independenceReviewId: opaqueIdSchema,
    independenceReviewedByActorId: canonicalActorIdSchema,
    independenceReviewedAt: canonicalTimestampSchema,
    humanIndependenceReviewed: z.literal(true),
  })
  .strict();

export type MemoryInformedNoticeGlobalGovernanceScopeV1 = Readonly<
  z.infer<typeof memoryInformedNoticeGlobalGovernanceScopeV1Schema>
>;
export type MemoryInformedNoticeTrustedAnchorV1 = Readonly<
  z.infer<typeof memoryInformedNoticeTrustedAnchorV1Schema>
>;
export type ResolveMemoryInformedNoticeTrustedAnchorV1 = (
  coordinates: Readonly<{
    manifestId: string;
    manifestRevision: number;
    governancePolicyId: string;
    governancePolicyVersion: number;
  }>,
) => Promise<MemoryInformedNoticeTrustedAnchorV1>;

type SqlRow = Record<string, unknown>;

export type MemoryInformedNoticeGovernanceWriterSql = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<SqlRow[]>;
  query: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  unsafe: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  transaction: (queriesOrFn: unknown, opts?: unknown) => Promise<unknown>;
  readonly transactionScoped: boolean;
};

export type PersistApprovedMemoryInformedNoticeBatchInputV1 = Readonly<{
  governanceScope: MemoryInformedNoticeGlobalGovernanceScopeV1;
  batch: unknown;
  attestations: readonly [unknown, unknown];
  trustManifest: unknown;
  resolveTrustedAnchor: ResolveMemoryInformedNoticeTrustedAnchorV1;
}>;

export type PersistApprovedMemoryInformedNoticeBatchResultV1 = Readonly<{
  batch: MemoryInformedNoticeApprovalBatchV1;
  attestations: readonly [
    MemoryInformedNoticeReviewAttestationV1,
    MemoryInformedNoticeReviewAttestationV1,
  ];
  verification: MemoryInformedNoticeGovernanceVerificationV1;
  recordedAt: string;
  noticeCount: number;
  replayed: boolean;
  authorityGranted: false;
  runtimeAccepted: false;
}>;

/**
 * Persists one externally approved global notice-copy batch inside an existing
 * schema-owner system transaction. There is no runtime client, route, default
 * trust resolver, environment lookup, event append, or serving call site.
 *
 * V67 deliberately prevents this function from succeeding. A separately
 * reviewed migration must first invoke the exact v65 verifier, remove only the
 * v55 catalog-seed and v66 persistence holds, and keep receipt, consent,
 * membership, and entitlement activation closed. This function rechecks that
 * narrow post-cutover shape before every write.
 */
export async function persistApprovedMemoryInformedNoticeBatchV1(
  input: PersistApprovedMemoryInformedNoticeBatchInputV1,
  sql: MemoryInformedNoticeGovernanceWriterSql,
): Promise<PersistApprovedMemoryInformedNoticeBatchResultV1> {
  if (!sql.transactionScoped) {
    throw new Error(
      "Informed-notice governance persistence requires an existing database transaction.",
    );
  }

  const governanceScope =
    memoryInformedNoticeGlobalGovernanceScopeV1Schema.parse(
      input.governanceScope,
    );
  const batch = parseMemoryInformedNoticeApprovalBatchV1(input.batch);
  const attestations = [
    memoryInformedNoticeReviewAttestationV1Schema.parse(input.attestations[0]),
    memoryInformedNoticeReviewAttestationV1Schema.parse(input.attestations[1]),
  ] as const;
  const trustManifest = memoryInformedNoticeTrustManifestV1Schema.parse(
    input.trustManifest,
  );
  const trustedAnchor = memoryInformedNoticeTrustedAnchorV1Schema.parse(
    await input.resolveTrustedAnchor(anchorCoordinates(trustManifest)),
  );
  assertAnchorBinding(trustedAnchor, trustManifest);
  if (
    batch.reviews.some(
      (review) =>
        review.reviewerActorId ===
        trustedAnchor.independenceReviewedByActorId,
    )
  ) {
    throw new Error(
      "Informed-notice independence reviewer must be distinct from both notice reviewers.",
    );
  }
  if (
    Date.parse(trustedAnchor.independenceReviewedAt) <
    Math.max(...batch.reviews.map((review) => Date.parse(review.reviewedAt)))
  ) {
    throw new Error(
      "Informed-notice independence review precedes the signed notice reviews.",
    );
  }

  // One global advisory key and a stable table-lock order serialize all notice
  // batches, including different batch IDs that target the same catalog tuple.
  await sql.query(
    `SELECT pg_advisory_xact_lock(
       hashtext('asael:memory-informed-notice-governance'), 66
     )`,
  );
  await sql.query(
    `LOCK TABLE
       omni_memory_informed_notice_approval_batches,
       omni_memory_informed_notice_approval_contracts,
       omni_memory_informed_notice_review_attestations,
       omni_memory_informed_notice_contracts
     IN SHARE ROW EXCLUSIVE MODE`,
  );

  const preflight = exactlyOne(
    await sql.query(NOTICE_GOVERNANCE_WRITER_PREFLIGHT_SQL),
    "informed-notice governance preflight",
  );
  if (
    preflight.schema_owner !== true ||
    preflight.system_scope !== true ||
    preflight.v67_schema_valid !== true ||
    preflight.persistence_holds_removed !== true ||
    preflight.catalog_hold_removed !== true ||
    preflight.downstream_holds_valid !== true ||
    preflight.relations_valid !== true ||
    preflight.anchor_review_valid !== true ||
    preflight.owner_only !== true
  ) {
    throw new Error(
      "Informed-notice governance persistence preflight failed closed.",
    );
  }
  const initialObservedAt = canonicalDatabaseTimestamp(
    preflight.observed_at,
    "preflight observation",
  );
  assertIndependenceReviewTime(trustedAnchor, initialObservedAt);
  verifyMemoryInformedNoticeGovernanceV1({
    trustedManifestSha256: trustedAnchor.trustedManifestSha256,
    observedAt: initialObservedAt,
    batch,
    attestations,
    trustManifest,
  });

  const finalObservedAt = canonicalDatabaseTimestamp(
    exactlyOne(
      await sql.query("SELECT statement_timestamp() AS observed_at"),
      "informed-notice governance persistence clock",
    ).observed_at,
    "persistence observation",
  );
  assertIndependenceReviewTime(trustedAnchor, finalObservedAt);
  const verification = verifyMemoryInformedNoticeGovernanceV1({
    trustedManifestSha256: trustedAnchor.trustedManifestSha256,
    observedAt: finalObservedAt,
    batch,
    attestations,
    trustManifest,
  });

  const batchInsert = await sql.query(
    `INSERT INTO omni_memory_informed_notice_approval_batches (
       schema_version, approval_batch_id, batch_sha256,
       governance_policy_id, governance_policy_version,
       decision_nonce_sha256, evidence_sha256, notice_count,
       verification_kind, trust_manifest_id, trust_manifest_revision,
       trust_manifest_sha256, trust_manifest_issued_at, observed_at,
       recorded_by_actor_id, independence_review_id,
       independence_reviewed_by_actor_id, independence_reviewed_at,
       human_independence_reviewed
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18, $19
     ) ON CONFLICT DO NOTHING RETURNING *`,
    [
      batch.schemaVersion,
      batch.approvalBatchId,
      batch.batchSha256,
      batch.governancePolicyId,
      batch.governancePolicyVersion,
      batch.decisionNonceSha256,
      batch.evidenceSha256,
      batch.notices.length,
      verification.verificationKind,
      trustManifest.manifestId,
      trustManifest.manifestRevision,
      verification.trustManifestSha256,
      trustManifest.issuedAt,
      finalObservedAt,
      governanceScope.initiatingActorId,
      trustedAnchor.independenceReviewId,
      trustedAnchor.independenceReviewedByActorId,
      trustedAnchor.independenceReviewedAt,
      trustedAnchor.humanIndependenceReviewed,
    ],
  );
  const replayed = batchInsert.length === 0;
  const persistedBatch = replayed
    ? exactlyOne(
        await sql.query(
          `SELECT *
           FROM omni_memory_informed_notice_approval_batches
           WHERE approval_batch_id = $1
           LIMIT 2 FOR SHARE`,
          [batch.approvalBatchId],
        ),
        "persisted informed-notice approval batch",
      )
    : exactlyOne(batchInsert, "informed-notice approval batch insert");
  const persistenceObservedAt = canonicalDatabaseTimestamp(
    persistedBatch.observed_at,
    "persisted batch observation",
  );
  if (
    (!replayed && persistenceObservedAt !== finalObservedAt) ||
    Date.parse(persistenceObservedAt) > Date.parse(finalObservedAt)
  ) {
    throw new Error(
      "Persisted informed-notice approval batch observation changed.",
    );
  }
  assertPersistedBatch(
    persistedBatch,
    batch,
    trustManifest,
    verification,
    governanceScope,
    trustedAnchor,
    persistenceObservedAt,
  );

  for (const [index, notice] of batch.notices.entries()) {
    const row = await insertOrLoadExact(
      sql,
      `INSERT INTO omni_memory_informed_notice_approval_contracts (
         schema_version, approval_batch_id, batch_sha256, notice_ordinal,
         record_schema_version, purpose_id, notice_contract_id,
         notice_contract_version, locale_id, notice_text, notice_sha256
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT DO NOTHING RETURNING *`,
      [
        batch.schemaVersion,
        batch.approvalBatchId,
        batch.batchSha256,
        index,
        notice.recordSchemaVersion,
        notice.purposeId,
        notice.noticeContractId,
        notice.noticeContractVersion,
        notice.localeId,
        notice.noticeText,
        notice.noticeSha256,
      ],
      `SELECT *
       FROM omni_memory_informed_notice_approval_contracts
       WHERE approval_batch_id = $1 AND notice_ordinal = $2
       LIMIT 2 FOR SHARE`,
      [batch.approvalBatchId, index],
      `informed-notice approval contract ${index}`,
    );
    assertPersistedNotice(row, batch, notice, index);
  }

  for (const [index, attestation] of attestations.entries()) {
    const verifiedAttestation = verification.attestations[index]!;
    const row = await insertOrLoadExact(
      sql,
      `INSERT INTO omni_memory_informed_notice_review_attestations (
         schema_version, approval_batch_id, batch_sha256,
         governance_policy_id, governance_policy_version,
         trust_manifest_sha256, trust_manifest_issued_at, observed_at,
         review_slot, review_id, reviewer_actor_id, reviewed_at,
         attester_key_id, public_key_sha256, signature_algorithm,
         signature_base64url
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16
       ) ON CONFLICT DO NOTHING RETURNING *`,
      [
        attestation.schemaVersion,
        batch.approvalBatchId,
        batch.batchSha256,
        batch.governancePolicyId,
        batch.governancePolicyVersion,
        verification.trustManifestSha256,
        trustManifest.issuedAt,
        persistenceObservedAt,
        attestation.reviewSlot,
        attestation.reviewId,
        attestation.reviewerActorId,
        attestation.reviewedAt,
        attestation.attesterKeyId,
        verifiedAttestation.publicKeySha256,
        attestation.signatureAlgorithm,
        attestation.signatureBase64url,
      ],
      `SELECT *
       FROM omni_memory_informed_notice_review_attestations
       WHERE approval_batch_id = $1 AND review_slot = $2
       LIMIT 2 FOR SHARE`,
      [batch.approvalBatchId, attestation.reviewSlot],
      `informed-notice review attestation ${attestation.reviewSlot}`,
    );
    assertPersistedAttestation(
      row,
      batch,
      attestation,
      verifiedAttestation.publicKeySha256,
      verification.trustManifestSha256,
      trustManifest,
      persistenceObservedAt,
    );
  }

  for (const notice of batch.notices) {
    const row = await insertOrLoadExact(
      sql,
      `INSERT INTO omni_memory_informed_notice_contracts (
         schema_version, purpose_id, notice_contract_id,
         notice_contract_version, locale_id, notice_text, notice_sha256
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING RETURNING *`,
      [
        notice.recordSchemaVersion,
        notice.purposeId,
        notice.noticeContractId,
        notice.noticeContractVersion,
        notice.localeId,
        notice.noticeText,
        notice.noticeSha256,
      ],
      `SELECT *
       FROM omni_memory_informed_notice_contracts
       WHERE purpose_id = $1 AND notice_contract_id = $2
         AND notice_contract_version = $3
       LIMIT 2 FOR SHARE`,
      [
        notice.purposeId,
        notice.noticeContractId,
        notice.noticeContractVersion,
      ],
      `live informed-notice contract ${notice.noticeContractId}`,
    );
    assertPersistedCatalogNotice(row, notice);
  }

  const completeness = exactlyOne(
    await sql.query(
      `SELECT
         (SELECT count(*)::int
          FROM omni_memory_informed_notice_approval_contracts
          WHERE approval_batch_id = $1) AS contract_count,
         (SELECT count(*)::int
          FROM omni_memory_informed_notice_review_attestations
          WHERE approval_batch_id = $1) AS attestation_count,
         (SELECT count(*)::int
          FROM omni_memory_informed_notice_approval_contracts evidence
          JOIN omni_memory_informed_notice_contracts catalog
            ON catalog.purpose_id = evidence.purpose_id
           AND catalog.notice_contract_id = evidence.notice_contract_id
           AND catalog.notice_contract_version = evidence.notice_contract_version
           AND catalog.locale_id = evidence.locale_id
           AND catalog.notice_text = evidence.notice_text
           AND catalog.notice_sha256 = evidence.notice_sha256
          WHERE evidence.approval_batch_id = $1) AS catalog_match_count`,
      [batch.approvalBatchId],
    ),
    "informed-notice governance completeness",
  );
  if (
    requiredNumber(completeness.contract_count, "contract count") !==
      batch.notices.length ||
    requiredNumber(completeness.attestation_count, "attestation count") !== 2 ||
    requiredNumber(completeness.catalog_match_count, "catalog match count") !==
      batch.notices.length
  ) {
    throw new Error(
      "Persisted informed-notice governance evidence is incomplete.",
    );
  }

  return Object.freeze({
    batch,
    attestations: Object.freeze(attestations),
    verification,
    recordedAt: canonicalDatabaseTimestamp(
      persistedBatch.recorded_at,
      "recorded time",
    ),
    noticeCount: batch.notices.length,
    replayed,
    authorityGranted: false,
    runtimeAccepted: false,
  });
}

const NOTICE_GOVERNANCE_WRITER_PREFLIGHT_SQL = `SELECT
  current_user = pg_get_userbyid(schema_relation.relowner) AS schema_owner,
  public.omni_system_scope_enabled() AS system_scope,
  statement_timestamp() AS observed_at,
  EXISTS (
    SELECT 1 FROM omni_schema_version
    WHERE version = 67
      AND name = 'memory_informed_notice_anchor_review_evidence_shadow'
      AND checksum = '6659ee684d50ec67c535c5d3f597347ab31143bd9d9ca9dc4748883b66935956'
  ) AS v67_schema_valid,
  NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname IN (
      'omni_notice_approval_batches_persistence_hold_check',
      'omni_notice_approval_contracts_persistence_hold_check',
      'omni_notice_review_attestations_persistence_hold_check'
    )
  ) AS persistence_holds_removed,
  NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'omni_memory_informed_notice_contracts'::regclass
      AND conname = 'omni_memory_informed_notice_contracts_seed_hold_check'
  ) AS catalog_hold_removed,
  (
    SELECT count(*) = 4 FROM pg_constraint
    WHERE (conrelid, conname, pg_get_expr(conbin, conrelid)) IN (
      ('omni_tenant_actor_memory_notice_receipts'::regclass,
       'omni_actor_memory_notice_receipts_issuance_hold_check', 'false'),
      ('omni_tenant_actor_memory_purpose_consents'::regclass,
       'omni_actor_memory_purpose_consents_grant_hold_check',
       '(state <> ''granted''::text)'),
      ('omni_tenant_actor_membership_epochs'::regclass,
       'omni_actor_membership_epochs_activation_hold_check',
       '(state <> ''active''::text)'),
      ('omni_tenant_memory_purpose_entitlements'::regclass,
       'omni_memory_purpose_entitlements_activation_hold_check',
       '(state <> ''active''::text)')
    ) AND contype = 'c' AND convalidated
  ) AS downstream_holds_valid,
  (
    SELECT count(*) = 4 FROM pg_class relation
    WHERE relation.oid IN (
      'omni_memory_informed_notice_contracts'::regclass,
      'omni_memory_informed_notice_approval_batches'::regclass,
      'omni_memory_informed_notice_approval_contracts'::regclass,
      'omni_memory_informed_notice_review_attestations'::regclass
    ) AND relation.relkind = 'r' AND relation.relpersistence = 'p'
      AND relation.relowner = schema_relation.relowner
      AND (
        relation.oid = 'omni_memory_informed_notice_contracts'::regclass
        OR (relation.relrowsecurity AND relation.relforcerowsecurity)
      )
  ) AS relations_valid,
  (
    SELECT count(*) = 4 FROM pg_attribute attribute
    WHERE attribute.attrelid =
        'omni_memory_informed_notice_approval_batches'::regclass
      AND attribute.attname IN (
        'independence_review_id',
        'independence_reviewed_by_actor_id',
        'independence_reviewed_at',
        'human_independence_reviewed'
      ) AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND attribute.attnotnull AND NOT attribute.atthasdef
      AND attribute.attgenerated = ''
  ) AND EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid =
        'omni_memory_informed_notice_approval_batches'::regclass
      AND conname = 'omni_notice_approval_batch_anchor_review_check'
      AND contype = 'c' AND convalidated
      AND pg_get_expr(conbin, conrelid) =
        'omni_notice_anchor_review_row_is_valid(independence_review_id, independence_reviewed_by_actor_id, independence_reviewed_at, trust_manifest_issued_at, observed_at, human_independence_reviewed)'
  ) AS anchor_review_valid,
  NOT EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE table_schema = current_schema()
      AND table_name IN (
        'omni_memory_informed_notice_contracts',
        'omni_memory_informed_notice_approval_batches',
        'omni_memory_informed_notice_approval_contracts',
        'omni_memory_informed_notice_review_attestations'
      ) AND grantee <> current_user
  ) AS owner_only
FROM pg_class schema_relation
WHERE schema_relation.oid = 'omni_schema_version'::regclass
LIMIT 1`;

function anchorCoordinates(manifest: MemoryInformedNoticeTrustManifestV1) {
  return Object.freeze({
    manifestId: manifest.manifestId,
    manifestRevision: manifest.manifestRevision,
    governancePolicyId: manifest.governancePolicyId,
    governancePolicyVersion: manifest.governancePolicyVersion,
  });
}

function assertAnchorBinding(
  anchor: MemoryInformedNoticeTrustedAnchorV1,
  manifest: MemoryInformedNoticeTrustManifestV1,
) {
  requireEqual("manifest ID", anchor.manifestId, manifest.manifestId);
  requireEqual(
    "manifest revision",
    anchor.manifestRevision,
    manifest.manifestRevision,
  );
  requireEqual(
    "governance policy ID",
    anchor.governancePolicyId,
    manifest.governancePolicyId,
  );
  requireEqual(
    "governance policy version",
    anchor.governancePolicyVersion,
    manifest.governancePolicyVersion,
  );
}

function assertIndependenceReviewTime(
  anchor: MemoryInformedNoticeTrustedAnchorV1,
  observedAt: string,
) {
  if (Date.parse(anchor.independenceReviewedAt) > Date.parse(observedAt)) {
    throw new Error(
      "Informed-notice independence review follows the database observation.",
    );
  }
}

async function insertOrLoadExact(
  sql: MemoryInformedNoticeGovernanceWriterSql,
  insertText: string,
  insertParams: unknown[],
  selectText: string,
  selectParams: unknown[],
  label: string,
) {
  const inserted = await sql.query(insertText, insertParams);
  if (inserted.length > 1) {
    throw new Error(`Expected at most one ${label} insert row.`);
  }
  return inserted.length === 1
    ? inserted[0]!
    : exactlyOne(await sql.query(selectText, selectParams), label);
}

function assertPersistedBatch(
  row: SqlRow,
  batch: MemoryInformedNoticeApprovalBatchV1,
  manifest: MemoryInformedNoticeTrustManifestV1,
  verification: MemoryInformedNoticeGovernanceVerificationV1,
  scope: MemoryInformedNoticeGlobalGovernanceScopeV1,
  trustedAnchor: MemoryInformedNoticeTrustedAnchorV1,
  observedAt: string,
) {
  const expected: ReadonlyArray<readonly [string, unknown]> = [
    ["schema_version", batch.schemaVersion],
    ["approval_batch_id", batch.approvalBatchId],
    ["batch_sha256", batch.batchSha256],
    ["governance_policy_id", batch.governancePolicyId],
    ["governance_policy_version", batch.governancePolicyVersion],
    ["decision_nonce_sha256", batch.decisionNonceSha256],
    ["evidence_sha256", batch.evidenceSha256],
    ["notice_count", batch.notices.length],
    ["verification_kind", verification.verificationKind],
    ["trust_manifest_id", manifest.manifestId],
    ["trust_manifest_revision", manifest.manifestRevision],
    ["trust_manifest_sha256", verification.trustManifestSha256],
    ["trust_manifest_issued_at", manifest.issuedAt],
    ["observed_at", observedAt],
    ["recorded_by_actor_id", scope.initiatingActorId],
    ["independence_review_id", trustedAnchor.independenceReviewId],
    [
      "independence_reviewed_by_actor_id",
      trustedAnchor.independenceReviewedByActorId,
    ],
    ["independence_reviewed_at", trustedAnchor.independenceReviewedAt],
    ["human_independence_reviewed", true],
  ];
  assertRowBindings(row, expected, "approval batch");
  canonicalDatabaseTimestamp(row.recorded_at, "recorded time");
}

function assertPersistedNotice(
  row: SqlRow,
  batch: MemoryInformedNoticeApprovalBatchV1,
  notice: MemoryInformedNoticeApprovalBatchV1["notices"][number],
  index: number,
) {
  assertRowBindings(
    row,
    [
      ["schema_version", batch.schemaVersion],
      ["approval_batch_id", batch.approvalBatchId],
      ["batch_sha256", batch.batchSha256],
      ["notice_ordinal", index],
      ["record_schema_version", notice.recordSchemaVersion],
      ["purpose_id", notice.purposeId],
      ["notice_contract_id", notice.noticeContractId],
      ["notice_contract_version", notice.noticeContractVersion],
      ["locale_id", notice.localeId],
      ["notice_text", notice.noticeText],
      ["notice_sha256", notice.noticeSha256],
    ],
    "approval notice",
  );
}

function assertPersistedAttestation(
  row: SqlRow,
  batch: MemoryInformedNoticeApprovalBatchV1,
  attestation: MemoryInformedNoticeReviewAttestationV1,
  publicKeySha256: string,
  trustManifestSha256: string,
  manifest: MemoryInformedNoticeTrustManifestV1,
  observedAt: string,
) {
  assertRowBindings(
    row,
    [
      ["schema_version", attestation.schemaVersion],
      ["approval_batch_id", batch.approvalBatchId],
      ["batch_sha256", batch.batchSha256],
      ["governance_policy_id", batch.governancePolicyId],
      ["governance_policy_version", batch.governancePolicyVersion],
      ["trust_manifest_sha256", trustManifestSha256],
      ["trust_manifest_issued_at", manifest.issuedAt],
      ["observed_at", observedAt],
      ["review_slot", attestation.reviewSlot],
      ["review_id", attestation.reviewId],
      ["reviewer_actor_id", attestation.reviewerActorId],
      ["reviewed_at", attestation.reviewedAt],
      ["attester_key_id", attestation.attesterKeyId],
      ["public_key_sha256", publicKeySha256],
      ["signature_algorithm", attestation.signatureAlgorithm],
      ["signature_base64url", attestation.signatureBase64url],
    ],
    "review attestation",
  );
}

function assertPersistedCatalogNotice(
  row: SqlRow,
  notice: MemoryInformedNoticeApprovalBatchV1["notices"][number],
) {
  assertRowBindings(
    row,
    [
      ["schema_version", notice.recordSchemaVersion],
      ["purpose_id", notice.purposeId],
      ["notice_contract_id", notice.noticeContractId],
      ["notice_contract_version", notice.noticeContractVersion],
      ["locale_id", notice.localeId],
      ["notice_text", notice.noticeText],
      ["notice_sha256", notice.noticeSha256],
    ],
    "catalog notice",
  );
  canonicalDatabaseTimestamp(row.created_at, "catalog notice creation time");
}

function assertRowBindings(
  row: SqlRow,
  expected: ReadonlyArray<readonly [string, unknown]>,
  label: string,
) {
  for (const [field, value] of expected) {
    const actual = row[field];
    if (typeof value === "number") {
      if (requiredNumber(actual, `${label} ${field}`) !== value) {
        throw new Error(`Persisted informed-notice ${label} binding changed.`);
      }
      continue;
    }
    if (field.endsWith("_at")) {
      if (canonicalDatabaseTimestamp(actual, `${label} ${field}`) !== value) {
        throw new Error(`Persisted informed-notice ${label} binding changed.`);
      }
      continue;
    }
    if (actual !== value) {
      throw new Error(`Persisted informed-notice ${label} binding changed.`);
    }
  }
}

function exactlyOne(rows: SqlRow[], label: string) {
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one ${label} row.`);
  }
  return rows[0]!;
}

function requiredNumber(value: unknown, label: string) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new Error(`Invalid ${label}.`);
  }
  return numeric;
}

function canonicalDatabaseTimestamp(value: unknown, label: string) {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (
    typeof timestamp !== "string" ||
    !canonicalTimestampSchema.safeParse(timestamp).success
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return timestamp;
}

function requireEqual(label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Informed-notice ${label} binding failed.`);
  }
}
