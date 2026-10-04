import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import { GOOGLE_DRIVE_READ_SCOPE } from "@/lib/connectors/google-workspace-capabilities";
import { listWorkspaceLibraryVersions, getWorkspaceLibraryVersion } from "@/lib/library/history-store";
import * as currentLibrary from "@/lib/library/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildSourceAdapterDeleteV1, sourceContractSha256 } from "@/lib/sources/contracts";
import { applyPreparedCanonicalSourceDelete, applyPreparedCanonicalSourceUpsert } from "@/lib/sources/convergence-store";
import { persistCanonicalSourceWrite } from "@/lib/sources/store";
import { buildCanonicalTextSourceWrite, type CanonicalTextSourceWrite } from "@/lib/sources/text-lineage";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const tenantId = "library-history-test", actorId = "history-owner@example.test";
const authUserId = "bbbbbbbb-1234-4234-8234-bbbbbbbbbbbb", canonicalActorId = `actor:${authUserId}`;
const connectionId = "library-history-google", canonicalConnectionId = "library-history-canonical-google";
const owner = { tenantId, actorId, requestActorBinding: {
  version: 1 as const, kind: "auth_user" as const, authUserId, canonicalActorId,
  legacyOwnerActorIds: [actorId], readableOwnerActorIds: [canonicalActorId, actorId],
} };
const itemId = (write: CanonicalTextSourceWrite) => `library:source_item:${write.adapterOutput.sourceItem.sourceItemId}`;
const versionId = (write: CanonicalTextSourceWrite) => `version:source_item:${write.adapterOutput.sourceItem.sourceItemId}:${write.adapterOutput.sourceRevision.sourceRevisionId}`;
const list = (write: CanonicalTextSourceWrite, query: Parameters<typeof listWorkspaceLibraryVersions>[1] = {}) =>
  listWorkspaceLibraryVersions({ ...owner, libraryItemId: itemId(write) }, query);
const exact = (write: CanonicalTextSourceWrite) =>
  getWorkspaceLibraryVersion({ ...owner, libraryItemId: itemId(write), versionId: versionId(write) });

// Administrator writes below are synthetic fixtures. Every reader reconnects
// as a non-owner NOSUPERUSER/NOBYPASSRLS role using the real serving policies.
databaseDescribe("Library immutable metadata history under current serving authority", () => {
  let admin: ReturnType<typeof postgres>;
  let roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 1, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    await admin`INSERT INTO omni_auth_tenants (id, name, slug) VALUES (${tenantId}, 'History', 'library-history-test')`;
    await admin`INSERT INTO omni_auth_users (id, email, password_hash) VALUES (${authUserId}, ${actorId}, 'test-only')`;
    await admin`INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
      VALUES ('library-history-membership', ${tenantId}, ${authUserId}, 'operator')`;
    for (const [id, physicalActorId] of [[connectionId, actorId], [canonicalConnectionId, canonicalActorId]]) {
      await admin`INSERT INTO omni_oauth_grants (id, tenant_id, actor_id, provider, account_email, scopes, sealed_tokens,
        authorization_generation, expires_at) VALUES (${id}, ${tenantId}, ${physicalActorId}, 'google', ${actorId},
          ${[GOOGLE_DRIVE_READ_SCOPE]}, '{}'::jsonb, 1, NOW() - INTERVAL '1 day')`;
    }
    const runtimePassword = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE library_history_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    roleCreated = true;
    await admin`GRANT SELECT ON omni_schema_version, omni_capture_assets, omni_capture_recordings,
      omni_knowledge_documents, omni_projects, omni_project_artifacts, omni_missions, omni_mission_artifacts,
      omni_source_items, omni_source_revisions, omni_source_sync_heads, omni_oauth_grants TO library_history_runtime`;
    await closeDatabaseClient();
    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = "library_history_runtime";
    runtimeUrl.password = runtimePassword;
    vi.stubEnv("DATABASE_URL", runtimeUrl.toString());
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1");
    await ensureDatabaseSchema();
    const [role] = await runWithDatabaseActorScope(tenantId, [canonicalActorId, actorId], () =>
      getSql()`SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role).toMatchObject({ name: "library_history_runtime", rolsuper: false, rolbypassrls: false });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await closeDatabaseClient();
    vi.unstubAllEnvs();
    if (admin) {
      if (roleCreated) { await admin`DROP OWNED BY library_history_runtime`; await admin`DROP ROLE library_history_runtime`; }
      await admin.end();
    }
  });

  async function fixtureTransaction<T>(operation: (sql: SqlClient) => Promise<T>): Promise<T> {
    return await admin.begin(async (tx) => {
      const tagged = (strings: TemplateStringsArray, ...params: unknown[]) => tx(strings, ...params as never[]);
      const sql = Object.assign(tagged, { transactionScoped: true,
        query: (text: string, params?: unknown[]) => tx.unsafe(text, (params ?? []) as never[]),
        unsafe: (text: string, params?: unknown[]) => tx.unsafe(text, (params ?? []) as never[]),
        transaction: async () => { throw new Error("Fixture transaction already open."); },
      }) as unknown as SqlClient;
      return operation(sql);
    }) as T;
  }
  async function source(name: string, options: {
    identity?: string; capturedAt?: string; expiresAt?: string; actor?: string; connection?: string;
    purposes?: readonly string[]; permissions?: readonly string[]; retentionPolicy?: string;
    head?: boolean; capture?: boolean; documentSource?: string;
  } = {}) {
    const physicalActorId = options.actor ?? actorId;
    const sourceConnectionId = options.connection ?? (options.capture ? "first_party.capture" : connectionId);
    const content = `Synthetic retained metadata fixture ${name}`;
    const write = buildCanonicalTextSourceWrite({ lineage: {
      executionScope: createExecutionScope({ tenantId, initiatingActorId: physicalActorId,
        executingPrincipalType: "system", executingPrincipalId: "library-history-fixture", correlationId: `history-${name}`,
        contextGrantIds: [sourceConnectionId], purpose: "connector.sync" }),
      connectionId: sourceConnectionId, adapterId: options.capture ? "asael.capture" : "google.personal_sync.drive",
      externalItemId: options.identity ?? name, sourceKind: options.capture ? "capture" : "file",
      capturedAt: options.capturedAt ?? "2020-01-01T00:00:00.000Z", visibility: "user_private",
      retentionExpiresAt: options.expiresAt, allowedPurposeIds: options.purposes, permissionGrantIds: options.permissions,
      retentionPolicyId: options.retentionPolicy,
    }, content, normalizedContent: content, chunks: [{ index: 0, content, characterStart: 0, characterEnd: content.length }], mediaType: "text/plain" });
    await fixtureTransaction(async (sql) => {
      if (options.head) {
        await applyPreparedCanonicalSourceUpsert(sql, { executionScope: write.executionScope, output: write.adapterOutput,
          order: { authorizationGeneration: 1, rolloutGeneration: 1, phaseRank: 0, pageSequence: 0, ordinal: 0 } });
      } else {
        await persistCanonicalSourceWrite(sql, write, { documentId: `history-document-${name}` });
      }
      await sql`INSERT INTO omni_knowledge_documents (id, tenant_id, title, source, source_type, content_hash, source_item_id, source_revision_id)
        VALUES (${`history-document-${name}`}, ${tenantId}, ${name}, ${options.documentSource ?? "history-fixture"}, 'text',
          ${write.adapterOutput.sourceRevision.contentSha256}, ${write.adapterOutput.sourceItem.sourceItemId}, ${write.adapterOutput.sourceRevision.sourceRevisionId})`;
    });
    return write;
  }

  test("pages retained compatible metadata with exact immutable hashes and no inferred ordinal or archived bytes", async () => {
    const first = await source("page-first", { identity: "page" });
    const second = await source("page-second", { identity: "page", capturedAt: "2020-02-01T00:00:00.000Z" });
    const third = await source("page-third", { identity: "page", capturedAt: "2020-03-01T00:00:00.000Z" });
    const page = await list(third, { limit: 2 });
    expect(page.versions.map((entry) => entry.versionId)).toEqual([versionId(third), versionId(second)]);
    expect(page.coverage).toEqual({ limit: 2, returned: 2, hasMore: true, nextBefore: versionId(second), total: null });
    const older = await list(third, { limit: 2, before: page.coverage.nextBefore!, currentVersionId: page.currentVersionId });
    expect(older.versions.map((entry) => entry.versionId)).toEqual([versionId(first)]);
    expect(older.coverage).toMatchObject({ hasMore: false, nextBefore: null });
    expect((await exact(first)).version).toMatchObject({ sourceRevisionSha256: first.adapterOutput.sourceRevision.sourceRevisionSha256,
      contentSha256: first.adapterOutput.sourceRevision.contentSha256, byteCount: first.adapterOutput.sourceRevision.contentByteLength,
      current: false, ordinal: null, contentAvailability: "metadata_only", historicalAttachmentAuthority: "none" });
  });

  test("keeps exact canonical and legacy ownership within the real serving scope", async () => {
    const legacy = await source("legacy-owner");
    const canonical = await source("canonical-owner", { actor: canonicalActorId, connection: canonicalConnectionId });
    expect((await exact(legacy)).version.current).toBe(true);
    expect((await exact(canonical)).version.current).toBe(true);
    for (const scope of [{ tenantId, actorId: "other@example.test" }, { tenantId: "other-tenant", actorId }]) {
      await expect(getWorkspaceLibraryVersion({ ...scope, libraryItemId: itemId(legacy), versionId: versionId(legacy) }))
        .rejects.toMatchObject({ code: "library_history_unavailable", status: 404 });
    }
    await expect(getWorkspaceLibraryVersion({ tenantId, actorId, libraryItemId: itemId(canonical), versionId: versionId(canonical) }))
      .rejects.toMatchObject({ code: "library_history_unavailable" });
  });

  test("a changed current purpose set cannot authorize historical metadata under the old purpose", async () => {
    const old = await source("purpose-old", { identity: "purpose", purposes: ["purpose_old"] });
    const current = await source("purpose-current", { identity: "purpose", purposes: ["purpose_current"], capturedAt: "2020-02-01T00:00:00.000Z" });
    expect(itemId(current)).toBe(itemId(old));
    expect((await list(current)).versions.map((entry) => entry.versionId)).toEqual([versionId(current)]);
    await expect(exact(old)).rejects.toMatchObject({ code: "library_version_not_found" });
    await expect(list(current, { before: versionId(old), currentVersionId: versionId(current) }))
      .rejects.toMatchObject({ code: "library_history_changed" });
    // A mutable purpose projection cannot disagree with its immutable current
    // revision and still authorize either that revision or any older one.
    await admin`UPDATE omni_source_items SET allowed_purpose_ids = ${["purpose_unmatched"]},
      purpose_set_sha256 = ${sourceContractSha256(["purpose_unmatched"])} WHERE id = ${current.adapterOutput.sourceItem.sourceItemId}`;
    await expect(exact(current)).rejects.toMatchObject({ code: "library_history_unavailable" });
  });

  test("requires the current permission and retention-policy identity for every retained revision", async () => {
    const old = await source("permission-old", { identity: "permission", permissions: [connectionId, "grant_old"] });
    const current = await source("permission-current", { identity: "permission", permissions: [connectionId], capturedAt: "2020-02-01T00:00:00.000Z" });
    expect((await list(current)).versions.map((entry) => entry.versionId)).toEqual([versionId(current)]);
    await expect(exact(old)).rejects.toMatchObject({ code: "library_version_not_found" });
    const priorPolicy = await source("retention-policy-old", { identity: "retention-policy", retentionPolicy: "retention_old" });
    const newPolicy = await source("retention-policy-current", { identity: "retention-policy", retentionPolicy: "retention_current", capturedAt: "2020-02-01T00:00:00.000Z" });
    expect((await list(newPolicy)).versions.map((entry) => entry.versionId)).toEqual([versionId(newPolicy)]);
    await expect(exact(priorPolicy)).rejects.toMatchObject({ code: "library_version_not_found" });
  });

  test("applies retention separately to the current item, current revision and every historical revision", async () => {
    const expiredOld = await source("expired-history", { identity: "retention", expiresAt: "2021-01-01T00:00:00.000Z" });
    const current = await source("retained-current", { identity: "retention", capturedAt: "2020-02-01T00:00:00.000Z" });
    expect((await list(current)).versions.map((entry) => entry.versionId)).toEqual([versionId(current)]);
    await expect(exact(expiredOld)).rejects.toMatchObject({ code: "library_version_not_found" });
    const expiredCurrent = await source("expired-current", { expiresAt: "2021-01-01T00:00:00.000Z" });
    await admin`UPDATE omni_source_items SET retention_expires_at = NULL WHERE id = ${expiredCurrent.adapterOutput.sourceItem.sourceItemId}`;
    await expect(exact(expiredCurrent)).rejects.toMatchObject({ code: "library_history_unavailable" });
    await admin`UPDATE omni_source_items SET retention_expires_at = NOW() - INTERVAL '1 day' WHERE id = ${current.adapterOutput.sourceItem.sourceItemId}`;
    await expect(exact(current)).rejects.toMatchObject({ code: "library_history_unavailable" });
  });

  test("rechecks a current grant in the historical SQL statement after first-phase visibility", async () => {
    const write = await source("phase-revocation");
    const lookup = currentLibrary.getWorkspaceLibraryItem;
    const firstRead = vi.spyOn(currentLibrary, "getWorkspaceLibraryItem").mockImplementationOnce(async (input) => {
      const visible = await lookup(input);
      expect(visible).not.toBeNull();
      await admin`UPDATE omni_oauth_grants SET status = 'revoked' WHERE id = ${connectionId}`;
      return visible;
    });
    try {
      await expect(exact(write)).rejects.toMatchObject({ code: "library_history_unavailable", status: 404 });
      expect(firstRead).toHaveBeenCalledTimes(1);
    } finally {
      firstRead.mockRestore();
      await admin`UPDATE omni_oauth_grants SET status = 'active' WHERE id = ${connectionId}`;
    }
  });

  test("does not revive retained revisions after a canonical source deletion", async () => {
    const write = await source("deleted-head", { head: true });
    expect((await exact(write)).version.current).toBe(true);
    const upsert = write.adapterOutput, item = upsert.sourceItem;
    const deletion = buildSourceAdapterDeleteV1({ tenantId: item.tenantId, ownerActorId: item.ownerActorId,
      workspaceId: item.workspaceId, projectId: item.projectId, missionId: item.missionId, connectionId: item.connectionId,
      visibility: item.visibility, sensitivity: item.sensitivity, permissionGrantIds: item.permissionGrantIds,
      allowedPurposeIds: item.allowedPurposeIds, retentionPolicyId: item.retentionPolicyId, retentionExpiresAt: item.retentionExpiresAt,
      sourceItemId: item.sourceItemId, sourceKind: item.sourceKind, providerItemKeySha256: item.providerItemKeySha256,
      adapterId: upsert.adapterId, adapterVersionId: upsert.adapterVersionId, adapterConfigSha256: upsert.adapterConfigSha256,
      adapterEventKeySha256: sourceContractSha256("history-delete"), observedAt: "2020-02-01T00:00:00.000Z",
      lastKnownSourceRevisionId: upsert.sourceRevision.sourceRevisionId, deleteReason: "provider_deleted" });
    await fixtureTransaction((sql) => applyPreparedCanonicalSourceDelete(sql, { executionScope: write.executionScope, output: deletion,
      order: { authorizationGeneration: 1, rolloutGeneration: 1, phaseRank: 0, pageSequence: 1, ordinal: 0 } }));
    const [retained] = await admin`SELECT current_revision_id FROM omni_source_items WHERE id = ${item.sourceItemId}`;
    expect(retained.current_revision_id).toBe(upsert.sourceRevision.sourceRevisionId);
    await expect(list(write)).rejects.toMatchObject({ code: "library_history_unavailable" });
    await expect(exact(write)).rejects.toMatchObject({ code: "library_history_unavailable" });
  });

  test("rejects pagination and exact-read head pins after the source advances", async () => {
    const old = await source("drift-old", { identity: "drift" });
    const middle = await source("drift-middle", { identity: "drift", capturedAt: "2020-02-01T00:00:00.000Z" });
    const page = await list(middle, { limit: 1 });
    await source("drift-new", { identity: "drift", capturedAt: "2020-03-01T00:00:00.000Z" });
    await expect(list(middle, { limit: 1, before: page.coverage.nextBefore!, currentVersionId: page.currentVersionId }))
      .rejects.toMatchObject({ code: "library_history_changed", status: 409 });
    await expect(getWorkspaceLibraryVersion({ ...owner, libraryItemId: itemId(old), versionId: versionId(old) },
      { currentVersionId: page.currentVersionId })).rejects.toMatchObject({ code: "library_history_changed" });
    expect((await exact(old)).version.current).toBe(false);
  });

  test("retains transcript revision metadata after old document removal while originals expose only the known version", async () => {
    const recordingId = "history-recording", documentSource = `capture:${recordingId}`;
    const old = await source("transcript-old", { identity: recordingId, capture: true, documentSource });
    const current = await source("transcript-current", { identity: recordingId, capture: true, documentSource, capturedAt: "2020-02-01T00:00:00.000Z" });
    await admin`INSERT INTO omni_capture_recordings (id, tenant_id, actor_id, title, status, source, transcript, knowledge_document_id)
      VALUES (${recordingId}, ${tenantId}, ${actorId}, 'History recording', 'ready', ${documentSource}, 'Current transcript', 'history-document-transcript-current')`;
    await admin`DELETE FROM omni_knowledge_documents WHERE id = 'history-document-transcript-old'`;
    const transcriptKey = `library:capture_transcript:${recordingId}`;
    const history = await listWorkspaceLibraryVersions({ ...owner, libraryItemId: transcriptKey });
    expect(history.coverageBasis).toBe("retained_compatible_revisions");
    expect(history.versions.map((entry) => entry.sourceRevisionId)).toEqual([
      current.adapterOutput.sourceRevision.sourceRevisionId, old.adapterOutput.sourceRevision.sourceRevisionId,
    ]);
    const oldKey = `version:capture_transcript:${recordingId}:${old.adapterOutput.sourceRevision.sourceRevisionId}`;
    expect((await getWorkspaceLibraryVersion({ ...owner, libraryItemId: transcriptKey, versionId: oldKey })).version)
      .toMatchObject({ contentAvailability: "metadata_only", historicalAttachmentAuthority: "none", current: false });
    const original = await listWorkspaceLibraryVersions({ ...owner, libraryItemId: `library:capture_recording:${recordingId}` });
    expect(original).toMatchObject({ coverageBasis: "current_known_version_only", coverage: { returned: 1, hasMore: false } });
    expect(original.versions[0]).toMatchObject({ current: true, ordinal: null, sourceRevisionSha256: null });
    // Replacing the current document pointer invalidates the old exact
    // transcript history; its immutable rows cannot supply fresh authority.
    await admin`UPDATE omni_capture_recordings SET knowledge_document_id = NULL, transcript = '' WHERE id = ${recordingId}`;
    await expect(getWorkspaceLibraryVersion({ ...owner, libraryItemId: transcriptKey, versionId: oldKey }))
      .rejects.toMatchObject({ code: "library_history_unavailable" });
  });
});
