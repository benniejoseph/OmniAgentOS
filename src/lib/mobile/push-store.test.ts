import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityContext } from "@/lib/security/types";

const dbMocks = vi.hoisted(() => {
  const responses: Record<string, unknown>[][] = [];
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const sql = vi.fn(
    (strings: TemplateStringsArray, ...params: unknown[]) => {
      statements.push({ text: renderStatement(strings, params), params });
      return Promise.resolve(responses.shift() || []);
    },
  );
  const transaction = vi.fn(
    (operation: (transactionSql: typeof sql) => unknown) => operation(sql),
  );
  Object.assign(sql, { transaction });
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getSql: vi.fn(() => sql),
    hasDatabaseUrl: vi.fn(() => true),
    responses,
    sql,
    statements,
    transaction,
  };
});

const eventMocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(async () => ({ id: "push-event" })),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: dbMocks.ensureDatabaseSchema,
  getSql: dbMocks.getSql,
  hasDatabaseUrl: dbMocks.hasDatabaseUrl,
  runWithDatabaseSystemScope: (
    _reason: string,
    operation: () => unknown,
  ) => operation(),
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: eventMocks.appendScopedDomainEvent,
}));

import {
  acknowledgeMobilePushDelivery,
  getMobilePushAcknowledgementCandidate,
} from "@/lib/mobile/push-store";

beforeEach(() => {
  dbMocks.responses.splice(0);
  dbMocks.statements.splice(0);
  dbMocks.ensureDatabaseSchema.mockClear();
  dbMocks.getSql.mockClear();
  dbMocks.hasDatabaseUrl.mockClear();
  dbMocks.sql.mockClear();
  dbMocks.transaction.mockClear();
  eventMocks.appendScopedDomainEvent.mockClear();
});

describe("mobile push acknowledgement storage", () => {
  it("selects a candidate only through the exact installation binding", async () => {
    dbMocks.responses.push([deliveryRow("delivered")]);

    await expect(
      getMobilePushAcknowledgementCandidate(context(), "delivery-one"),
    ).resolves.toMatchObject({
      id: "delivery-one",
      status: "delivered",
    });

    const statement = dbMocks.statements[0];
    expect(statement.text).toMatch(
      /tenant_id = \$\d+[\s\S]*owner_actor_id = \$\d+[\s\S]*registration\.device_id = \$\d+[\s\S]*registration\.mobile_session_id = \$\d+/,
    );
    expect(statement.params).toEqual([
      "delivery-one",
      "tenant-one",
      "actor-one",
      "device-one",
      "session-one",
    ]);

    await expect(
      getMobilePushAcknowledgementCandidate(
        context({ deviceId: "device-two", sessionId: "session-two" }),
        "delivery-one",
      ),
    ).resolves.toBeUndefined();
    expect(dbMocks.statements[1].params).toEqual([
      "delivery-one",
      "tenant-one",
      "actor-one",
      "device-two",
      "session-two",
    ]);
  });

  it("acknowledges once and returns the stable result on retry", async () => {
    dbMocks.responses.push(
      [deliveryRow("delivered")],
      [deliveryRow("acknowledged")],
      [deliveryRow("acknowledged")],
    );

    await expect(
      acknowledgeMobilePushDelivery(
        context(),
        "delivery-one",
        "push-open-delivery-one",
      ),
    ).resolves.toMatchObject({ newlyAcknowledged: true });
    await expect(
      acknowledgeMobilePushDelivery(
        context(),
        "delivery-one",
        "push-open-delivery-one",
      ),
    ).resolves.toMatchObject({ newlyAcknowledged: false });

    expect(dbMocks.statements).toHaveLength(3);
    expect(dbMocks.statements[1].text).toContain(
      "UPDATE omni_mobile_push_deliveries",
    );
    expect(dbMocks.statements[1].params).toEqual([
      "delivery-one",
      "tenant-one",
      "actor-one",
      "device-one",
      "session-one",
    ]);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledOnce();
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "mobile.push_delivery_acknowledged",
        streamId: "mobile-push-delivery:delivery-one",
        executionScope: expect.objectContaining({
          tenantId: "tenant-one",
          initiatingActorId: "actor-one",
        }),
      }),
      { sql: dbMocks.sql },
    );
  });
});

function context(overrides: { deviceId?: string; sessionId?: string } = {}) {
  return {
    tenantId: "tenant-one",
    actorId: "actor-one",
    role: "operator",
    source: "mobile",
    auth: {
      userId: "user-one",
      email: "actor-one",
      sessionId: overrides.sessionId || "session-one",
      tenantName: "Tenant One",
    },
    native: {
      deviceId: overrides.deviceId || "device-one",
      platform: "ios",
      appVersion: "1.0.0",
      buildNumber: 1,
      clientContractVersion: 4,
    },
  } satisfies SecurityContext;
}

function deliveryRow(status: "delivered" | "acknowledged") {
  const timestamp = "2026-09-08T12:00:00.000Z";
  return {
    id: "delivery-one",
    tenant_id: "tenant-one",
    owner_actor_id: "actor-one",
    registration_id: "registration-one",
    notification_id: "notification-one",
    cause_kind: "meeting",
    cause_id: "meeting-one",
    parent_id: null,
    deep_link: "/meetings/meeting-one",
    dedupe_key: "a".repeat(64),
    payload: { schemaVersion: 1 },
    status,
    attempt: 1,
    max_attempts: 5,
    run_at: timestamp,
    lease_owner: null,
    lease_expires_at: null,
    last_error: null,
    delivered_at: timestamp,
    acknowledged_at: status === "acknowledged" ? timestamp : null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
