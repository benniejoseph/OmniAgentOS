import { z } from "zod";

import { appendScopedDomainEvent, type DomainEvent } from "@/lib/events/store";
import {
  assertMemoryMembershipManagementAuthorityRecordEventBindingV1,
  buildMemoryMembershipManagementAuthorityEventV1,
  parseMemoryMembershipManagementAuthorityRecordV1,
  type MemoryMembershipManagementAuthorityRecordV1,
} from "@/lib/memory/authority-contracts";
import {
  parseMemoryMembershipManagementBootstrapAttestationBundleV1,
  parseMemoryMembershipManagementBootstrapDecisionRecordV1,
  type MemoryMembershipManagementBootstrapAttestationBundleV1,
  type MemoryMembershipManagementBootstrapDecisionRecordV1,
} from "@/lib/memory/bootstrap-governance-contracts";
import {
  parseMemoryMembershipManagementBootstrapTrustManifestV1,
  verifyMemoryMembershipManagementBootstrapGovernanceV1,
  type MemoryMembershipManagementBootstrapGovernanceVerificationV1,
  type MemoryMembershipManagementBootstrapTrustManifestV1,
} from "@/lib/memory/bootstrap-governance-verifier";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_WRITER_PURPOSE =
  "memory.maintenance.v1" as const;
export const MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_ANCHOR_SCHEMA_VERSION =
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

export const memoryMembershipManagementBootstrapTrustedAnchorV1Schema = z
  .object({
    schemaVersion: z.literal(
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_TRUST_ANCHOR_SCHEMA_VERSION,
    ),
    anchorKind: z.literal("externally_reviewed_trust_manifest_v1"),
    tenantId: opaqueIdSchema,
    logicalDatabaseIdentityId: z.string().regex(/^[0-9a-f]{32}$/),
    manifestId: opaqueIdSchema,
    manifestRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    ceremonyPolicyId: opaqueIdSchema,
    ceremonyPolicyVersion: z.number().int().min(1).max(32_767),
    trustedManifestSha256: lowercaseSha256Schema,
    independenceReviewId: opaqueIdSchema,
    independenceReviewedByActorId: canonicalActorIdSchema,
    independenceReviewedAt: canonicalTimestampSchema,
    humanIndependenceReviewed: z.literal(true),
  })
  .strict();

export type MemoryMembershipManagementBootstrapTrustedAnchorV1 = Readonly<
  z.infer<
    typeof memoryMembershipManagementBootstrapTrustedAnchorV1Schema
  >
>;

export type ResolveMemoryMembershipManagementBootstrapTrustedAnchorV1 = (
  coordinates: Readonly<{
    tenantId: string;
    logicalDatabaseIdentityId: string;
    manifestId: string;
    manifestRevision: number;
    ceremonyPolicyId: string;
    ceremonyPolicyVersion: number;
  }>,
) => Promise<MemoryMembershipManagementBootstrapTrustedAnchorV1>;

type SqlRow = Record<string, unknown>;

export type MemoryMembershipManagementBootstrapWriterSql = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<SqlRow[]>;
  query: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  unsafe: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  transaction: (queriesOrFn: unknown, opts?: unknown) => Promise<unknown>;
  readonly transactionScoped: boolean;
};

export type RecordHeldMembershipManagementAuthorityInputV1 = Readonly<{
  executionScope: ExecutionScope;
  decision: unknown;
  attestationBundle: unknown;
  trustManifest: unknown;
  resolveTrustedAnchor:
    ResolveMemoryMembershipManagementBootstrapTrustedAnchorV1;
}>;

export type RecordHeldMembershipManagementAuthorityResultV1 = Readonly<{
  decision: MemoryMembershipManagementBootstrapDecisionRecordV1;
  attestationBundle: MemoryMembershipManagementBootstrapAttestationBundleV1;
  verification: MemoryMembershipManagementBootstrapGovernanceVerificationV1;
  authority: MemoryMembershipManagementAuthorityRecordV1;
  event: DomainEvent;
  authorityGranted: false;
  runtimeAccepted: false;
}>;

/**
 * Persists one externally authorized bootstrap ceremony inside an existing
 * schema-owner transaction. There is deliberately no runtime client, route,
 * environment lookup, or default trust-anchor resolver in this module.
 *
 * The resolver is the authorization boundary: it must read an independently
 * anchored, rollback-protected registry and must not derive trust from the
 * supplied manifest. Cryptographic consistency alone is insufficient.
 * Successful persistence creates only a held v56 authority and a matching
 * typed event. It cannot activate memory access or change any RLS/ACL hold.
 */
export async function recordHeldMembershipManagementAuthorityV1(
  input: RecordHeldMembershipManagementAuthorityInputV1,
  sql: MemoryMembershipManagementBootstrapWriterSql,
): Promise<RecordHeldMembershipManagementAuthorityResultV1> {
  if (!sql.transactionScoped) {
    throw new Error(
      "Bootstrap governance persistence requires an existing database transaction.",
    );
  }

  const executionScope = parsePersistedExecutionScope(input.executionScope);
  if (!executionScope || !executionScope.initiatingActorId) {
    throw new Error("Bootstrap governance persistence requires an attributed execution scope.");
  }
  if (
    executionScope.executingPrincipalType !== "user" ||
    executionScope.executingPrincipalId !== executionScope.initiatingActorId ||
    executionScope.purpose !==
      MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_WRITER_PURPOSE
  ) {
    throw new Error("Bootstrap governance persistence requires the exact human maintenance scope.");
  }

  const requestedDecision =
    parseMemoryMembershipManagementBootstrapDecisionRecordV1(input.decision);
  const requestedBundle =
    parseMemoryMembershipManagementBootstrapAttestationBundleV1(
      requestedDecision,
      input.attestationBundle,
    );
  const trustManifest =
    parseMemoryMembershipManagementBootstrapTrustManifestV1(
      input.trustManifest,
    );
  requireEqual("tenant", executionScope.tenantId, requestedDecision.tenantId);
  requireEqual(
    "recording actor",
    executionScope.initiatingActorId,
    requestedDecision.recordedByActorId,
  );

  const trustedAnchor = memoryMembershipManagementBootstrapTrustedAnchorV1Schema.parse(
    await input.resolveTrustedAnchor(anchorCoordinates(trustManifest)),
  );
  assertAnchorBinding(trustedAnchor, trustManifest);

  const preflightRows = await sql.query(
    `SELECT
       current_user = pg_get_userbyid(schema_relation.relowner) AS schema_owner,
       public.omni_system_scope_enabled() AS system_scope,
       database_identity.id AS database_identity_id,
       statement_timestamp() AS observed_at,
       EXISTS (
         SELECT 1 FROM omni_schema_version
         WHERE version = 57
           AND name = 'membership_management_bootstrap_evidence_shadow'
           AND checksum = '8a06a730f9da8eea20b3c1abf9937369451550865ecbdf27c0019047b80f151b'
       ) AS bootstrap_schema_valid,
       EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid =
           'omni_tenant_actor_membership_management_authorities'::regclass
           AND conname =
             'omni_membership_management_authority_activation_hold_check'
           AND contype = 'c'
           AND convalidated
           AND pg_get_expr(conbin, conrelid) = '(state <> ''active''::text)'
       ) AS activation_hold_valid
     FROM pg_class schema_relation
     CROSS JOIN omni_database_identity database_identity
     WHERE schema_relation.oid = 'omni_schema_version'::regclass
     LIMIT 1`,
  );
  const preflight = exactlyOne(preflightRows, "bootstrap governance preflight");
  if (
    preflight.schema_owner !== true ||
    preflight.system_scope !== true ||
    preflight.bootstrap_schema_valid !== true ||
    preflight.activation_hold_valid !== true
  ) {
    throw new Error("Bootstrap governance persistence preflight failed closed.");
  }
  const databaseIdentityId = requiredString(
    preflight.database_identity_id,
    "database identity",
  );
  requireEqual(
    "logical database identity",
    databaseIdentityId,
    requestedDecision.databaseIdentityId,
  );
  const initialObservedAt = canonicalDatabaseTimestamp(
    preflight.observed_at,
    "preflight observation",
  );
  if (
    Date.parse(trustedAnchor.independenceReviewedAt) >
    Date.parse(initialObservedAt)
  ) {
    throw new Error(
      "Bootstrap governance independence review follows the trusted database observation.",
    );
  }
  verifyMemoryMembershipManagementBootstrapGovernanceV1({
    expectedLogicalDatabaseIdentityId: databaseIdentityId,
    trustedManifestSha256: trustedAnchor.trustedManifestSha256,
    observedAt: initialObservedAt,
    decision: requestedDecision,
    attestationBundle: requestedBundle,
    trustManifest,
  });

  const decisionRows = await sql.query(
    `INSERT INTO omni_membership_management_bootstrap_decisions (
       schema_version, tenant_id, governance_decision_id,
       database_identity_id, subject_actor_id, grantee_actor_id,
       management_authority_id, authority_generation, decision_action,
       ceremony_policy_id, ceremony_policy_version, trust_manifest_sha256,
       decision_nonce_sha256, evidence_sha256, decision_sha256,
       not_before, expires_at, state, lifecycle_revision,
       recorded_by_actor_id, recorded_at, verified_by_actor_id, verified_at,
       consumed_by_actor_id, consumed_at, revoked_by_actor_id, revoked_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21, NULL, NULL, NULL, NULL, NULL, NULL
     ) RETURNING *`,
    decisionParams(requestedDecision),
  );
  const persistedDecision = decisionFromRow(
    exactlyOne(decisionRows, "bootstrap governance decision insert"),
  );

  const verificationRows = await sql.query(
    "SELECT statement_timestamp() AS observed_at",
  );
  const verifiedObservedAt = canonicalDatabaseTimestamp(
    exactlyOne(verificationRows, "bootstrap governance verification clock")
      .observed_at,
    "verification observation",
  );
  const verification =
    verifyMemoryMembershipManagementBootstrapGovernanceV1({
      expectedLogicalDatabaseIdentityId: databaseIdentityId,
      trustedManifestSha256: trustedAnchor.trustedManifestSha256,
      observedAt: verifiedObservedAt,
      decision: persistedDecision,
      attestationBundle: requestedBundle,
      trustManifest,
    });

  for (const attestation of requestedBundle.attestations) {
    await sql.query(
      `INSERT INTO omni_membership_management_bootstrap_attestations (
         schema_version, tenant_id, governance_decision_id, decision_sha256,
         attester_slot, attester_key_id, signature_algorithm,
         signature_base64url, attested_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        attestation.schemaVersion,
        attestation.tenantId,
        attestation.governanceDecisionId,
        attestation.decisionSha256,
        attestation.attesterSlot,
        attestation.attesterKeyId,
        attestation.signatureAlgorithm,
        attestation.signatureBase64url,
        attestation.attestedAt,
      ],
    );
  }

  const authorityRows = await sql.query(
    `INSERT INTO omni_tenant_actor_membership_management_authorities (
       schema_version, tenant_id, subject_actor_id, grantee_actor_id,
       management_authority_id, authority_generation, state,
       lifecycle_revision, created_by_actor_id, activated_by_actor_id,
       revoked_by_actor_id, created_at, activated_at, revoked_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'held', 0, $7, NULL, NULL,
       statement_timestamp(), NULL, NULL, statement_timestamp())
     RETURNING *`,
    [
      1,
      persistedDecision.tenantId,
      persistedDecision.subjectActorId,
      persistedDecision.granteeActorId,
      persistedDecision.managementAuthorityId,
      persistedDecision.authorityGeneration,
      executionScope.initiatingActorId,
    ],
  );
  const authority = authorityFromRow(
    exactlyOne(authorityRows, "held membership management authority insert"),
  );
  const authorityEvent = buildMemoryMembershipManagementAuthorityEventV1({
    tenantId: authority.tenantId,
    subjectActorId: authority.subjectActorId,
    granteeActorId: authority.granteeActorId,
    managementAuthorityId: authority.managementAuthorityId,
    authorityGeneration: authority.authorityGeneration,
    governanceDecisionId: persistedDecision.governanceDecisionId,
    decisionActorId: authority.createdByActorId,
    decisionAt: authority.createdAt,
    state: "held",
    lifecycleRevision: 0,
  });
  assertMemoryMembershipManagementAuthorityRecordEventBindingV1(
    authority,
    authorityEvent,
  );
  const event = await appendScopedDomainEvent(
    {
      id: `memory-mm-authority-held:${persistedDecision.decisionSha256}`,
      streamId: `memory-authority:${authority.tenantId}:${authority.managementAuthorityId}`,
      type: authorityEvent.type,
      payload: authorityEvent.payload,
      executionScope,
    },
    { sql },
  );

  return Object.freeze({
    decision: persistedDecision,
    attestationBundle: requestedBundle,
    verification,
    authority,
    event,
    authorityGranted: false as const,
    runtimeAccepted: false as const,
  });
}

function anchorCoordinates(
  manifest: MemoryMembershipManagementBootstrapTrustManifestV1,
) {
  return Object.freeze({
    tenantId: manifest.tenantId,
    logicalDatabaseIdentityId: manifest.logicalDatabaseIdentityId,
    manifestId: manifest.manifestId,
    manifestRevision: manifest.manifestRevision,
    ceremonyPolicyId: manifest.ceremonyPolicyId,
    ceremonyPolicyVersion: manifest.ceremonyPolicyVersion,
  });
}

function assertAnchorBinding(
  anchor: MemoryMembershipManagementBootstrapTrustedAnchorV1,
  manifest: MemoryMembershipManagementBootstrapTrustManifestV1,
) {
  requireEqual("anchor tenant", anchor.tenantId, manifest.tenantId);
  requireEqual(
    "anchor database identity",
    anchor.logicalDatabaseIdentityId,
    manifest.logicalDatabaseIdentityId,
  );
  requireEqual("anchor manifest ID", anchor.manifestId, manifest.manifestId);
  requireEqual(
    "anchor manifest revision",
    anchor.manifestRevision,
    manifest.manifestRevision,
  );
  requireEqual(
    "anchor ceremony policy ID",
    anchor.ceremonyPolicyId,
    manifest.ceremonyPolicyId,
  );
  requireEqual(
    "anchor ceremony policy version",
    anchor.ceremonyPolicyVersion,
    manifest.ceremonyPolicyVersion,
  );
}

function decisionParams(
  decision: MemoryMembershipManagementBootstrapDecisionRecordV1,
) {
  return [
    decision.schemaVersion,
    decision.tenantId,
    decision.governanceDecisionId,
    decision.databaseIdentityId,
    decision.subjectActorId,
    decision.granteeActorId,
    decision.managementAuthorityId,
    decision.authorityGeneration,
    decision.decisionAction,
    decision.ceremonyPolicyId,
    decision.ceremonyPolicyVersion,
    decision.trustManifestSha256,
    decision.decisionNonceSha256,
    decision.evidenceSha256,
    decision.decisionSha256,
    decision.notBefore,
    decision.expiresAt,
    decision.state,
    decision.lifecycleRevision,
    decision.recordedByActorId,
    decision.recordedAt,
  ];
}

function decisionFromRow(row: SqlRow) {
  return parseMemoryMembershipManagementBootstrapDecisionRecordV1({
    schemaVersion: Number(row.schema_version),
    tenantId: row.tenant_id,
    governanceDecisionId: row.governance_decision_id,
    databaseIdentityId: row.database_identity_id,
    subjectActorId: row.subject_actor_id,
    granteeActorId: row.grantee_actor_id,
    managementAuthorityId: row.management_authority_id,
    authorityGeneration: Number(row.authority_generation),
    decisionAction: row.decision_action,
    ceremonyPolicyId: row.ceremony_policy_id,
    ceremonyPolicyVersion: Number(row.ceremony_policy_version),
    trustManifestSha256: row.trust_manifest_sha256,
    decisionNonceSha256: row.decision_nonce_sha256,
    evidenceSha256: row.evidence_sha256,
    decisionSha256: row.decision_sha256,
    notBefore: canonicalDatabaseTimestamp(row.not_before, "decision notBefore"),
    expiresAt: canonicalDatabaseTimestamp(row.expires_at, "decision expiresAt"),
    state: row.state,
    lifecycleRevision: Number(row.lifecycle_revision),
    recordedByActorId: row.recorded_by_actor_id,
    recordedAt: canonicalDatabaseTimestamp(row.recorded_at, "decision recordedAt"),
    verifiedByActorId: row.verified_by_actor_id,
    verifiedAt: row.verified_at,
    consumedByActorId: row.consumed_by_actor_id,
    consumedAt: row.consumed_at,
    revokedByActorId: row.revoked_by_actor_id,
    revokedAt: row.revoked_at,
  });
}

function authorityFromRow(row: SqlRow) {
  return parseMemoryMembershipManagementAuthorityRecordV1({
    schemaVersion: Number(row.schema_version),
    tenantId: row.tenant_id,
    subjectActorId: row.subject_actor_id,
    granteeActorId: row.grantee_actor_id,
    managementAuthorityId: row.management_authority_id,
    authorityGeneration: Number(row.authority_generation),
    state: row.state,
    lifecycleRevision: Number(row.lifecycle_revision),
    createdByActorId: row.created_by_actor_id,
    activatedByActorId: row.activated_by_actor_id,
    revokedByActorId: row.revoked_by_actor_id,
    createdAt: canonicalDatabaseTimestamp(row.created_at, "authority createdAt"),
    activatedAt: row.activated_at,
    revokedAt: row.revoked_at,
    updatedAt: canonicalDatabaseTimestamp(row.updated_at, "authority updatedAt"),
  });
}

function exactlyOne(rows: SqlRow[], label: string): SqlRow {
  if (rows.length !== 1) {
    throw new Error(`${label} must return exactly one row.`);
  }
  return rows[0];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function canonicalDatabaseTimestamp(value: unknown, label: string): string {
  const timestamp = value instanceof Date
    ? value.toISOString()
    : typeof value === "string"
      ? new Date(value).toISOString()
      : "";
  if (!timestamp) throw new Error(`${label} is invalid.`);
  return canonicalTimestampSchema.parse(timestamp);
}

function requireEqual(
  label: string,
  actual: string | number,
  expected: string | number,
) {
  if (actual !== expected) {
    throw new Error(`Bootstrap governance ${label} binding failed.`);
  }
}
