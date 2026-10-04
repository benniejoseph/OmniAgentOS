import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema, getSql, runWithDatabaseActorScope, runWithDatabaseTenantScope } from "@/lib/db/client";
import { acceptMeetingCalendarSync, readMeetingCalendarSync, readBlockedMeetingCalendarSync, readMeetingCalendarConnection,
  settleMeetingCalendarSync, type MeetingCalendarAuthority } from "@/lib/connectors/meeting-calendar-sync-store";
import { GOOGLE_CALENDAR_EVENTS_READ_SCOPE } from "@/lib/connectors/google-workspace-capabilities";
import { MEETING_CALENDAR_SYNC_CONTRACT } from "@/lib/mobile/meeting-calendar-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl && process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true" ? describe : describe.skip;
const owner = "calendar-owner@example.test", other = "calendar-other@example.test", roleName = "meeting_calendar_test_runtime";
const canonical = "actor:11111111-1111-4111-8111-111111111111", workspace = `workspace:personal:${canonical.slice(6)}`;
const sha = (key: string) => createHash("sha256").update(key).digest("hex");

// Disposable database only. No credential opening, provider calls or network
// synchronization occurs: the real serving-role intent/receipt store is tested.
integration("Meeting Calendar durable acceptance with forced owner RLS", () => {
  let admin: ReturnType<typeof postgres>, roleCreated = false;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 3, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema();
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    roleCreated = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    // Empty-schema bootstrap does not provision the legacy serving grants.
    // Keep these explicit; the new receipt table must use migration 224's
    // inherited grants, and all product operations still run with forced RLS.
    await admin.unsafe(`GRANT SELECT ON public.omni_schema_version,public.omni_auth_users,public.omni_auth_tenants,public.omni_auth_memberships,public.omni_agent_runs,public.omni_tool_executions TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,UPDATE ON public.omni_oauth_grants TO ${roleName}`);
    await admin.unsafe(`GRANT SELECT,INSERT ON public.omni_events TO ${roleName}`);
    await admin.unsafe(`GRANT USAGE ON SEQUENCE public.omni_events_seq_seq TO ${roleName}`);
    await closeDatabaseClient();
    const url = new URL(databaseUrl!); url.username = roleName; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "2"); vi.stubEnv("VERCEL", "");
    await ensureDatabaseSchema();
    const [role] = await runWithDatabaseActorScope("calendar-proof", [owner], () => getSql()`SELECT current_user AS role,rolsuper,rolbypassrls,
      row_security_active('public.omni_meeting_calendar_sync_acceptances') AS active FROM pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ role: roleName, rolsuper: false, rolbypassrls: false, active: true });
  }, 180_000);
  afterAll(async () => {
    await closeDatabaseClient(); vi.unstubAllEnvs();
    if (admin) {
      if (roleCreated) { await admin.unsafe(`DROP OWNED BY ${roleName}`); await admin.unsafe(`DROP ROLE ${roleName}`); }
      await admin.end();
    }
  });
  async function seed(tag: string) {
    const tenantId = `calendar-${tag}`, connectionId = randomUUID();
    await admin`INSERT INTO omni_oauth_grants(id,tenant_id,actor_id,provider,account_email,connection_purpose,scopes,sealed_tokens,authorization_generation)
      VALUES(${connectionId},${tenantId},${owner},'google',${owner},'personal',${[GOOGLE_CALENDAR_EVENTS_READ_SCOPE]},'{}'::JSONB,3)`;
    const scope = { tenantId, ownerActorId: owner, canonicalActorId: canonical, workspaceId: workspace };
    const executionScope = createExecutionScope({ tenantId, initiatingActorId: owner, executingPrincipalType: "user", executingPrincipalId: owner,
      correlationId: `calendar-fixture:${tag}`, causationId: connectionId, purpose: "api.meetings.calendar.sync" });
    const authority: MeetingCalendarAuthority = { scope, executionScope, accountEmail: owner };
    const request = { contract: MEETING_CALENDAR_SYNC_CONTRACT, connectionId, expectedAuthorizationGeneration: 3 };
    return { authority, request };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const accept = (fixture: Fixture, key = "calendar-one") => acceptMeetingCalendarSync({ ...fixture, idempotencyKey: key });
  const eventCount = async (fixture: Fixture) => Number((await admin`SELECT count(*) AS count FROM omni_events
    WHERE tenant_id=${fixture.authority.scope.tenantId} AND type LIKE 'meeting.calendar.sync.%'`)[0].count);
  test("co-commits one immutable acceptance and returns the same receipt on exact replay", async () => {
    const fixture = await seed("replay"), first = await accept(fixture), replay = await accept(fixture);
    expect(first.newlyAccepted).toBe(true); expect(replay).toEqual({ sync: first.sync, newlyAccepted: false });
    expect(await eventCount(fixture)).toBe(1);
    expect(await readMeetingCalendarSync(fixture.authority, first.sync.acceptance.id, sha("calendar-one"))).toEqual(first.sync);
    expect(await readMeetingCalendarSync(fixture.authority, first.sync.acceptance.id, sha("another-key"))).toBeNull();
    await expect(acceptMeetingCalendarSync({ ...fixture, request: { ...fixture.request, expectedAuthorizationGeneration: 4 }, idempotencyKey: "calendar-one" })).rejects.toMatchObject({ code: "calendar_key_conflict" });
  });
  test("serializes different keys for the same connection and holds uncertainty permanently", async () => {
    const fixture = await seed("concurrent");
    const results = await Promise.allSettled([accept(fixture, "calendar-a"), accept(fixture, "calendar-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("No acceptance won the parent lock.");
    const id = winner.value.sync.acceptance.id;
    const unknown = await settleMeetingCalendarSync(fixture.authority, id, null);
    expect(unknown.state).toBe("unconfirmed");
    expect(await readBlockedMeetingCalendarSync(fixture.authority, fixture.request.connectionId)).toEqual(unknown);
    await expect(accept(fixture, "calendar-third")).rejects.toMatchObject({ code: "calendar_sync_unconfirmed" });
    expect(await eventCount(fixture)).toBe(2);
  });
  test("settles once without changing acceptance and allows a later deliberate sync", async () => {
    const fixture = await seed("settled"), first = await accept(fixture), observedAt = new Date(Date.now() + 1_000);
    observedAt.setUTCMilliseconds(123);
    const at = observedAt.toISOString();
    const settlement = { status: "healthy" as const, imported: 2, removed: 0, cursorAdvanced: true,
      coverage: { status: "healthy" as const, backfillState: "complete" as const, lastAttemptedAt: at, lastSuccessfulAt: at, failureCode: "none" as const }, settledAt: at };
    const settled = await settleMeetingCalendarSync(fixture.authority, first.sync.acceptance.id, settlement);
    expect(settled.acceptance).toEqual(first.sync.acceptance); expect(settled.state).toBe("settled");
    expect(settled.updatedAt).toBe(at); expect(settled.settlement).toEqual(settlement);
    expect(await settleMeetingCalendarSync(fixture.authority, first.sync.acceptance.id, null)).toEqual(settled);
    expect((await accept(fixture)).sync).toEqual(settled); expect(await eventCount(fixture)).toBe(2);
    expect((await accept(fixture, "calendar-next")).newlyAccepted).toBe(true);
  });
  test("denies stale authorization, missing scope and an active web sync lease before acceptance", async () => {
    const fixture = await seed("authority");
    await expect(accept({ ...fixture, request: { ...fixture.request, expectedAuthorizationGeneration: 2 } })).rejects.toMatchObject({ code: "calendar_connection_changed" });
    await admin`UPDATE omni_oauth_grants SET scopes=${[]} WHERE id=${fixture.request.connectionId}`;
    await expect(accept(fixture)).rejects.toMatchObject({ code: "calendar_connection_changed" });
    await admin`UPDATE omni_oauth_grants SET scopes=${[GOOGLE_CALENDAR_EVENTS_READ_SCOPE]},sync_lease_owner_id='web-sync',sync_lease_expires_at=clock_timestamp()+INTERVAL '1 minute'
      WHERE id=${fixture.request.connectionId}`;
    await expect(accept(fixture)).rejects.toMatchObject({ code: "calendar_sync_busy" });
    expect(await eventCount(fixture)).toBe(0);
  });
  test("keeps exact recovery after revocation while excluding every other owner and actor-free scope", async () => {
    const fixture = await seed("private"), first = await accept(fixture), tenantId = fixture.authority.scope.tenantId;
    await admin`UPDATE omni_oauth_grants SET status='revoked',authorization_generation=4 WHERE id=${fixture.request.connectionId}`;
    expect(await readMeetingCalendarSync(fixture.authority, first.sync.acceptance.id, sha("calendar-one"))).toEqual(first.sync);
    expect(await readMeetingCalendarConnection(fixture.authority)).toMatchObject({ status: "revoked", authorizationGeneration: 4 });
    for (const actorId of [other, null]) {
      const scoped = <T>(operation: () => Promise<T>) => actorId === null
        ? runWithDatabaseTenantScope(tenantId, operation)
        : runWithDatabaseActorScope(tenantId, [actorId], operation);
      const visible = await scoped(() => getSql()`SELECT id FROM omni_meeting_calendar_sync_acceptances WHERE tenant_id=${tenantId}`);
      const events = await scoped(() => getSql()`SELECT id FROM omni_events WHERE tenant_id=${tenantId} AND type LIKE 'meeting.calendar.sync.%'`);
      expect(visible).toEqual([]); expect(events).toEqual([]);
    }
  });
  test("serving role cannot alter immutable acceptance coordinates or invent terminal evidence", async () => {
    const fixture = await seed("immutable"), first = await accept(fixture), tenantId = fixture.authority.scope.tenantId;
    const owned = <T>(work: () => Promise<T>) => runWithDatabaseActorScope(tenantId, [owner], work);
    await expect(owned(() => getSql()`UPDATE omni_meeting_calendar_sync_acceptances SET request_sha256=${"b".repeat(64)} WHERE id=${first.sync.acceptance.id}`)).rejects.toThrow();
    await expect(owned(() => getSql()`UPDATE omni_meeting_calendar_sync_acceptances SET state='unconfirmed' WHERE id=${first.sync.acceptance.id}`)).rejects.toThrow();
    expect(await eventCount(fixture)).toBe(1);
  });
});
