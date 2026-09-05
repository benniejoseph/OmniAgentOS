import { generateKeyPairSync, sign } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const eventMocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: eventMocks.appendScopedDomainEvent,
}));

import {
  buildMemoryMembershipManagementBootstrapAttestationBundleV1,
  buildMemoryMembershipManagementBootstrapAttestationRecordV1,
  buildMemoryMembershipManagementBootstrapDecisionRecordWithComputedSha256V1,
  canonicalMemoryMembershipManagementBootstrapDecisionPreimageV1,
} from "@/lib/memory/bootstrap-governance-contracts";
import {
  memoryMembershipManagementBootstrapTrustManifestSha256V1,
  parseMemoryMembershipManagementBootstrapTrustManifestV1,
} from "@/lib/memory/bootstrap-governance-verifier";
import {
  MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_WRITER_PURPOSE,
  recordHeldMembershipManagementAuthorityV1,
  type MemoryMembershipManagementBootstrapWriterSql,
} from "@/lib/memory/bootstrap-governance-writer";
import { createExecutionScope } from "@/lib/security/execution-scope";

const TENANT_ID = "tenant:bootstrap-writer";
const DATABASE_ID = "1234567890abcdef1234567890abcdef";
const RECORDER_ID = "actor:00000000-0000-4000-8000-000000000001";
const SUBJECT_ID = "actor:00000000-0000-4000-8000-000000000002";
const GRANTEE_ID = "actor:00000000-0000-4000-8000-000000000003";
const CUSTODIAN_ID = "actor:00000000-0000-4000-8000-000000000004";
const REVIEWER_ID = "actor:00000000-0000-4000-8000-000000000005";
const NOT_BEFORE = "2026-09-05T09:30:00.000Z";
const EXPIRES_AT = "2026-09-05T09:40:00.000Z";
const OBSERVED_AT = "2026-09-05T09:34:00.000Z";

describe("held membership-management bootstrap writer", () => {
  beforeEach(() => {
    eventMocks.appendScopedDomainEvent.mockReset();
    eventMocks.appendScopedDomainEvent.mockImplementation(async (input) => ({
      id: input.id,
      seq: 41,
      streamId: input.streamId,
      type: input.type,
      tenantId: input.executionScope.tenantId,
      actorId: input.executionScope.initiatingActorId,
      payload: input.payload,
      correlationId: input.executionScope.correlationId,
      executionScope: input.executionScope,
      at: OBSERVED_AT,
    }));
  });

  it("persists verified evidence, one held authority, and its event through one transaction client", async () => {
    const fixture = governanceFixture();
    const { sql, calls } = fakeTransactionSql(fixture);

    const result = await recordHeldMembershipManagementAuthorityV1(
      {
        executionScope: maintenanceScope(),
        decision: fixture.decision,
        attestationBundle: fixture.bundle,
        trustManifest: fixture.manifest,
        resolveTrustedAnchor: async (coordinates) => {
          expect(coordinates).toEqual({
            tenantId: TENANT_ID,
            logicalDatabaseIdentityId: DATABASE_ID,
            manifestId: fixture.manifest.manifestId,
            manifestRevision: fixture.manifest.manifestRevision,
            ceremonyPolicyId: fixture.manifest.ceremonyPolicyId,
            ceremonyPolicyVersion: fixture.manifest.ceremonyPolicyVersion,
          });
          return fixture.anchor;
        },
      },
      sql,
    );

    expect(result.authority).toMatchObject({
      tenantId: TENANT_ID,
      subjectActorId: SUBJECT_ID,
      granteeActorId: GRANTEE_ID,
      state: "held",
      lifecycleRevision: 0,
    });
    expect(result.verification).toMatchObject({
      manifestDigestBound: true,
      decisionDigestValid: true,
      authorityGranted: false,
      runtimeAccepted: false,
    });
    expect(result.authorityGranted).toBe(false);
    expect(result.runtimeAccepted).toBe(false);
    expect(calls.map((call) => call.label)).toEqual([
      "preflight",
      "decision",
      "clock",
      "attestation",
      "attestation",
      "authority",
    ]);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledTimes(1);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.membership_management_authority.held",
        executionScope: maintenanceScope(),
        payload: expect.objectContaining({
          governanceDecisionId: fixture.decision.governanceDecisionId,
          state: "held",
        }),
      }),
      { sql },
    );
  });

  it("rejects a non-transaction client before resolving trust", async () => {
    const fixture = governanceFixture();
    const { sql } = fakeTransactionSql(fixture, false);
    const resolveTrustedAnchor = vi.fn(async () => fixture.anchor);

    await expect(
      recordHeldMembershipManagementAuthorityV1(
        {
          executionScope: maintenanceScope(),
          decision: fixture.decision,
          attestationBundle: fixture.bundle,
          trustManifest: fixture.manifest,
          resolveTrustedAnchor,
        },
        sql,
      ),
    ).rejects.toThrow(/existing database transaction/i);
    expect(resolveTrustedAnchor).not.toHaveBeenCalled();
  });

  it("rejects a self-asserted or stale anchor digest before any write", async () => {
    const fixture = governanceFixture();
    const { sql, calls } = fakeTransactionSql(fixture);

    await expect(
      recordHeldMembershipManagementAuthorityV1(
        {
          executionScope: maintenanceScope(),
          decision: fixture.decision,
          attestationBundle: fixture.bundle,
          trustManifest: fixture.manifest,
          resolveTrustedAnchor: async () => ({
            ...fixture.anchor,
            trustedManifestSha256: "f".repeat(64),
          }),
        },
        sql,
      ),
    ).rejects.toThrow(/trust-manifest digest binding failed/i);
    expect(calls.map((call) => call.label)).toEqual(["preflight"]);
    expect(eventMocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });

  it("requires a canonical human maintenance scope bound to the recorder", async () => {
    const fixture = governanceFixture();
    const { sql, calls } = fakeTransactionSql(fixture);
    const scope = createExecutionScope({
      ...maintenanceScope(),
      executingPrincipalType: "system",
      executingPrincipalId: "system:bootstrap",
    });

    await expect(
      recordHeldMembershipManagementAuthorityV1(
        {
          executionScope: scope,
          decision: fixture.decision,
          attestationBundle: fixture.bundle,
          trustManifest: fixture.manifest,
          resolveTrustedAnchor: async () => fixture.anchor,
        },
        sql,
      ),
    ).rejects.toThrow(/exact human maintenance scope/i);
    expect(calls).toEqual([]);
  });
});

function governanceFixture() {
  const keyPairs = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
  const publicKeys = keyPairs.map(({ publicKey }) =>
    publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url")
  );
  const manifest = parseMemoryMembershipManagementBootstrapTrustManifestV1({
    schemaVersion: 1,
    manifestId: "trust-manifest:bootstrap-writer",
    manifestRevision: 1,
    logicalDatabaseIdentityId: DATABASE_ID,
    tenantId: TENANT_ID,
    decisionAction: "create_held_membership_management_authority",
    ceremonyPolicyId: "ceremony-policy:bootstrap-writer",
    ceremonyPolicyVersion: 1,
    issuedAt: "2026-09-05T09:00:00.000Z",
    notBefore: "2026-09-05T09:00:00.000Z",
    expiresAt: "2026-09-05T10:00:00.000Z",
    keys: [
      {
        attesterSlot: "organization_custodian",
        attesterKeyId: "key:bootstrap-custodian",
        controllerActorId: CUSTODIAN_ID,
        signatureAlgorithm: "ed25519",
        publicKeyBase64url: publicKeys[0],
        notBefore: "2026-09-05T09:00:00.000Z",
        expiresAt: "2026-09-05T10:00:00.000Z",
        revokedAt: null,
      },
      {
        attesterSlot: "independent_reviewer",
        attesterKeyId: "key:bootstrap-reviewer",
        controllerActorId: REVIEWER_ID,
        signatureAlgorithm: "ed25519",
        publicKeyBase64url: publicKeys[1],
        notBefore: "2026-09-05T09:00:00.000Z",
        expiresAt: "2026-09-05T10:00:00.000Z",
        revokedAt: null,
      },
    ],
  });
  const trustManifestSha256 =
    memoryMembershipManagementBootstrapTrustManifestSha256V1(manifest);
  const decision =
    buildMemoryMembershipManagementBootstrapDecisionRecordWithComputedSha256V1({
      tenantId: TENANT_ID,
      governanceDecisionId: "governance-decision:bootstrap-writer",
      databaseIdentityId: DATABASE_ID,
      subjectActorId: SUBJECT_ID,
      granteeActorId: GRANTEE_ID,
      managementAuthorityId: "membership-authority:bootstrap-writer",
      authorityGeneration: 1,
      ceremonyPolicyId: manifest.ceremonyPolicyId,
      ceremonyPolicyVersion: manifest.ceremonyPolicyVersion,
      trustManifestSha256,
      decisionNonceSha256: "a".repeat(64),
      evidenceSha256: "b".repeat(64),
      notBefore: NOT_BEFORE,
      expiresAt: EXPIRES_AT,
      recordedByActorId: RECORDER_ID,
      recordedAt: "2026-09-05T09:31:00.000Z",
    });
  const preimage =
    canonicalMemoryMembershipManagementBootstrapDecisionPreimageV1(decision);
  const attestations = keyPairs.map(({ privateKey }, index) =>
    buildMemoryMembershipManagementBootstrapAttestationRecordV1({
      tenantId: TENANT_ID,
      governanceDecisionId: decision.governanceDecisionId,
      decisionSha256: decision.decisionSha256,
      attesterSlot: index === 0
        ? "organization_custodian"
        : "independent_reviewer",
      attesterKeyId: manifest.keys[index].attesterKeyId,
      signatureBase64url: sign(null, preimage, privateKey).toString("base64url"),
      attestedAt: index === 0
        ? "2026-09-05T09:32:00.000Z"
        : "2026-09-05T09:33:00.000Z",
    })
  );
  const bundle =
    buildMemoryMembershipManagementBootstrapAttestationBundleV1(
      decision,
      attestations,
    );
  const anchor = Object.freeze({
    schemaVersion: 1 as const,
    anchorKind: "externally_reviewed_trust_manifest_v1" as const,
    tenantId: TENANT_ID,
    logicalDatabaseIdentityId: DATABASE_ID,
    manifestId: manifest.manifestId,
    manifestRevision: manifest.manifestRevision,
    ceremonyPolicyId: manifest.ceremonyPolicyId,
    ceremonyPolicyVersion: manifest.ceremonyPolicyVersion,
    trustedManifestSha256: trustManifestSha256,
    independenceReviewId: "independence-review:bootstrap-writer",
    independenceReviewedByActorId: REVIEWER_ID,
    independenceReviewedAt: "2026-09-05T09:20:00.000Z",
    humanIndependenceReviewed: true as const,
  });
  return { manifest, decision, bundle, anchor };
}

function maintenanceScope() {
  return createExecutionScope({
    tenantId: TENANT_ID,
    initiatingActorId: RECORDER_ID,
    executingPrincipalType: "user",
    executingPrincipalId: RECORDER_ID,
    correlationId: "correlation:bootstrap-writer",
    purpose: MEMORY_MEMBERSHIP_MANAGEMENT_BOOTSTRAP_WRITER_PURPOSE,
  });
}

function fakeTransactionSql(
  fixture: ReturnType<typeof governanceFixture>,
  transactionScoped = true,
) {
  const calls: Array<{ label: string; params: unknown[] }> = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT current_user")) {
      calls.push({ label: "preflight", params });
      return [{
        schema_owner: true,
        system_scope: true,
        database_identity_id: DATABASE_ID,
        observed_at: new Date(OBSERVED_AT),
        bootstrap_schema_valid: true,
        activation_hold_valid: true,
      }];
    }
    if (normalized.startsWith("INSERT INTO omni_membership_management_bootstrap_decisions")) {
      calls.push({ label: "decision", params });
      return [decisionRow(fixture, OBSERVED_AT)];
    }
    if (normalized === "SELECT statement_timestamp() AS observed_at") {
      calls.push({ label: "clock", params });
      return [{ observed_at: new Date(OBSERVED_AT) }];
    }
    if (normalized.startsWith("INSERT INTO omni_membership_management_bootstrap_attestations")) {
      calls.push({ label: "attestation", params });
      return [];
    }
    if (normalized.startsWith("INSERT INTO omni_tenant_actor_membership_management_authorities")) {
      calls.push({ label: "authority", params });
      return [authorityRow(fixture)];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  });
  const sql = Object.assign(
    vi.fn(async () => []),
    {
      query,
      unsafe: vi.fn(async () => []),
      transaction: vi.fn(async () => undefined),
      transactionScoped,
    },
  ) as unknown as MemoryMembershipManagementBootstrapWriterSql;
  return { sql, calls };
}

function decisionRow(
  fixture: ReturnType<typeof governanceFixture>,
  recordedAt: string,
) {
  const decision = fixture.decision;
  return {
    schema_version: decision.schemaVersion,
    tenant_id: decision.tenantId,
    governance_decision_id: decision.governanceDecisionId,
    database_identity_id: decision.databaseIdentityId,
    subject_actor_id: decision.subjectActorId,
    grantee_actor_id: decision.granteeActorId,
    management_authority_id: decision.managementAuthorityId,
    authority_generation: String(decision.authorityGeneration),
    decision_action: decision.decisionAction,
    ceremony_policy_id: decision.ceremonyPolicyId,
    ceremony_policy_version: decision.ceremonyPolicyVersion,
    trust_manifest_sha256: decision.trustManifestSha256,
    decision_nonce_sha256: decision.decisionNonceSha256,
    evidence_sha256: decision.evidenceSha256,
    decision_sha256: decision.decisionSha256,
    not_before: new Date(decision.notBefore),
    expires_at: new Date(decision.expiresAt),
    state: "held",
    lifecycle_revision: "0",
    recorded_by_actor_id: decision.recordedByActorId,
    recorded_at: new Date(recordedAt),
    verified_by_actor_id: null,
    verified_at: null,
    consumed_by_actor_id: null,
    consumed_at: null,
    revoked_by_actor_id: null,
    revoked_at: null,
  };
}

function authorityRow(fixture: ReturnType<typeof governanceFixture>) {
  return {
    schema_version: 1,
    tenant_id: TENANT_ID,
    subject_actor_id: SUBJECT_ID,
    grantee_actor_id: GRANTEE_ID,
    management_authority_id: fixture.decision.managementAuthorityId,
    authority_generation: "1",
    state: "held",
    lifecycle_revision: "0",
    created_by_actor_id: RECORDER_ID,
    activated_by_actor_id: null,
    revoked_by_actor_id: null,
    created_at: new Date(OBSERVED_AT),
    activated_at: null,
    revoked_at: null,
    updated_at: new Date(OBSERVED_AT),
  };
}
