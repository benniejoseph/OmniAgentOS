import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope,
} from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import { searchContent } from "@/lib/content-search/service";
import type { SecurityContext } from "@/lib/security/types";
import {
  GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_READ_SCOPE, GOOGLE_GMAIL_READ_SCOPE,
} from "@/lib/connectors/google-workspace-capabilities";
import { getWorkspaceLibraryItem, listWorkspaceLibrary } from "@/lib/library/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  buildSourceAdapterDeleteV1, sourceContractSha256,
} from "@/lib/sources/contracts";
import {
  applyPreparedCanonicalSourceDelete, applyPreparedCanonicalSourceUpsert,
} from "@/lib/sources/convergence-store";
import { persistCanonicalSourceWrite } from "@/lib/sources/store";
import { buildCanonicalTextSourceWrite, type CanonicalTextSourceWrite } from "@/lib/sources/text-lineage";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true"
  ? describe : describe.skip;
const tenantId = "library-current-test";
const authUserId = "aaaaaaaa-1234-4234-8234-aaaaaaaaaaaa";
const canonicalActorId = `actor:${authUserId}`;
const actorId = "library-owner@example.test";
const owner = {
  tenantId, actorId,
  requestActorBinding: {
    version: 1 as const, kind: "auth_user" as const, authUserId, canonicalActorId,
    legacyOwnerActorIds: [actorId], readableOwnerActorIds: [canonicalActorId, actorId],
  },
};
const connectionId = "library-current-google";
const canonicalConnectionId = "library-canonical-google";
const asOwner = <T,>(operation: () => Promise<T>) =>
  runWithDatabaseActorScope(tenantId, [canonicalActorId, actorId], operation);
const list = (query?: string, kinds?: readonly ("image" | "document")[]) => asOwner(() =>
  listWorkspaceLibrary({ ...owner, sourceAuthorities: ["source_item"], query, kinds, limit: 100 }));
const exact = (write: CanonicalTextSourceWrite) => asOwner(() => getWorkspaceLibraryItem({
  ...owner, libraryItemId: `library:source_item:${write.adapterOutput.sourceItem.sourceItemId}`,
}));

// All writes below are synthetic administrator fixtures. Application readers
// reconnect as a non-owner, non-bypass serving role with the real RLS policies.
databaseDescribe("Library current connected-source visibility", () => {
  let admin: ReturnType<typeof postgres>;
  let roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 1, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require",
      onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    await admin`INSERT INTO omni_auth_tenants (id, name, slug) VALUES (${tenantId}, 'Library', 'library-current-test')`;
    await admin`INSERT INTO omni_auth_users (id, email, password_hash) VALUES (${authUserId}, ${actorId}, 'test-only')`;
    await admin`INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role)
      VALUES ('library-current-membership', ${tenantId}, ${authUserId}, 'operator')`;
    await grant(connectionId, actorId);
    await grant(canonicalConnectionId, canonicalActorId);
    // A new disposable credential for this test process; no reusable secret is checked in.
    const runtimePassword = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE library_current_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    roleCreated = true;
    // Legacy object grants normally come from deployment provisioning. These
    // fixture grants change neither actor/tenant policy nor grant contents.
    await admin`GRANT SELECT ON omni_schema_version, omni_capture_assets,
      omni_capture_recordings, omni_knowledge_documents, omni_projects,
      omni_project_artifacts, omni_missions, omni_mission_artifacts,
      omni_source_items, omni_source_revisions, omni_source_sync_heads,
      omni_oauth_grants TO library_current_runtime`;
    await closeDatabaseClient();
    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = "library_current_runtime";
    runtimeUrl.password = runtimePassword;
    vi.stubEnv("DATABASE_URL", runtimeUrl.toString());
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1");
    await ensureDatabaseSchema();
    const [role] = await asOwner(() => getSql()`SELECT current_user AS name, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname = current_user`);
    expect(role).toMatchObject({ name: "library_current_runtime", rolsuper: false, rolbypassrls: false });
  });

  afterAll(async () => {
    await closeDatabaseClient();
    vi.unstubAllEnvs();
    if (admin) {
      if (roleCreated) {
        await admin`DROP OWNED BY library_current_runtime`;
        await admin`DROP ROLE library_current_runtime`;
      }
      await admin.end();
    }
  });

  async function grant(id: string, physicalActorId: string) {
    await admin`INSERT INTO omni_oauth_grants (id, tenant_id, actor_id, provider,
      account_email, scopes, sealed_tokens, authorization_generation, expires_at)
      VALUES (${id}, ${tenantId}, ${physicalActorId}, 'google', ${actorId},
        ${[GOOGLE_DRIVE_READ_SCOPE, GOOGLE_GMAIL_READ_SCOPE]}, '{}'::jsonb, 1, NOW() - INTERVAL '1 day')`;
  }

  async function fixtureTransaction<T>(operation: (sql: SqlClient) => Promise<T>): Promise<T> {
    // The fixture adapter supplies an existing administrator transaction to the
    // real canonical writers, preserving immutable hashes, triggers and receipts.
    return await admin.begin(async (tx) => {
      const tagged = (strings: TemplateStringsArray, ...params: unknown[]) => tx(strings, ...params as never[]);
      const sql = Object.assign(tagged, {
        transactionScoped: true,
        query: (text: string, params?: unknown[]) => tx.unsafe(text, (params ?? []) as never[]),
        unsafe: (text: string, params?: unknown[]) => tx.unsafe(text, (params ?? []) as never[]),
        transaction: async () => { throw new Error("Fixture transaction is already open."); },
      }) as unknown as SqlClient;
      return operation(sql);
    }) as T;
  }

  async function source(name: string, options: {
    actor?: string; tenant?: string; connection?: string; adapter?: string;
    kind?: "file" | "document" | "image" | "email"; title?: string;
    head?: boolean; generation?: number; document?: boolean; metadata?: boolean;
    expiresAt?: string; capturedAt?: string; externalItemId?: string;
    visibility?: "user_private" | "agent_private";
  } = {}) {
    const physicalActorId = options.actor ?? actorId;
    const sourceConnectionId = options.connection ?? connectionId;
    const content = `Synthetic Library fixture ${name}`;
    const write = buildCanonicalTextSourceWrite({
      lineage: {
        executionScope: createExecutionScope({
          tenantId: options.tenant ?? tenantId, initiatingActorId: physicalActorId,
          executingPrincipalType: "system", executingPrincipalId: "library-fixture",
          correlationId: `library-${name}`, contextGrantIds: [sourceConnectionId], purpose: "connector.sync",
        }),
        connectionId: sourceConnectionId, adapterId: options.adapter ?? "google.personal_sync.drive",
        externalItemId: options.externalItemId ?? name, sourceKind: options.kind ?? "file",
        capturedAt: options.capturedAt ?? "2026-10-01T00:00:00.000Z",
        visibility: options.visibility ?? "user_private",
        retentionExpiresAt: options.expiresAt,
      },
      content, normalizedContent: content,
      chunks: [{ index: 0, content, characterStart: 0, characterEnd: content.length }],
      mediaType: options.metadata ? "application/x.asael-source-metadata" : "text/plain",
    });
    await fixtureTransaction(async (sql) => {
      if (options.head) {
        await applyPreparedCanonicalSourceUpsert(sql, {
          executionScope: write.executionScope, output: write.adapterOutput,
          order: { authorizationGeneration: options.generation ?? 1, rolloutGeneration: 1,
            phaseRank: 0, pageSequence: 0, ordinal: 0 },
        });
      } else {
        await persistCanonicalSourceWrite(sql, write, { documentId: `library-document-${name}` });
      }
      if (options.document !== false) await sql`
        INSERT INTO omni_knowledge_documents (id, tenant_id, title, source, source_type,
          content_hash, source_item_id, source_revision_id)
        VALUES (${`library-document-${name}`}, ${write.adapterOutput.tenantId}, ${options.title ?? name},
          'library-fixture', 'text', ${write.adapterOutput.sourceRevision.contentSha256},
          ${write.adapterOutput.sourceItem.sourceItemId}, ${write.adapterOutput.sourceRevision.sourceRevisionId})`;
    });
    return write;
  }

  test("canonical deletion hides the retained current revision from exact reads, lists and facets", async () => {
    const write = await source("Deleted document", { head: true });
    expect(await exact(write)).not.toBeNull();
    expect((await list("Deleted document")).countsByKind).toEqual({ file: 1 });
    const upsert = write.adapterOutput;
    const item = upsert.sourceItem;
    const deletion = buildSourceAdapterDeleteV1({
      tenantId: item.tenantId, ownerActorId: item.ownerActorId,
      workspaceId: item.workspaceId, projectId: item.projectId, missionId: item.missionId,
      connectionId: item.connectionId, visibility: item.visibility, sensitivity: item.sensitivity,
      permissionGrantIds: item.permissionGrantIds, allowedPurposeIds: item.allowedPurposeIds,
      retentionPolicyId: item.retentionPolicyId, retentionExpiresAt: item.retentionExpiresAt,
      sourceItemId: item.sourceItemId, sourceKind: item.sourceKind,
      providerItemKeySha256: item.providerItemKeySha256,
      adapterId: upsert.adapterId, adapterVersionId: upsert.adapterVersionId,
      adapterConfigSha256: upsert.adapterConfigSha256,
      adapterEventKeySha256: sourceContractSha256("library-delete"),
      observedAt: "2026-10-02T00:00:00.000Z",
      lastKnownSourceRevisionId: upsert.sourceRevision.sourceRevisionId,
      deleteReason: "provider_deleted",
    });
    await fixtureTransaction((sql) => applyPreparedCanonicalSourceDelete(sql, {
      executionScope: write.executionScope, output: deletion,
      order: { authorizationGeneration: 1, rolloutGeneration: 1, phaseRank: 0, pageSequence: 1, ordinal: 0 },
    }));
    const [retained] = await admin`SELECT current_revision_id FROM omni_source_items WHERE id = ${item.sourceItemId}`;
    expect(retained.current_revision_id).toBe(upsert.sourceRevision.sourceRevisionId);
    expect(await exact(write)).toBeNull();
    expect(await list("Deleted document")).toMatchObject({ items: [], countsByKind: {}, total: 0 });
  });

  test("requires an active exact physical grant with a current capability and generation", async () => {
    const write = await source("Grant document", { head: true });
    // A refreshable access token expired yesterday. Metadata reads need no
    // token decrypt/refresh and continue under the current authorization.
    expect(await exact(write)).not.toBeNull();
    for (const status of ["revoked", "disabled"]) {
      await admin`UPDATE omni_oauth_grants SET status = ${status} WHERE id = ${connectionId}`;
      expect(await exact(write)).toBeNull();
    }
    await admin`UPDATE omni_oauth_grants SET status = 'active', scopes = ${[GOOGLE_DRIVE_FILE_SCOPE]} WHERE id = ${connectionId}`;
    expect(await exact(write)).toBeNull();
    await admin`UPDATE omni_oauth_grants SET scopes = ${[GOOGLE_DRIVE_READ_SCOPE]}, provider = 'salesforce' WHERE id = ${connectionId}`;
    expect(await exact(write)).toBeNull();
    await admin`UPDATE omni_oauth_grants SET provider = 'google', actor_id = 'wrong-account@example.test' WHERE id = ${connectionId}`;
    expect(await exact(write)).toBeNull();
    await admin`UPDATE omni_oauth_grants SET actor_id = ${actorId}, authorization_generation = 2 WHERE id = ${connectionId}`;
    expect(await exact(write)).toBeNull();
    expect((await list("Grant document")).items).toEqual([]);
    await admin`UPDATE omni_oauth_grants SET authorization_generation = 1,
      scopes = ${[GOOGLE_DRIVE_READ_SCOPE, GOOGLE_GMAIL_READ_SCOPE]} WHERE id = ${connectionId}`;
    expect(await exact(write)).not.toBeNull();
  });

  test("search uses the same current grant as exact opening and removes revoked source metadata", async () => {
    const write = await source("Search current grant", { head: true });
    const context: SecurityContext = { tenantId, actorId, role: "operator", source: "session",
      auth: { userId: authUserId, email: actorId, sessionId: "library-search-fixture", tenantName: "Library" } };
    const search = () => asOwner(() => searchContent(context, { query: "Search current grant", provider: "library", limit: 8 }));
    const id = `library:source_item:${write.adapterOutput.sourceItem.sourceItemId}`;
    const visible = await search();
    expect(visible.groups[0].status).toBe("ready");
    expect(visible.groups[0].items.map((item) => item.id)).toEqual([id]);
    expect(visible.groups[0].items[0].href).toBe(`/app/capture?libraryItem=${encodeURIComponent(id)}`);
    await admin`UPDATE omni_oauth_grants SET status = 'revoked' WHERE id = ${connectionId}`;
    try {
      expect((await search()).groups[0]).toMatchObject({ status: "ready", items: [], nextCursor: null });
      expect(await exact(write)).toBeNull();
    } finally {
      await admin`UPDATE omni_oauth_grants SET status = 'active' WHERE id = ${connectionId}`;
    }
  });

  test("an older upsert head cannot authorize a later current revision", async () => {
    const prior = await source("Head original", { head: true, externalItemId: "head-identity" });
    expect(await exact(prior)).not.toBeNull();
    const next = await source("Head advanced", { externalItemId: "head-identity", capturedAt: "2026-10-02T00:00:00.000Z" });
    expect(next.adapterOutput.sourceItem.sourceItemId).toBe(prior.adapterOutput.sourceItem.sourceItemId);
    const [state] = await admin`SELECT item.current_revision_id, head.source_revision_id
      FROM omni_source_items item JOIN omni_source_sync_heads head
        ON head.tenant_id = item.tenant_id AND head.source_item_id = item.id
      WHERE item.id = ${next.adapterOutput.sourceItem.sourceItemId}`;
    expect(state.current_revision_id).toBe(next.adapterOutput.sourceRevision.sourceRevisionId);
    expect(state.source_revision_id).toBe(prior.adapterOutput.sourceRevision.sourceRevisionId);
    expect(await exact(next)).toBeNull();
    expect((await list("Head advanced")).items).toEqual([]);
  });

  test("does not cross the validated canonical/current-email pair or borrow another connection", async () => {
    const canonical = await source("Canonical owner", { actor: canonicalActorId, connection: canonicalConnectionId });
    const wrongPhysical = await source("Mixed owner", { actor: canonicalActorId });
    const alias = await source("Retired alias", { actor: "old-alias@example.test" });
    const missing = await source("Missing grant", { connection: "library-unknown-account" });
    const foreignTenant = await source("Foreign tenant", { tenant: "library-other-tenant" });
    expect((await exact(canonical))?.scope.ownerActorId).toBe(canonicalActorId);
    for (const hidden of [wrongPhysical, alias, missing, foreignTenant]) expect(await exact(hidden)).toBeNull();
  });

  test("legacy Google requires a live current document and original known authorization generation", async () => {
    const legacy = await source("Legacy original");
    const deleted = await source("Legacy deleted");
    expect(await exact(legacy)).not.toBeNull();
    await admin`DELETE FROM omni_knowledge_documents WHERE id = 'library-document-Legacy deleted'`;
    expect(await exact(deleted)).toBeNull();
    await admin`UPDATE omni_oauth_grants SET authorization_generation = 2 WHERE id = ${connectionId}`;
    expect(await exact(legacy)).toBeNull();
    const freshMetadata = await source("Fresh metadata", { head: true, generation: 2, document: false, metadata: true });
    const missingText = await source("Missing canonical text", { head: true, generation: 2, document: false });
    expect(await exact(freshMetadata)).not.toBeNull();
    expect(await exact(missingText)).toBeNull();
    await admin`UPDATE omni_oauth_grants SET authorization_generation = 1 WHERE id = ${connectionId}`;
  });

  test("retention applies to both item and current revision while private and unsupported sources stay excluded", async () => {
    const expired = await source("Expired source", { expiresAt: "2026-01-01T00:00:00.000Z" });
    expect(await exact(expired)).toBeNull();
    // Increasing the mutable item retention cannot revive an expired immutable
    // revision. No trigger, policy or immutable revision is bypassed.
    await admin`UPDATE omni_source_items SET retention_expires_at = NULL
      WHERE id = ${expired.adapterOutput.sourceItem.sourceItemId}`;
    expect(await exact(expired)).toBeNull();
    const itemExpired = await source("Expired item only");
    await admin`UPDATE omni_source_items SET retention_expires_at = NOW() - INTERVAL '1 day'
      WHERE id = ${itemExpired.adapterOutput.sourceItem.sourceItemId}`;
    expect(await exact(itemExpired)).toBeNull();
    const agentPrivate = await source("Agent private", { visibility: "agent_private" });
    const capture = await source("Capture shadow", { connection: "first_party.capture", adapter: "asael.capture" });
    const unknown = await source("Unknown adapter", { adapter: "google.personal_sync.unknown" });
    const wrongKind = await source("Wrong adapter kind", { kind: "image" });
    for (const hidden of [agentPrivate, capture, unknown, wrongKind]) expect(await exact(hidden)).toBeNull();
  });

  test("known first-party imports remain visible only with the exact current document binding", async () => {
    for (const adapter of ["knowledge_service", "ingest_api", "portable_restore"]) {
      const write = await source(`Import ${adapter}`, { adapter: `asael.${adapter}`, connection: `first_party.${adapter}`, kind: "document" });
      expect(await exact(write)).not.toBeNull();
      await admin`DELETE FROM omni_knowledge_documents WHERE id = ${`library-document-Import ${adapter}`}`;
      expect(await exact(write)).toBeNull();
    }
    const crossed = await source("Crossed import", { adapter: "asael.ingest_api", connection: "first_party.knowledge_service" });
    expect(await exact(crossed)).toBeNull();
  });

  test("unauthorized newer rows cannot starve the result or cross-kind facet windows", async () => {
    for (let index = 0; index < 105; index++) await source(`Hidden window ${index}`, {
      connection: "library-no-current-grant", title: `Window proof hidden ${index}`,
      capturedAt: "2026-10-03T00:00:00.000Z",
    });
    const document = await source("Window document", { adapter: "asael.ingest_api",
      connection: "first_party.ingest_api", kind: "document", title: "Window proof document" });
    const image = await source("Window image", { adapter: "asael.ingest_api",
      connection: "first_party.ingest_api", kind: "image", title: "Window proof image" });
    const result = await list("Window proof", ["image"]);
    expect(result.items.map((item) => item.sourceId)).toEqual([image.adapterOutput.sourceItem.sourceItemId]);
    expect(result.countsByKind).toEqual({ document: 1, image: 1 });
    expect(result.countsAreLowerBound).toBe(false);
    expect(await exact(document)).not.toBeNull();
  });

  test("an exact source remains resolvable beyond the list candidate window", async () => {
    const oldest = await source("Outside window oldest", { adapter: "asael.ingest_api",
      connection: "first_party.ingest_api", kind: "document", capturedAt: "2020-01-01T00:00:00.000Z" });
    for (let index = 0; index < 101; index++) await source(`Outside window recent ${index}`, {
      adapter: "asael.ingest_api", connection: "first_party.ingest_api", kind: "document",
    });
    const result = await list("Outside window");
    expect(result.items).toHaveLength(100);
    expect(result.items.some((item) => item.sourceId === oldest.adapterOutput.sourceItem.sourceItemId)).toBe(false);
    expect(result.totalIsLowerBound).toBe(true);
    expect((await exact(oldest))?.sourceId).toBe(oldest.adapterOutput.sourceItem.sourceItemId);
  });
});
