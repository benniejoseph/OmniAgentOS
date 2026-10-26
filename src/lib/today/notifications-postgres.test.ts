import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const dbMocks = vi.hoisted(() => {
  const rows: Record<string, unknown>[] = [];
  const queryResponses: Record<string, unknown>[][] = [];
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const sql = vi.fn(
    (strings: TemplateStringsArray, ...params: unknown[]) => {
      statements.push({ text: renderStatement(strings, params), params });
      return Promise.resolve([...rows]);
    },
  );
  const query = vi.fn((text: string, params: unknown[]) => {
    queries.push({ text, params });
    return Promise.resolve(queryResponses.shift() || []);
  });
  const transaction = vi.fn(
    (operation: (transactionSql: typeof sql) => unknown) => operation(sql),
  );
  Object.assign(sql, { query, transaction, transactionScoped: true });
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getDatabaseTenantContext: vi.fn(() => undefined),
    getSql: vi.fn(() => sql),
    hasDatabaseUrl: vi.fn(() => true),
    rows,
    queries,
    query,
    queryResponses,
    sql,
    statements,
    transaction,
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
  markAllNotificationsRead,
  updatePersonalNotification,
  recordResponsibilityInboxNotificationWithSql,
} from "@/lib/today/notifications";
import { notificationMutationFromRequest, notificationSha256 } from "@/lib/today/notification-events";

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
  dbMocks.queryResponses.splice(0);
  dbMocks.queries.splice(0);
  dbMocks.statements.splice(0);
  dbMocks.ensureDatabaseSchema.mockClear();
  dbMocks.getDatabaseTenantContext.mockClear();
  dbMocks.getSql.mockClear();
  dbMocks.hasDatabaseUrl.mockClear();
  dbMocks.sql.mockClear();
  dbMocks.query.mockClear();
  dbMocks.transaction.mockClear();
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
  it.each([
    ["responsibility_change", { includeResponsibilityChanges: false }, [false, true, true]],
    ["availability_watch", { includeAvailabilityWatches: false }, [true, false, true]],
    ["self_improvement", { includeSelfImprovements: false }, [true, true, false]],
  ] as const)("filters unsupported %s notifications before collision detection and the bounded list window", async (kind, compatibility, flags) => {
    await listNotifications(1, { tenantId: "tenant-a", actorId, requestActorBinding: binding, ...compatibility });
    const statement = dbMocks.statements[0];
    expect(statement.params).toEqual(["tenant-a", canonicalActorId, actorId, ...flags, 1]);
    const filterPosition = statement.text.indexOf(`kind <> '${kind}'`);
    expect(filterPosition).toBeGreaterThan(0);
    expect(filterPosition).toBeLessThan(statement.text.indexOf("logical_occurrence_collision AS"));
    expect(filterPosition).toBeLessThan(statement.text.indexOf("LIMIT"));
  });
  it.each([
    ["responsibility_change", { includeResponsibilityChanges: false }],
    ["availability_watch", { includeAvailabilityWatches: false }],
    ["self_improvement", { includeSelfImprovements: false }],
  ] as const)("does not acknowledge %s through an older client's exact-item request", async (kind, compatibility) => {
    dbMocks.queryResponses.push([{ ...notificationRow("inbox-a", canonicalActorId), kind, source_type: kind,
      source_id: `source-${kind}`, occurrence_key: `notification-${kind}`, urgency: "update" }]);
    const mutation = notificationMutationFromRequest(new Request("https://example.test/api/notifications/inbox-a", { headers: { "Idempotency-Key": "old-client-exact" } }),
      { tenantId: "tenant-a", actorId, role: "operator", source: "session", auth: { userId: authUserId, email: actorId, sessionId: "fixture", tenantName: "Fixture" } }, "inbox-a");
    expect(await updatePersonalNotification("inbox-a", "read", { tenantId: "tenant-a", actorId, requestActorBinding: binding, mutation, ...compatibility })).toBeUndefined();
    expect(dbMocks.queries[0].params).toEqual(["inbox-a", "tenant-a", canonicalActorId, actorId]);
    expect(dbMocks.sql).not.toHaveBeenCalled();
    expect(dependencyMocks.updateTodayItem).not.toHaveBeenCalled();
  });
  it("writes only the fixed Responsibility inbox variant and refuses mismatched persisted identity", async () => {
    const responsibilityId = `responsibility:${"a".repeat(64)}`; const candidateId = `responsibility-notification:${"b".repeat(64)}`;
    const input = { tenantId: "tenant-a", actorId: canonicalActorId, responsibilityId, candidateId, now: "2026-09-04T12:00:00.000Z" };
    const id = `notification_${notificationSha256([input.tenantId, input.actorId, responsibilityId, candidateId]).slice(0, 48)}`;
    const row = { ...notificationRow(id, canonicalActorId), kind: "responsibility_change", source_type: "responsibility_change", source_id: responsibilityId,
      occurrence_key: candidateId, title: "Responsibility change", urgency: "update" };
    dbMocks.rows.push(row);
    expect(await recordResponsibilityInboxNotificationWithSql(dbMocks.getSql() as unknown as Parameters<typeof recordResponsibilityInboxNotificationWithSql>[0], input))
      .toMatchObject({ id, kind: "responsibility_change", sourceId: responsibilityId, actorId: canonicalActorId });
    dbMocks.rows[0] = { ...row, id: "notification-unrelated" };
    await expect(recordResponsibilityInboxNotificationWithSql(dbMocks.getSql() as unknown as Parameters<typeof recordResponsibilityInboxNotificationWithSql>[0], input)).rejects.toThrow("does not match");
    expect(dependencyMocks.updateTodayItem).not.toHaveBeenCalled();
  });
  it("binds canonical Responsibility actions to the current request and never completes or snoozes Today work", async () => {
    const row = { ...notificationRow("inbox-a", canonicalActorId), kind: "responsibility_change", source_type: "responsibility_change",
      source_id: `responsibility:${"a".repeat(64)}`, occurrence_key: `responsibility-notification:${"b".repeat(64)}`, urgency: "update" };
    for (const action of ["complete", "snooze"] as const) {
      dbMocks.queryResponses.push([row]);
      const mutation = notificationMutationFromRequest(new Request("https://example.test/api/notifications/inbox-a", { headers: { "Idempotency-Key": `inbox-${action}` } }),
        { tenantId: "tenant-a", actorId, role: "operator", source: "session", auth: { userId: authUserId, email: actorId, sessionId: "fixture", tenantName: "Fixture" } }, "inbox-a");
      await expect(updatePersonalNotification("inbox-a", action, { tenantId: "tenant-a", actorId, requestActorBinding: binding, mutation })).rejects.toThrow("only read and dismiss");
    }
    expect(dbMocks.queries[0].params).toEqual(["inbox-a", "tenant-a", canonicalActorId, actorId]);
    expect(dependencyMocks.updateTodayItem).not.toHaveBeenCalled(); expect(dbMocks.sql).not.toHaveBeenCalled();
  });
  it("returns the first snooze effect without extending it on a lost-response retry", async () => {
    const notification = notificationRow("notification-a", actorId);
    const executionScope = {
      version: 1 as const,
      tenantId: "tenant-a",
      initiatingActorId: actorId,
      executingPrincipalType: "user" as const,
      executingPrincipalId: actorId,
      workspaceId: null,
      projectId: null,
      missionId: null,
      delegationId: null,
      correlationId: "push-action-delivery-a-snooze",
      causationId: "notification-a",
      contextGrantIds: [] as string[],
      capabilityGrantIds: [] as string[],
      purpose: "notification.update",
    };
    const originalSnooze = "2026-09-04T12:15:00.000Z";
    dbMocks.queryResponses.push(
      [notification],
      [{
        stream_id: "notification:notification-a",
        type: "notification.updated",
        causation_id: "notification-a",
        correlation_id: "push-action-delivery-a-snooze",
        payload: {
          schemaVersion: 1,
          notificationId: "notification-a",
          sourceType: "today_item",
          sourceId: "source-notification-a",
          action: "snooze",
          status: "snoozed",
          idempotencyKeySha256:
            "7c0a14bbb0bdcc11ff62b89981e9e4d315aca3f62a8db3ba59f2aadaf10019f1",
          effect: {
            status: "snoozed",
            snoozedUntil: originalSnooze,
            readAt: null,
            updatedAt: "2026-09-04T12:00:00.000Z",
          },
          _executionScope: executionScope,
        },
      }],
    );

    await expect(updatePersonalNotification("notification-a", "snooze", {
      tenantId: "tenant-a",
      actorId,
      snoozeMinutes: 15,
      now: new Date("2026-09-04T13:00:00.000Z"),
      mutation: {
        executionScope,
        idempotencyKey: "push-action-delivery-a-snooze",
      },
    })).resolves.toMatchObject({
      id: "notification-a",
      status: "snoozed",
      snoozedUntil: originalSnooze,
      updatedAt: "2026-09-04T12:00:00.000Z",
    });

    expect(dbMocks.queries[0].text).toContain("FOR UPDATE");
    expect(dbMocks.queries[1].text).toContain("FROM omni_events");
    expect(dbMocks.sql).not.toHaveBeenCalled();
    expect(dependencyMocks.updateTodayItem).not.toHaveBeenCalled();
  });

  it("rejects production notification mutations without an event envelope", async () => {
    await expect(updatePersonalNotification("notification-a", "read", {
      tenantId: "tenant-a",
      actorId,
    })).rejects.toThrow("require a mutation envelope");
    await expect(markAllNotificationsRead({
      tenantId: "tenant-a",
      actorId,
    })).rejects.toThrow("require a mutation envelope");
    expect(dbMocks.sql).not.toHaveBeenCalled();
  });

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
      true,
      true,
      true,
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
      true,
      true,
      true,
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
      true,
      true,
      true,
      5,
    ]);
  });

  it("preserves the authenticated owner binding and compatibility filters in both center read modes", async () => {
    dbMocks.rows.push(notificationRow("canonical-notification", canonicalActorId));

    await getNotificationCenter({
      tenantId: "tenant-a",
      actorId,
      processDue: false,
      requestActorBinding: binding,
      includeAvailabilityWatches: false,
      includeSelfImprovements: false,
      now: new Date("2026-09-04T12:00:00.000Z"),
    });
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      canonicalActorId,
      actorId,
      true,
      false,
      false,
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
      includeAvailabilityWatches: false,
      includeSelfImprovements: false,
      now: new Date("2026-09-04T12:00:00.000Z"),
    });
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      canonicalActorId,
      actorId,
      true,
      false,
      false,
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
    snoozed_until: null,
    read_at: null,
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
