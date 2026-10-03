import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDatabaseClient, ensureDatabaseSchema } from "@/lib/db/client";
import { changeResponsibility } from "@/lib/responsibilities/store";
import { responsibilityId, reviewPreview } from "@/lib/responsibilities/state";
import { recordResponsibilityObservation, readResponsibilityObservationHistory } from "@/lib/responsibilities/observation-store";
import { draftFixture, pinsFixture } from "@/lib/responsibilities/test-fixtures";
import { observationSource, sourceReadFixture, projectionFixture } from "@/lib/responsibilities/observation-test-fixtures";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY } from "@/lib/responsibilities/comparison-policy";
import type { ResponsibilityRecord, ResponsibilitySource } from "@/lib/responsibilities/contracts";
import type { ResponsibilityOwner } from "@/lib/responsibilities/state";
import { observeResponsibility } from "@/lib/responsibilities/observation-service";
import { saveMeeting } from "@/lib/meetings/store";
import type { MeetingDraftInput } from "@/lib/meetings/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const databaseUrl = process.env.DATABASE_URL;
const resetAllowed = process.env.OMNIAGENT_INTEGRATION_DATABASE_RESET === "true";
const databaseDescribe = databaseUrl && resetAllowed ? describe : describe.skip;
const policySha256 = RESPONSIBILITY_MEETING_COMPARISON_POLICY.policySha256;
type Transaction = postgres.TransactionSql;

// Disposable database only, following the existing integration lane guard.
// Synthetic source adapters exercise persistence; canonical source admission
// has its separate exact-owner/revision/consent tests. No source/provider effect.
databaseDescribe("Responsibility observation durable boundaries", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await closeDatabaseClient();
    admin = postgres(databaseUrl!, { max: 1, prepare: false,
      ssl: new URL(databaseUrl!).searchParams.get("sslmode") === "disable" ? false : "require", onnotice: () => undefined });
    await admin`DROP SCHEMA IF EXISTS public CASCADE`; await admin`CREATE SCHEMA public`;
    await ensureDatabaseSchema(); await admin`GRANT USAGE ON SCHEMA public TO omni_runtime`;
  });
  afterAll(async () => { await closeDatabaseClient(); await admin?.end(); });

  async function reviewed(tag: string, sources: ResponsibilitySource[] = [observationSource]) {
    const owner = { tenantId: `observation-${tag}`, actorId: "actor:11111111-1111-4111-8111-111111111111" };
    const now = new Date().toISOString();
    const draft = { ...draftFixture, sources, cadence: { ...draftFixture.cadence!, startsAt: now, expiresAt: new Date(Date.parse(now) + 86_400_000).toISOString() } };
    const id = responsibilityId(owner, "create");
    const first = await changeResponsibility(owner, id, { action: "create", expectedRevision: 0, draft }, "create");
    const preview = reviewPreview(first.current, { ...pinsFixture, sources: sources.map((source) => ({ source, revisionSha256: "a".repeat(64) })) });
    const result = await changeResponsibility(owner, id, { action: "review", expectedRevision: 1, draftSha256: preview.draftSha256, reviewSha256: preview.reviewSha256 }, "review", preview);
    return { owner, record: result.current };
  }
  function request(record: ResponsibilityRecord, expectedBaselineRevision = 0) {
    return { responsibilityId: record.id, expectedResponsibilityRevision: record.revision, expectedReviewSha256: record.review!.reviewSha256, expectedBaselineRevision, policySha256 };
  }
  function reader(owner: ResponsibilityOwner, projection = projectionFixture) {
    return vi.fn(async () => {
      const fixture = sourceReadFixture(projection); const now = new Date().toISOString();
      return { ...fixture, authority: { ...fixture.authority, tenantId: owner.tenantId, requestActorId: owner.actorId, authoredOwnerActorId: owner.actorId },
        observedAt: now, sourceUpdatedAt: now, freshUntil: new Date(Date.parse(now) + 3_600_000).toISOString() };
    });
  }
  async function asRuntime<T>(owner: ResponsibilityOwner, operation: (sql: Transaction) => Promise<T>) {
    return admin.begin(async (sql) => {
      await sql`SET LOCAL ROLE omni_runtime`; await sql`SELECT set_config('omni.system_scope','false',true)`;
      await sql`SELECT set_config('omni.tenant_id',${owner.tenantId},true)`;
      await sql`SELECT set_config('omni.actor_scope_v1',${JSON.stringify({ version: 1, tenantId: owner.tenantId, actorIds: [owner.actorId] })},true)`;
      return operation(sql);
    });
  }

  test("co-commits content-free receipt/baseline/event and enforces exact actor/tenant reads", async () => {
    const { owner, record } = await reviewed("owner"); const now = new Date().toISOString();
    // Stable source time cannot be newer than the admitted check time.
    const source = reader(owner); const evidence = await source();
    const result = await recordResponsibilityObservation(owner, request(record), "first", async () => evidence, new Date().toISOString());
    expect(result.receipt.plan.outcome).toBe("baseline_established"); expect(result.currentBaseline?.revision).toBe(1);
    const history = await readResponsibilityObservationHistory(owner, record.id, 25);
    expect(history.receipts).toEqual([result.receipt]); expect(history.baseline).toEqual(result.currentBaseline);
    const events = await admin`SELECT type,payload FROM omni_events WHERE id = ${result.receipt.plan.observation.id}`;
    expect(events).toHaveLength(1); expect(events[0].payload).toMatchObject({ outcome: "baseline_established", deliveryRequested: false, activationSupported: false });
    expect(JSON.stringify(events)).not.toContain("Budget review");
    expect(result.receipt.savedAt >= now).toBe(true);
    for (const foreign of [{ ...owner, actorId: "other" }, { ...owner, tenantId: "other" }]) {
      await expect(readResponsibilityObservationHistory(foreign, record.id, 25)).rejects.toMatchObject({ status: 404 });
      const rows = await asRuntime(foreign, async (sql) => ({ observations: await sql`SELECT id FROM omni_responsibility_observations`, baselines: await sql`SELECT observation_id FROM omni_responsibility_baselines`, changes: await sql`SELECT id FROM omni_responsibility_changes` }));
      expect(rows).toEqual({ observations: [], baselines: [], changes: [] });
    }
  });

  test("serializes duplicate admission and stale baseline CAS while replay remains immutable after review edits", async () => {
    const { owner, record } = await reviewed("cas"); const evidence = await reader(owner)(); const now = new Date().toISOString();
    const source = vi.fn(async () => evidence);
    const pair = await Promise.all([recordResponsibilityObservation(owner, request(record), "same", source, now), recordResponsibilityObservation(owner, request(record), "same", source, now)]);
    expect(pair.map((value) => value.replayed).sort()).toEqual([false, true]); expect(pair[0].receipt).toEqual(pair[1].receipt); expect(source).toHaveBeenCalledTimes(1);
    const contenders = await Promise.allSettled(["a", "b"].map((key) => recordResponsibilityObservation(owner, request(record, 1), key, source, now)));
    expect(contenders.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect((contenders.find((value) => value.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "responsibility_baseline_revision_conflict" });
    await changeResponsibility(owner, record.id, { action: "update", expectedRevision: record.revision, draft: { ...record.draft, purpose: "Updated draft" } }, "update");
    const noRead = vi.fn().mockRejectedValue(new Error("source no longer readable"));
    const replay = await recordResponsibilityObservation(owner, request(record), "same", noRead, new Date().toISOString());
    expect(replay.receipt).toEqual(pair[0].receipt); expect(replay.currentBaseline?.revision).toBe(2); expect(noRead).not.toHaveBeenCalled();
    await expect(recordResponsibilityObservation(owner, request(record, 2), "new", noRead, new Date().toISOString())).rejects.toMatchObject({ code: "responsibility_observation_review_changed" });
  });

  test("keeps independent changes after quiet provenance advancement and failed/blocked checks", async () => {
    const { owner, record } = await reviewed("changes");
    const first = await reader(owner)();
    await recordResponsibilityObservation(owner, request(record), "first", async () => first, new Date().toISOString());
    const changed = await reader(owner, { ...projectionFixture, meeting: { ...projectionFixture.meeting!, startsAt: "2026-10-05T09:30:00.000Z" } })();
    const material = await recordResponsibilityObservation(owner, request(record, 1), "changed", async () => changed, new Date().toISOString());
    expect(material.receipt.plan.outcome).toBe("material_change"); expect(material.receipt.plan.change?.deliveryState).toBe("not_requested");
    const quiet = await recordResponsibilityObservation(owner, request(record, 2), "quiet", async () => changed, new Date().toISOString());
    expect(quiet.receipt.plan.outcome).toBe("no_change"); expect(quiet.currentBaseline?.revision).toBe(3);
    // The managed client deliberately reserves all transaction control. An SQL
    // failure aborts the whole observation; it cannot confirm a failed receipt.
    await expect(recordResponsibilityObservation(owner, request(record, 3), "sql-failed", async (_input, sql) => {
      await sql`SELECT 1 / 0`; return first;
    }, new Date().toISOString())).rejects.toMatchObject({ code: "25P02" });
    const afterSqlFailure = await readResponsibilityObservationHistory(owner, record.id, 25);
    expect(afterSqlFailure.receipts).toHaveLength(3); expect(afterSqlFailure.baseline).toEqual(quiet.currentBaseline);
    const failed = await recordResponsibilityObservation(owner, request(record, 3), "failed", async () => { throw new Error("source retrieval unavailable"); }, new Date().toISOString());
    const denied = await recordResponsibilityObservation(owner, request(record, 3), "denied", async () => ({ state: "unavailable", source: observationSource, reason: "access_denied" }), new Date().toISOString());
    expect(failed.receipt.plan.outcome).toBe("failed"); expect(denied.receipt.plan.outcome).toBe("blocked");
    expect(failed.currentBaseline).toEqual(quiet.currentBaseline); expect(denied.currentBaseline).toEqual(quiet.currentBaseline);
    const changes = await admin`SELECT snapshot FROM omni_responsibility_changes WHERE tenant_id = ${owner.tenantId}`;
    expect(changes.map((row) => row.snapshot)).toEqual([material.receipt.plan.change]);
    await expect(admin`DELETE FROM omni_responsibility_changes WHERE id = ${material.receipt.plan.change!.id}`).rejects.toMatchObject({ code: "23514" });
    await expect(admin`UPDATE omni_responsibility_observations SET outcome = 'no_change' WHERE id = ${failed.receipt.plan.observation.id}`).rejects.toMatchObject({ code: "23514" });
    await expect(admin`UPDATE omni_responsibility_baselines SET revision = revision + 2 WHERE tenant_id = ${owner.tenantId}`).rejects.toMatchObject({ code: "23514" });
    const short = await readResponsibilityObservationHistory(owner, record.id, 2); expect(short.receipts).toHaveLength(2); expect(short.hasMore).toBe(true);
  });

  test("rolls back every observation row when its event cannot commit", async () => {
    const { owner, record } = await reviewed("rollback"); const evidence = await reader(owner)();
    await admin.unsafe(`CREATE FUNCTION public.reject_fixture_observation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'responsibility.observation.recorded' AND NEW.tenant_id = 'observation-rollback' THEN RAISE EXCEPTION 'fixture event rejection'; END IF; RETURN NEW; END $$`);
    await admin`CREATE TRIGGER reject_fixture_observation_event BEFORE INSERT ON omni_events FOR EACH ROW EXECUTE FUNCTION public.reject_fixture_observation_event()`;
    try {
      await expect(recordResponsibilityObservation(owner, request(record), "failed-commit", async () => evidence, new Date().toISOString())).rejects.toThrow(/fixture event rejection/);
      expect(await admin`SELECT id FROM omni_responsibility_observations WHERE tenant_id = ${owner.tenantId}`).toEqual([]);
      expect(await admin`SELECT observation_id FROM omni_responsibility_baselines WHERE tenant_id = ${owner.tenantId}`).toEqual([]);
      expect(await admin`SELECT id FROM omni_responsibility_changes WHERE tenant_id = ${owner.tenantId}`).toEqual([]);
    } finally {
      await admin`DROP TRIGGER reject_fixture_observation_event ON omni_events`; await admin`DROP FUNCTION public.reject_fixture_observation_event()`;
    }
  });

  test("admits the real canonical Meeting head and blocks a later consent revocation", async () => {
    const tenantId = "observation-native"; const userId = "11111111-1111-4111-8111-111111111111";
    const actorId = `actor:${userId}`; const workspaceId = "workspace:observation-native";
    await admin`INSERT INTO omni_auth_tenants (id,name,slug) VALUES (${tenantId},'Observation native','observation-native')`;
    await admin`INSERT INTO omni_auth_users (id,email,password_hash) VALUES (${userId},'observation-native@example.test','fixture-only')`;
    await admin`INSERT INTO omni_auth_memberships (id,tenant_id,user_id,role) VALUES ('membership:observation-native',${tenantId},${userId},'admin')`;
    await admin`INSERT INTO omni_tenant_workspaces (tenant_id,workspace_id,display_name,owner_actor_id,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},'Observation native',${actorId},'active',1,${actorId},${actorId},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    await admin`INSERT INTO omni_tenant_workspace_memberships (tenant_id,workspace_id,subject_kind,subject_key,subject_actor_id,membership_generation,access_level,state,lifecycle_revision,created_by_actor_id,activated_by_actor_id,created_at,activated_at,updated_at)
      VALUES (${tenantId},${workspaceId},'user',${actorId},${actorId},1,'manager','active',1,${actorId},${actorId},statement_timestamp(),statement_timestamp(),statement_timestamp())`;
    const now = new Date().toISOString();
    const draft: MeetingDraftInput = { title: "A native meeting", summary: "Exact stored summary, not an extracted agenda", status: "scheduled",
      scheduledStartAt: new Date(Date.parse(now) + 3_600_000).toISOString(), scheduledEndAt: new Date(Date.parse(now) + 7_200_000).toISOString(), actualStartAt: null, actualEndAt: null,
      timezone: "UTC", location: "", projectId: null, declaredAccessClass: "owner_private", participants: [{ participantId: "owner", displayName: "Owner", email: null, entityId: null,
        role: "organizer", response: "accepted", attendeeConsent: "granted", recordingConsent: "not_required", consentCapturedAt: now, source: "manual" }],
      sourceLinks: [], entityLinks: [], decisions: [], commitments: [], followUps: [] };
    const authority = { tenantId, workspaceId, canonicalActorId: actorId, readableActorIds: [actorId], idempotencyKey: "native-meeting",
      executionScope: createExecutionScope({ tenantId, initiatingActorId: actorId, executingPrincipalType: "user", executingPrincipalId: actorId, workspaceId, correlationId: "native-meeting", purpose: "meeting.write" }) };
    const meeting = await saveMeeting({ authority, draft });
    const { record } = await reviewed("native", [{ kind: "meeting", id: meeting.meetingId, workspaceId }]);
    const context: SecurityContext = { tenantId, actorId: "observation-native@example.test", role: "operator", source: "session",
      auth: { userId, email: "observation-native@example.test", sessionId: "fixture", tenantName: "Native" } };
    const accepted = await observeResponsibility(context, request(record), "native-read");
    expect(accepted.receipt.plan.outcome).toBe("baseline_established");
    expect(accepted.receipt.plan.observation.sources[0]).toMatchObject({ revisionId: meeting.meetingRevisionId, revisionSha256: meeting.meetingSha256, observedAt: meeting.revisedAt });
    await saveMeeting({ authority: { ...authority, idempotencyKey: "revoke-attendee-consent" }, meetingId: meeting.meetingId, expectedRevision: 1,
      draft: { ...draft, participants: [{ ...draft.participants[0], attendeeConsent: "declined" }] } });
    const revoked = await observeResponsibility(context, request(record, 1), "native-revoked");
    expect(revoked.receipt.plan.outcome).toBe("blocked"); expect(revoked.currentBaseline).toEqual(accepted.currentBaseline);
  });
});
