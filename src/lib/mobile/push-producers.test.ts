import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getTodayPreferences: vi.fn(),
  isQuietHoursActive: vi.fn(() => false),
  enqueueMobilePush: vi.fn(),
  applyNotificationDispositionDecision: vi.fn(),
  listDueNotificationDigestActors: vi.fn(async () => [] as string[]),
  flushDueNotificationDigest: vi.fn(async () => undefined),
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

vi.mock("@/lib/mobile/notification-disposition-store", () => ({
  applyNotificationDispositionDecision:
    mocks.applyNotificationDispositionDecision,
  listDueNotificationDigestActors: mocks.listDueNotificationDigestActors,
  flushDueNotificationDigest: mocks.flushDueNotificationDigest,
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
  mocks.applyNotificationDispositionDecision.mockReset().mockImplementation(
    async (input) => {
      const delivery = input.decision.outcome === "send"
        ? await input.directDelivery(sql)
        : { deliveryIds: [] };
      return {
        applied: true,
        deliveryIds: delivery.deliveryIds,
        record: { outcome: input.decision.outcome },
      };
    },
  );
  mocks.listDueNotificationDigestActors.mockReset().mockResolvedValue([]);
  mocks.flushDueNotificationDigest.mockReset().mockResolvedValue(undefined);
  vi.mocked(sql.transaction).mockClear();
});

describe("domain mobile push producers", () => {
  it("records a deferred approval during quiet hours without touching the outbox", async () => {
    mocks.rows.push(candidate("approval", "approval-one", now));
    mocks.isQuietHoursActive.mockReturnValue(true);

    await expect(processDomainMobilePushProducers({
      tenantId: "tenant-one",
      now,
    })).resolves.toMatchObject({
      queued: 0,
      dispositionsApplied: 1,
      decisionsByOutcome: { defer: 1 },
    });

    expect(mocks.enqueueMobilePush).not.toHaveBeenCalled();
    expect(mocks.applyNotificationDispositionDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        coordinates: expect.objectContaining({
          sourceKind: "tool_approval",
          sourceId: "approval-one",
        }),
        decision: expect.objectContaining({
          outcome: "defer",
          reason: "quiet_hours",
          decisionGrantsAuthority: false,
        }),
      }),
    );
  });

  it("waits until a meeting enters the actor's configured lead window", async () => {
    const meetingAt = new Date(now.getTime() + 90 * 60_000);
    mocks.rows.push(candidate("meeting", "meeting-one", meetingAt));
    mocks.getTodayPreferences.mockResolvedValueOnce(preferences({
      reminderLeadMinutes: 30,
    }));

    await expect(processDomainMobilePushProducers({
      tenantId: "tenant-one",
      now,
    })).resolves.toMatchObject({
      queued: 0,
      decisionsByOutcome: { digest: 1 },
    });
  });

  it("reuses the exact causal occurrence so the outbox can deduplicate retries", async () => {
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

  it("suppresses successful runs and batches canceled runs without direct delivery", async () => {
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
    expect(mocks.flushDueNotificationDigest).toHaveBeenCalledWith({
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      now,
    });
  });

  it("maps delegation, schedule, and security state to real reachable targets", async () => {
    mocks.rows.push(
      proactiveCandidate("delegation", "delegation-one", {
        state: "waiting",
        sourceKind: "delegated_task",
        targetKind: "run",
        targetId: "child-run-one",
      }),
      proactiveCandidate("routine", "schedule-one", {
        state: "circuit_open",
        sourceKind: "scheduled_routine",
        targetKind: "notification",
      }),
      proactiveCandidate("security", "incident-one", {
        state: "security_critical",
        sourceKind: "security_incident",
        targetKind: "notification",
      }),
    );
    mocks.isQuietHoursActive.mockReturnValue(true);

    await expect(processDomainMobilePushProducers({
      tenantId: "tenant-one",
      now,
    })).resolves.toMatchObject({
      queued: 2,
      decisionsByOutcome: { defer: 1, send: 2 },
      queuedProactiveByKind: {
        delegation: 0,
        routine: 1,
        security: 1,
      },
    });

    expect(mocks.enqueueMobilePush).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueMobilePush).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: { kind: "notification", id: "schedule-one" },
      }),
    );
    expect(mocks.enqueueMobilePush).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: { kind: "notification", id: "incident-one" },
      }),
    );
  });

  it("anti-joins terminal, pending digest, and not-due deferred dispositions", async () => {
    await processDomainMobilePushProducers({
      tenantId: "tenant-one",
      now,
    });

    const query = sql.mock.calls[0][0].join("?");
    expect(query).toContain("FROM omni_notification_dispositions disposition");
    expect(query).toContain("disposition.state = 'terminal'");
    expect(query).toContain("disposition.outcome = 'digest'");
    expect(query).toContain("disposition.outcome IN ('defer', 'send')");
    expect(query).toContain("disposition.due_at >");
    expect(query).toContain("omni_delegation_executions");
    expect(query).toContain("omni_workflow_schedule_occurrences");
    expect(query).toContain("omni_incidents");
    expect(query).not.toContain("OFFSET");
    expect(query).toContain("candidate.occurs_at <");
  });

  it("uses a stable keyset so disappearing and disabled first-page rows do not skip work", async () => {
    const firstPage = [
      candidate("approval", "approval-newer", now),
      ...Array.from({ length: 19 }, (_, index) => candidate(
        "approval",
        `approval-disabled-${index}`,
        new Date(now.getTime() - index),
        { actorId: `disabled-${index}` },
      )),
    ];
    const older = candidate(
      "approval",
      "approval-older",
      new Date(now.getTime() - 60_000),
    );
    sql.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([older]);
    mocks.getTodayPreferences.mockImplementation(async ({ actorId }) => ({
      ...preferences(),
      actorId,
      notificationsEnabled: !String(actorId).startsWith("disabled-"),
    }));

    await expect(processDomainMobilePushProducers({
      tenantId: "tenant-one",
      limit: 2,
      now,
    })).resolves.toMatchObject({
      scanned: 21,
      dispositionsApplied: 2,
      skippedByPreference: 19,
    });

    expect(sql).toHaveBeenCalledTimes(2);
    expect(mocks.applyNotificationDispositionDecision.mock.calls.map(
      ([input]) => input.coordinates.sourceId,
    )).toEqual(["approval-newer", "approval-older"]);
    const secondQueryParameters = sql.mock.calls[1].slice(1);
    expect(secondQueryParameters).toContain(firstPage.at(-1)?.occurs_at);
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
    actorId?: string;
  } = {},
) {
  const sourceKind = kind === "approval"
    ? "tool_approval"
    : kind === "customer"
      ? "customer_risk"
      : kind === "run"
        ? "agent_run"
        : "meeting";
  return {
    producer_kind: kind,
    source_kind: sourceKind,
    owner_actor_id: options.actorId || "actor-one",
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
    target_kind: kind,
    target_id: sourceId,
    cooldown_active: options.cooldownActive ?? false,
  };
}

function proactiveCandidate(
  kind: "delegation" | "routine" | "security",
  sourceId: string,
  options: {
    state: "waiting" | "failed" | "rejected" | "approval_required" |
      "circuit_open" | "security_warning" | "security_critical";
    sourceKind: "delegated_task" | "scheduled_routine" | "security_incident";
    targetKind: "run" | "notification";
    targetId?: string;
  },
) {
  return {
    producer_kind: kind,
    source_kind: options.sourceKind,
    owner_actor_id: "actor-one",
    source_id: sourceId,
    occurrence_key: "revision-one",
    occurs_at: now.toISOString(),
    candidate_state: options.state,
    target_kind: options.targetKind,
    target_id: options.targetId || sourceId,
    cooldown_active: false,
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
