import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAbandonedExternalA2ASafety: vi.fn(),
  touchExternalA2ASafety: vi.fn(),
  getDelegationTask: vi.fn(),
  transitionDelegationTask: vi.fn(),
}));

vi.mock("@/lib/a2a/safety-store", () => ({
  listAbandonedExternalA2ASafety: mocks.listAbandonedExternalA2ASafety,
  touchExternalA2ASafety: mocks.touchExternalA2ASafety,
}));
vi.mock("@/lib/delegation/store", () => ({
  getDelegationTask: mocks.getDelegationTask,
  transitionDelegationTask: mocks.transitionDelegationTask,
}));

import { reconcileAbandonedExternalA2ATasks } from "@/lib/a2a/maintenance";

describe("external A2A abandonment reconciliation", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.touchExternalA2ASafety.mockResolvedValue({ status: "canceled" });
    mocks.getDelegationTask.mockResolvedValue(task());
    mocks.transitionDelegationTask.mockImplementation(async (input) => ({
      ...task(),
      state: input.transition.to,
    }));
  });

  it("cancels a stalled task before its hard deadline", async () => {
    mocks.listAbandonedExternalA2ASafety.mockResolvedValue([safety()]);
    const result = await reconcileAbandonedExternalA2ATasks({
      tenantId: "tenant-one",
      now: "2026-09-07T06:02:01.000Z",
    });
    expect(result).toMatchObject({ scanned: 1, canceled: 1, expired: 0, failed: 0 });
    expect(mocks.transitionDelegationTask).toHaveBeenCalledWith(
      expect.objectContaining({
        transition: expect.objectContaining({ to: "canceled", initiator: "system" }),
        parentExecutionScope: expect.objectContaining({
          tenantId: "tenant-one",
          initiatingActorId: "actor-one",
          executingPrincipalId: "principal:atlas:1",
        }),
      }),
    );
    expect(mocks.touchExternalA2ASafety).toHaveBeenCalledWith(
      expect.objectContaining({ status: "canceled", reason: "progress_timeout_expired" }),
    );
  });

  it("expires a task at its hard deadline and isolates per-task failures", async () => {
    mocks.listAbandonedExternalA2ASafety.mockResolvedValue([safety(), {
      ...safety(),
      reservation: { ...safety().reservation, internalTaskId: "delegation-task:two" },
    }]);
    mocks.getDelegationTask
      .mockResolvedValueOnce(task())
      .mockRejectedValueOnce(new Error("missing canonical task"));
    const result = await reconcileAbandonedExternalA2ATasks({
      tenantId: "tenant-one",
      now: "2026-09-07T06:05:00.000Z",
    });
    expect(result).toMatchObject({ scanned: 2, expired: 1, failed: 1 });
    expect(mocks.transitionDelegationTask).toHaveBeenCalledWith(
      expect.objectContaining({ transition: { to: "expired" } }),
    );
  });
});

function task() {
  return {
    tenantId: "tenant-one",
    ownerActorId: "actor-one",
    taskId: "delegation-task:one",
    parentPrincipalId: "principal:atlas:1",
    parentDelegationId: null,
    lifecycleRevision: 2,
    completeBy: "2026-09-07T06:05:00.000Z",
    state: "working",
  };
}

function safety() {
  return {
    reservation: {
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      internalTaskId: "delegation-task:one",
      safetyId: `a2a-safety:${"a".repeat(64)}`,
      safetySha256: "a".repeat(64),
    },
    status: "active",
  };
}
