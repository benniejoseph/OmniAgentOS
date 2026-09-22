import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getTodayPreferences: vi.fn(),
  isQuietHoursActive: vi.fn(() => false),
  enqueueMobilePush: vi.fn(),
  appendScopedDomainEvent: vi.fn(async () => undefined),
}));

type MockSql = ReturnType<typeof vi.fn> & {
  transaction: ReturnType<typeof vi.fn>;
};
const sql = vi.fn(async () => mocks.rows) as MockSql;
sql.transaction = vi.fn(async (
  operation: (client: typeof sql) => unknown,
) => operation(sql));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: () => sql,
  hasDatabaseUrl: () => true,
  runWithDatabaseSystemScope: (
    _reason: string,
    operation: () => unknown,
  ) => operation(),
}));

vi.mock("@/lib/today/briefs", () => ({
  getTodayPreferences: mocks.getTodayPreferences,
}));

vi.mock("@/lib/today/notifications", () => ({
  isQuietHoursActive: mocks.isQuietHoursActive,
}));

vi.mock("@/lib/mobile/push-store", () => {
  class MobilePushStorageRequiredError extends Error {}
  return {
    enqueueMobilePush: mocks.enqueueMobilePush,
    MobilePushStorageRequiredError,
  };
});

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));

import { processDomainMobilePushProducers } from "@/lib/mobile/push-producers";

const now = new Date("2026-09-18T12:00:00.000Z");

beforeEach(() => {
  mocks.rows.splice(0);
  sql.mockClear();
  mocks.ensureDatabaseSchema.mockClear();
  mocks.getTodayPreferences.mockReset().mockResolvedValue(preferences());
  mocks.isQuietHoursActive.mockReset().mockReturnValue(false);
  mocks.enqueueMobilePush.mockReset().mockResolvedValue([{ id: "delivery-one" }]);
  mocks.appendScopedDomainEvent.mockClear();
  vi.mocked(sql.transaction).mockClear();
});

describe("domain mobile push producers", () => {
  it("records a deferred decision during quiet hours without consuming the occurrence", async () => {
    mocks.rows.push(candidate("approval", "approval-one", now));
    mocks.isQuietHoursActive.mockReturnValueOnce(true).mockReturnValue(false);

    await expect(processDomainMobilePushProducers({
      tenantId: "tenant-one",
      now,
    })).resolves.toMatchObject({ queued: 0, skippedByPreference: 1 });
    await expect(processDomainMobilePushProducers({
      tenantId: "tenant-one",
      now,
    })).resolves.toMatchObject({ queued: 1, skippedByPreference: 0 });

    expect(mocks.enqueueMobilePush).toHaveBeenCalledOnce();
    expect(mocks.enqueueMobilePush).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-one",
      actorId: "actor-one",
      occurrenceKey: "revision-one",
      target: { kind: "approval", id: "approval-one" },
      executionScope: expect.objectContaining({
        purpose: "notification.delivery.decision",
      }),
    }));
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledTimes(2);
    expect(mocks.appendScopedDomainEvent.mock.calls[0][0]).toMatchObject({
      type: "notification.delivery_decided",
      payload: { decision: { outcome: "defer", reason: "quiet_hours" } },
    });
  });

  it("waits until a meeting enters the actor's configured lead window", async () => {
    const meetingAt = new Date(now.getTime() + 90 * 60_000);
    mocks.rows.push(candidate("meeting", "meeting-one", meetingAt));
    mocks.getTodayPreferences
      .mockResolvedValueOnce(preferences({ reminderLeadMinutes: 30 }))
      .mockResolvedValueOnce(preferences({ reminderLeadMinutes: 120 }));

    await expect(processDomainMobilePushProducers({
      tenantId: "tenant-one",
      now,
    })).resolves.toMatchObject({ queued: 0, skippedByPreference: 1 });
    await expect(processDomainMobilePushProducers({
      tenantId: "tenant-one",
      now,
    })).resolves.toMatchObject({ queued: 1, queuedByKind: { meeting: 1 } });
  });

  it("reuses the causal occurrence across ticks so the outbox deduplicates", async () => {
    mocks.rows.push(candidate("run", "run-one", now, { state: "failed" }));
    mocks.enqueueMobilePush
      .mockResolvedValueOnce([{ id: "delivery-one" }])
      .mockResolvedValueOnce([]);

    const first = await processDomainMobilePushProducers({
      tenantId: "tenant-one",
      now,
    });
    const second = await processDomainMobilePushProducers({
      tenantId: "tenant-one",
      now,
    });

    expect(first.queued).toBe(1);
    expect(second.queued).toBe(0);
    expect(mocks.enqueueMobilePush).toHaveBeenCalledTimes(2);
    const [firstInput] = mocks.enqueueMobilePush.mock.calls[0];
    const [secondInput] = mocks.enqueueMobilePush.mock.calls[1];
    expect(secondInput).toMatchObject({
      tenantId: firstInput.tenantId,
      actorId: firstInput.actorId,
      target: firstInput.target,
      occurrenceKey: firstInput.occurrenceKey,
      executionScope: {
        correlationId: firstInput.executionScope.correlationId,
        causationId: "run-one",
        purpose: "notification.delivery.decision",
      },
    });
  });

  it("suppresses successful runs and digests canceled runs without touching the outbox", async () => {
    mocks.rows.push(
      candidate("run", "run-success", now, { state: "completed" }),
      candidate("run", "run-canceled", now, { state: "canceled" }),
    );

    await expect(processDomainMobilePushProducers({
      tenantId: "tenant-one",
      now,
    })).resolves.toMatchObject({
      queued: 0,
      decisionsByOutcome: { suppress: 1, digest: 1 },
    });

    expect(mocks.enqueueMobilePush).not.toHaveBeenCalled();
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledTimes(2);
  });

  it("defers an actionable failure while the server-derived cooldown is active", async () => {
    mocks.rows.push(candidate("run", "run-failed", now, {
      state: "failed",
      cooldownActive: true,
    }));

    await expect(processDomainMobilePushProducers({
      tenantId: "tenant-one",
      now,
    })).resolves.toMatchObject({
      queued: 0,
      decisionsByOutcome: { defer: 1 },
    });
    expect(mocks.enqueueMobilePush).not.toHaveBeenCalled();
    expect(mocks.appendScopedDomainEvent.mock.calls[0][0]).toMatchObject({
      payload: { decision: { reason: "cooldown_active" } },
    });
  });

  it("pages past a full duplicate window so older eligible work is not starved", async () => {
    const newest = Array.from({ length: 20 }, (_, index) =>
      candidate("approval", `approval-new-${index}`, now));
    const older = candidate(
      "approval",
      "approval-older",
      new Date(now.getTime() - 60_000),
    );
    sql
      .mockResolvedValueOnce(newest)
      .mockResolvedValueOnce([older]);
    mocks.enqueueMobilePush.mockImplementation(async (input) =>
      input.target.id === "approval-older" ? [{ id: "delivery-older" }] : []
    );

    await expect(processDomainMobilePushProducers({
      tenantId: "tenant-one",
      limit: 1,
      now,
    })).resolves.toMatchObject({
      scanned: 21,
      queued: 1,
      queuedByKind: { approval: 1 },
    });

    expect(sql).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueMobilePush).toHaveBeenCalledTimes(21);
    expect(mocks.enqueueMobilePush).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: { kind: "approval", id: "approval-older" },
      }),
    );
  });
});

function candidate(
  kind: "approval" | "meeting" | "customer" | "run",
  sourceId: string,
  occursAt: Date,
  options: {
    state?: "approval_required" | "scheduled" | "at_risk" |
      "completed" | "failed" | "canceled";
    cooldownActive?: boolean;
  } = {},
) {
  return {
    producer_kind: kind,
    owner_actor_id: "actor-one",
    source_id: sourceId,
    occurrence_key: "revision-one",
    occurs_at: occursAt.toISOString(),
    candidate_state: options.state || (
      kind === "approval"
        ? "approval_required"
        : kind === "meeting"
          ? "scheduled"
          : kind === "customer"
            ? "at_risk"
            : "completed"
    ),
    cooldown_active: options.cooldownActive ?? false,
  };
}

function preferences(
  overrides: { reminderLeadMinutes?: number } = {},
) {
  return {
    tenantId: "tenant-one",
    actorId: "actor-one",
    notificationsEnabled: true,
    quietHoursEnabled: true,
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
    timezone: "UTC",
    reminderLeadMinutes: overrides.reminderLeadMinutes ?? 30,
  };
}
