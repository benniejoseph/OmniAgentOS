import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithManagedDatabaseTransaction } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import { buildCustomerAccountRevision, buildCustomerFactRevision, customerAccountId, customerFactId, customerMutationId, type CustomerAccountRevision, type CustomerFactRevision } from "@/lib/customer-success/contracts";
import { customerHealthEvaluationId } from "@/lib/customer-success/health-contracts";
import { evaluateAndSaveCustomerHealth, getCurrentCustomerHealthScore } from "@/lib/customer-success/health-store";
import { CUSTOMER_ACCOUNT_FACT_LIMIT, CustomerAccountNotFoundError, CustomerAccountProjectionLimitError, getCustomerAccount360, type CustomerAccountReadAuthority } from "@/lib/customer-success/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const tenantId = "customer-projection-bounds", foreignTenantId = "customer-projection-foreign";
const workspaceId = "workspace:customer-projection", privateWorkspaceId = "workspace:customer-projection-private";
const ownerUser = "11111111-1111-4111-8111-111111111111", readerUser = "22222222-2222-4222-8222-222222222222", outsiderUser = "33333333-3333-4333-8333-333333333333";
const ownerActor = `actor:${ownerUser}`, readerActor = `actor:${readerUser}`, outsiderActor = `actor:${outsiderUser}`;
const now = "2026-09-08T12:00:00.000Z";
const readPurpose = "customer_success.account.read" as const;

// Destructive opt-in fixture. Administration creates immutable fixtures only.
// Every behavioral operation executes the actual store in a managed transaction as
// omni_runtime, with RLS enabled and no system/superuser/bypass authority.
databaseDescribe("bounded Customer Account 360 heads under serving PostgreSQL RLS", () => {
  let admin: ReturnType<typeof postgres>;
  const accounts = new Map<string, CustomerAccountRevision>();
  beforeAll(async () => {
    await closeDatabaseClient();
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1");
    admin = postgres(databaseUrl!, { max: 1, prepare: false, ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
    await admin`GRANT SELECT ON omni_auth_users,omni_auth_memberships,omni_auth_tenants,
      omni_tenant_workspaces,omni_tenant_workspace_memberships,omni_schema_version,
      omni_customer_accounts,omni_customer_account_revisions,omni_customer_fact_revisions TO omni_runtime`;
    // The event stream's restrictive run/tool policies reference these tables
    // even for an unrelated customer stream. Grant only their RLS-scoped reads;
    // the tool access helper's auth-user/membership reads are granted above.
    await admin`GRANT SELECT ON omni_agent_runs,omni_tool_executions TO omni_runtime`;
    await admin`GRANT SELECT,INSERT ON omni_events TO omni_runtime`;
    await admin`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO omni_runtime`;
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES
      (${ownerUser},'customer-owner@example.test','fixture-only'),
      (${readerUser},'customer-reader@example.test','fixture-only'),
      (${outsiderUser},'customer-outsider@example.test','fixture-only')`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES
      (${tenantId},'Account projection bounds',${tenantId}),(${foreignTenantId},'Foreign account tenant',${foreignTenantId})`;
    for (const user of [ownerUser, readerUser, outsiderUser]) {
      await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES (${`bounds:${user}`},${tenantId},${user},'operator')`;
    }
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES ('bounds:foreign-owner',${foreignTenantId},${ownerUser},'operator')`;
    for (const [tenant, workspace] of [[tenantId, workspaceId], [tenantId, privateWorkspaceId], [foreignTenantId, workspaceId]]) {
      await admin`INSERT INTO omni_tenant_workspaces(tenant_id,workspace_id,display_name,owner_actor_id,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
        VALUES (${tenant},${workspace},'Bounds fixture',${ownerActor},'active',1,${ownerActor},${ownerActor},${now},${now},${now})`;
      await membership(tenant, workspace, ownerActor, "manager");
    }
    await membership(tenantId, workspaceId, readerActor, "reader");
    for (const key of ["complete", "overflow", "retracted", "purpose", "scope"]) {
      accounts.set(key, await seedAccount(key));
    }
    accounts.set("private", await seedAccount("private", tenantId, privateWorkspaceId));
    accounts.set("foreign", await seedAccount("foreign", foreignTenantId, workspaceId));
    await seedFacts(accounts.get("complete")!, CUSTOMER_ACCOUNT_FACT_LIMIT, 1, "active");
    await seedFacts(accounts.get("overflow")!, CUSTOMER_ACCOUNT_FACT_LIMIT + 1, 1, "active");
    await seedFacts(accounts.get("retracted")!, CUSTOMER_ACCOUNT_FACT_LIMIT + 1, 1, "active");
    await seedFacts(accounts.get("retracted")!, CUSTOMER_ACCOUNT_FACT_LIMIT + 1, 2, "retracted");
    await seedFacts(accounts.get("purpose")!, 1, 1, "active");
    await seedFacts(accounts.get("purpose")!, 1, 2, "active", "customer_success.analytics");
    for (const key of ["scope", "private", "foreign"]) await seedFacts(accounts.get(key)!, 1, 1, "active");
    // Publish statistics for the fresh bulk fixture and its RLS lookup tables
    // before serving reads, rather than depending on automatic analysis timing.
    // This runs only on the fixture admin connection; serving budgets stay intact.
    await admin`ANALYZE
      omni_customer_accounts, omni_customer_account_revisions, omni_customer_fact_revisions,
      omni_tenant_workspaces, omni_tenant_workspace_memberships,
      omni_auth_users, omni_auth_user_actor_identifiers, omni_auth_memberships`;
  }, 180_000);
  afterAll(async () => { await closeDatabaseClient(); await admin?.end(); vi.unstubAllEnvs(); });

  function authority(actor = ownerActor, tenant = tenantId, workspace = workspaceId): CustomerAccountReadAuthority {
    return { tenantId: tenant, workspaceId: workspace, canonicalActorId: actor, readableActorIds: [actor], purposeId: readPurpose };
  }
  function serving<T>(access: CustomerAccountReadAuthority, read: (sql: SqlClient) => Promise<T>): Promise<T> {
    return runWithDatabaseActorScope(access.tenantId, access.readableActorIds, () => getSql().transaction(async (sql: SqlClient) => {
      await sql`SET LOCAL ROLE omni_runtime`;
      await sql`SET LOCAL row_security = on`;
      await sql`SELECT set_config('omni.system_scope','false',true)`;
      const proof = await sql`SELECT current_user AS role, rolbypassrls, rolsuper,
        row_security_active('public.omni_customer_accounts') AS accounts_rls,
        row_security_active('public.omni_customer_fact_revisions') AS facts_rls,
        row_security_active('public.omni_customer_health_scores') AS health_rls,
        omni_system_scope_enabled() AS system_scope
        FROM pg_roles WHERE rolname=current_user`;
      expect(proof[0]).toMatchObject({ role: "omni_runtime", rolbypassrls: false, rolsuper: false, accounts_rls: true, facts_rls: true, health_rls: true, system_scope: false });
      // Explicit adoption keeps the actual store's getSql calls on this same
      // serving connection, including its nested actor scope on pool size one.
      return runWithManagedDatabaseTransaction(sql, () => read(getSql()));
    }) as Promise<T>);
  }
  function read(key: string, access = authority()) {
    return serving(access, () => getCustomerAccount360(access, accounts.get(key)!.accountId));
  }
  function healthInput(key: string, idempotencyKey: string, access = authority()) {
    const account = accounts.get(key)!;
    return {
      authority: {
        ...access,
        purposeId: "customer_success.account.manage" as const,
        idempotencyKey,
        executionScope: createExecutionScope({
          tenantId: access.tenantId, workspaceId: access.workspaceId,
          initiatingActorId: access.canonicalActorId, executingPrincipalType: "user",
          executingPrincipalId: access.canonicalActorId, correlationId: idempotencyKey,
          purpose: "customer.health.evaluate",
        }),
      },
      accountId: account.accountId,
      expectedAccountRevision: account.revision,
      expectedAccountSha256: account.accountSha256,
      evaluationId: customerHealthEvaluationId({ accountId: account.accountId, idempotencyKey }),
    };
  }
  function evaluate(key: string, idempotencyKey: string, access = authority()) {
    return serving(access, () => evaluateAndSaveCustomerHealth(healthInput(key, idempotencyKey, access)));
  }

  test("returns the complete 5000-fact set without silent truncation", async () => {
    const result = await read("complete"), account = accounts.get("complete")!;
    expect(result?.facts).toHaveLength(5_000);
    expect(result?.factsByKind.health).toHaveLength(5_000);
    expect(result?.historyCount).toBe(5_001);
    expect(result?.conflictCount).toBe(0);
    expect(result?.facts.map((view) => view.fact.factId).sort()).toEqual(Array.from({ length: 5_000 }, (_, index) => factId(account, index)).sort());
    expect(result?.facts.every((view) => view.fact.revision === 1 && view.fact.state === "active")).toBe(true);
  }, 60_000);

  test("rejects a 5001st active head instead of publishing a partial projection", async () => {
    let published = false;
    await expect(read("overflow").then((value) => { published = true; return value; })).rejects.toBeInstanceOf(CustomerAccountProjectionLimitError);
    expect(published).toBe(false);
    await serving(authority(), async (sql) => {
      const rows = await sql`SELECT count(*)::INTEGER AS total FROM omni_customer_fact_revisions WHERE account_id=${accounts.get("overflow")!.accountId}`;
      expect(rows[0].total).toBe(5_001);
    });
  }, 60_000);

  test("5001 retracted latest heads neither overflow nor resurrect 5001 older active revisions", async () => {
    const result = await read("retracted");
    expect(result?.facts).toEqual([]);
    expect(result?.factsByKind.health).toEqual([]);
    expect(result?.historyCount).toBe(10_003);
    expect(result?.conflictCount).toBe(0);
    await serving(authority(), async (sql) => {
      const rows = await sql`SELECT fact_state,count(*)::INTEGER AS total FROM omni_customer_fact_revisions WHERE account_id=${accounts.get("retracted")!.accountId} GROUP BY fact_state ORDER BY fact_state`;
      expect(rows).toEqual([{ fact_state: "active", total: 5_001 }, { fact_state: "retracted", total: 5_001 }]);
    });
  }, 60_000);

  test("read-purpose filtering happens after latest-head selection and rejects another caller purpose", async () => {
    // The DB requires its read-purpose column, while the typed snapshot below
    // narrows the payload purpose. This negative fixture proves the projection
    // fails closed without reviving the older application-readable revision.
    const result = await read("purpose");
    expect(result?.facts).toEqual([]);
    expect(result?.historyCount).toBe(3);
    const wrong = { ...authority(), purposeId: "customer_success.analytics" } as unknown as CustomerAccountReadAuthority;
    await expect(serving(wrong, () => getCustomerAccount360(wrong, accounts.get("scope")!.accountId))).rejects.toThrow("Customer account read authority is invalid.");
  });

  test("workspace membership permits another reader while tenant membership alone cannot read the owner's account", async () => {
    const result = await read("scope", authority(readerActor));
    expect(result?.account.ownerActorId).toBe(ownerActor);
    expect(result?.facts).toHaveLength(1);
    expect(await read("scope", authority(outsiderActor))).toBeUndefined();
    await serving(authority(outsiderActor), async (sql) => {
      expect(await sql`SELECT account_id FROM omni_customer_accounts`).toEqual([]);
      expect(await sql`SELECT fact_id FROM omni_customer_fact_revisions`).toEqual([]);
    });
    expect(await read("private", authority(readerActor, tenantId, privateWorkspaceId))).toBeUndefined();
  });

  test("tenant and exact workspace scope cannot be widened by an account ID", async () => {
    expect(await read("scope", authority(ownerActor, foreignTenantId))).toBeUndefined();
    expect(await read("foreign", authority())).toBeUndefined();
    expect(await read("private", authority())).toBeUndefined();
    await serving(authority(), async (sql) => {
      const tenants = await sql`SELECT DISTINCT tenant_id FROM omni_customer_accounts`;
      expect(tenants).toEqual([{ tenant_id: tenantId }]);
      const hidden = await sql`SELECT fact_id FROM omni_customer_fact_revisions WHERE account_id=${accounts.get("foreign")!.accountId}`;
      expect(hidden).toEqual([]);
    });
  });

  test("health evaluation preserves all 5000 evidence identities using the serving role", async () => {
    const score = await evaluate("complete", "health:complete"), account = accounts.get("complete")!;
    expect(score).toMatchObject({ accountId: account.accountId, accountSha256: account.accountSha256, revision: 1, authority: "deterministic_policy" });
    const evidence = score.factors.flatMap((factor) => factor.evidence);
    expect(evidence).toHaveLength(5_000);
    expect(evidence.map((reference) => reference.factId).sort()).toEqual(Array.from({ length: 5_000 }, (_, index) => factId(account, index)).sort());
    expect(evidence.every((reference) => reference.factRevisionId === `${reference.factId}:v1`)).toBe(true);
    const current = await serving(authority(), () => getCurrentCustomerHealthScore(authority(), account.accountId));
    expect(current?.scoreSha256).toBe(score.scoreSha256);
  }, 60_000);

  test("health overflow cannot persist a partial policy, score, revision, or evaluated event", async () => {
    await expect(evaluate("overflow", "health:overflow")).rejects.toBeInstanceOf(CustomerAccountProjectionLimitError);
    const id = accounts.get("overflow")!.accountId;
    await serving(authority(), async (sql) => {
      const rows = await sql`SELECT
        (SELECT count(*) FROM omni_customer_health_policies WHERE tenant_id=${tenantId} AND workspace_id=${workspaceId} AND account_id=${id})::INTEGER AS policies,
        (SELECT count(*) FROM omni_customer_health_score_revisions WHERE tenant_id=${tenantId} AND workspace_id=${workspaceId} AND account_id=${id})::INTEGER AS revisions,
        (SELECT count(*) FROM omni_customer_health_scores WHERE tenant_id=${tenantId} AND workspace_id=${workspaceId} AND account_id=${id})::INTEGER AS scores,
        (SELECT count(*) FROM omni_events WHERE tenant_id=${tenantId} AND stream_id=${id} AND type='customer.account.health.evaluated')::INTEGER AS events`;
      expect(rows[0]).toEqual({ policies: 0, revisions: 0, scores: 0, events: 0 });
    });
  }, 60_000);

  test("health remains unknown after retracted or source-purpose-ineligible latest heads", async () => {
    for (const key of ["retracted", "purpose"]) {
      const score = await evaluate(key, `health:${key}`);
      expect(score).toMatchObject({ status: "unknown", scoreBasisPoints: null, confidenceBasisPoints: 0, coverageBasisPoints: 0 });
      expect(score.factors).toHaveLength(4);
      expect(score.factors.every((factor) => factor.evidence.length === 0 && factor.evidenceState === "missing")).toBe(true);
    }
  }, 60_000);

  test("health fact evaluation retains exact owner, tenant, workspace and mutation-purpose boundaries", async () => {
    for (const access of [authority(readerActor), authority(outsiderActor), authority(ownerActor, foreignTenantId), authority(ownerActor, tenantId, privateWorkspaceId)]) {
      await expect(evaluate("scope", "health:denied", access)).rejects.toBeInstanceOf(CustomerAccountNotFoundError);
    }
    const invalid = healthInput("scope", "health:wrong-purpose");
    invalid.authority = { ...invalid.authority, purposeId: readPurpose } as unknown as typeof invalid.authority;
    await expect(serving(authority(), () => evaluateAndSaveCustomerHealth(invalid))).rejects.toThrow("Customer health mutation authority is invalid.");
    expect(await serving(authority(), () => getCurrentCustomerHealthScore(authority(), accounts.get("scope")!.accountId))).toBeUndefined();
  });

  async function membership(tenant: string, workspace: string, actor: string, access: "manager" | "reader") {
    await admin`INSERT INTO omni_tenant_workspace_memberships(tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenant},${workspace},'user',${actor},${actor},1,${access},'active',1,${ownerActor},${ownerActor},${now},${now},${now})`;
  }
  async function seedAccount(key: string, tenant = tenantId, workspace = workspaceId) {
    const id = customerAccountId({ tenantId: tenant, workspaceId: workspace, idempotencyKey: key });
    const account = buildCustomerAccountRevision({ tenantId: tenant, workspaceId: workspace, accountId: id, revision: 1, mutationId: customerMutationId({ accountId: id, idempotencyKey: key, operation: "account.create" }), name: `Bounds ${key}`, lifecycle: "active", organizationEntityId: null,
      accountOwner: { ownerKind: "actor", ownerId: ownerActor, displayName: "Fixture owner" }, ownerActorId: ownerActor, revisedByActorId: ownerActor, revisedAt: now,
      crmPermissions: { readScope: "workspace_members", writeScope: "account_owner", externalWriteState: "disabled", customerDataPurposeIds: ["customer_success.account.manage", readPurpose, "customer_success.analytics"] } });
    await admin`INSERT INTO omni_customer_account_revisions(tenant_id,workspace_id,account_id,revision_id,revision,mutation_id,owner_actor_id,allowed_purpose_ids,account_sha256,account_snapshot,revised_at)
      VALUES (${tenant},${workspace},${id},${account.revisionId},1,${account.mutationId},${ownerActor},${account.crmPermissions.customerDataPurposeIds},${account.accountSha256},${admin.json(account)},${now})`;
    await admin`INSERT INTO omni_customer_accounts(tenant_id,workspace_id,account_id,owner_actor_id,current_revision,current_revision_id,name,lifecycle,allowed_purpose_ids,account_sha256,account_snapshot,created_at,revised_at)
      VALUES (${tenant},${workspace},${id},${ownerActor},1,${account.revisionId},${account.name},'active',${account.crmPermissions.customerDataPurposeIds},${account.accountSha256},${admin.json(account)},${now},${now})`;
    return account;
  }
  function factId(account: CustomerAccountRevision, index: number) {
    return customerFactId({ accountId: account.accountId, idempotencyKey: `fact:${index}` });
  }
  async function seedFacts(account: CustomerAccountRevision, total: number, revision: number, state: "active" | "retracted", purpose: typeof readPurpose | "customer_success.analytics" = readPurpose) {
    // At most 250 immutable JSON snapshots and one INSERT are held per batch.
    // This uses real persisted domain snapshots without per-row network calls.
    for (let offset = 0; offset < total; offset += 250) {
      const batch: CustomerFactRevision[] = [];
      for (let index = offset; index < Math.min(total, offset + 250); index++) {
        batch.push(buildCustomerFactRevision({ tenantId: account.tenantId, workspaceId: account.workspaceId, accountId: account.accountId, factId: factId(account, index), revision,
          mutationId: customerMutationId({ accountId: account.accountId, idempotencyKey: `fact:${index}:v${revision}`, operation: "fact.record" }), factKey: `health.fact_${index}`, state,
          value: { kind: "health", dimension: "support", status: "watch", scoreBasisPoints: null, summary: `Exact bounded fact ${index}` },
          source: { sourceKind: "manual", sourceId: `fixture:${index}`, sourceRevisionId: `fixture:${index}:v${revision}`, sourceRevisionSha256: "a".repeat(64), sourceLabel: "Bounded fixture evidence", providerId: null, providerObjectType: null, providerObjectIdSha256: null, permissionBasis: "operator_assertion", allowedPurposeIds: [purpose], observedAt: now, ingestedAt: now },
          owner: { ownerKind: "actor", ownerId: ownerActor, displayName: "Fixture owner" }, confidenceBasisPoints: 8_000, validFrom: now, recordedByActorId: ownerActor, recordedAt: now }));
      }
      await admin`INSERT INTO omni_customer_fact_revisions(tenant_id,workspace_id,account_id,fact_id,fact_revision_id,revision,mutation_id,owner_actor_id,fact_key,fact_kind,fact_state,allowed_purpose_ids,value_sha256,source_revision_sha256,fact_sha256,fact_snapshot,recorded_at)
        SELECT fact->>'tenantId',fact->>'workspaceId',fact->>'accountId',fact->>'factId',fact->>'factRevisionId',(fact->>'revision')::INTEGER,
          fact->>'mutationId',fact->>'recordedByActorId',fact->>'factKey',fact->>'kind',fact->>'state',ARRAY[${readPurpose}]::TEXT[],
          fact->>'valueSha256',fact->'source'->>'sourceRevisionSha256',fact->>'factSha256',fact,(fact->>'recordedAt')::TIMESTAMPTZ
        FROM jsonb_array_elements(${admin.json(batch)}::JSONB) AS seeded(fact)`;
    }
  }
});
