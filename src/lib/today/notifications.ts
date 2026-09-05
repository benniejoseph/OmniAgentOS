import { randomUUID } from "node:crypto";
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
  parsePersistedExecutionScope,
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

  for (const preference of preferences) {
    if (!preference.notificationsEnabled || isQuietHoursActive(preference, now)) continue;
    const ownerActorId = options.actorId ?? preference.actorId;
    const items = await listTodayItems(100, {
      tenantId: preference.tenantId,
      actorId: ownerActorId,
    });
    for (const item of items) {
      if (generated.length >= limit) return generated;
      if (item.status !== "open" || !item.dueAt) continue;
      const dueAt = Date.parse(item.dueAt);
      if (!Number.isFinite(dueAt) || dueAt > now.getTime() + preference.reminderLeadMinutes * 60_000) continue;
      generated.push(await upsertNotification({
        tenantId: preference.tenantId,
        actorId: ownerActorId,
        title: item.title,
        sourceId: item.id,
        occurrenceKey: item.dueAt,
        urgency: dueAt <= now.getTime() ? "overdue" : "due_soon",
        dueAt: item.dueAt,
        now,
      }));
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
    if (mutation) {
      return getSql().transaction(
        (sql: NotificationSqlClient) => apply(sql),
      ) as Promise<PersonalNotification | undefined>;
    }
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
    if (mutation) {
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
    const rows = await getSql()`
      UPDATE omni_personal_notifications
      SET status = 'read', read_at = ${now}, updated_at = ${now}
      WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND status = 'unread'
      RETURNING *
    `;
    return rows.map(notificationFromRow);
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
}) {
  const now = input.now.toISOString();
  const existing = await findNotificationByOccurrence(input);
  if (existing) {
    if (existing.status === "dismissed" || existing.status === "acted") return existing;
    if (existing.status === "snoozed" && existing.snoozedUntil && Date.parse(existing.snoozedUntil) > input.now.getTime()) return existing;
    return saveNotification({
      ...existing,
      title: safeText(input.title, 280),
      urgency: input.urgency,
      status: existing.status === "snoozed" ? "unread" : existing.status,
      snoozedUntil: undefined,
      updatedAt: now,
    });
  }
  const notification: PersonalNotification = {
    id: randomUUID(),
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
  return saveNotification(notification);
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
}) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_personal_notifications
      WHERE tenant_id = ${input.tenantId} AND actor_id = ${input.actorId}
        AND source_type = 'today_item' AND source_id = ${input.sourceId}
        AND occurrence_key = ${input.occurrenceKey}
      LIMIT 1
    `;
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
