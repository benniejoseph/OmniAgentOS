import { assertA2APeerRolloutActive } from "@/lib/a2a/rollout";
import { findExternalA2ASafetyForDelegation } from "@/lib/a2a/safety-store";
import { A2APeerStoreError, getA2APeer } from "@/lib/a2a/store";
import { currentAccountRoleInTenant, isAuthEnforced } from "@/lib/auth/store";
import {
  DelegationTaskConflictError,
  getDelegationTask,
} from "@/lib/delegation/store";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityRole } from "@/lib/security/types";
import type { ToolExecutionScopeBinding } from "@/lib/tools/execution-scope";
import type { ToolExecutionRecord } from "@/lib/tools/types";

export const REQUESTER_LEFT_WITHDRAWAL_REASON =
  "Withdrawn: the member who requested this action no longer belongs to this workspace.";
export const REQUESTER_DEMOTED_WITHDRAWAL_REASON =
  "Withdrawn: the member who requested this action no longer holds the role it was requested with.";
export const DELEGATION_ENDED_WITHDRAWAL_REASON =
  "Withdrawn: the external delegation that requested this action is no longer active.";

const ROLE_RANK: Record<SecurityRole, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
  system: 3,
};
// A delegate may wait on this very approval; any other state has ended the
// work the call was made for.
const LIVE_DELEGATION_STATES = new Set(["working", "waiting"]);

/**
 * Why the authority a pending approval was requested under no longer holds,
 * or undefined while it does. An approved action runs with the role recorded
 * for its requester, so it must not be approved once the requester has left
 * the workspace or lost that role, or once the external delegation that
 * asked for it has ended.
 */
export async function lapsedApprovalAuthority(input: {
  binding: ToolExecutionScopeBinding;
  record: Pick<ToolExecutionRecord, "actorId">;
  now?: number;
}): Promise<string | undefined> {
  const scope = input.binding.executionScope;
  if (
    scope.correlationId.startsWith("a2a-delegated:") &&
    !(await externalDelegationLive(scope, input.now ?? Date.now()))
  ) {
    return DELEGATION_ENDED_WITHDRAWAL_REASON;
  }
  const requester = scope.initiatingActorId || input.record.actorId;
  // Identities are not accounts when sign-in is off, and a system caller's
  // authority is its deployment's.
  if (!requester || input.binding.requesterRole === "system" || !isAuthEnforced()) {
    return undefined;
  }
  const role = await currentAccountRoleInTenant({
    tenantId: scope.tenantId,
    actorId: requester,
  });
  if (role === undefined) return undefined;
  if (role === null) return REQUESTER_LEFT_WITHDRAWAL_REASON;
  return ROLE_RANK[role] < ROLE_RANK[input.binding.requesterRole]
    ? REQUESTER_DEMOTED_WITHDRAWAL_REASON
    : undefined;
}

/**
 * Whether the delegation behind a delegated call still holds the authority
 * the call was checked against: its safety lease, its task and the peer
 * rollout its token was issued under.
 */
async function externalDelegationLive(scope: ExecutionScope, now: number) {
  const ownerActorId = scope.initiatingActorId;
  if (!scope.delegationId || !ownerActorId) return false;
  const safety = await findExternalA2ASafetyForDelegation({
    tenantId: scope.tenantId,
    ownerActorId,
    delegationId: scope.delegationId,
  });
  if (
    !safety ||
    safety.status !== "active" ||
    now >= Date.parse(safety.reservation.deadlineAt)
  ) {
    return false;
  }
  const [task, rollout] = await Promise.all([
    unlessMissing(getDelegationTask({
      tenantId: scope.tenantId,
      ownerActorId,
      taskId: safety.reservation.internalTaskId,
    })),
    unlessMissing(getA2APeer({
      tenantId: scope.tenantId,
      ownerActorId,
      rolloutId: safety.reservation.rolloutId,
    })),
  ]);
  if (
    !task ||
    !LIVE_DELEGATION_STATES.has(task.state) ||
    task.delegationId !== scope.delegationId ||
    !rollout ||
    rollout.rolloutSha256 !== safety.reservation.rolloutSha256
  ) {
    return false;
  }
  try {
    assertA2APeerRolloutActive({ rollout, direction: "outbound" });
    return true;
  } catch {
    return false;
  }
}

async function unlessMissing<T>(read: Promise<T>) {
  try {
    return await read;
  } catch (error) {
    if (
      error instanceof DelegationTaskConflictError ||
      (error instanceof A2APeerStoreError && error.status === 404)
    ) {
      return undefined;
    }
    throw error;
  }
}
