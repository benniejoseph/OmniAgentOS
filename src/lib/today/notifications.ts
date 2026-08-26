import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { redactSensitive } from "@/lib/security/context";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import {
  getTodayPreferences,
  listTodayPreferencesForTenant,
  localScheduleParts,
} from "@/lib/today/briefs";
import { listTodayItems, updateTodayItem } from "@/lib/today/store";
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
}) {
  const now = options.now || new Date();
  let preferences: TodayPreferences;
  let notifications: PersonalNotification[];
  if (options.processDue === false) {
    [preferences, notifications] = await Promise.all([
      getTodayPreferences(options),
      listNotifications(60, options),
    ]);
  } else {
    preferences = await getTodayPreferences(options);
    await processDueNotifications({ ...options, now });
    notifications = await listNotifications(60, options);
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
}) {
  const now = options.now || new Date();
  const preferences = options.actorId
    ? [await getTodayPreferences({ tenantId: options.tenantId, actorId: options.actorId })]
    : await listTodayPreferencesForTenant(options.tenantId);
  const generated: PersonalNotification[] = [];
  const limit = Math.min(Math.max(options.limit || 20, 1), 100);

  for (const preference of preferences) {
    if (!preference.notificationsEnabled || isQuietHoursActive(preference, now)) continue;
    const items = await listTodayItems(100, {
      tenantId: preference.tenantId,
      actorId: preference.actorId,
    });
    for (const item of items) {
      if (generated.length >= limit) return generated;
      if (item.status !== "open" || !item.dueAt) continue;
      const dueAt = Date.parse(item.dueAt);
      if (!Number.isFinite(dueAt) || dueAt > now.getTime() + preference.reminderLeadMinutes * 60_000) continue;
      generated.push(await upsertNotification({
        tenantId: preference.tenantId,
        actorId: preference.actorId,
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
  options: { tenantId?: string; actorId: string },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const bounded = Math.min(Math.max(limit, 1), 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_personal_notifications
      WHERE tenant_id = ${tenantId} AND actor_id = ${actorId}
      ORDER BY
        CASE status WHEN 'unread' THEN 0 WHEN 'snoozed' THEN 1 WHEN 'read' THEN 2 ELSE 3 END,
        updated_at DESC
      LIMIT ${bounded}
    `;
    return rows.map(notificationFromRow);
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
  options: { tenantId?: string; actorId: string; snoozeMinutes?: number; now?: Date },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const now = options.now || new Date();
  const notification = await findNotification(id, { tenantId, actorId });
  if (!notification) return undefined;

  if (action === "complete") {
    await updateTodayItem(notification.sourceId, { status: "done" }, { tenantId, actorId });
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
    readAt: action === "read" || action === "complete" ? now.toISOString() : notification.readAt,
    snoozedUntil: action === "snooze"
      ? new Date(now.getTime() + snoozeMinutes * 60_000).toISOString()
      : undefined,
    updatedAt: now.toISOString(),
  };
  return saveNotification(updated);
}

export async function markAllNotificationsRead(options: {
  tenantId?: string;
  actorId: string;
  now?: Date;
}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const now = (options.now || new Date()).toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
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

async function findNotification(id: string, options: { tenantId: string; actorId: string }) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM omni_personal_notifications WHERE id = ${id} AND tenant_id = ${options.tenantId} AND actor_id = ${options.actorId} LIMIT 1`;
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

async function saveNotification(notification: PersonalNotification) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
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
  return order[left.status] - order[right.status] || right.updatedAt.localeCompare(left.updatedAt);
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
