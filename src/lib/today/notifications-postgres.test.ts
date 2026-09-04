import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const dbMocks = vi.hoisted(() => {
  const rows: Record<string, unknown>[] = [];
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const sql = vi.fn(
    (strings: TemplateStringsArray, ...params: unknown[]) => {
      statements.push({ text: renderStatement(strings, params), params });
      return Promise.resolve([...rows]);
    },
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getDatabaseTenantContext: vi.fn(() => undefined),
    getSql: vi.fn(() => sql),
    hasDatabaseUrl: vi.fn(() => true),
    rows,
    sql,
    statements,
  };
});

const dependencyMocks = vi.hoisted(() => ({
  getTodayPreferences: vi.fn(),
  listTodayItems: vi.fn(),
  listTodayPreferencesForTenant: vi.fn(),
  localScheduleParts: vi.fn(),
  updateTodayItem: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return {
    ...actual,
    ensureDatabaseSchema: dbMocks.ensureDatabaseSchema,
    getDatabaseTenantContext: dbMocks.getDatabaseTenantContext,
    getSql: dbMocks.getSql,
    hasDatabaseUrl: dbMocks.hasDatabaseUrl,
  };
});

vi.mock("@/lib/today/briefs", () => ({
  getTodayPreferences: dependencyMocks.getTodayPreferences,
  listTodayPreferencesForTenant: dependencyMocks.listTodayPreferencesForTenant,
  localScheduleParts: dependencyMocks.localScheduleParts,
}));

vi.mock("@/lib/today/store", () => ({
  listTodayItems: dependencyMocks.listTodayItems,
  updateTodayItem: dependencyMocks.updateTodayItem,
}));

import {
  getNotificationCenter,
  listNotifications,
} from "@/lib/today/notifications";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "notification-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

beforeEach(() => {
  dbMocks.rows.splice(0);
  dbMocks.statements.splice(0);
  dbMocks.ensureDatabaseSchema.mockClear();
  dbMocks.getDatabaseTenantContext.mockClear();
  dbMocks.getSql.mockClear();
  dbMocks.hasDatabaseUrl.mockClear();
  dbMocks.sql.mockClear();
  dependencyMocks.getTodayPreferences.mockReset().mockResolvedValue({
    tenantId: "tenant-a",
    actorId,
    briefEnabled: true,
    briefTime: "08:00",
    timezone: "UTC",
    reminderLeadMinutes: 30,
    notificationsEnabled: false,
    quietHoursEnabled: false,
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:00:00.000Z",
  });
  dependencyMocks.listTodayItems.mockReset().mockResolvedValue([]);
  dependencyMocks.listTodayPreferencesForTenant.mockReset().mockResolvedValue([]);
  dependencyMocks.localScheduleParts.mockReset().mockReturnValue({
    date: "2026-09-04",
    time: "12:00",
  });
  dependencyMocks.updateTodayItem.mockReset();
});

describe("Postgres personal notification owner reads", () => {
  it("merges readable partitions before globally ordering and limiting", async () => {
    dbMocks.rows.push(
      notificationRow("canonical-notification", canonicalActorId),
      notificationRow("email-notification", actorId),
    );

    await expect(listNotifications(2, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual([
      expect.objectContaining({ id: "canonical-notification", actorId }),
      expect.objectContaining({ id: "email-notification", actorId }),
    ]);

    const statement = dbMocks.statements[0];
    expect(statement.text).toMatch(
      /WITH readable_notifications AS MATERIALIZED[\s\S]*AND \(actor_id = \$\d+ OR actor_id = \$\d+\)[\s\S]*GROUP BY source_type, source_id, occurrence_key[\s\S]*HAVING COUNT\(DISTINCT actor_id COLLATE "C"\) > 1[\s\S]*CASE status[\s\S]*updated_at DESC,[\s\S]*id ASC[\s\S]*LIMIT \$\d+/,
    );
    expect(statement.params).toEqual([
      "tenant-a",
      canonicalActorId,
      actorId,
      2,
    ]);
  });

  it("fails closed when the complete readable snapshot reports a collision beyond the limit", async () => {
    dbMocks.rows.push({
      ...notificationRow("visible-notification", actorId),
      logical_occurrence_collision: true,
    });

    await expect(listNotifications(1, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toThrow(
      "Personal notifications resolved to a duplicate logical occurrence.",
    );

    const statement = dbMocks.statements[0];
    expect(statement.text.indexOf("logical_occurrence_collision AS")).toBeLessThan(
      statement.text.indexOf("limited_notifications AS"),
    );
    expect(statement.params.at(-1)).toBe(1);
  });

  it("keeps missing and malformed bindings on the exact actor", async () => {
    await listNotifications(5, { tenantId: "tenant-a", actorId });
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      actorId,
      actorId,
      5,
    ]);

    dbMocks.statements.splice(0);
    await listNotifications(5, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: {
        ...binding,
        readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
      },
    });
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      actorId,
      actorId,
      5,
    ]);
  });

  it("threads the binding only through the non-processing center read", async () => {
    dbMocks.rows.push(notificationRow("canonical-notification", canonicalActorId));

    await getNotificationCenter({
      tenantId: "tenant-a",
      actorId,
      processDue: false,
      requestActorBinding: binding,
      now: new Date("2026-09-04T12:00:00.000Z"),
    });
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      canonicalActorId,
      actorId,
      60,
    ]);

    dbMocks.rows.splice(
      0,
      dbMocks.rows.length,
      notificationRow("email-notification", actorId),
    );
    dbMocks.statements.splice(0);
    await getNotificationCenter({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
      now: new Date("2026-09-04T12:00:00.000Z"),
    });
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      actorId,
      actorId,
      60,
    ]);
    expect(dependencyMocks.listTodayItems).not.toHaveBeenCalled();
  });
});

function notificationRow(id: string, ownerActorId: string) {
  return {
    id,
    tenant_id: "tenant-a",
    actor_id: ownerActorId,
    title: id,
    kind: "reminder",
    source_type: "today_item",
    source_id: `source-${id}`,
    occurrence_key: "2026-09-04T12:30:00.000Z",
    urgency: "due_soon",
    status: "unread",
    due_at: "2026-09-04T12:30:00.000Z",
    created_at: "2026-09-04T10:00:00.000Z",
    updated_at: "2026-09-04T12:00:00.000Z",
    logical_occurrence_collision: false,
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
