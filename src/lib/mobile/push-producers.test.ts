import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getTodayPreferences: vi.fn(),
  isQuietHoursActive: vi.fn(() => false),
  enqueueMobilePush: vi.fn(),
}));

const sql = vi.fn(async () => mocks.rows);

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

import { processDomainMobilePushProducers } from "@/lib/mobile/push-producers";

const now = new Date("2026-09-18T12:00:00.000Z");

beforeEach(() => {
  mocks.rows.splice(0);
  sql.mockClear();
  mocks.ensureDatabaseSchema.mockClear();
  mocks.getTodayPreferences.mockReset().mockResolvedValue(preferences());
  mocks.isQuietHoursActive.mockReset().mockReturnValue(false);
  mocks.enqueueMobilePush.mockReset().mockResolvedValue([{ id: "delivery-one" }]);
});

describe("domain mobile push producers", () => {
  it("holds candidates during quiet hours without consuming their occurrence", async () => {
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
    }));
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
    mocks.rows.push(candidate("run", "run-one", now));
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
        purpose: "mobile.push_producer.run",
      },
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
) {
  return {
    producer_kind: kind,
    owner_actor_id: "actor-one",
    source_id: sourceId,
    occurrence_key: "revision-one",
    occurs_at: occursAt.toISOString(),
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
