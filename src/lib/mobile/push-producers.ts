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
  decideServerNotification,
  domainNotificationCandidate,
  MOBILE_PUSH_COOLDOWN_MINUTES,
  type DomainNotificationProducerKind,
  type NotificationDecisionPolicyInput,
} from "@/lib/mobile/notification-delivery-policy";
import {
  appendNotificationDecisionEvent,
  notificationDecisionExecutionScope,
} from "@/lib/mobile/notification-decision-events";
import {
  mobilePushTargetSchema,
  type MobilePushTarget,
} from "@/lib/mobile/push-contract";
import { getTodayPreferences } from "@/lib/today/briefs";
import { isQuietHoursActive } from "@/lib/today/notifications";

type ProducerKind = DomainNotificationProducerKind;

type ProducerCandidate = Readonly<{
  kind: ProducerKind;
  actorId: string;
  sourceId: string;
  occurrenceKey: string;
  occursAt: string;
  sourceState: "approval_required" | "scheduled" | "at_risk" |
    "completed" | "failed" | "canceled";
  cooldownActive: boolean;
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
      const decisionsByOutcome = {
        send: 0,
        defer: 0,
        digest: 0,
        suppress: 0,
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
          if (!preference.notificationsEnabled) {
            skippedByPreference += 1;
            continue;
          }
          const target = mobilePushTargetSchema.safeParse({
            kind: candidate.kind,
            id: candidate.sourceId,
          });
          if (!target.success) continue;
          const decision = decideServerNotification({
            candidate: domainNotificationCandidate({
              tenantId: options.tenantId,
              actorId: candidate.actorId,
              sourceKind: candidate.kind,
              sourceId: candidate.sourceId,
              occurrenceKey: candidate.occurrenceKey,
              occursAt: candidate.occursAt,
              sourceState: candidate.sourceState,
            }),
            policy: domainProducerPolicy(candidate, preference, now),
          });
          decisionsByOutcome[decision.outcome] += 1;
          const executionScope = notificationDecisionExecutionScope({
            tenantId: options.tenantId,
            actorId: candidate.actorId,
            sourceId: candidate.sourceId,
            producerId: "mobile-push-producer",
            decision,
          });
          const queued = await getSql().transaction(async (sql) => {
            const deliveries = decision.outcome === "send"
              ? await enqueueMobilePush({
                  tenantId: options.tenantId,
                  actorId: candidate.actorId,
                  target: target.data as MobilePushTarget,
                  occurrenceKey: candidate.occurrenceKey,
                  executionScope,
                  sql,
                })
              : [];
            await appendNotificationDecisionEvent({
              decision,
              executionScope,
              sql,
            });
            return deliveries;
          }) as Awaited<ReturnType<typeof enqueueMobilePush>>;
          if (decision.outcome !== "send") {
            skippedByPreference += 1;
          }
          queuedByKind[candidate.kind] += queued.length;
          if (totalQueued(queuedByKind) >= limit) break;
        }
      }
      return {
        scanned,
        queued: totalQueued(queuedByKind),
        queuedByKind,
        decisionsByOutcome,
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
  const cooldownFloor = new Date(
    now.getTime() - MOBILE_PUSH_COOLDOWN_MINUTES * 60_000,
  ).toISOString();
  const rows = await getSql()`
    (
      SELECT 'approval'::TEXT AS producer_kind,
        execution.actor_id AS owner_actor_id,
        execution.id AS source_id,
        execution.created_at::TEXT AS occurrence_key,
        execution.created_at AS occurs_at,
        'approval_required'::TEXT AS candidate_state,
        EXISTS (
          SELECT 1 FROM omni_mobile_push_deliveries delivery
          WHERE delivery.tenant_id = ${tenantId}
            AND delivery.owner_actor_id = execution.actor_id
            AND delivery.status IN ('queued', 'running', 'delivered', 'acknowledged')
            AND delivery.created_at >= ${cooldownFloor}
        ) AS cooldown_active
      FROM omni_tool_executions execution
      WHERE execution.tenant_id = ${tenantId}
        AND execution.actor_id IS NOT NULL
        AND execution.status = 'approval_required'
        AND execution.approval_required
        AND execution.created_at >= ${recentApproval}
      ORDER BY execution.created_at DESC, execution.id COLLATE "C"
      LIMIT ${perKindWindow}
    ) UNION ALL (
      SELECT 'meeting'::TEXT AS producer_kind,
        meeting.owner_actor_id,
        meeting.meeting_id AS source_id,
        meeting.current_revision_id || ':' || meeting.scheduled_start_at::TEXT AS occurrence_key,
        meeting.scheduled_start_at AS occurs_at,
        'scheduled'::TEXT AS candidate_state,
        EXISTS (
          SELECT 1 FROM omni_mobile_push_deliveries delivery
          WHERE delivery.tenant_id = ${tenantId}
            AND delivery.owner_actor_id = meeting.owner_actor_id
            AND delivery.status IN ('queued', 'running', 'delivered', 'acknowledged')
            AND delivery.created_at >= ${cooldownFloor}
        ) AS cooldown_active
      FROM omni_meetings meeting
      WHERE meeting.tenant_id = ${tenantId}
        AND meeting.status = 'scheduled'
        AND meeting.scheduled_start_at >= ${now.toISOString()}
        AND meeting.scheduled_start_at <= ${meetingHorizon}
      ORDER BY meeting.scheduled_start_at, meeting.meeting_id COLLATE "C"
      LIMIT ${perKindWindow}
    ) UNION ALL (
      SELECT 'customer'::TEXT AS producer_kind,
        health.owner_actor_id,
        health.account_id AS source_id,
        health.current_revision_id AS occurrence_key,
        health.evaluated_at AS occurs_at,
        'at_risk'::TEXT AS candidate_state,
        EXISTS (
          SELECT 1 FROM omni_mobile_push_deliveries delivery
          WHERE delivery.tenant_id = ${tenantId}
            AND delivery.owner_actor_id = health.owner_actor_id
            AND delivery.status IN ('queued', 'running', 'delivered', 'acknowledged')
            AND delivery.created_at >= ${cooldownFloor}
        ) AS cooldown_active
      FROM omni_customer_health_scores health
      WHERE health.tenant_id = ${tenantId}
        AND health.health_status = 'at_risk'
        AND health.evaluated_at >= ${recentCustomer}
      ORDER BY health.evaluated_at DESC, health.account_id COLLATE "C"
      LIMIT ${perKindWindow}
    ) UNION ALL (
      SELECT 'run'::TEXT AS producer_kind,
        run.owner_actor_id,
        run.id AS source_id,
        run.status || ':' || run.completed_at::TEXT AS occurrence_key,
        run.completed_at AS occurs_at,
        run.status::TEXT AS candidate_state,
        EXISTS (
          SELECT 1 FROM omni_mobile_push_deliveries delivery
          WHERE delivery.tenant_id = ${tenantId}
            AND delivery.owner_actor_id = run.owner_actor_id
            AND delivery.status IN ('queued', 'running', 'delivered', 'acknowledged')
            AND delivery.created_at >= ${cooldownFloor}
        ) AS cooldown_active
      FROM omni_agent_runs run
      WHERE run.tenant_id = ${tenantId}
        AND run.owner_actor_id IS NOT NULL
        AND run.status IN ('completed', 'failed', 'canceled')
        AND run.completed_at >= ${recentRun}
      ORDER BY run.completed_at DESC, run.id COLLATE "C"
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
    const sourceState = producerState(kind, row.candidate_state);
    return kind && occursAt && actorId && sourceId && occurrenceKey && sourceState
      ? [{
          kind,
          occursAt,
          actorId,
          sourceId,
          occurrenceKey,
          sourceState,
          cooldownActive: row.cooldown_active === true,
        }]
      : [];
  });
}

function domainProducerPolicy(
  candidate: ProducerCandidate,
  preference: Awaited<ReturnType<typeof getTodayPreferences>>,
  now: Date,
): NotificationDecisionPolicyInput {
  return {
    evaluatedAt: now.toISOString(),
    quietHoursActive: isQuietHoursActive(preference, now),
    cooldownActive: candidate.cooldownActive,
    digestEnabled: true,
    meetingImminenceMinutes: candidate.kind === "meeting"
      ? preference.reminderLeadMinutes
      : undefined,
  };
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

function producerState(
  kind: ProducerKind | undefined,
  value: unknown,
): ProducerCandidate["sourceState"] | undefined {
  const state = String(value || "");
  if (kind === "approval" && state === "approval_required") return state;
  if (kind === "meeting" && state === "scheduled") return state;
  if (kind === "customer" && state === "at_risk") return state;
  if (
    kind === "run" &&
    (state === "completed" || state === "failed" || state === "canceled")
  ) {
    return state;
  }
  return undefined;
}

function timestamp(value: unknown) {
  const result = value instanceof Date ? value.toISOString() : String(value || "");
  return Number.isFinite(Date.parse(result)) ? result : undefined;
}

function bounded(value: unknown, max: number) {
  const result = String(value || "").trim();
  return result && result.length <= max ? result : undefined;
}
