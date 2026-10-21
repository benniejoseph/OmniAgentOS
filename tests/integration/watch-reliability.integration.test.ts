/** Opt-in proof against the existing isolated candidate schema; never resets it. */
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import webpush from "web-push";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ serving: false, execute: vi.fn() }));
vi.mock("@/lib/db/client", async original => {
  const actual = await original<typeof import("@/lib/db/client")>();
  return { ...actual, ensureDatabaseSchema: () => harness.serving ? Promise.resolve() : actual.ensureDatabaseSchema() };
});
vi.mock("@/lib/tools/executor", () => ({ executeGovernedTool: harness.execute }));
import { closeDatabaseClient, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { readAvailabilityWatchesPushStatusWithSql } from "@/lib/availability-watches/notifications";
import { executeAvailabilityWatchJob } from "@/lib/availability-watches/runtime";
import { readAvailabilityCheck, readAvailabilityHead, saveAvailabilityCheck, saveAvailabilityHead, withAvailabilityOwner } from "@/lib/availability-watches/store";
import { resolveAvailabilityWatchConfig, type AvailabilityWatchProjection } from "@/lib/availability-watches/contracts";
import { enqueueOperationJob } from "@/lib/operations/job-queue";
import { browserDelivery, registerBrowserPush } from "@/lib/web-push/store";
import type { SecurityContext } from "@/lib/security/types";

const candidate = process.env.ASAEL_AGENT_CANDIDATE_DATABASE === "1" ? describe : describe.skip;
const tenant = `watch-reliability-${randomUUID()}`, user = randomUUID(), email = `${user}@example.test`, actor = `actor:${user}`;
const owner = { tenantId: tenant, actorId: actor };
const role = `candidate_${randomBytes(6).toString("hex")}`;
const hash = () => randomBytes(32).toString("hex");
const watchId = `watch_${randomBytes(24).toString("hex")}`, openingId = `availability-opening:${hash()}`;
const evidence: Record<string, unknown> = { tenant, scenario: "bounded watch delivery projection and expired legacy job admission", storage: "isolated loopback PostgreSQL" };

candidate("watch reliability with real PostgreSQL and actor RLS", () => {
  let admin: ReturnType<typeof postgres>;
  const scoped = <T>(operation: () => Promise<T>) => runWithDatabaseActorScope(tenant, [actor, email], operation);
  beforeAll(async () => {
    const url = new URL(process.env.ASAEL_CANDIDATE_DATABASE_URL ?? "http://invalid");
    if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/asael_agents_candidate") throw new Error("Only the isolated candidate database is allowed.");
    await closeDatabaseClient();
    admin = postgres(url.toString(), { ssl: false, prepare: false, max: 2, onnotice: () => undefined });
    expect((await admin`SELECT to_regclass('omni_availability_watches') AS table_name`)[0].table_name).toBe("omni_availability_watches");
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES (${user},${email},'synthetic-no-login')`;
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES (${tenant},'Watch reliability candidate',${tenant})`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES (${randomUUID()},${tenant},${user},'operator')`;
    url.username = role; url.password = password; url.searchParams.set("sslmode", "disable");
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "3"); vi.stubEnv("VERCEL", "");
    harness.serving = true;
    evidence.rls = await scoped(async () => (await getSql()`SELECT rolsuper,rolbypassrls,row_security_active('omni_mobile_push_deliveries') AS active FROM pg_roles WHERE rolname=current_user`)[0]);
    expect(evidence.rls).toMatchObject({ rolsuper: false, rolbypassrls: false, active: true });

    const session = randomUUID(), registration = randomUUID(), device = `candidate-${randomUUID()}`;
    await admin`INSERT INTO omni_mobile_sessions(id,family_id,user_id,tenant_id,device_id,device_name,platform,access_token_hash,refresh_token_hash,access_expires_at,refresh_expires_at,app_version,app_build_number,client_contract_version,client_attested_at)
      VALUES (${session},${randomUUID()},${user},${tenant},${device},'Synthetic Android','android',${hash()},${hash()},NOW()+interval '1 hour',NOW()+interval '1 day','1.39.0',113,60,NOW())`;
    await admin`INSERT INTO omni_mobile_push_registrations(id,tenant_id,owner_actor_id,user_id,mobile_session_id,device_id,platform,provider,environment,token_sha256,token_bundle,preview_policy,last_registered_at)
      VALUES (${registration},${tenant},${email},${user},${session},${device},'android','fcm','production',${hash()},'{}'::jsonb,'hidden',NOW())`;
    for (const [index, status] of ["queued", "delivered", "failed", "queued"].entries()) {
      const notice = randomUUID(), delivery = randomUUID(), occurrence = index === 3 ? `availability-opening:${hash()}` : openingId;
      // One ledger notice per occurrence; several device attempts can reference it.
      const existing = await admin`SELECT id FROM omni_personal_notifications WHERE tenant_id=${tenant} AND source_id=${watchId} AND occurrence_key=${occurrence}`;
      const notificationId = existing[0]?.id as string | undefined ?? notice;
      if (!existing.length) await admin`INSERT INTO omni_personal_notifications(id,tenant_id,actor_id,title,kind,source_type,source_id,occurrence_key,urgency,status,due_at)
        VALUES (${notice},${tenant},${actor},'Synthetic watch opening','availability_watch','availability_watch',${watchId},${occurrence},'update','unread',NOW())`;
      await admin`INSERT INTO omni_mobile_push_deliveries(id,tenant_id,owner_actor_id,registration_id,notification_id,cause_kind,cause_id,deep_link,dedupe_key,payload,status,provider_accepted_at)
        VALUES (${delivery},${tenant},${email},${registration},${notificationId},'notification',${notificationId},'/watches',${hash()},'{}'::jsonb,${status},${status === "delivered" ? new Date() : null})`;
      if (status === "delivered") for (const kind of ["received", "received", "opened"]) {
        await admin`INSERT INTO omni_mobile_push_delivery_receipts(id,tenant_id,owner_actor_id,delivery_id,registration_id,device_id,mobile_session_id,platform,receipt_kind,app_lifecycle,observed_at,idempotency_key_sha256,request_sha256)
          VALUES (${randomUUID()},${tenant},${email},${delivery},${registration},${device},${session},'android',${kind},'foreground',NOW(),${hash()},${hash()})`;
      }
    }
  });
  afterAll(async () => {
    await closeDatabaseClient();
    if (admin) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE ${role}`); await admin.end(); }
    if (process.env.ASAEL_CANDIDATE_EVIDENCE_FILE) await writeFile(process.env.ASAEL_CANDIDATE_EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    vi.unstubAllEnvs();
  });
  it("projects 100 watches, counts receipts once and excludes another occurrence and actor", async () => {
    const watches = [{ watchId, openingId }, ...Array.from({ length: 99 }, () => ({ watchId: `watch_${randomBytes(24).toString("hex")}`, openingId: null }))];
    const result = await scoped(() => readAvailabilityWatchesPushStatusWithSql(getSql(), owner, watches));
    expect(result.size).toBe(100);
    expect(result.get(watchId)).toMatchObject({ queued: 1, running: 0, providerAccepted: 1, received: 1, opened: 1, failed: 1, eligibleDevices: 1 });
    expect(result.get(watches[99].watchId)).toMatchObject({ queued: 0, received: 0, eligibleDevices: 1 });
    const otherActor = `actor:${randomUUID()}`;
    const foreign = await runWithDatabaseActorScope(tenant, [otherActor], () => readAvailabilityWatchesPushStatusWithSql(getSql(), owner, watches));
    expect(foreign.get(watchId)).toMatchObject({ queued: 0, received: 0, opened: 0, eligibleDevices: 0 });
    evidence.projection = { count: result.size, first: result.get(watchId), foreign: foreign.get(watchId) };
  });
  it("cancels a queued legacy check after its show window, without calling a provider", async () => {
    const now = new Date().toISOString(), yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const createdAt = new Date(Date.now() - 3 * 86400000).toISOString();
    // Old releases persisted day-end even for a noon-only request. Keep its original config digest intact.
    const config = resolveAvailabilityWatchConfig({ source: { provider: "district", cinemaId: "1022272", cinemaName: "Synthetic cinema", sourceUrl: "https://www.district.in/movies/synthetic-cinema-CD1022272" },
      target: { date: yesterday, timezone: "Asia/Kolkata", movieTitle: "Synthetic movie", language: "Tamil", seatClass: "gold", latestTime: "12:00" } }, createdAt);
    config.expiresAt = new Date(Date.now() + 86400000).toISOString();
    const id = `watch_${randomBytes(24).toString("hex")}`, checkId = `availability-check:${hash()}`;
    const watch: AvailabilityWatchProjection = { schemaVersion: 1, id, revision: 1, generation: 1, state: "active", config,
      lastCheckedAt: null, lastSuccessfulAt: null, nextCheckAt: null, checksUsed: 1, consecutiveFailures: 0, lastError: null,
      lastObservation: null, matches: [], openingId: null, notification: null, delivery: null, createdAt, updatedAt: now };
    const job = await withAvailabilityOwner(owner, async sql => {
      const job = await enqueueOperationJob({ tenantId: tenant, type: "availability.watch.check", dedupeMode: "idempotent", dedupeKey: checkId,
        payload: { actorId: actor, watchId: id, checkId, generation: 1, scheduledFor: createdAt } }, { sql });
      await saveAvailabilityHead(sql, owner, { watch, pendingCheckId: checkId });
      await saveAvailabilityCheck(sql, owner, id, { id: checkId, generation: 1, scheduledFor: createdAt, state: "queued", startedAt: null, finishedAt: null, observation: null, error: null, toolExecutionId: null }, job.id);
      return job;
    });
    expect(await executeAvailabilityWatchJob(job, new AbortController().signal)).toMatchObject({ outcome: "superseded" });
    const saved = await withAvailabilityOwner(owner, async sql => ({ head: await readAvailabilityHead(sql, owner, id), check: await readAvailabilityCheck(sql, owner, id, checkId) }));
    expect(saved.head).toMatchObject({ pendingCheckId: null, watch: { state: "expired", generation: 2, nextCheckAt: null, config } });
    expect(saved.check.check).toMatchObject({ state: "canceled" });
    expect(harness.execute).not.toHaveBeenCalled();
    evidence.expiredAdmission = { state: saved.head?.watch.state, checkState: saved.check.check.state, providerCalls: 0, originalConfigPreserved: true };
  });
  it("does not display a delayed browser opening after its final matching show has started", async () => {
    const keys = webpush.generateVAPIDKeys();
    vi.stubEnv("OMNIAGENT_WEB_PUSH_PUBLIC_KEY", keys.publicKey); vi.stubEnv("OMNIAGENT_WEB_PUSH_PRIVATE_KEY", keys.privateKey);
    vi.stubEnv("OMNIAGENT_WEB_PUSH_SUBJECT", "https://asael.example");
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", JSON.stringify({ activeKeyId: "candidate", keys: { candidate: randomBytes(32).toString("base64url") } }));
    const sessionId = randomUUID();
    const context: SecurityContext = { tenantId: tenant, actorId: email, role: "operator", source: "session", auth: { userId: user, email, sessionId, tenantName: "Synthetic" } };
    await admin`INSERT INTO omni_auth_sessions(id,user_id,tenant_id,token_hash,expires_at) VALUES (${sessionId},${user},${tenant},${hash()},NOW()+interval '1 hour')`;
    await admin`INSERT INTO omni_today_preferences(tenant_id,actor_id,timezone,notifications_enabled) VALUES (${tenant},${actor},'Asia/Kolkata',true)`;
    const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
    const registration = await registerBrowserPush(context, { endpoint: `https://fcm.googleapis.com/fcm/send/synthetic-${randomUUID()}`, expirationTime: null,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } });
    const now = new Date().toISOString(), date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const config = resolveAvailabilityWatchConfig({ source: { provider: "district", cinemaId: "1022272", cinemaName: "Synthetic cinema", sourceUrl: "https://www.district.in/movies/synthetic-cinema-CD1022272" },
      target: { date, timezone: "Asia/Kolkata", movieTitle: "Synthetic movie", language: "Tamil", seatClass: "gold", latestTime: "12:00" } }, now);
    const id = `watch_${randomBytes(24).toString("hex")}`, opening = `availability-opening:${hash()}`, notice = randomUUID(), delivery = `web_delivery_${randomBytes(24).toString("hex")}`;
    const watch: AvailabilityWatchProjection = { schemaVersion: 1, id, revision: 1, generation: 1, state: "fulfilled", config,
      lastCheckedAt: now, lastSuccessfulAt: now, nextCheckAt: null, checksUsed: 1, consecutiveFailures: 0, lastError: null,
      lastObservation: null, openingId: opening, notification: null, delivery: null, createdAt: now, updatedAt: now,
      matches: [{ sessionId: "synthetic-show", movieTitle: "Synthetic movie", language: "Tamil", format: "2D", startsAt: new Date(Date.now() + 3600000).toISOString(),
        localTime: "10:00", seatClass: "GOLD", availableSeats: 3, price: 100, currency: "INR", bookingUrl: config.source.sourceUrl }] };
    await withAvailabilityOwner(owner, sql => saveAvailabilityHead(sql, owner, { watch, pendingCheckId: null }));
    await admin`INSERT INTO omni_personal_notifications(id,tenant_id,actor_id,title,kind,source_type,source_id,occurrence_key,urgency,status,due_at)
      VALUES (${notice},${tenant},${actor},'Synthetic delayed opening','availability_watch','availability_watch',${id},${opening},'update','unread',NOW())`;
    await admin`INSERT INTO omni_web_push_deliveries(id,tenant_id,actor_id,registration_id,session_id,notification_id,occurrence_key,kind,state,expires_at,accepted_at)
      VALUES (${delivery},${tenant},${actor},${registration.id},${sessionId},${notice},${opening},'watch','accepted',${config.expiresAt},NOW())`;
    expect(await browserDelivery(context, delivery)).toMatchObject({ display: true, href: `/app/watches/${id}` });
    await withAvailabilityOwner(owner, sql => saveAvailabilityHead(sql, owner, { watch: { ...watch, revision: 2, updatedAt: new Date().toISOString(),
      matches: [{ ...watch.matches[0], startsAt: new Date(Date.now() - 60000).toISOString() }] }, pendingCheckId: null }, 1));
    await expect(browserDelivery(context, delivery)).rejects.toMatchObject({ code: "browser_alert_unavailable", message: "The booking alert is no longer actionable." });
    expect((await admin`SELECT received_at,opened_at FROM omni_web_push_deliveries WHERE id=${delivery}`)[0]).toMatchObject({ received_at: null, opened_at: null });
    evidence.delayedBrowserOpening = { actionableDisplayed: true, expiredShowRejected: true, noFalseReceipts: true };
  });
});
