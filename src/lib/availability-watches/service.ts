import { randomUUID } from "node:crypto";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { cancelAvailabilityWatchPushWithSql, readAvailabilityWatchPushStatusWithSql, readAvailabilityWatchesPushStatusWithSql } from "./notifications";
import { AVAILABILITY_WATCH_CONTRACT, AVAILABILITY_WATCH_COVERAGE, AvailabilityWatchCheckSchema, AvailabilityWatchCreateInputSchema, AvailabilityWatchError, AvailabilityWatchIdSchema,
  resolveAvailabilityWatchConfig, type AvailabilityWatchOwner, type AvailabilityWatchProjection } from "./contracts";
import { appendAvailabilityEvent, availabilityHeadFromRow, availabilityNow, lockAvailabilityOwner, readAvailabilityHead, readAvailabilityMutation, readAvailabilityCheck,
  resolveAvailabilityOwner, saveAvailabilityCheck, saveAvailabilityHead, saveAvailabilityMutation, withAvailabilityOwner } from "./store";

export async function createAvailabilityWatch(input: unknown, owner: AvailabilityWatchOwner & { requestId: string }): Promise<AvailabilityWatchProjection> {
  const request = { action: "create", input: AvailabilityWatchCreateInputSchema.parse(input) };
  return withAvailabilityOwner(owner, async (sql) => {
    await lockAvailabilityOwner(sql, owner); await resolveAvailabilityOwner(sql, owner);
    const replay = await readAvailabilityMutation(sql, owner, owner.requestId, request); if (replay) return replay;
    const now = await availabilityNow(sql); const config = resolveAvailabilityWatchConfig(input, now);
    // The default budget shrinks as time passes. It is not a new user intent:
    // repeated requests for the same target retain the original watch budget.
    const duplicateIdentity = { ...config } as Record<string, unknown>;
    if (request.input.maxChecks === undefined) delete duplicateIdentity.maxChecks;
    const duplicates = request.input.maxChecks === undefined
      ? await sql`SELECT * FROM omni_availability_watches WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
          AND ((snapshot->'config') - 'maxChecks') = ${duplicateIdentity}::jsonb AND state IN ('active','degraded','fulfilled') AND expires_at > ${now}::timestamptz
          ORDER BY created_at,id LIMIT 1 FOR UPDATE`
      : await sql`SELECT * FROM omni_availability_watches WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
          AND config_sha256 = ${canonicalJsonSha256(config)} AND state IN ('active','degraded','fulfilled') AND expires_at > ${now}::timestamptz
          ORDER BY created_at,id LIMIT 1 FOR UPDATE`;
    if (duplicates[0]) {
      const existing = availabilityHeadFromRow(duplicates[0], owner).watch;
      await saveAvailabilityMutation(sql, owner, owner.requestId, request, existing); return existing;
    }
    const counts = await sql`SELECT count(*)::int AS count FROM omni_availability_watches WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId}
      AND state IN ('active','degraded') AND expires_at > ${now}::timestamptz`;
    if (Number(counts[0]?.count) >= 20) throw new AvailabilityWatchError("Stop an existing watch before adding more than 20 active watches.", 409, "availability_watch_limit");
    const watch: AvailabilityWatchProjection = { schemaVersion: 1, id: `watch_${canonicalJsonSha256([owner.tenantId, owner.actorId, randomUUID()]).slice(0, 48)}`,
      revision: 1, generation: 1, state: "active", config, lastCheckedAt: null, lastSuccessfulAt: null, nextCheckAt: now,
      checksUsed: 0, consecutiveFailures: 0, lastError: null, lastObservation: null, matches: [], openingId: null, notification: null, delivery: null, createdAt: now, updatedAt: now };
    await saveAvailabilityHead(sql, owner, { watch, pendingCheckId: null }); await appendAvailabilityEvent(sql, owner, watch, "created");
    await saveAvailabilityMutation(sql, owner, owner.requestId, request, watch); return watch;
  });
}
export async function listAvailabilityWatches(owner: AvailabilityWatchOwner & { limit?: number }) {
  return withAvailabilityOwner(owner, async (sql) => {
    await resolveAvailabilityOwner(sql, owner); const limit = Math.min(100, Math.max(1, owner.limit || 40));
    const rows = await sql`SELECT * FROM omni_availability_watches WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} ORDER BY created_at DESC,id LIMIT ${limit + 1}`;
    const watches = rows.slice(0, limit).map(row => availabilityHeadFromRow(row, owner).watch);
    const deliveries = await readAvailabilityWatchesPushStatusWithSql(sql, owner, watches.map(watch => ({ watchId: watch.id, openingId: watch.openingId })));
    return { schemaVersion: 1 as const, contract: AVAILABILITY_WATCH_CONTRACT, coverage: AVAILABILITY_WATCH_COVERAGE,
      watches: watches.map(watch => ({ ...watch, delivery: deliveries.get(watch.id)! })), hasMore: rows.length > limit };
  });
}
export async function getAvailabilityWatch(id: string, owner: AvailabilityWatchOwner, page: { limit?: number; before?: { scheduledFor: string; id: string } } = {}) {
  AvailabilityWatchIdSchema.parse(id);
  return withAvailabilityOwner(owner, async (sql) => {
    await resolveAvailabilityOwner(sql, owner); const head = await readAvailabilityHead(sql, owner, id, false); if (!head) throw notFound();
    const limit = Math.min(40, Math.max(1, page.limit ?? 40));
    const rows = page.before
      ? await sql`SELECT snapshot FROM omni_availability_watch_checks WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND watch_id = ${id}
          AND (scheduled_for < ${page.before.scheduledFor}::timestamptz OR (scheduled_for = ${page.before.scheduledFor}::timestamptz AND id > ${page.before.id}))
          ORDER BY scheduled_for DESC,id LIMIT ${limit + 1}`
      : await sql`SELECT snapshot FROM omni_availability_watch_checks WHERE tenant_id = ${owner.tenantId} AND actor_id = ${owner.actorId} AND watch_id = ${id} ORDER BY scheduled_for DESC,id LIMIT ${limit + 1}`;
    const checks = rows.slice(0, limit).map(row => AvailabilityWatchCheckSchema.parse(row.snapshot));
    const last = checks.at(-1);
    return { schemaVersion: 1 as const, contract: AVAILABILITY_WATCH_CONTRACT, coverage: AVAILABILITY_WATCH_COVERAGE,
      watch: { ...head.watch, delivery: await readAvailabilityWatchPushStatusWithSql(sql, { ...owner, watchId: id, openingId: head.watch.openingId }) },
      checks, hasMore: rows.length > limit, nextPage: rows.length > limit && last ? { id, limit, before: { scheduledFor: last.scheduledFor, id: last.id } } : null };
  });
}
export async function stopAvailabilityWatch(id: string, owner: AvailabilityWatchOwner & { expectedRevision: number; requestId: string }): Promise<AvailabilityWatchProjection> {
  AvailabilityWatchIdSchema.parse(id);
  if (!Number.isSafeInteger(owner.expectedRevision) || owner.expectedRevision < 1) throw new AvailabilityWatchError("An exact saved watch revision is required.");
  const request = { action: "stop", id, expectedRevision: owner.expectedRevision };
  return withAvailabilityOwner(owner, async (sql) => {
    await lockAvailabilityOwner(sql, owner); await resolveAvailabilityOwner(sql, owner);
    const replay = await readAvailabilityMutation(sql, owner, owner.requestId, request); if (replay) return replay;
    const head = await readAvailabilityHead(sql, owner, id); if (!head) throw notFound(); const previous = head.watch;
    if (previous.revision !== owner.expectedRevision) throw new AvailabilityWatchError("The watch changed; refresh it before stopping.", 409, "availability_watch_changed");
    if (previous.state === "stopped") { await saveAvailabilityMutation(sql, owner, owner.requestId, request, previous); return previous; }
    const now = await availabilityNow(sql); const watch: AvailabilityWatchProjection = { ...previous, state: "stopped", revision: previous.revision + 1, generation: previous.generation + 1,
      nextCheckAt: null, updatedAt: now, notification: previous.notification && previous.notification.state !== "recorded" ? { ...previous.notification, state: "canceled", nextAttemptAt: null } : previous.notification };
    if (head.pendingCheckId) {
      const pending = await readAvailabilityCheck(sql, owner, id, head.pendingCheckId);
      await saveAvailabilityCheck(sql, owner, id, { ...pending.check, state: "canceled", finishedAt: now });
    }
    await saveAvailabilityHead(sql, owner, { watch, pendingCheckId: null }, previous.revision); await cancelAvailabilityWatchPushWithSql(sql, owner, id);
    await appendAvailabilityEvent(sql, owner, watch, "stopped"); await saveAvailabilityMutation(sql, owner, owner.requestId, request, watch); return watch;
  });
}
function notFound() { return new AvailabilityWatchError("This watch is unavailable in your account.", 404, "availability_watch_not_found"); }
