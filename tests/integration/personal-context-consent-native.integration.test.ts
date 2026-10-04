import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { PERSONAL_CONTEXT_NOTICE_SHA256 } from "@/lib/memory/personal-context-consent";
import {
  PERSONAL_CONTEXT_CONSENT_NATIVE_ACCEPTED_EVENT,
  PERSONAL_CONTEXT_CONSENT_NATIVE_READ_PURPOSE,
  type PersonalContextConsentNativeCurrent,
  type PersonalContextConsentNativeRequest,
} from "@/lib/memory/personal-context-consent-native-contracts";
import {
  PERSONAL_CONTEXT_CONSENT_MANAGE_PURPOSE,
  activatePersonalContextConsent,
  readPersonalContextConsentNative,
  revokePersonalContextConsent,
  submitPersonalContextConsentNative,
  type PersonalContextConsentNativeAuthority,
} from "@/lib/memory/personal-context-consent-store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const userId = "11111111-1111-4111-8111-111111111111", otherUserId = "22222222-2222-4222-8222-222222222222";
const actor = `actor:${userId}`, otherActor = `actor:${otherUserId}`;
const runtimeRole = "personal_consent_test_runtime";
const actorBinding = { version: 1 as const, kind: "auth_user" as const, authUserId: userId, canonicalActorId: actor,
  legacyOwnerActorIds: ["consent-owner@example.test"], readableOwnerActorIds: [actor, "consent-owner@example.test"] };

// Destructive opt-in fixture. Product operations execute as a real runtime
// login with forced RLS and the existing column-limited consent grants.
databaseDescribe("native personal recall consent serving-role decisions", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 3, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`;
    await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT ON omni_schema_version,omni_auth_users,omni_auth_tenants,omni_auth_memberships,omni_agent_runs,omni_tool_executions TO ${runtimeRole}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON omni_events TO ${runtimeRole}`);
    await admin.unsafe(`GRANT USAGE ON SEQUENCE omni_events_seq_seq TO ${runtimeRole}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES
      (${userId},'consent-owner@example.test','fixture-only'),(${otherUserId},'consent-other@example.test','fixture-only')`;
    await closeDatabaseClient();
    const url = new URL(databaseUrl!); url.username = runtimeRole; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", randomBytes(32).toString("hex"));
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2"); vi.stubEnv("VERCEL", "");
    await ensureDatabaseSchema();
    const [proof] = await runWithDatabaseActorScope("consent-proof", [actor], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('public.omni_personal_context_consents') AS consent_rls,
      has_function_privilege(current_user,'public.omni_personal_context_consent_row_is_valid(smallint,text,text,bigint,text,text,smallint,text,text,bigint,text,text,timestamptz,timestamptz,timestamptz,timestamptz)','EXECUTE') AS can_validate,
      has_table_privilege(current_user,'public.omni_personal_context_consents','DELETE') AS can_delete,
      has_column_privilege(current_user,'public.omni_personal_context_consents','notice_sha256','UPDATE') AS can_rewrite_notice
      FROM pg_roles WHERE rolname=current_user`);
    expect(proof).toMatchObject({ role: runtimeRole, rolsuper: false, rolbypassrls: false, consent_rls: true,
      can_validate: true, can_delete: false, can_rewrite_notice: false });
  }, 180_000);
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) {
      if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${runtimeRole}`); await admin.unsafe(`DROP ROLE ${runtimeRole}`); }
      await admin.end();
    }
  });

  function authority(tenantId: string, purpose: string = PERSONAL_CONTEXT_CONSENT_NATIVE_READ_PURPOSE,
    ownerActorId = actor): PersonalContextConsentNativeAuthority {
    return { tenantId, ownerActorId, executionScope: createExecutionScope({ tenantId,
      initiatingActorId: ownerActorId, executingPrincipalType: "user", executingPrincipalId: ownerActorId,
      correlationId: `consent-fixture:${tenantId}`, purpose }) };
  }
  async function seed(tag: string) {
    const tenantId = `native-consent-${tag}`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},'Native consent fixture',${tenantId})`;
    for (const id of [userId, otherUserId]) {
      await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${`${tenantId}:${id}`},${tenantId},${id},'operator')`;
    }
    return tenantId;
  }
  function keyDigest(key: string) { return createHash("sha256").update(key).digest("hex"); }
  function read(tenantId: string, key?: string, ownerActorId = actor) {
    return readPersonalContextConsentNative(authority(tenantId, PERSONAL_CONTEXT_CONSENT_NATIVE_READ_PURPOSE, ownerActorId),
      key ? { acceptanceKeySha256: keyDigest(key) } : {});
  }
  function request(current: PersonalContextConsentNativeCurrent, action: PersonalContextConsentNativeRequest["action"] = "activate"): PersonalContextConsentNativeRequest {
    if (!current.decisionToken) throw new Error("Fixture store did not return its current decision token.");
    return { contract: "asael-personal-context-consent-decision:1", action, noticeSha256: current.notice.sha256,
      expectedState: current.state, expectedConsentGeneration: current.consentGeneration,
      expectedLifecycleRevision: current.lifecycleRevision, expectedDecisionToken: current.decisionToken };
  }
  function submit(tenantId: string, value: PersonalContextConsentNativeRequest, key = "decision-key") {
    return submitPersonalContextConsentNative({ authority: authority(tenantId, PERSONAL_CONTEXT_CONSENT_MANAGE_PURPOSE),
      idempotencyKey: key, request: value });
  }
  async function counts(tenantId: string) {
    const [rows] = await admin`SELECT count(*) AS count FROM omni_personal_context_consents WHERE tenant_id=${tenantId}`;
    const [events] = await admin`SELECT count(*) AS count FROM omni_events WHERE tenant_id=${tenantId}`;
    const [acceptances] = await admin`SELECT count(*) AS count FROM omni_events WHERE tenant_id=${tenantId} AND type=${PERSONAL_CONTEXT_CONSENT_NATIVE_ACCEPTED_EVENT}`;
    return { rows: Number(rows.count), events: Number(events.count), acceptances: Number(acceptances.count) };
  }

  test("accepts the exact notice and state atomically and reads one immutable decision by raw key digest", async () => {
    const tenant = await seed("accept"), before = await read(tenant), value = request(before.current);
    expect(before).toMatchObject({ current: { state: "inactive", consentGeneration: 0, lifecycleRevision: 0, authority: null }, acceptance: null });
    const result = await submit(tenant, value);
    expect(result).toMatchObject({ newlyApplied: true, current: { state: "active", consentGeneration: 1, lifecycleRevision: 1 },
      acceptance: { changed: true, idempotencyKeySha256: keyDigest("decision-key"), before: { consentGeneration: 0 }, after: { consentGeneration: 1 } } });
    expect((await read(tenant, "decision-key")).acceptance).toEqual(result.acceptance);
    expect((await read(tenant, "unknown-key")).acceptance).toBeNull();
    expect(await counts(tenant)).toEqual({ rows: 1, events: 2, acceptances: 1 });
    const [event] = await admin`SELECT payload FROM omni_events WHERE id=${result.acceptance.id}`;
    expect(event.payload.nativeAcceptance.expectedDecisionSha256).toBe(value.expectedDecisionToken);
    expect(event.payload.nativeAcceptance.expectedDecisionToken).toBeUndefined();
  });

  test("historical acceptance replay after revoke and reactivation never changes the current generation", async () => {
    const tenant = await seed("replay"), value = request((await read(tenant)).current);
    const accepted = await submit(tenant, value, "activate-first");
    const revoked = await submit(tenant, request(accepted.current, "revoke"), "revoke-first");
    expect(revoked.current).toMatchObject({ state: "inactive", consentGeneration: 1, lifecycleRevision: 2, authority: null });
    const replay = await submit(tenant, value, "activate-first");
    expect(replay.acceptance).toEqual(accepted.acceptance); expect(replay.newlyApplied).toBe(false);
    expect(replay.current).toEqual(revoked.current);
    expect((await read(tenant, "activate-first")).acceptance).toEqual(accepted.acceptance);
    const next = await submit(tenant, request(revoked.current), "activate-second");
    expect(next.current.consentGeneration).toBe(2);
    const replayLater = await submit(tenant, value, "activate-first");
    expect(replayLater.current).toEqual(next.current); expect(replayLater.acceptance).toEqual(accepted.acceptance);
    expect(await counts(tenant)).toEqual({ rows: 2, events: 6, acceptances: 3 });
  });

  test("delayed activation remains stale after the initial state becomes inactive again", async () => {
    const tenant = await seed("stale"), old = request((await read(tenant)).current);
    const active = await submit(tenant, old, "activate");
    await submit(tenant, request(active.current, "revoke"), "revoke");
    await expect(submit(tenant, old, "delayed-old-activation")).rejects.toMatchObject({ status: 409, code: "personal_context_consent_state_changed" });
    expect((await read(tenant)).current).toMatchObject({ state: "inactive", consentGeneration: 1, lifecycleRevision: 2 });
    expect(await counts(tenant)).toEqual({ rows: 1, events: 4, acceptances: 2 });
  });

  test("concurrent duplicate keys replay once while competing keys cannot accept the same stale generation", async () => {
    const duplicateTenant = await seed("duplicate"), duplicateValue = request((await read(duplicateTenant)).current);
    const duplicates = await Promise.all([submit(duplicateTenant, duplicateValue), submit(duplicateTenant, duplicateValue)]);
    expect(duplicates.map((value) => value.newlyApplied).sort()).toEqual([false, true]);
    expect(duplicates[0].acceptance).toEqual(duplicates[1].acceptance);
    expect(await counts(duplicateTenant)).toEqual({ rows: 1, events: 2, acceptances: 1 });
    const tenant = await seed("competing"), value = request((await read(tenant)).current);
    const results = await Promise.allSettled([submit(tenant, value, "first"), submit(tenant, value, "second")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ code: "personal_context_consent_state_changed", status: 409 });
    expect(await counts(tenant)).toEqual({ rows: 1, events: 2, acceptances: 1 });
  });

  test("fresh no-op decisions are receipted once but stale no-ops and changed same-key requests conflict", async () => {
    const tenant = await seed("noop"), initial = (await read(tenant)).current, value = request(initial, "revoke");
    const accepted = await submit(tenant, value, "noop");
    expect(accepted.acceptance.changed).toBe(false); expect(accepted.current).toEqual(initial);
    expect((await submit(tenant, value, "noop")).newlyApplied).toBe(false);
    await expect(submit(tenant, request(initial), "noop")).rejects.toMatchObject({ code: "personal_context_consent_key_conflict", status: 409 });
    const active = await submit(tenant, request(initial), "activate");
    const unchanged = await submit(tenant, request(active.current), "active-noop");
    expect(unchanged.acceptance.changed).toBe(false);
    await expect(submit(tenant, request(initial), "stale-active-noop")).rejects.toMatchObject({ code: "personal_context_consent_state_changed" });
    expect(await counts(tenant)).toEqual({ rows: 1, events: 4, acceptances: 3 });
  });

  test("legacy web activation and revocation share the same generation fence without invented native receipts", async () => {
    const tenant = await seed("web"), old = request((await read(tenant)).current);
    const web = { tenantId: tenant, actorBinding, executionScope: authority(tenant, PERSONAL_CONTEXT_CONSENT_MANAGE_PURPOSE).executionScope };
    await activatePersonalContextConsent({ ...web, noticeSha256: PERSONAL_CONTEXT_NOTICE_SHA256 });
    expect((await read(tenant)).current).toMatchObject({ state: "active", consentGeneration: 1, lifecycleRevision: 1 });
    await revokePersonalContextConsent(web);
    const current = await read(tenant, "legacy-web");
    expect(current).toMatchObject({ current: { state: "inactive", consentGeneration: 1, lifecycleRevision: 2 }, acceptance: null });
    await expect(submit(tenant, old)).rejects.toMatchObject({ code: "personal_context_consent_state_changed" });
    expect((await submit(tenant, request(current.current), "native-after-web")).current.consentGeneration).toBe(2);
    expect(await counts(tenant)).toEqual({ rows: 2, events: 4, acceptances: 1 });
  });

  test("exact receipts stay canonical owner and tenant private, and read authority never authorizes a decision", async () => {
    const tenant = await seed("private"), foreign = await seed("foreign"), value = request((await read(tenant)).current);
    await submit(tenant, value);
    expect(await read(tenant, "decision-key", otherActor)).toMatchObject({ current: { state: "inactive", consentGeneration: 0 }, acceptance: null });
    expect(await read(foreign, "decision-key")).toMatchObject({ current: { state: "inactive", consentGeneration: 0 }, acceptance: null });
    await expect(submitPersonalContextConsentNative({ authority: authority(tenant), idempotencyKey: "read-cannot-write", request: value }))
      .rejects.toMatchObject({ status: 403, code: "personal_context_consent_authority_invalid" });
    const delegated = authority(tenant, PERSONAL_CONTEXT_CONSENT_MANAGE_PURPOSE);
    await expect(submitPersonalContextConsentNative({ authority: { ...delegated,
      executionScope: { ...delegated.executionScope, executingPrincipalType: "agent", executingPrincipalId: "agent:fixture" } },
    idempotencyKey: "agent-cannot-write", request: value })).rejects.toMatchObject({ status: 403 });
  });

  test("failure to append the acceptance rolls back both consent history and its lifecycle event", async () => {
    const tenant = await seed("rollback"), value = request((await read(tenant)).current);
    await admin.unsafe(`CREATE FUNCTION reject_fixture_consent_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.tenant_id = 'native-consent-rollback' AND NEW.type = 'memory.personal_context_consent.decision.accepted'
        THEN RAISE EXCEPTION 'fixture acceptance unavailable'; END IF; RETURN NEW; END $$`);
    await admin`CREATE TRIGGER reject_fixture_consent_acceptance BEFORE INSERT ON omni_events
      FOR EACH ROW EXECUTE FUNCTION reject_fixture_consent_acceptance()`;
    try {
      await expect(submit(tenant, value)).rejects.toThrow();
      expect(await counts(tenant)).toEqual({ rows: 0, events: 0, acceptances: 0 });
      expect(await read(tenant, "decision-key")).toMatchObject({ current: { state: "inactive", consentGeneration: 0 }, acceptance: null });
    } finally {
      await admin`DROP TRIGGER reject_fixture_consent_acceptance ON omni_events`;
      await admin`DROP FUNCTION reject_fixture_consent_acceptance()`;
    }
    expect((await submit(tenant, value)).newlyApplied).toBe(true);
  });
});
