import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import {
  enqueueMobilePush,
  MobilePushStorageRequiredError,
} from "@/lib/mobile/push-store";
import {
  mobilePushDedupeKey,
  mobilePushTargetSchema,
  type MobilePushTarget,
} from "@/lib/mobile/push-contract";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { getTodayPreferences } from "@/lib/today/briefs";
import { isQuietHoursActive } from "@/lib/today/notifications";

type ProducerKind = "approval" | "meeting" | "customer" | "run";

type ProducerCandidate = Readonly<{
  kind: ProducerKind;
  actorId: string;
  sourceId: string;
  occurrenceKey: string;
  occursAt: string;
}>;

export async function processDomainMobilePushProducers(options: {
  tenantId: string;
  limit?: number;
  now?: Date;
}) {
  if (!hasDatabaseUrl()) throw new MobilePushStorageRequiredError();
  await ensureDatabaseSchema();
  const limit = Math.min(Math.max(Math.trunc(options.limit || 20), 1), 100);
  const now = options.now || new Date();
  return runWithDatabaseSystemScope(
    `Produce actor-private domain notifications for tenant ${options.tenantId}.`,
    async () => {
      const preferences = new Map<string, Awaited<ReturnType<typeof getTodayPreferences>>>();
      const queuedByKind: Record<ProducerKind, number> = {
        approval: 0,
        meeting: 0,
        customer: 0,
        run: 0,
      };
      const pageSize = Math.min(Math.max(limit, 20), 100);
      let offset = 0;
      let scanned = 0;
      let skippedByPreference = 0;
      let exhausted = false;
      while (!exhausted && totalQueued(queuedByKind) < limit) {
        const candidates = await readCandidatePage(
          options.tenantId,
          pageSize,
          offset,
          now,
        );
        exhausted = candidates.length < pageSize;
        offset += candidates.length;
        scanned += candidates.length;
        for (const candidate of candidates) {
          const preference = preferences.get(candidate.actorId) ||
            await getTodayPreferences({
              tenantId: options.tenantId,
              actorId: candidate.actorId,
            });
          preferences.set(candidate.actorId, preference);
          if (
            !preference.notificationsEnabled ||
            isQuietHoursActive(preference, now) ||
            (
              candidate.kind === "meeting" &&
              Date.parse(candidate.occursAt) >
                now.getTime() + preference.reminderLeadMinutes * 60_000
            )
          ) {
            skippedByPreference += 1;
            continue;
          }
          const target = mobilePushTargetSchema.safeParse({
            kind: candidate.kind,
            id: candidate.sourceId,
          });
          if (!target.success) continue;
          const correlationId = `mobile_push_producer_${mobilePushDedupeKey({
            tenantId: options.tenantId,
            actorId: candidate.actorId,
            kind: candidate.kind,
            sourceId: candidate.sourceId,
            occurrenceKey: candidate.occurrenceKey,
          })}`;
          const executionScope = createExecutionScope({
            tenantId: options.tenantId,
            initiatingActorId: candidate.actorId,
            executingPrincipalType: "system",
            executingPrincipalId: "mobile-push-producer",
            correlationId,
            causationId: candidate.sourceId,
            purpose: `mobile.push_producer.${candidate.kind}`,
          });
          const queued = await enqueueMobilePush({
            tenantId: options.tenantId,
            actorId: candidate.actorId,
            target: target.data as MobilePushTarget,
            occurrenceKey: candidate.occurrenceKey,
            executionScope,
          });
          queuedByKind[candidate.kind] += queued.length;
          if (totalQueued(queuedByKind) >= limit) break;
        }
      }
      return {
        scanned,
        queued: totalQueued(queuedByKind),
        queuedByKind,
        skippedByPreference,
      };
    },
  );
}

async function readCandidatePage(
  tenantId: string,
  pageSize: number,
  offset: number,
  now: Date,
) {
  const perKindWindow = pageSize + offset;
  const meetingHorizon = new Date(now.getTime() + 2 * 60 * 60_000).toISOString();
  const recentApproval = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
  const recentCustomer = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
  const recentRun = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const rows = await getSql()`
    (
      SELECT 'approval'::TEXT AS producer_kind,
        actor_id AS owner_actor_id,
        id AS source_id,
        created_at::TEXT AS occurrence_key,
        created_at AS occurs_at
      FROM omni_tool_executions
      WHERE tenant_id = ${tenantId}
        AND actor_id IS NOT NULL
        AND status = 'approval_required'
        AND approval_required
        AND created_at >= ${recentApproval}
      ORDER BY created_at DESC, id COLLATE "C"
      LIMIT ${perKindWindow}
    ) UNION ALL (
      SELECT 'meeting'::TEXT AS producer_kind,
        owner_actor_id,
        meeting_id AS source_id,
        current_revision_id || ':' || scheduled_start_at::TEXT AS occurrence_key,
        scheduled_start_at AS occurs_at
      FROM omni_meetings
      WHERE tenant_id = ${tenantId}
        AND status = 'scheduled'
        AND scheduled_start_at >= ${now.toISOString()}
        AND scheduled_start_at <= ${meetingHorizon}
      ORDER BY scheduled_start_at, meeting_id COLLATE "C"
      LIMIT ${perKindWindow}
    ) UNION ALL (
      SELECT 'customer'::TEXT AS producer_kind,
        owner_actor_id,
        account_id AS source_id,
        current_revision_id AS occurrence_key,
        evaluated_at AS occurs_at
      FROM omni_customer_health_scores
      WHERE tenant_id = ${tenantId}
        AND health_status = 'at_risk'
        AND evaluated_at >= ${recentCustomer}
      ORDER BY evaluated_at DESC, account_id COLLATE "C"
      LIMIT ${perKindWindow}
    ) UNION ALL (
      SELECT 'run'::TEXT AS producer_kind,
        owner_actor_id,
        id AS source_id,
        status || ':' || completed_at::TEXT AS occurrence_key,
        completed_at AS occurs_at
      FROM omni_agent_runs
      WHERE tenant_id = ${tenantId}
        AND owner_actor_id IS NOT NULL
        AND status IN ('completed', 'failed', 'canceled')
        AND completed_at >= ${recentRun}
      ORDER BY completed_at DESC, id COLLATE "C"
      LIMIT ${perKindWindow}
    )
    ORDER BY occurs_at DESC, producer_kind COLLATE "C", source_id COLLATE "C"
    LIMIT ${pageSize}
    OFFSET ${offset}
  `;
  return rows.flatMap((row): ProducerCandidate[] => {
    const kind = producerKind(row.producer_kind);
    const occursAt = timestamp(row.occurs_at);
    const actorId = bounded(row.owner_actor_id, 500);
    const sourceId = bounded(row.source_id, 240);
    const occurrenceKey = bounded(row.occurrence_key, 1_000);
    return kind && occursAt && actorId && sourceId && occurrenceKey
      ? [{ kind, occursAt, actorId, sourceId, occurrenceKey }]
      : [];
  });
}

function totalQueued(queuedByKind: Record<ProducerKind, number>) {
  return Object.values(queuedByKind).reduce((sum, count) => sum + count, 0);
}

function producerKind(value: unknown): ProducerKind | undefined {
  return value === "approval" || value === "meeting" ||
      value === "customer" || value === "run"
    ? value
    : undefined;
}

function timestamp(value: unknown) {
  const result = value instanceof Date ? value.toISOString() : String(value || "");
  return Number.isFinite(Date.parse(result)) ? result : undefined;
}

function bounded(value: unknown, max: number) {
  const result = String(value || "").trim();
  return result && result.length <= max ? result : undefined;
}
