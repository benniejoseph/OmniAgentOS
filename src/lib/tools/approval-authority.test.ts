import { beforeEach, describe, expect, it, vi } from "vitest";
import { A2APeerStoreError } from "@/lib/a2a/store";
import { DelegationTaskConflictError } from "@/lib/delegation/store";
import {
  createExecutionScope,
  type CreateExecutionScopeInput,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import type { SecurityRole } from "@/lib/security/types";
import {
  DELEGATION_ENDED_WITHDRAWAL_REASON,
  REQUESTER_DEMOTED_WITHDRAWAL_REASON,
  REQUESTER_LEFT_WITHDRAWAL_REASON,
  lapsedApprovalAuthority,
} from "@/lib/tools/approval-authority";

const mocks = vi.hoisted(() => ({
  assertA2APeerRolloutActive: vi.fn(),
  currentAccountRoleInTenant: vi.fn(),
  findExternalA2ASafetyForDelegation: vi.fn(),
  getA2APeer: vi.fn(),
  getDelegationTask: vi.fn(),
  isAuthEnforced: vi.fn(),
}));

vi.mock("@/lib/a2a/rollout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/a2a/rollout")>()),
  assertA2APeerRolloutActive: mocks.assertA2APeerRolloutActive,
}));
vi.mock("@/lib/a2a/safety-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/a2a/safety-store")>()),
  findExternalA2ASafetyForDelegation: mocks.findExternalA2ASafetyForDelegation,
}));
vi.mock("@/lib/a2a/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/a2a/store")>()),
  getA2APeer: mocks.getA2APeer,
}));
vi.mock("@/lib/auth/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/store")>()),
  currentAccountRoleInTenant: mocks.currentAccountRoleInTenant,
  isAuthEnforced: mocks.isAuthEnforced,
}));
vi.mock("@/lib/delegation/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/delegation/store")>()),
  getDelegationTask: mocks.getDelegationTask,
}));

// Far from the real clock, so only the time passed in decides a deadline.
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const TENANT_ID = "tenant-authority";
const OWNER_ID = "owner@example.com";

function scope(
  overrides: Partial<CreateExecutionScopeInput> = {},
): ExecutionScope {
  return createExecutionScope({
    tenantId: TENANT_ID,
    initiatingActorId: OWNER_ID,
    executingPrincipalType: "user",
    executingPrincipalId: OWNER_ID,
    correlationId: "member-request",
    purpose: "tool.http.request",
    ...overrides,
  });
}

function binding(
  requesterRole: SecurityRole = "operator",
  executionScope = scope(),
) {
  return {
    executionScope,
    requesterRole,
    toolId: "http.request",
    inputSha256: "a".repeat(64),
  };
}

const record = { actorId: OWNER_ID };

describe("the authority of a member's pending approval", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.isAuthEnforced.mockReturnValue(true);
  });

  it("holds while the requester keeps the role it asked with", async () => {
    for (const role of ["operator", "admin"] as const) {
      mocks.currentAccountRoleInTenant.mockResolvedValueOnce(role);
      await expect(lapsedApprovalAuthority({ binding: binding(), record }))
        .resolves.toBeUndefined();
    }
    expect(mocks.currentAccountRoleInTenant).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      actorId: OWNER_ID,
    });
    expect(mocks.findExternalA2ASafetyForDelegation).not.toHaveBeenCalled();
  });

  it("lapses once the requester has left the workspace", async () => {
    mocks.currentAccountRoleInTenant.mockResolvedValue(null);

    await expect(lapsedApprovalAuthority({ binding: binding(), record }))
      .resolves.toBe(REQUESTER_LEFT_WITHDRAWAL_REASON);
  });

  it("lapses once the requester holds a lower role", async () => {
    mocks.currentAccountRoleInTenant.mockResolvedValue("viewer");

    await expect(lapsedApprovalAuthority({ binding: binding(), record }))
      .resolves.toBe(REQUESTER_DEMOTED_WITHDRAWAL_REASON);
    mocks.currentAccountRoleInTenant.mockResolvedValue("operator");
    await expect(lapsedApprovalAuthority({ binding: binding("admin"), record }))
      .resolves.toBe(REQUESTER_DEMOTED_WITHDRAWAL_REASON);
  });

  it("checks the recorded requester when the scope names none", async () => {
    mocks.currentAccountRoleInTenant.mockResolvedValue(null);

    await expect(lapsedApprovalAuthority({
      binding: binding("operator", scope({ initiatingActorId: null })),
      record: { actorId: "recorded@example.com" },
    })).resolves.toBe(REQUESTER_LEFT_WITHDRAWAL_REASON);
    expect(mocks.currentAccountRoleInTenant).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      actorId: "recorded@example.com",
    });
  });

  it("does not check a requester that is not an account", async () => {
    mocks.currentAccountRoleInTenant.mockResolvedValue(undefined);

    await expect(lapsedApprovalAuthority({ binding: binding(), record }))
      .resolves.toBeUndefined();
  });

  it("does not check identities while sign-in is off, a system caller, or no requester", async () => {
    mocks.currentAccountRoleInTenant.mockResolvedValue(null);
    mocks.isAuthEnforced.mockReturnValue(false);
    await expect(lapsedApprovalAuthority({ binding: binding(), record }))
      .resolves.toBeUndefined();

    mocks.isAuthEnforced.mockReturnValue(true);
    await expect(lapsedApprovalAuthority({ binding: binding("system"), record }))
      .resolves.toBeUndefined();
    await expect(lapsedApprovalAuthority({
      binding: binding("operator", scope({ initiatingActorId: null })),
      record: { actorId: undefined },
    })).resolves.toBeUndefined();

    expect(mocks.currentAccountRoleInTenant).not.toHaveBeenCalled();
  });
});

describe("the authority of an external delegation's pending approval", () => {
  const delegatedScope = scope({
    executingPrincipalType: "agent",
    executingPrincipalId: "delegate-principal",
    delegationId: "delegation-1",
    correlationId: `a2a-delegated:${"b".repeat(64)}`,
  });
  const reservation = {
    internalTaskId: "task-1",
    rolloutId: "rollout-1",
    rolloutSha256: "c".repeat(64),
    deadlineAt: new Date(NOW + 60_000).toISOString(),
  };
  const rollout = { rolloutSha256: reservation.rolloutSha256 };

  function check() {
    return lapsedApprovalAuthority({
      binding: binding("viewer", delegatedScope),
      record,
      now: NOW,
    });
  }

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.isAuthEnforced.mockReturnValue(true);
    mocks.currentAccountRoleInTenant.mockResolvedValue("admin");
    mocks.findExternalA2ASafetyForDelegation.mockResolvedValue({
      reservation,
      status: "active",
    });
    mocks.getDelegationTask.mockResolvedValue({
      state: "working",
      delegationId: "delegation-1",
    });
    mocks.getA2APeer.mockResolvedValue(rollout);
    mocks.assertA2APeerRolloutActive.mockReturnValue(rollout);
  });

  it("holds while its lease, task and peer rollout are all current", async () => {
    await expect(check()).resolves.toBeUndefined();
    mocks.getDelegationTask.mockResolvedValue({
      state: "waiting",
      delegationId: "delegation-1",
    });
    await expect(check()).resolves.toBeUndefined();

    expect(mocks.findExternalA2ASafetyForDelegation).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      ownerActorId: OWNER_ID,
      delegationId: "delegation-1",
    });
    expect(mocks.getDelegationTask).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      ownerActorId: OWNER_ID,
      taskId: "task-1",
    });
    expect(mocks.getA2APeer).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      ownerActorId: OWNER_ID,
      rolloutId: "rollout-1",
    });
    expect(mocks.assertA2APeerRolloutActive).toHaveBeenCalledWith({
      rollout,
      direction: "outbound",
    });
    // The owner's membership is checked as well.
    expect(mocks.currentAccountRoleInTenant).toHaveBeenCalled();
  });

  it.each([
    ["it has no safety lease", () =>
      mocks.findExternalA2ASafetyForDelegation.mockResolvedValue(undefined)],
    ["its lease ended", () =>
      mocks.findExternalA2ASafetyForDelegation.mockResolvedValue({
        reservation,
        status: "completed",
      })],
    ["its lease is past its deadline", () =>
      mocks.findExternalA2ASafetyForDelegation.mockResolvedValue({
        reservation: { ...reservation, deadlineAt: new Date(NOW).toISOString() },
        status: "active",
      })],
    ["its task finished", () =>
      mocks.getDelegationTask.mockResolvedValue({
        state: "completed",
        delegationId: "delegation-1",
      })],
    ["its task belongs to another delegation", () =>
      mocks.getDelegationTask.mockResolvedValue({
        state: "working",
        delegationId: "delegation-2",
      })],
    ["its task is gone", () =>
      mocks.getDelegationTask.mockRejectedValue(
        new DelegationTaskConflictError("Delegation task was not found."),
      )],
    ["its peer rollout is gone", () =>
      mocks.getA2APeer.mockRejectedValue(
        new A2APeerStoreError("A2A peer rollout not found.", 404),
      )],
    ["its peer rollout changed", () =>
      mocks.getA2APeer.mockResolvedValue({ rolloutSha256: "d".repeat(64) })],
    ["its peer rollout was paused", () =>
      mocks.assertA2APeerRolloutActive.mockImplementation(() => {
        throw new Error("The A2A peer rollout is not enabled and active.");
      })],
  ])("lapses once %s", async (_case, arrange) => {
    arrange();

    await expect(check()).resolves.toBe(DELEGATION_ENDED_WITHDRAWAL_REASON);
  });

  it("lapses when the scope names no delegation or owner", async () => {
    for (const overrides of [
      { delegationId: null },
      { initiatingActorId: null },
    ]) {
      await expect(lapsedApprovalAuthority({
        binding: binding("viewer", { ...delegatedScope, ...overrides }),
        record,
        now: NOW,
      })).resolves.toBe(DELEGATION_ENDED_WITHDRAWAL_REASON);
    }
    expect(mocks.findExternalA2ASafetyForDelegation).not.toHaveBeenCalled();
  });

  it("surfaces a store failure rather than treating it as ended", async () => {
    mocks.getA2APeer.mockRejectedValue(
      new A2APeerStoreError("The A2A peer store is unavailable.", 503),
    );
    await expect(check()).rejects.toThrow("unavailable");

    mocks.getA2APeer.mockResolvedValue(rollout);
    mocks.getDelegationTask.mockRejectedValue(new Error("connection reset"));
    await expect(check()).rejects.toThrow("connection reset");
  });

  it("does not check delegations outside external delegated calls", async () => {
    await expect(lapsedApprovalAuthority({
      binding: binding("viewer", { ...delegatedScope, correlationId: "council" }),
      record,
      now: NOW,
    })).resolves.toBeUndefined();

    expect(mocks.findExternalA2ASafetyForDelegation).not.toHaveBeenCalled();
  });
});
