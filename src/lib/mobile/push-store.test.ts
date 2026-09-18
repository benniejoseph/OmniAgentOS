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

const providerMocks = vi.hoisted(() => ({
  deliverMobilePush: vi.fn(async () => ({ messageId: "provider-message" })),
  mobilePushProviderConfiguration: vi.fn(() => ({
    apns: "configured",
    fcm: "configured",
  })),
}));

const credentialMocks = vi.hoisted(() => ({
  credentialBinding: vi.fn((input: unknown) => input),
  openCredentialBundle: vi.fn(() => ({ token: "fcm-token-for-test-delivery" })),
  sealCredentialBundle: vi.fn(() => ({ sealed: true })),
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

vi.mock("@/lib/mobile/push-providers", () => {
  class MobilePushProviderError extends Error {
    constructor(
      message: string,
      readonly permanent: boolean,
      readonly code: string,
    ) {
      super(message);
      this.name = "MobilePushProviderError";
    }
  }
  return {
    deliverMobilePush: providerMocks.deliverMobilePush,
    MobilePushProviderError,
    mobilePushProviderConfiguration:
      providerMocks.mobilePushProviderConfiguration,
  };
});

vi.mock("@/lib/settings/credential-vault", () => ({
  credentialBinding: credentialMocks.credentialBinding,
  openCredentialBundle: credentialMocks.openCredentialBundle,
  sealCredentialBundle: credentialMocks.sealCredentialBundle,
}));

import {
  acknowledgeMobilePushDelivery,
  dispatchMobilePushDeliveries,
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
  providerMocks.deliverMobilePush.mockReset().mockResolvedValue({
    messageId: "provider-message",
  });
  providerMocks.mobilePushProviderConfiguration.mockClear();
  credentialMocks.credentialBinding.mockClear();
  credentialMocks.openCredentialBundle.mockClear();
  credentialMocks.sealCredentialBundle.mockClear();
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

describe("mobile push delivery leases", () => {
  it("leases each delivery immediately before its serial provider call", async () => {
    dbMocks.responses.push(
      [],
      [deliveryRow("running", { id: "delivery-one", leaseOwner: "lease-one" })],
      [registrationRow()],
      [{ id: "delivery-one" }],
      [],
      [deliveryRow("running", { id: "delivery-two", leaseOwner: "lease-two" })],
      [registrationRow()],
      [{ id: "delivery-two" }],
      [],
    );

    await expect(
      dispatchMobilePushDeliveries({ tenantId: "tenant-one", limit: 2 }),
    ).resolves.toEqual({
      processed: 2,
      delivered: 2,
      retried: 0,
      failed: 0,
      unsettled: 0,
    });

    const leaseStatements = dbMocks.statements.filter((statement) =>
      statement.text.includes("WITH next_deliveries AS"),
    );
    expect(leaseStatements).toHaveLength(2);
    expect(leaseStatements.every((statement) => statement.text.includes("LIMIT 1")))
      .toBe(true);
    const settlementStatements = dbMocks.statements.filter((statement) =>
      statement.text.includes("SET status = 'delivered'") &&
      statement.text.includes("lease_owner ="),
    );
    expect(settlementStatements).toHaveLength(2);
    expect(settlementStatements.every((statement) =>
      statement.text.includes("owner_actor_id ="),
    )).toBe(true);
    expect(providerMocks.deliverMobilePush).toHaveBeenCalledTimes(2);
  });

  it("continues with the next delivery when failure settlement loses its lease", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    providerMocks.deliverMobilePush
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ messageId: "provider-message-two" });
    dbMocks.responses.push(
      [],
      [deliveryRow("running", { id: "delivery-one", leaseOwner: "lease-one" })],
      [registrationRow()],
      [],
      [deliveryRow("running", { id: "delivery-two", leaseOwner: "lease-two" })],
      [registrationRow()],
      [{ id: "delivery-two" }],
      [],
    );

    await expect(
      dispatchMobilePushDeliveries({ tenantId: "tenant-one", limit: 2 }),
    ).resolves.toEqual({
      processed: 2,
      delivered: 1,
      retried: 0,
      failed: 0,
      unsettled: 1,
    });
    expect(providerMocks.deliverMobilePush).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      "Mobile push delivery failure settlement failed.",
      "Error",
    );
    warning.mockRestore();
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

function deliveryRow(
  status: "running" | "delivered" | "acknowledged",
  overrides: { id?: string; leaseOwner?: string } = {},
) {
  const timestamp = "2026-09-08T12:00:00.000Z";
  const id = overrides.id || "delivery-one";
  return {
    id,
    tenant_id: "tenant-one",
    owner_actor_id: "actor-one",
    registration_id: "registration-one",
    notification_id: status === "running" ? null : "notification-one",
    cause_kind: "meeting",
    cause_id: "meeting-one",
    parent_id: null,
    deep_link: "/meetings/meeting-one",
    dedupe_key: "a".repeat(64),
    payload: {
      schemaVersion: "1",
      deliveryId: id,
      causeKind: "meeting",
      causeId: "meeting-one",
      deepLink: "/meetings/meeting-one",
    },
    status,
    attempt: 1,
    max_attempts: 5,
    run_at: timestamp,
    lease_owner: status === "running" ? overrides.leaseOwner || "lease-one" : null,
    lease_expires_at: status === "running" ? "2026-09-08T12:00:30.000Z" : null,
    last_error: null,
    delivered_at: status === "running" ? null : timestamp,
    acknowledged_at: status === "acknowledged" ? timestamp : null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function registrationRow() {
  const timestamp = "2026-09-08T12:00:00.000Z";
  return {
    id: "registration-one",
    tenant_id: "tenant-one",
    owner_actor_id: "actor-one",
    user_id: "user-one",
    mobile_session_id: "session-one",
    device_id: "device-one",
    platform: "android",
    provider: "fcm",
    environment: "production",
    token_sha256: "b".repeat(64),
    credential_version: 1,
    token_bundle: { sealed: true },
    preview_policy: "hidden",
    state: "active",
    lifecycle_revision: 1,
    last_registered_at: timestamp,
    last_delivered_at: null,
    revoked_at: null,
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
