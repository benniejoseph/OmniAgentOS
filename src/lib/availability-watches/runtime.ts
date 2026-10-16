import { getSql, hasDatabaseUrl, ensureDatabaseSchema, runWithDatabaseActorScope, runWithDatabaseSystemScope } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import { enqueueOperationJob, type OperationJobRecord } from "@/lib/operations/job-queue";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { executeGovernedTool } from "@/lib/tools/executor";
import { availabilitySourceFailure } from "./adapter";
import { AvailabilityObservationSchema, AvailabilityWatchError, AvailabilityWatchIdSchema, type AvailabilityObservation, type AvailabilityWatchOwner, type AvailabilityWatchProjection } from "./contracts";
import { admitAvailabilityWatchOpeningWithSql, cancelAvailabilityWatchPushWithSql } from "./notifications";
import { appendAvailabilityEvent, availabilityNow, readAvailabilityCheck, readAvailabilityHead, resolveAvailabilityOwner, saveAvailabilityCheck, saveAvailabilityHead, withAvailabilityOwner, type WatchHead } from "./store";

export const emptyAvailabilityWatchSummary = () => ({ inspected: 0, queued: 0, delivered: 0, recovered: 0, failed: 0 });
/** Existing scheduler fast lane, bounded enumeration only; all work re-enters its exact owner. */
export async function processDueAvailabilityWatches(input: { limit?: number; deadlineAt?: number } = {}) {
  const summary = emptyAvailabilityWatchSummary(); if (!hasDatabaseUrl()) return summary; await ensureDatabaseSchema();
  const limit = Math.min(20, Math.max(1, input.limit || 5));
  const rows = await runWithDatabaseSystemScope("Enumerate bounded availability watch owner coordinates.", () => getSql()`
    SELECT tenant_id,actor_id,id FROM omni_availability_watches
    WHERE (state IN ('active','degraded') AND (next_check_at <= now() OR expires_at <= now() OR pending_check_id IS NOT NULL))
      OR (state = 'fulfilled' AND (notification_due_at <= now() OR (notification_due_at IS NOT NULL AND expires_at <= now())))
    ORDER BY COALESCE(notification_due_at,next_check_at,updated_at),id LIMIT ${limit}`);
  for (const row of rows) {
    if (Date.now() >= (input.deadlineAt || Infinity)) break; summary.inspected++;
    const owner = { tenantId: String(row.tenant_id), actorId: String(row.actor_id) };
    try {
      const outcome = await withAvailabilityOwner(owner, async (sql) => {
        const head = await readAvailabilityHead(sql, owner, String(row.id)); if (!head) return "unchanged";
        const now = await availabilityNow(sql);
        if (head.watch.config.expiresAt <= now) { await expireWatch(sql, owner, head, now); return "recovered"; }
        try { await resolveAvailabilityOwner(sql, owner); }
        catch (error) {
          if (!(error instanceof AvailabilityWatchError) || error.status !== 403) throw error;
          if (head.pendingCheckId) {
            const pending = await readAvailabilityCheck(sql, owner, head.watch.id, head.pendingCheckId);
            await saveAvailabilityCheck(sql, owner, head.watch.id, { ...pending.check, state: "canceled", finishedAt: now });
          }
          const previous = head.watch; head.watch = { ...previous, state: "stopped", generation: previous.generation + 1, revision: previous.revision + 1,
            nextCheckAt: null, updatedAt: now, lastError: { code: error.code, message: error.message, at: now },
            notification: previous.notification ? { ...previous.notification, state: "canceled", nextAttemptAt: null } : null };
          head.pendingCheckId = null; await saveAvailabilityHead(sql, owner, head, previous.revision); await cancelAvailabilityWatchPushWithSql(sql, owner, previous.id);
          await appendAvailabilityEvent(sql, owner, head.watch, "owner_unavailable"); return "recovered";
        }
        if (head.watch.state === "fulfilled") { return await deliverOpening(sql, owner, head, now) ? "delivered" : "unchanged"; }
        if (!["active", "degraded"].includes(head.watch.state)) return "unchanged";
        if (head.pendingCheckId) {
          const pending = await readAvailabilityCheck(sql, owner, head.watch.id, head.pendingCheckId);
          const jobs = await sql`SELECT status FROM omni_operation_jobs WHERE tenant_id = ${owner.tenantId} AND id = ${pending.jobId}`;
          if (!jobs.length || ["completed", "failed", "canceled", "quarantined"].includes(String(jobs[0].status))) {
            await settleFailure(sql, owner, head, pending.check.id, now, { code: "check_worker_unavailable", message: "The scheduled check ended without confirmed source evidence. Asael will retry within its remaining budget." });
            return "recovered";
          }
          return "unchanged";
        }
        if (!head.watch.nextCheckAt || head.watch.nextCheckAt > now) return "unchanged";
        if (head.watch.checksUsed >= head.watch.config.maxChecks) { await exhaustWatch(sql, owner, head, now); return "recovered"; }
        const previous = head.watch; const scheduledFor = previous.nextCheckAt!;
        const checkId = `availability-check:${canonicalJsonSha256([owner, previous.id, previous.generation, scheduledFor])}`;
        const job = await enqueueOperationJob({ tenantId: owner.tenantId, type: "availability.watch.check", priority: 20, maxAttempts: 3,
          dedupeMode: "idempotent", dedupeKey: checkId, payload: { actorId: owner.actorId, watchId: previous.id, checkId, generation: previous.generation, scheduledFor } }, { sql });
        await saveAvailabilityCheck(sql, owner, previous.id, { id: checkId, generation: previous.generation, scheduledFor,
          state: "queued", startedAt: null, finishedAt: null, observation: null, error: null, toolExecutionId: null }, job.id);
        head.pendingCheckId = checkId; head.watch = { ...previous, revision: previous.revision + 1, checksUsed: previous.checksUsed + 1,
          nextCheckAt: null, updatedAt: now };
        await saveAvailabilityHead(sql, owner, head, previous.revision); await appendAvailabilityEvent(sql, owner, head.watch, "check_queued", { checkId }); return "queued";
      });
      if (outcome === "queued" || outcome === "delivered" || outcome === "recovered") summary[outcome]++;
    } catch { summary.failed++; }
  }
  return summary;
}

/** Durable queue lease fences both dispatch admission and commit. Reads can be retried; openings cannot. */
export async function executeAvailabilityWatchJob(job: OperationJobRecord, abortSignal: AbortSignal): Promise<Record<string, unknown>> {
  const owner = { tenantId: job.tenantId, actorId: String(job.payload.actorId || "") };
  const watchId = AvailabilityWatchIdSchema.parse(job.payload.watchId); const checkId = String(job.payload.checkId || "");
  const admission = await withAvailabilityOwner(owner, async (sql) => {
    const head = await readAvailabilityHead(sql, owner, watchId); const now = await availabilityNow(sql);
    if (!head || !["active", "degraded"].includes(head.watch.state) || head.watch.generation !== job.payload.generation || head.pendingCheckId !== checkId) return null;
    if (head.watch.config.expiresAt <= now) { await expireWatch(sql, owner, head, now); return null; }
    await assertJobLease(sql, job); const pending = await readAvailabilityCheck(sql, owner, watchId, checkId);
    if (pending.jobId !== job.id || pending.check.generation !== head.watch.generation || pending.check.scheduledFor !== job.payload.scheduledFor || !["queued", "running"].includes(pending.check.state)) return null;
    const context = await resolveAvailabilityOwner(sql, owner);
    await saveAvailabilityCheck(sql, owner, watchId, { ...pending.check, state: "running", startedAt: pending.check.startedAt || now });
    return { config: head.watch.config, context };
  });
  if (!admission) return { resourceId: watchId, outcome: "superseded" };
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(admission.context);
  if (!actorBinding) throw new AvailabilityWatchError("The scheduled read owner could not be bound.", 403);
  let observation: AvailabilityObservation | undefined; let failure: { code: string; message: string } | undefined; let executionId: string | null = null;
  try {
    abortSignal.throwIfAborted();
    const result = await runWithDatabaseActorScope(owner.tenantId, actorBinding.readableOwnerActorIds, () => executeGovernedTool({
      toolId: "web.availability.inspect", input: { source: admission.config.source, target: admission.config.target }, dryRun: false, requireReadOnly: true,
      context: admission.context, requestActorBinding: actorBinding,
      executionScope: createExecutionScope({ tenantId: owner.tenantId, initiatingActorId: owner.actorId, executingPrincipalType: "user", executingPrincipalId: owner.actorId,
        correlationId: checkId, causationId: watchId, purpose: "availability_watch.scheduled_public_read" }),
      idempotencyKey: `${checkId}:attempt:${job.attempt}`, abortSignal,
    }));
    executionId = result.record.id;
    if (result.record.status !== "executed") {
      failure = availabilitySourceFailure(result.record.reason);
      throw new AvailabilityWatchError(failure.message, 503, failure.code);
    }
    observation = AvailabilityObservationSchema.parse(result.result);
    const observedUrl = new URL(observation.sourceUrl);
    if (Date.parse(observation.checkedAt) < Date.now() - 60_000 || Date.parse(observation.checkedAt) > Date.now() + 5_000 ||
      observedUrl.protocol !== "https:" || observedUrl.hostname !== "www.district.in" || observedUrl.port || observedUrl.username || observedUrl.password ||
      !observedUrl.pathname.endsWith(`-CD${admission.config.source.cinemaId}`) || observedUrl.searchParams.get("fromdate") !== admission.config.target.date) {
      throw new AvailabilityWatchError("The source result did not match the current scheduled check.", 503, "source_binding_changed");
    }
  } catch (error) { failure ||= availabilitySourceFailure(error); }
  return withAvailabilityOwner(owner, async (sql) => {
    const head = await readAvailabilityHead(sql, owner, watchId); const now = await availabilityNow(sql);
    if (!head || head.watch.generation !== job.payload.generation || head.pendingCheckId !== checkId || !["active", "degraded"].includes(head.watch.state)) return { resourceId: watchId, outcome: "superseded" };
    await assertJobLease(sql, job); await resolveAvailabilityOwner(sql, owner);
    if (head.watch.config.expiresAt <= now) { await expireWatch(sql, owner, head, now); return { resourceId: watchId, outcome: "expired" }; }
    if (!observation || failure) {
      await settleFailure(sql, owner, head, checkId, now, failure || { code: "source_unavailable", message: "The source returned no confirmed availability evidence." }, executionId);
      return { resourceId: watchId, outcome: "source_unavailable" };
    }
    const pending = await readAvailabilityCheck(sql, owner, watchId, checkId); const previous = head.watch;
    await saveAvailabilityCheck(sql, owner, watchId, { ...pending.check, state: "completed", finishedAt: now, observation, toolExecutionId: executionId });
    const found = observation.outcome === "available";
    const openingId = found ? `availability-opening:${canonicalJsonSha256([owner, watchId, previous.generation])}` : null;
    head.pendingCheckId = null;
    head.watch = { ...previous, revision: previous.revision + 1, state: found ? "fulfilled" : previous.checksUsed >= previous.config.maxChecks ? "exhausted" : "active",
      lastCheckedAt: now, lastSuccessfulAt: now, consecutiveFailures: 0, lastError: null, lastObservation: observation, matches: observation.matches,
      openingId, notification: found ? { state: "pending", notificationId: null, dispositionId: null, pushDeliveryIds: [], nextAttemptAt: now } : null,
      nextCheckAt: found || previous.checksUsed >= previous.config.maxChecks ? null : nextCheck(previous, now, 0), updatedAt: now };
    await saveAvailabilityHead(sql, owner, head, previous.revision);
    await appendAvailabilityEvent(sql, owner, head.watch, found ? "opening_observed" : previous.consecutiveFailures ? "source_recovered" : "checked", { checkId, outcome: observation.outcome, sourceSha256: observation.sourceSha256 });
    if (found) await deliverOpening(sql, owner, head, now);
    return { resourceId: watchId, outcome: observation.outcome, checkId };
  });
}
async function assertJobLease(sql: SqlClient, job: OperationJobRecord) {
  const rows = await sql`SELECT id FROM omni_operation_jobs WHERE tenant_id = ${job.tenantId} AND id = ${job.id} AND type = 'availability.watch.check'
    AND status = 'running' AND lease_owner = ${job.leaseOwner || ""} AND lease_expires_at > clock_timestamp() FOR UPDATE`;
  if (rows.length !== 1) throw new AvailabilityWatchError("The availability check lease expired.", 409, "availability_watch_lease_expired");
}
async function settleFailure(sql: SqlClient, owner: AvailabilityWatchOwner, head: WatchHead, checkId: string, now: string, failure: { code: string; message: string }, executionId: string | null = null) {
  const pending = await readAvailabilityCheck(sql, owner, head.watch.id, checkId); const previous = head.watch;
  await saveAvailabilityCheck(sql, owner, previous.id, { ...pending.check, state: "failed", finishedAt: now, error: failure, toolExecutionId: executionId });
  const exhausted = previous.checksUsed >= previous.config.maxChecks;
  head.watch = { ...previous, revision: previous.revision + 1, state: exhausted ? "exhausted" : "degraded", lastCheckedAt: now,
    consecutiveFailures: previous.consecutiveFailures + 1, lastError: { ...failure, at: now }, updatedAt: now,
    nextCheckAt: exhausted ? null : nextCheck(previous, now, previous.consecutiveFailures + 1) };
  head.pendingCheckId = null; await saveAvailabilityHead(sql, owner, head, previous.revision);
  await appendAvailabilityEvent(sql, owner, head.watch, "check_failed", { checkId, code: failure.code });
}
function nextCheck(watch: AvailabilityWatchProjection, now: string, failures: number) {
  const delay = Math.min(60, watch.config.intervalMinutes * Math.pow(2, Math.min(6, failures))) * 60_000;
  return new Date(Math.min(Date.parse(watch.config.expiresAt), Date.parse(now) + delay)).toISOString();
}
async function deliverOpening(sql: SqlClient, owner: AvailabilityWatchOwner, head: WatchHead, now: string) {
  const previous = head.watch;
  if (previous.state !== "fulfilled" || !previous.openingId || previous.config.expiresAt <= now || !previous.notification ||
    ["recorded", "expired", "canceled"].includes(previous.notification.state) || (previous.notification.nextAttemptAt && previous.notification.nextAttemptAt > now)) return false;
  const delivery = await admitAvailabilityWatchOpeningWithSql(sql, { ...owner, watchId: previous.id, generation: previous.generation,
    openingId: previous.openingId, observedAt: previous.lastObservation!.checkedAt,
    title: `Booking availability found: ${previous.config.target.movieTitle || "Movie"} at ${previous.lastObservation!.providerCinemaName}`.slice(0, 220), expiresAt: previous.config.expiresAt, now });
  head.watch = { ...previous, revision: previous.revision + 1, notification: delivery, updatedAt: now };
  await saveAvailabilityHead(sql, owner, head, previous.revision);
  await appendAvailabilityEvent(sql, owner, head.watch, "notification_updated", { state: delivery.state, notificationId: delivery.notificationId });
  return delivery.state === "recorded";
}
async function expireWatch(sql: SqlClient, owner: AvailabilityWatchOwner, head: WatchHead, now: string) {
  const previous = head.watch;
  if (["stopped", "expired", "exhausted"].includes(previous.state)) return;
  if (head.pendingCheckId) {
    const pending = await readAvailabilityCheck(sql, owner, previous.id, head.pendingCheckId);
    await saveAvailabilityCheck(sql, owner, previous.id, { ...pending.check, state: "canceled", finishedAt: now });
  }
  head.watch = { ...previous, state: previous.state === "fulfilled" ? "fulfilled" : "expired", revision: previous.revision + 1,
    generation: previous.state === "fulfilled" ? previous.generation : previous.generation + 1, nextCheckAt: null, updatedAt: now,
    notification: previous.notification && previous.notification.state !== "recorded" ? { ...previous.notification, state: "expired", nextAttemptAt: null } : previous.notification };
  head.pendingCheckId = null; await saveAvailabilityHead(sql, owner, head, previous.revision); await cancelAvailabilityWatchPushWithSql(sql, owner, previous.id);
  await appendAvailabilityEvent(sql, owner, head.watch, "expired");
}
async function exhaustWatch(sql: SqlClient, owner: AvailabilityWatchOwner, head: WatchHead, now: string) {
  const previous = head.watch; head.watch = { ...previous, state: "exhausted", revision: previous.revision + 1, nextCheckAt: null, updatedAt: now };
  await saveAvailabilityHead(sql, owner, head, previous.revision); await appendAvailabilityEvent(sql, owner, head.watch, "exhausted");
}
