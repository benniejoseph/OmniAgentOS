import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import type { NotificationCandidateV1 } from "@/lib/mobile/notification-decision";
import { notificationDecisionExecutionScope } from "@/lib/mobile/notification-decision-events";
import {
  decideServerNotification,
  delegatedTaskNotificationCandidate,
  domainNotificationCandidate,
  MOBILE_PUSH_COOLDOWN_MINUTES,
  notificationDispositionCoordinates,
  scheduledRoutineNotificationCandidate,
  securityIncidentNotificationCandidate,
  type DomainNotificationProducerKind,
  type NotificationDecisionPolicyInput,
} from "@/lib/mobile/notification-delivery-policy";
import type { NotificationDispositionSourceKind } from "@/lib/mobile/notification-disposition";
import {
  applyNotificationDispositionDecision,
  flushDueNotificationDigest,
  listDueNotificationDigestActors,
} from "@/lib/mobile/notification-disposition-store";
import {
  mobilePushTargetSchema,
  type MobilePushTarget,
} from "@/lib/mobile/push-contract";
import {
  enqueueMobilePush,
  MobilePushStorageRequiredError,
} from "@/lib/mobile/push-store";
import { getTodayPreferences } from "@/lib/today/briefs";
import { isQuietHoursActive } from "@/lib/today/notifications";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type ProducerKind = DomainNotificationProducerKind;
const MAX_DIGEST_BATCHES_PER_ACTOR = 5;
type ProactiveProducerKind = ProducerKind | "delegation" | "routine" | "security";
type CandidateState =
  | "approval_required"
  | "scheduled"
  | "at_risk"
  | "completed"
  | "failed"
  | "canceled"
  | "waiting"
  | "rejected"
  | "circuit_open"
  | "security_warning"
  | "security_critical";

type ProducerCandidate = Readonly<{
  kind: ProactiveProducerKind;
  sourceKind: NotificationDispositionSourceKind;
  actorId: string;
  sourceId: string;
  occurrenceKey: string;
  occursAt: string;
  sourceState: CandidateState;
  cooldownActive: boolean;
  target: MobilePushTarget;
}>;

type ProducerCursor = Readonly<{
  occursAt: string;
  kind: ProactiveProducerKind;
  sourceId: string;
  actorId: string;
  occurrenceKey: string;
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
      const preferences = new Map<
        string,
        Awaited<ReturnType<typeof getTodayPreferences>>
      >();
      const queuedByKind: Record<ProducerKind, number> = {
        approval: 0,
        meeting: 0,
        customer: 0,
        run: 0,
      };
      const queuedProactiveByKind = {
        delegation: 0,
        routine: 0,
        security: 0,
      };
      const processedByKind: Record<ProactiveProducerKind, number> = {
        approval: 0,
        meeting: 0,
        customer: 0,
        run: 0,
        delegation: 0,
        routine: 0,
        security: 0,
      };
      const decisionsByOutcome = {
        send: 0,
        defer: 0,
        digest: 0,
        suppress: 0,
      };
      const digestActors = new Set<string>();
      const pageSize = Math.min(Math.max(limit, 20), 100);
      let cursor: ProducerCursor | undefined;
      let scanned = 0;
      let dispositionsApplied = 0;
      let queued = 0;
      let skippedByPreference = 0;
      let exhausted = false;
      while (!exhausted && dispositionsApplied < limit) {
        const candidates = await readCandidatePage(
          options.tenantId,
          pageSize,
          cursor,
          now,
        );
        exhausted = candidates.length < pageSize;
        scanned += candidates.length;
        if (candidates.length) cursor = producerCursor(candidates.at(-1)!);
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
          const notificationCandidate = candidateForSource(
            options.tenantId,
            candidate,
          );
          const decision = decideServerNotification({
            candidate: notificationCandidate,
            policy: domainProducerPolicy(candidate, preference, now),
          });
          const coordinates = notificationDispositionCoordinates({
            tenantId: options.tenantId,
            ownerActorId: candidate.actorId,
            sourceKind: candidate.sourceKind,
            sourceId: candidate.sourceId,
            occurrenceKey: candidate.occurrenceKey,
            decision,
          });
          const executionScope = notificationDecisionExecutionScope({
            tenantId: options.tenantId,
            actorId: candidate.actorId,
            sourceId: candidate.sourceId,
            producerId: "proactive-notification-producer",
            decision,
          });
          const result = await applyNotificationDispositionDecision({
            coordinates,
            decision,
            executionScope,
            now,
            directDelivery: decision.outcome === "send"
              ? async (sql) => {
                  const deliveries = await enqueueMobilePush({
                    tenantId: options.tenantId,
                    actorId: candidate.actorId,
                    target: candidate.target,
                    occurrenceKey: candidate.occurrenceKey,
                    executionScope,
                    sql,
                  });
                  return {
                    deliveryKind: "mobile_push_outbox" as const,
                    deliveryIds: deliveries.map((delivery) => delivery.id),
                    targetSha256: canonicalJsonSha256(candidate.target),
                  };
                }
              : undefined,
          });
          if (!result.applied) continue;
          dispositionsApplied += 1;
          processedByKind[candidate.kind] += 1;
          decisionsByOutcome[decision.outcome] += 1;
          if (decision.outcome === "digest") digestActors.add(candidate.actorId);
          if (decision.outcome !== "send") skippedByPreference += 1;
          queued += result.deliveryIds.length;
          if (isLegacyProducerKind(candidate.kind)) {
            queuedByKind[candidate.kind] += result.deliveryIds.length;
          } else {
            queuedProactiveByKind[candidate.kind] += result.deliveryIds.length;
          }
          if (dispositionsApplied >= limit) break;
        }
      }
      for (const actorId of await listDueNotificationDigestActors({
        tenantId: options.tenantId,
        now,
      })) {
        digestActors.add(actorId);
      }
      let digestsDelivered = 0;
      for (const actorId of [...digestActors].sort()) {
        for (
          let batch = 0;
          batch < MAX_DIGEST_BATCHES_PER_ACTOR;
          batch += 1
        ) {
          const delivered = await flushDueNotificationDigest({
            tenantId: options.tenantId,
            ownerActorId: actorId,
            now,
          });
          if (!delivered) break;
          digestsDelivered += 1;
        }
      }
      return {
        scanned,
        dispositionsApplied,
        queued,
        queuedByKind,
        queuedProactiveByKind,
        processedByKind,
        decisionsByOutcome,
        digestsDelivered,
        skippedByPreference,
      };
    },
  );
}

async function readCandidatePage(
  tenantId: string,
  pageSize: number,
  cursor: ProducerCursor | undefined,
  now: Date,
) {
  const nowIso = now.toISOString();
  const meetingHorizon = new Date(now.getTime() + 2 * 60 * 60_000).toISOString();
  const recentThirtyDays = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
  const recentDay = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const cooldownFloor = new Date(
    now.getTime() - MOBILE_PUSH_COOLDOWN_MINUTES * 60_000,
  ).toISOString();
  const rows = await getSql()`
    WITH candidates AS (
      (
        SELECT 'approval'::TEXT AS producer_kind,
          'tool_approval'::TEXT AS source_kind,
          execution.actor_id AS owner_actor_id,
          execution.id AS source_id,
          execution.created_at::TEXT AS occurrence_key,
          execution.created_at AS occurs_at,
          'approval_required'::TEXT AS candidate_state,
          'approval'::TEXT AS target_kind,
          execution.id AS target_id,
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
          AND execution.created_at >= ${recentThirtyDays}
      ) UNION ALL (
        SELECT 'meeting', 'meeting', meeting.owner_actor_id,
          meeting.meeting_id,
          meeting.current_revision_id || ':' || meeting.scheduled_start_at::TEXT,
          meeting.scheduled_start_at, 'scheduled', 'meeting', meeting.meeting_id,
          EXISTS (
            SELECT 1 FROM omni_mobile_push_deliveries delivery
            WHERE delivery.tenant_id = ${tenantId}
              AND delivery.owner_actor_id = meeting.owner_actor_id
              AND delivery.status IN ('queued', 'running', 'delivered', 'acknowledged')
              AND delivery.created_at >= ${cooldownFloor}
          )
        FROM omni_meetings meeting
        WHERE meeting.tenant_id = ${tenantId}
          AND meeting.status = 'scheduled'
          AND meeting.scheduled_start_at >= ${nowIso}
          AND meeting.scheduled_start_at <= ${meetingHorizon}
      ) UNION ALL (
        SELECT 'customer', 'customer_risk', health.owner_actor_id,
          health.account_id, health.current_revision_id, health.evaluated_at,
          'at_risk', 'customer', health.account_id,
          EXISTS (
            SELECT 1 FROM omni_mobile_push_deliveries delivery
            WHERE delivery.tenant_id = ${tenantId}
              AND delivery.owner_actor_id = health.owner_actor_id
              AND delivery.status IN ('queued', 'running', 'delivered', 'acknowledged')
              AND delivery.created_at >= ${cooldownFloor}
          )
        FROM omni_customer_health_scores health
        WHERE health.tenant_id = ${tenantId}
          AND health.health_status = 'at_risk'
          AND health.evaluated_at >= ${recentThirtyDays}
      ) UNION ALL (
        SELECT 'run', 'agent_run', run.owner_actor_id, run.id,
          run.status || ':' || run.completed_at::TEXT, run.completed_at,
          run.status::TEXT, 'run', run.id,
          EXISTS (
            SELECT 1 FROM omni_mobile_push_deliveries delivery
            WHERE delivery.tenant_id = ${tenantId}
              AND delivery.owner_actor_id = run.owner_actor_id
              AND delivery.status IN ('queued', 'running', 'delivered', 'acknowledged')
              AND delivery.created_at >= ${cooldownFloor}
          )
        FROM omni_agent_runs run
        WHERE run.tenant_id = ${tenantId}
          AND run.owner_actor_id IS NOT NULL
          AND run.status IN ('completed', 'failed', 'canceled')
          AND run.completed_at >= ${recentDay}
      ) UNION ALL (
        SELECT 'delegation', 'delegated_task', execution.owner_actor_id,
          execution.execution_id,
          execution.state || ':' || execution.lifecycle_revision::TEXT || ':' || execution.updated_at::TEXT,
          execution.updated_at, execution.state::TEXT, 'run',
          execution.child_run_id,
          EXISTS (
            SELECT 1 FROM omni_mobile_push_deliveries delivery
            WHERE delivery.tenant_id = ${tenantId}
              AND delivery.owner_actor_id = execution.owner_actor_id
              AND delivery.status IN ('queued', 'running', 'delivered', 'acknowledged')
              AND delivery.created_at >= ${cooldownFloor}
          )
        FROM omni_delegation_executions execution
        INNER JOIN omni_agent_runs child_run
          ON child_run.tenant_id = execution.tenant_id
          AND child_run.owner_actor_id = execution.owner_actor_id
          AND child_run.id = execution.child_run_id
        WHERE execution.tenant_id = ${tenantId}
          AND (
            execution.state IN ('failed', 'rejected')
            OR (
              execution.state = 'waiting'
              AND child_run.status = 'waiting_approval'
            )
          )
          AND execution.updated_at >= ${recentThirtyDays}
      ) UNION ALL (
        SELECT 'routine', 'scheduled_routine', occurrence.owner_actor_id,
          occurrence.id,
          'failed:' || occurrence.updated_at::TEXT || ':' || occurrence.attempt_count::TEXT,
          occurrence.updated_at, 'failed', 'notification', occurrence.id,
          EXISTS (
            SELECT 1 FROM omni_mobile_push_deliveries delivery
            WHERE delivery.tenant_id = ${tenantId}
              AND delivery.owner_actor_id = occurrence.owner_actor_id
              AND delivery.status IN ('queued', 'running', 'delivered', 'acknowledged')
              AND delivery.created_at >= ${cooldownFloor}
          )
        FROM omni_workflow_schedule_occurrences occurrence
        WHERE occurrence.tenant_id = ${tenantId}
          AND occurrence.status = 'failed'
          AND occurrence.updated_at >= ${recentThirtyDays}
      ) UNION ALL (
        SELECT 'routine', 'scheduled_routine', occurrence.owner_actor_id,
          occurrence.id, 'approval:' || run.id || ':' || run.updated_at::TEXT,
          run.updated_at, 'approval_required', 'notification', occurrence.id,
          EXISTS (
            SELECT 1 FROM omni_mobile_push_deliveries delivery
            WHERE delivery.tenant_id = ${tenantId}
              AND delivery.owner_actor_id = occurrence.owner_actor_id
              AND delivery.status IN ('queued', 'running', 'delivered', 'acknowledged')
              AND delivery.created_at >= ${cooldownFloor}
          )
        FROM omni_workflow_schedule_occurrences occurrence
        INNER JOIN omni_workflow_runs run
          ON run.tenant_id = occurrence.tenant_id
          AND run.id = occurrence.workflow_run_id
        WHERE occurrence.tenant_id = ${tenantId}
          AND run.status = 'waiting_approval'
          AND run.updated_at >= ${recentThirtyDays}
      ) UNION ALL (
        SELECT 'routine', 'scheduled_routine', trigger.owner_actor_id,
          trigger.id,
          'circuit_open:' || trigger.circuit_opened_at::TEXT || ':' || trigger.consecutive_failure_count::TEXT,
          trigger.circuit_opened_at, 'circuit_open', 'notification', trigger.id,
          EXISTS (
            SELECT 1 FROM omni_mobile_push_deliveries delivery
            WHERE delivery.tenant_id = ${tenantId}
              AND delivery.owner_actor_id = trigger.owner_actor_id
              AND delivery.status IN ('queued', 'running', 'delivered', 'acknowledged')
              AND delivery.created_at >= ${cooldownFloor}
          )
        FROM omni_workflow_triggers trigger
        WHERE trigger.tenant_id = ${tenantId}
          AND trigger.trigger_kind = 'schedule'
          AND trigger.circuit_state = 'open'
          AND trigger.circuit_opened_at IS NOT NULL
          AND trigger.circuit_opened_at >= ${recentThirtyDays}
      ) UNION ALL (
        SELECT 'security', 'security_incident', auth_user.actor_id,
          incident.id,
          incident.status || ':' || incident.last_seen_at::TEXT || ':' || incident.occurrence_count::TEXT,
          incident.last_seen_at,
          CASE WHEN incident.severity = 'critical' THEN 'security_critical' ELSE 'security_warning' END,
          'notification', incident.id,
          EXISTS (
            SELECT 1 FROM omni_mobile_push_deliveries delivery
            WHERE delivery.tenant_id = ${tenantId}
              AND delivery.owner_actor_id = auth_user.actor_id
              AND delivery.status IN ('queued', 'running', 'delivered', 'acknowledged')
              AND delivery.created_at >= ${cooldownFloor}
          )
        FROM omni_incidents incident
        INNER JOIN omni_auth_memberships membership
          ON membership.tenant_id = incident.tenant_id
          AND membership.status = 'active'
          AND membership.role IN ('operator', 'admin')
        INNER JOIN omni_auth_users auth_user
          ON auth_user.id = membership.user_id
          AND auth_user.status = 'active'
        WHERE incident.tenant_id = ${tenantId}
          AND incident.status IN ('open', 'acknowledged')
          AND incident.severity IN ('warning', 'critical')
          AND incident.last_seen_at >= ${recentThirtyDays}
      )
    )
    SELECT candidate.*
    FROM candidates candidate
    WHERE NOT EXISTS (
      SELECT 1
      FROM omni_notification_dispositions disposition
      WHERE disposition.tenant_id = ${tenantId}
        AND disposition.owner_actor_id = candidate.owner_actor_id
        AND disposition.source_kind = candidate.source_kind
        AND disposition.source_id = candidate.source_id
        AND disposition.occurrence_key = candidate.occurrence_key
        AND (
          disposition.state = 'terminal'
          OR disposition.outcome = 'digest'
          OR (
            disposition.outcome IN ('defer', 'send')
            AND disposition.due_at > ${nowIso}
          )
        )
    )
      AND (
        ${cursor?.occursAt || null}::TIMESTAMPTZ IS NULL
        OR candidate.occurs_at < ${cursor?.occursAt || null}
        OR (
          candidate.occurs_at = ${cursor?.occursAt || null}
          AND candidate.producer_kind COLLATE "C" > ${cursor?.kind || null}
        )
        OR (
          candidate.occurs_at = ${cursor?.occursAt || null}
          AND candidate.producer_kind = ${cursor?.kind || null}
          AND candidate.source_id COLLATE "C" > ${cursor?.sourceId || null}
        )
        OR (
          candidate.occurs_at = ${cursor?.occursAt || null}
          AND candidate.producer_kind = ${cursor?.kind || null}
          AND candidate.source_id = ${cursor?.sourceId || null}
          AND candidate.owner_actor_id COLLATE "C" > ${cursor?.actorId || null}
        )
        OR (
          candidate.occurs_at = ${cursor?.occursAt || null}
          AND candidate.producer_kind = ${cursor?.kind || null}
          AND candidate.source_id = ${cursor?.sourceId || null}
          AND candidate.owner_actor_id = ${cursor?.actorId || null}
          AND candidate.occurrence_key COLLATE "C" > ${cursor?.occurrenceKey || null}
        )
      )
    ORDER BY candidate.occurs_at DESC, candidate.producer_kind COLLATE "C",
      candidate.source_id COLLATE "C", candidate.owner_actor_id COLLATE "C",
      candidate.occurrence_key COLLATE "C"
    LIMIT ${pageSize}
  `;
  return rows.flatMap(producerCandidateFromRow);
}

function producerCandidateFromRow(
  row: Record<string, unknown>,
): ProducerCandidate[] {
  const kind = proactiveProducerKind(row.producer_kind);
  const sourceKind = dispositionSourceKind(row.source_kind);
  const occursAt = timestamp(row.occurs_at);
  const actorId = bounded(row.owner_actor_id, 320);
  const sourceId = bounded(row.source_id, 240);
  const occurrenceKey = bounded(row.occurrence_key, 1_000);
  const sourceState = candidateState(kind, row.candidate_state);
  const target = mobileTarget(row.target_kind, row.target_id);
  return kind && sourceKind && occursAt && actorId && sourceId &&
      occurrenceKey && sourceState && target
    ? [{
        kind,
        sourceKind,
        occursAt,
        actorId,
        sourceId,
        occurrenceKey,
        sourceState,
        cooldownActive: row.cooldown_active === true,
        target,
      }]
    : [];
}

function candidateForSource(
  tenantId: string,
  candidate: ProducerCandidate,
): NotificationCandidateV1 {
  const coordinates = {
    tenantId,
    actorId: candidate.actorId,
    sourceId: candidate.sourceId,
    occurrenceKey: candidate.occurrenceKey,
  };
  if (isLegacyProducerKind(candidate.kind)) {
    if (!isLegacyState(candidate.kind, candidate.sourceState)) {
      throw new Error("Legacy notification producer state is invalid.");
    }
    return domainNotificationCandidate({
      ...coordinates,
      sourceKind: candidate.kind,
      occursAt: candidate.occursAt,
      sourceState: candidate.sourceState,
    });
  }
  if (candidate.kind === "delegation") {
    if (
      candidate.sourceState !== "waiting" &&
      candidate.sourceState !== "failed" &&
      candidate.sourceState !== "rejected"
    ) {
      throw new Error("Delegated notification producer state is invalid.");
    }
    return delegatedTaskNotificationCandidate({
      ...coordinates,
      sourceKind: "delegated_task",
      state: candidate.sourceState,
    });
  }
  if (candidate.kind === "routine") {
    if (
      candidate.sourceState !== "approval_required" &&
      candidate.sourceState !== "failed" &&
      candidate.sourceState !== "circuit_open"
    ) {
      throw new Error("Scheduled notification producer state is invalid.");
    }
    return scheduledRoutineNotificationCandidate({
      ...coordinates,
      sourceKind: "scheduled_routine",
      state: candidate.sourceState,
    });
  }
  if (
    candidate.sourceState !== "security_warning" &&
    candidate.sourceState !== "security_critical"
  ) {
    throw new Error("Security notification producer state is invalid.");
  }
  return securityIncidentNotificationCandidate({
    ...coordinates,
    sourceKind: "security_incident",
    severity: candidate.sourceState === "security_critical"
      ? "critical"
      : "warning",
  });
}

function producerCursor(candidate: ProducerCandidate): ProducerCursor {
  return {
    occursAt: candidate.occursAt,
    kind: candidate.kind,
    sourceId: candidate.sourceId,
    actorId: candidate.actorId,
    occurrenceKey: candidate.occurrenceKey,
  };
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

function isLegacyProducerKind(
  value: ProactiveProducerKind,
): value is ProducerKind {
  return value === "approval" || value === "meeting" ||
    value === "customer" || value === "run";
}

function proactiveProducerKind(
  value: unknown,
): ProactiveProducerKind | undefined {
  const kind = String(value || "");
  return kind === "approval" || kind === "meeting" || kind === "customer" ||
      kind === "run" || kind === "delegation" || kind === "routine" ||
      kind === "security"
    ? kind
    : undefined;
}

function dispositionSourceKind(
  value: unknown,
): NotificationDispositionSourceKind | undefined {
  const kind = String(value || "");
  return kind === "tool_approval" || kind === "meeting" ||
      kind === "customer_risk" || kind === "agent_run" ||
      kind === "delegated_task" || kind === "scheduled_routine" ||
      kind === "security_incident"
    ? kind
    : undefined;
}

function candidateState(
  kind: ProactiveProducerKind | undefined,
  value: unknown,
): CandidateState | undefined {
  const state = String(value || "") as CandidateState;
  if (kind === "approval" && state === "approval_required") return state;
  if (kind === "meeting" && state === "scheduled") return state;
  if (kind === "customer" && state === "at_risk") return state;
  if (kind === "run" && ["completed", "failed", "canceled"].includes(state)) {
    return state;
  }
  if (
    kind === "delegation" &&
    ["waiting", "failed", "rejected"].includes(state)
  ) {
    return state;
  }
  if (
    kind === "routine" &&
    ["approval_required", "failed", "circuit_open"].includes(state)
  ) {
    return state;
  }
  if (
    kind === "security" &&
    ["security_warning", "security_critical"].includes(state)
  ) {
    return state;
  }
  return undefined;
}

function isLegacyState(
  kind: ProducerKind,
  state: CandidateState,
): state is "approval_required" | "scheduled" | "at_risk" |
  "completed" | "failed" | "canceled" {
  return (kind === "approval" && state === "approval_required") ||
    (kind === "meeting" && state === "scheduled") ||
    (kind === "customer" && state === "at_risk") ||
    (kind === "run" && ["completed", "failed", "canceled"].includes(state));
}

function mobileTarget(kind: unknown, idValue: unknown) {
  const id = bounded(idValue, 240);
  if (!id) return undefined;
  const parsed = mobilePushTargetSchema.safeParse({
    kind: String(kind || ""),
    id,
  });
  return parsed.success ? parsed.data : undefined;
}

function timestamp(value: unknown) {
  const result = value instanceof Date ? value.toISOString() : String(value || "");
  return Number.isFinite(Date.parse(result))
    ? new Date(result).toISOString()
    : undefined;
}

function bounded(value: unknown, max: number) {
  const result = String(value || "").trim();
  return result && result.length <= max ? result : undefined;
}
