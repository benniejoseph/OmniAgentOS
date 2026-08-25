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
import type {
  TodayItem,
  TodayItemKind,
  TodayItemPriority,
  TodayItemStatus,
  TodayLedger,
} from "@/lib/today/types";

export async function createTodayItem(input: {
  tenantId?: string;
  actorId: string;
  title: string;
  kind?: TodayItemKind;
  priority?: TodayItemPriority;
  dueAt?: string;
}) {
  const now = new Date().toISOString();
  const item: TodayItem = {
    id: randomUUID(),
    tenantId: normalizeTenantId(input.tenantId),
    actorId: safeText(input.actorId, 200),
    title: safeText(input.title, 280),
    kind: input.kind || "task",
    priority: input.priority || "medium",
    status: "open",
    dueAt: optionalDate(input.dueAt),
    createdAt: now,
    updatedAt: now,
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_today_items (
        id, tenant_id, actor_id, title, kind, priority, status, due_at, created_at, updated_at
      ) VALUES (
        ${item.id}, ${item.tenantId}, ${item.actorId}, ${item.title}, ${item.kind},
        ${item.priority}, ${item.status}, ${item.dueAt || null}, ${now}, ${now}
      )
    `;
    return item;
  }
  await updateLedger((ledger) => ({ items: [item, ...ledger.items] }));
  return item;
}

export async function listTodayItems(
  limit = 100,
  options: { tenantId?: string; actorId: string } ,
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const bounded = Math.min(Math.max(limit, 1), 250);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_today_items
      WHERE tenant_id = ${tenantId} AND actor_id = ${actorId}
      ORDER BY
        CASE status WHEN 'open' THEN 0 ELSE 1 END,
        due_at ASC NULLS LAST,
        created_at DESC
      LIMIT ${bounded}
    `;
    return rows.map(itemFromRow);
  }
  const ledger = await readLedger();
  return ledger.items
    .filter((item) => item.tenantId === tenantId && item.actorId === actorId)
    .sort(compareItems)
    .slice(0, bounded);
}

export async function updateTodayItem(
  id: string,
  input: {
    title?: string;
    status?: TodayItemStatus;
    priority?: TodayItemPriority;
    dueAt?: string | null;
  },
  options: { tenantId?: string; actorId: string },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_today_items
      SET title = COALESCE(${input.title ? safeText(input.title, 280) : null}, title),
          status = COALESCE(${input.status || null}, status),
          priority = COALESCE(${input.priority || null}, priority),
          due_at = CASE WHEN ${input.dueAt === null} THEN NULL ELSE COALESCE(${optionalDate(input.dueAt || undefined) || null}, due_at) END,
          completed_at = CASE WHEN ${input.status === "done"} THEN ${now} WHEN ${input.status === "open"} THEN NULL ELSE completed_at END,
          updated_at = ${now}
      WHERE id = ${id} AND tenant_id = ${tenantId} AND actor_id = ${actorId}
      RETURNING *
    `;
    return rows[0] ? itemFromRow(rows[0]) : undefined;
  }
  let updated: TodayItem | undefined;
  await updateLedger((ledger) => {
    const item = ledger.items.find((candidate) =>
      candidate.id === id && candidate.tenantId === tenantId && candidate.actorId === actorId
    );
    if (!item) return ledger;
    if (input.title) item.title = safeText(input.title, 280);
    if (input.status) {
      item.status = input.status;
      item.completedAt = input.status === "done" ? now : undefined;
    }
    if (input.priority) item.priority = input.priority;
    if (input.dueAt !== undefined) item.dueAt = optionalDate(input.dueAt || undefined);
    item.updatedAt = now;
    updated = item;
    return ledger;
  });
  return updated;
}

function readLedger() {
  return readJsonFile<TodayLedger>(getDataPath("today.json"), { items: [] });
}

function updateLedger(mutate: (ledger: TodayLedger) => TodayLedger) {
  return updateJsonFile<TodayLedger>(
    getDataPath("today.json"),
    { items: [] },
    (ledger) => ({ items: mutate(ledger).items.slice(0, 1_000) }),
  );
}

function itemFromRow(row: Record<string, unknown>): TodayItem {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    title: safeText(String(row.title), 280),
    kind: String(row.kind) as TodayItemKind,
    priority: String(row.priority) as TodayItemPriority,
    status: String(row.status) as TodayItemStatus,
    dueAt: date(row.due_at),
    completedAt: date(row.completed_at),
    createdAt: date(row.created_at) || new Date(0).toISOString(),
    updatedAt: date(row.updated_at) || new Date(0).toISOString(),
  };
}

function compareItems(left: TodayItem, right: TodayItem) {
  if (left.status !== right.status) return left.status === "open" ? -1 : 1;
  if (left.dueAt && right.dueAt) return left.dueAt.localeCompare(right.dueAt);
  if (left.dueAt) return -1;
  if (right.dueAt) return 1;
  return right.createdAt.localeCompare(left.createdAt);
}

function optionalDate(value?: string) {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function date(value: unknown) {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

function safeText(value: string, max: number) {
  return String(redactSensitive(value)).replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default";
}
