import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import {
  assertExecutionScopeTenant,
  createExecutionScope,
  executionScopesEqual,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import { todayActorReadOrder } from "@/lib/today/actor-scope";
import {
  getTodayPreferences,
  listTodayPreferencesForTenant,
  localScheduleParts,
} from "@/lib/today/briefs";
import { listTodayItems, updateTodayItem } from "@/lib/today/store";
import {
  NOTIFICATION_EVENT_SCHEMA_VERSION,
  notificationBulkMutationEventPayloadSchema,
  notificationDueMutationEventPayloadSchema,
  notificationMutationEventId,
  notificationMutationEventPayloadSchema,
  notificationSha256,
  type NotificationMutationContext,
} from "@/lib/today/notification-events";
import type {
  PersonalNotification,
  PersonalNotificationLedger,
  PersonalNotificationStatus,
  TodayPreferences,
} from "@/lib/today/types";
import { enqueueMobilePush } from "@/lib/mobile/push-store";
import {
  decideServerNotification,
  MOBILE_PUSH_COOLDOWN_MINUTES,
  notificationDispositionCoordinates,
  todayReminderNotificationCandidate,
} from "@/lib/mobile/notification-delivery-policy";
import {
  notificationDecisionExecutionScope,
} from "@/lib/mobile/notification-decision-events";
import { applyNotificationDispositionDecision } from "@/lib/mobile/notification-disposition-store";

export async function getNotificationCenter(options: {
  tenantId?: string;
  actorId: string;
  now?: Date;
  processDue?: boolean;
  requestActorBinding?: CanonicalRequestActorBindingV1;
}) {
  const now = options.now || new Date();
  const ownerScope = { tenantId: options.tenantId, actorId: options.actorId };
  const preferenceScope = {
    ...ownerScope,
    requestActorBinding: options.requestActorBinding,
  };
  let preferences: TodayPreferences;
  let notifications: PersonalNotification[];
  if (options.processDue === false) {
    [preferences, notifications] = await Promise.all([
      getTodayPreferences(preferenceScope),
      listNotifications(60, {
        ...ownerScope,
        requestActorBinding: options.requestActorBinding,
      }),
    ]);
  } else {
    preferences = await getTodayPreferences(preferenceScope);
    await processDueNotifications({
      ...ownerScope,
      now,
      requestActorBinding: options.requestActorBinding,
    });
    notifications = await listNotifications(60, ownerScope);
  }
  return {
    generatedAt: now.toISOString(),
    notifications,
    unreadCount: notifications.filter((item) => item.status === "unread").length,
    quietHoursActive: isQuietHoursActive(preferences, now),
    preferences,
  };
}

export async function processDueNotifications(options: {
  tenantId?: string;
  actorId?: string;
  now?: Date;
  limit?: number;
  requestActorBinding?: CanonicalRequestActorBindingV1;
}) {
  const now = options.now || new Date();
  const preferences = options.actorId
    ? [await getTodayPreferences({
        tenantId: options.tenantId,
        actorId: options.actorId,
        requestActorBinding: options.requestActorBinding,
      })]
    : await listTodayPreferencesForTenant(options.tenantId);
  const generated: PersonalNotification[] = [];
  const limit = Math.min(Math.max(options.limit || 20, 1), 100);
  const scanPageSize = 100;

  for (const preference of preferences) {
    if (!preference.notificationsEnabled) continue;
    const ownerActorId = options.actorId ?? preference.actorId;
    let offset = 0;
    while (generated.length < limit) {
      const items = await listTodayItems(scanPageSize, {
        tenantId: preference.tenantId,
        actorId: ownerActorId,
        offset,
      });
      for (const item of items) {
        if (generated.length >= limit) return generated;
        if (item.status !== "open" || !item.dueAt) continue;
        const dueAt = Date.parse(item.dueAt);
        if (!Number.isFinite(dueAt) || dueAt > now.getTime() + preference.reminderLeadMinutes * 60_000) continue;
        const result = await upsertNotification({
          tenantId: preference.tenantId,
          actorId: ownerActorId,
          title: item.title,
          sourceId: item.id,
          occurrenceKey: item.dueAt,
          urgency: dueAt <= now.getTime() ? "overdue" : "due_soon",
          dueAt: item.dueAt,
          now,
          quietHoursActive: isQuietHoursActive(preference, now),
          mutation: dueNotificationMutation({
            tenantId: preference.tenantId,
            actorId: ownerActorId,
            sourceId: item.id,
            occurrenceKey: item.dueAt,
          }),
        });
        if (result.changed) generated.push(result.notification);
      }
      offset += items.length;
      if (items.length < scanPageSize) break;
    }
  }
  return generated;
}

export async function listNotifications(
  limit = 60,
  options: {
    tenantId?: string;
    actorId: string;
    requestActorBinding?: CanonicalRequestActorBindingV1;
  },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const bounded = Math.min(Math.max(limit, 1), 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const actorReadOrder = todayActorReadOrder(
      options.actorId,
      options.requestActorBinding,
      actorId,
    );
    const canonicalActorId = actorReadOrder[0];
    const exactActorId = actorReadOrder[1];
    const rows = await getSql()`
      WITH readable_notifications AS MATERIALIZED (
        SELECT * FROM omni_personal_notifications
        WHERE tenant_id = ${tenantId}
          AND (actor_id = ${canonicalActorId} OR actor_id = ${exactActorId})
      ), logical_occurrence_collision AS (
        SELECT 1
        FROM readable_notifications
        GROUP BY source_type, source_id, occurrence_key
        HAVING COUNT(DISTINCT actor_id COLLATE "C") > 1
      ), limited_notifications AS (
        SELECT * FROM readable_notifications
        ORDER BY
          CASE status WHEN 'unread' THEN 0 WHEN 'snoozed' THEN 1 WHEN 'read' THEN 2 ELSE 3 END,
          updated_at DESC,
          id ASC
        LIMIT ${bounded}
      )
      SELECT limited_notifications.*,
        EXISTS (SELECT 1 FROM logical_occurrence_collision) AS logical_occurrence_collision
      FROM limited_notifications
      ORDER BY
        CASE limited_notifications.status WHEN 'unread' THEN 0 WHEN 'snoozed' THEN 1 WHEN 'read' THEN 2 ELSE 3 END,
        limited_notifications.updated_at DESC,
        limited_notifications.id ASC
    `;
    if (rows.some((row) => row.logical_occurrence_collision === true)) {
      throw new Error("Personal notifications resolved to a duplicate logical occurrence.");
    }
    return rows.map((row) =>
      notificationForRequest(notificationFromRow(row), exactActorId),
    );
  }
  const ledger = await readLedger();
  return ledger.notifications
    .filter((item) => item.tenantId === tenantId && item.actorId === actorId)
    .sort(compareNotifications)
    .slice(0, bounded);
}

export async function updatePersonalNotification(
  id: string,
  action: "read" | "dismiss" | "snooze" | "complete",
  options: {
    tenantId?: string;
    actorId: string;
    snoozeMinutes?: number;
    now?: Date;
    mutation?: NotificationMutationContext;
    onlyIfUnread?: boolean;
  },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const now = options.now || new Date();
  const mutation = options.mutation
    ? exactNotificationMutation(options.mutation, tenantId, actorId, id)
    : undefined;
  const apply = async (sql?: NotificationSqlClient) => {
    const notification = await findNotification(id, {
      tenantId,
      actorId,
      sql,
      forUpdate: Boolean(sql),
    });
    if (!notification) return undefined;
    if (mutation && sql) {
      const prior = await priorNotificationMutation(
        notification,
        action,
        mutation,
        sql,
      );
      if (prior) return prior;
    }
    if (action === "read" && options.onlyIfUnread && notification.status !== "unread") {
      return notification;
    }

    if (action === "complete") {
      const item = await updateTodayItem(
        notification.sourceId,
        { status: "done" },
        { tenantId, actorId, sql },
      );
      if (!item) {
        throw new Error("Notification source item was not found.");
      }
    }
    const status: PersonalNotificationStatus = action === "complete"
      ? "acted"
      : action === "dismiss"
        ? "dismissed"
        : action === "snooze"
          ? "snoozed"
          : "read";
    const snoozeMinutes = normalizeSnooze(options.snoozeMinutes);
    const updated: PersonalNotification = {
      ...notification,
      status,
      readAt: action === "read" || action === "complete"
        ? now.toISOString()
        : notification.readAt,
      snoozedUntil: action === "snooze"
        ? new Date(now.getTime() + snoozeMinutes * 60_000).toISOString()
        : undefined,
      updatedAt: now.toISOString(),
    };
    const saved = await saveNotification(updated, sql);
    if (mutation) {
      await appendNotificationMutationEvent(
        saved,
        action,
        mutation,
        sql,
      );
    }
    return saved;
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (!mutation) {
      throw new Error("Notification updates require a mutation envelope.");
    }
    return getSql().transaction(
      (sql: NotificationSqlClient) => apply(sql),
    ) as Promise<PersonalNotification | undefined>;
  }
  return apply();
}

export async function markAllNotificationsRead(options: {
  tenantId?: string;
  actorId: string;
  now?: Date;
  mutation?: NotificationMutationContext;
}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const now = (options.now || new Date()).toISOString();
  const mutation = options.mutation
    ? exactNotificationMutation(
        options.mutation,
        tenantId,
        actorId,
        "notifications:read_all",
        "notification.read_all",
      )
    : undefined;
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (!mutation) {
      throw new Error("Bulk notification updates require a mutation envelope.");
    }
    return getSql().transaction(async (sql: NotificationSqlClient) => {
      const rows = await sql`
        UPDATE omni_personal_notifications
        SET status = 'read', read_at = ${now}, updated_at = ${now}
        WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND status = 'unread'
        RETURNING *
      `;
      await appendNotificationBulkMutationEvent(
        tenantId,
        actorId,
        mutation,
        sql,
      );
      return rows.map(notificationFromRow);
    }) as Promise<PersonalNotification[]>;
  }
  const updated: PersonalNotification[] = [];
  await updateLedger((ledger) => ({
    notifications: ledger.notifications.map((item) => {
      if (item.tenantId !== tenantId || item.actorId !== actorId || item.status !== "unread") return item;
      const next = { ...item, status: "read" as const, readAt: now, updatedAt: now };
      updated.push(next);
      return next;
    }),
  }));
  if (mutation) {
    await appendNotificationBulkMutationEvent(tenantId, actorId, mutation);
  }
  return updated;
}

export function isQuietHoursActive(preferences: TodayPreferences, now = new Date()) {
  if (!preferences.quietHoursEnabled) return false;
  const current = localScheduleParts(now, preferences.timezone).time;
  const start = preferences.quietHoursStart;
  const end = preferences.quietHoursEnd;
  if (start === end) return false;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

async function upsertNotification(input: {
  tenantId: string;
  actorId: string;
  title: string;
  sourceId: string;
  occurrenceKey: string;
  urgency: PersonalNotification["urgency"];
  dueAt: string;
  now: Date;
  quietHoursActive: boolean;
  mutation: NotificationDueMutationContext;
}) {
  const now = input.now.toISOString();
  const apply = async (sql?: NotificationSqlClient) => {
    const existing = await findNotificationByOccurrence(input, sql, Boolean(sql));
    if (existing) {
      if (existing.status === "dismissed" || existing.status === "acted") {
        return { notification: existing, changed: false };
      }
      if (
        existing.status === "snoozed" &&
        existing.snoozedUntil &&
        Date.parse(existing.snoozedUntil) > input.now.getTime()
      ) {
        return { notification: existing, changed: false };
      }
      const next = {
        ...existing,
        title: safeText(input.title, 280),
        urgency: input.urgency,
        status: existing.status === "snoozed" ? "unread" : existing.status,
        snoozedUntil: undefined,
        updatedAt: now,
      };
      if (
        next.title === existing.title &&
        next.urgency === existing.urgency &&
        next.status === existing.status &&
        next.snoozedUntil === existing.snoozedUntil &&
        next.dueAt === existing.dueAt
      ) {
        if (sql) {
          await decideTodayNotificationDelivery({
            notification: existing,
            quietHoursActive: input.quietHoursActive,
            evaluatedAt: input.now,
            sql,
          });
        }
        return { notification: existing, changed: false };
      }
      const saved = await saveNotification(next, sql);
      await appendNotificationDueMutationEvent(
        saved,
        "refreshed",
        input.mutation,
        sql,
      );
      if (sql) {
        await decideTodayNotificationDelivery({
          notification: saved,
          quietHoursActive: input.quietHoursActive,
          evaluatedAt: input.now,
          sql,
        });
      }
      return { notification: saved, changed: true };
    }
    const notification: PersonalNotification = {
      id: `notification_${notificationSha256({
        tenantId: input.tenantId,
        actorId: input.actorId,
        sourceId: input.sourceId,
        occurrenceKey: input.occurrenceKey,
      }).slice(0, 48)}`,
      tenantId: input.tenantId,
      actorId: input.actorId,
      title: safeText(input.title, 280),
      kind: "reminder",
      sourceType: "today_item",
      sourceId: input.sourceId,
      occurrenceKey: input.occurrenceKey,
      urgency: input.urgency,
      status: "unread",
      dueAt: input.dueAt,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await saveNotification(notification, sql);
    await appendNotificationDueMutationEvent(
      saved,
      "created",
      input.mutation,
      sql,
    );
    if (sql) {
      await decideTodayNotificationDelivery({
        notification: saved,
        quietHoursActive: input.quietHoursActive,
        evaluatedAt: input.now,
        sql,
      });
    }
    return { notification: saved, changed: true };
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(
      (sql: NotificationSqlClient) => apply(sql),
    ) as Promise<{ notification: PersonalNotification; changed: boolean }>;
  }
  return apply();
}

async function decideTodayNotificationDelivery(input: {
  notification: PersonalNotification;
  quietHoursActive: boolean;
  evaluatedAt: Date;
  sql: NotificationSqlClient;
}) {
  const cooldownActive = await todayPushCooldownActive(
    input.notification,
    input.evaluatedAt,
    input.sql,
  );
  const decision = decideServerNotification({
    candidate: todayReminderNotificationCandidate({
      tenantId: input.notification.tenantId,
      actorId: input.notification.actorId,
      sourceKind: "today_reminder",
      sourceId: input.notification.sourceId,
      occurrenceKey: input.notification.occurrenceKey,
      urgency: input.notification.urgency,
    }),
    policy: {
      evaluatedAt: input.evaluatedAt.toISOString(),
      quietHoursActive: input.quietHoursActive,
      cooldownActive,
      digestEnabled: true,
    },
  });
  const executionScope = notificationDecisionExecutionScope({
    tenantId: input.notification.tenantId,
    actorId: input.notification.actorId,
    sourceId: input.notification.sourceId,
    producerId: "notification-scheduler",
    decision,
  });
  const target = {
    kind: "work_item" as const,
    id: input.notification.sourceId,
  };
  await applyNotificationDispositionDecision({
    coordinates: notificationDispositionCoordinates({
      tenantId: input.notification.tenantId,
      ownerActorId: input.notification.actorId,
      sourceKind: "today_reminder",
      sourceId: input.notification.sourceId,
      occurrenceKey: input.notification.occurrenceKey,
      decision,
    }),
    decision,
    executionScope,
    sql: input.sql,
    now: input.evaluatedAt,
    directDelivery: decision.outcome === "send"
      ? async (sql) => {
          const deliveries = await enqueueMobilePush({
            tenantId: input.notification.tenantId,
            actorId: input.notification.actorId,
            notificationId: input.notification.id,
            target,
            occurrenceKey: input.notification.occurrenceKey,
            executionScope,
            sql,
          });
          return {
            deliveryKind: "mobile_push_outbox" as const,
            deliveryIds: deliveries.map((delivery) => delivery.id),
            targetSha256: notificationSha256(target),
          };
        }
      : undefined,
  });
}

async function todayPushCooldownActive(
  notification: PersonalNotification,
  now: Date,
  sql: NotificationSqlClient,
) {
  const cooldownFloor = new Date(
    now.getTime() - MOBILE_PUSH_COOLDOWN_MINUTES * 60_000,
  ).toISOString();
  const rows = await sql`
    SELECT EXISTS (
      SELECT 1
      FROM omni_mobile_push_deliveries delivery
      WHERE delivery.tenant_id = ${notification.tenantId}
        AND delivery.owner_actor_id = ${notification.actorId}
        AND delivery.status IN ('queued', 'running', 'delivered', 'acknowledged')
        AND delivery.created_at >= ${cooldownFloor}
    ) AS cooldown_active
  `;
  return rows[0]?.cooldown_active === true;
}

type NotificationDueMutationContext = Readonly<{
  executionScope: ExecutionScope;
  idempotencyKey: string;
}>;

function dueNotificationMutation(input: {
  tenantId: string;
  actorId: string;
  sourceId: string;
  occurrenceKey: string;
}): NotificationDueMutationContext {
  const idempotencyKey = `notification_due_${notificationSha256(input)}`;
  return {
    idempotencyKey,
    executionScope: createExecutionScope({
      tenantId: input.tenantId,
      initiatingActorId: input.actorId,
      executingPrincipalType: "system",
      executingPrincipalId: "notification-scheduler",
      correlationId: idempotencyKey,
      causationId: input.sourceId,
      purpose: "notification.due.process",
    }),
  };
}

type NotificationSqlClient = ReturnType<typeof getSql>;

async function findNotification(id: string, options: {
  tenantId: string;
  actorId: string;
  sql?: NotificationSqlClient;
  forUpdate?: boolean;
}) {
  if (hasDatabaseUrl()) {
    if (!options.sql) await ensureDatabaseSchema();
    const sql = options.sql || getSql();
    const rows = await sql.query(
      `SELECT * FROM omni_personal_notifications
       WHERE id = $1 AND tenant_id = $2 AND actor_id = $3
       LIMIT 1${options.forUpdate ? " FOR UPDATE" : ""}`,
      [id, options.tenantId, options.actorId],
    );
    return rows[0] ? notificationFromRow(rows[0]) : undefined;
  }
  const ledger = await readLedger();
  return ledger.notifications.find((item) => item.id === id && item.tenantId === options.tenantId && item.actorId === options.actorId);
}

async function findNotificationByOccurrence(input: {
  tenantId: string;
  actorId: string;
  sourceId: string;
  occurrenceKey: string;
}, transactionSql?: NotificationSqlClient, forUpdate = false) {
  if (hasDatabaseUrl()) {
    if (!transactionSql) await ensureDatabaseSchema();
    const sql = transactionSql || getSql();
    const rows = await sql.query(
      `SELECT * FROM omni_personal_notifications
       WHERE tenant_id = $1 AND actor_id = $2
         AND source_type = 'today_item' AND source_id = $3
         AND occurrence_key = $4
       LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [input.tenantId, input.actorId, input.sourceId, input.occurrenceKey],
    );
    return rows[0] ? notificationFromRow(rows[0]) : undefined;
  }
  const ledger = await readLedger();
  return ledger.notifications.find((item) =>
    item.tenantId === input.tenantId && item.actorId === input.actorId
      && item.sourceId === input.sourceId && item.occurrenceKey === input.occurrenceKey
  );
}

async function saveNotification(
  notification: PersonalNotification,
  transactionSql?: NotificationSqlClient,
) {
  if (hasDatabaseUrl()) {
    if (!transactionSql) await ensureDatabaseSchema();
    const sql = transactionSql || getSql();
    const rows = await sql`
      INSERT INTO omni_personal_notifications (
        id, tenant_id, actor_id, title, kind, source_type, source_id,
        occurrence_key, urgency, status, due_at, snoozed_until, read_at,
        created_at, updated_at
      ) VALUES (
        ${notification.id}, ${notification.tenantId}, ${notification.actorId}, ${notification.title},
        ${notification.kind}, ${notification.sourceType}, ${notification.sourceId},
        ${notification.occurrenceKey}, ${notification.urgency}, ${notification.status},
        ${notification.dueAt}, ${notification.snoozedUntil || null}, ${notification.readAt || null},
        ${notification.createdAt}, ${notification.updatedAt}
      )
      ON CONFLICT (tenant_id, actor_id, source_type, source_id, occurrence_key) DO UPDATE SET
        title = EXCLUDED.title,
        urgency = EXCLUDED.urgency,
        status = EXCLUDED.status,
        due_at = EXCLUDED.due_at,
        snoozed_until = EXCLUDED.snoozed_until,
        read_at = EXCLUDED.read_at,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `;
    return notificationFromRow(rows[0]);
  }
  await updateLedger((ledger) => ({
    notifications: [notification, ...ledger.notifications.filter((item) => item.id !== notification.id)].slice(0, 500),
  }));
  return notification;
}

function exactNotificationMutation(
  value: NotificationMutationContext,
  tenantId: string,
  actorId: string,
  notificationId: string,
  purpose = "notification.update",
) {
  const executionScope = parsePersistedExecutionScope(value.executionScope);
  if (!executionScope) {
    throw new Error("Notification mutation requires an execution scope.");
  }
  assertExecutionScopeTenant(executionScope, tenantId);
  if (
    executionScope.initiatingActorId !== actorId ||
    executionScope.executingPrincipalType !== "user" ||
    executionScope.executingPrincipalId !== actorId ||
    executionScope.causationId !== notificationId ||
    executionScope.purpose !== purpose
  ) {
    throw new Error(
      "Notification mutation scope must bind the authenticated user and target.",
    );
  }
  const idempotencyKey = value.idempotencyKey.trim();
  if (
    !idempotencyKey ||
    idempotencyKey.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
  ) {
    throw new Error(
      "Notification Idempotency-Key must use 1-200 letters, numbers, dots, underscores, colons, or hyphens.",
    );
  }
  return { executionScope, idempotencyKey } as const;
}

async function appendNotificationBulkMutationEvent(
  tenantId: string,
  actorId: string,
  mutation: ReturnType<typeof exactNotificationMutation>,
  sql?: NotificationSqlClient,
) {
  const payload = notificationBulkMutationEventPayloadSchema.parse({
    schemaVersion: NOTIFICATION_EVENT_SCHEMA_VERSION,
    action: "read_all",
    idempotencyKeySha256: notificationSha256({
      tenantId,
      actorId,
      idempotencyKey: mutation.idempotencyKey,
    }),
  });
  await appendScopedDomainEvent({
    id: notificationMutationEventId({
      tenantId,
      actorId,
      idempotencyKey: mutation.idempotencyKey,
    }),
    streamId: `notifications:${notificationSha256({ tenantId, actorId })}`,
    type: "notifications.read_all",
    executionScope: mutation.executionScope,
    payload,
  }, sql ? { sql } : {});
}

async function appendNotificationDueMutationEvent(
  notification: PersonalNotification,
  operation: "created" | "refreshed",
  mutation: NotificationDueMutationContext,
  sql?: NotificationSqlClient,
) {
  const executionScope = parsePersistedExecutionScope(mutation.executionScope);
  if (
    !executionScope ||
    executionScope.tenantId !== notification.tenantId ||
    executionScope.initiatingActorId !== notification.actorId ||
    executionScope.executingPrincipalType !== "system" ||
    executionScope.executingPrincipalId !== "notification-scheduler" ||
    executionScope.causationId !== notification.sourceId ||
    executionScope.purpose !== "notification.due.process"
  ) {
    throw new Error("Due notification mutation scope is invalid.");
  }
  const titleSha256 = notificationSha256(notification.title);
  const eventIdempotencyKey = [
    mutation.idempotencyKey,
    operation,
    notification.status,
    notification.urgency,
    titleSha256,
  ].join(":");
  const payload = notificationDueMutationEventPayloadSchema.parse({
    schemaVersion: NOTIFICATION_EVENT_SCHEMA_VERSION,
    notificationId: notification.id,
    sourceType: notification.sourceType,
    sourceId: notification.sourceId,
    occurrenceKeySha256: notificationSha256(notification.occurrenceKey),
    titleSha256,
    operation,
    status: notification.status,
    urgency: notification.urgency,
    idempotencyKeySha256: notificationSha256({
      tenantId: notification.tenantId,
      actorId: notification.actorId,
      idempotencyKey: mutation.idempotencyKey,
    }),
  });
  await appendScopedDomainEvent({
    id: notificationMutationEventId({
      tenantId: notification.tenantId,
      actorId: notification.actorId,
      idempotencyKey: eventIdempotencyKey,
    }),
    streamId: `notification:${notification.id}`,
    type: "notification.due_upserted",
    executionScope,
    payload,
  }, sql ? { sql } : {});
}

async function appendNotificationMutationEvent(
  notification: PersonalNotification,
  action: "read" | "dismiss" | "snooze" | "complete",
  mutation: ReturnType<typeof exactNotificationMutation>,
  sql?: NotificationSqlClient,
) {
  const payload = notificationMutationEventPayloadSchema.parse({
    schemaVersion: NOTIFICATION_EVENT_SCHEMA_VERSION,
    notificationId: notification.id,
    sourceType: notification.sourceType,
    sourceId: notification.sourceId,
    action,
    status: notification.status,
    idempotencyKeySha256: notificationSha256({
      tenantId: notification.tenantId,
      actorId: notification.actorId,
      idempotencyKey: mutation.idempotencyKey,
    }),
    effect: {
      status: notification.status,
      snoozedUntil: notification.snoozedUntil || null,
      readAt: notification.readAt || null,
      updatedAt: notification.updatedAt,
    },
  });
  await appendScopedDomainEvent({
    id: notificationMutationEventId({
      tenantId: notification.tenantId,
      actorId: notification.actorId,
      idempotencyKey: mutation.idempotencyKey,
    }),
    streamId: `notification:${notification.id}`,
    type: "notification.updated",
    executionScope: mutation.executionScope,
    payload,
  }, sql ? { sql } : {});
}

async function priorNotificationMutation(
  notification: PersonalNotification,
  action: "read" | "dismiss" | "snooze" | "complete",
  mutation: ReturnType<typeof exactNotificationMutation>,
  sql: NotificationSqlClient,
) {
  const eventId = notificationMutationEventId({
    tenantId: notification.tenantId,
    actorId: notification.actorId,
    idempotencyKey: mutation.idempotencyKey,
  });
  const rows = await sql.query(
    `SELECT stream_id, type, payload, causation_id, correlation_id
     FROM omni_events
     WHERE id = $1 AND tenant_id = $2 AND actor_id = $3
     LIMIT 1`,
    [eventId, notification.tenantId, notification.actorId],
  );
  if (!rows[0]) return undefined;
  const row = rows[0];
  const persistedPayload = row.payload;
  if (
    !persistedPayload ||
    typeof persistedPayload !== "object" ||
    Array.isArray(persistedPayload)
  ) {
    throw new Error("Notification mutation idempotency evidence is invalid.");
  }
  const {
    _executionScope: rawExecutionScope,
    ...domainPayload
  } = persistedPayload as Record<string, unknown>;
  const payload = notificationMutationEventPayloadSchema.parse(domainPayload);
  const persistedScope = parsePersistedExecutionScope(rawExecutionScope);
  const expectedKeySha256 = notificationSha256({
    tenantId: notification.tenantId,
    actorId: notification.actorId,
    idempotencyKey: mutation.idempotencyKey,
  });
  if (
    String(row.stream_id) !== `notification:${notification.id}` ||
    String(row.type) !== "notification.updated" ||
    String(row.causation_id || "") !==
      String(mutation.executionScope.causationId || "") ||
    String(row.correlation_id || "") !== mutation.executionScope.correlationId ||
    !persistedScope ||
    !executionScopesEqual(persistedScope, mutation.executionScope) ||
    payload.notificationId !== notification.id ||
    payload.sourceType !== notification.sourceType ||
    payload.sourceId !== notification.sourceId ||
    payload.action !== action ||
    payload.idempotencyKeySha256 !== expectedKeySha256 ||
    (payload.effect && payload.effect.status !== payload.status)
  ) {
    throw new Error(
      "Notification mutation idempotency key is bound to another effect.",
    );
  }
  return payload.effect
    ? {
        ...notification,
        status: payload.effect.status,
        snoozedUntil: payload.effect.snoozedUntil || undefined,
        readAt: payload.effect.readAt || undefined,
        updatedAt: payload.effect.updatedAt,
      }
    : notification;
}

function readLedger() {
  return readJsonFile<PersonalNotificationLedger>(getDataPath("personal-notifications.json"), { notifications: [] });
}
function updateLedger(mutate: (ledger: PersonalNotificationLedger) => PersonalNotificationLedger) {
  return updateJsonFile<PersonalNotificationLedger>(
    getDataPath("personal-notifications.json"),
    { notifications: [] },
    mutate,
  );
}

function notificationFromRow(row: Record<string, unknown>): PersonalNotification {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    title: safeText(row.title, 280),
    kind: "reminder",
    sourceType: "today_item",
    sourceId: String(row.source_id),
    occurrenceKey: String(row.occurrence_key),
    urgency: String(row.urgency) === "overdue" ? "overdue" : "due_soon",
    status: normalizeStatus(row.status),
    dueAt: dateValue(row.due_at),
    snoozedUntil: optionalDate(row.snoozed_until),
    readAt: optionalDate(row.read_at),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function compareNotifications(left: PersonalNotification, right: PersonalNotification) {
  const order: Record<PersonalNotificationStatus, number> = { unread: 0, snoozed: 1, read: 2, acted: 3, dismissed: 4 };
  return order[left.status] - order[right.status]
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}
function notificationForRequest(
  notification: PersonalNotification,
  requestActorId: string,
): PersonalNotification {
  return { ...notification, actorId: requestActorId };
}
function normalizeStatus(value: unknown): PersonalNotificationStatus {
  return ["unread", "read", "snoozed", "dismissed", "acted"].includes(String(value))
    ? String(value) as PersonalNotificationStatus
    : "unread";
}
function normalizeSnooze(value?: number) { return [5, 15, 30, 60, 120, 1440].includes(value || 0) ? value! : 15; }
function optionalDate(value: unknown) { return value ? dateValue(value) : undefined; }
function dateValue(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
function safeText(value: unknown, max: number) { return String(redactSensitive(String(value || ""))).replace(/\s+/g, " ").trim().slice(0, max); }
function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default";
}
