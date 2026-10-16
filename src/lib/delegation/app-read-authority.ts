import "server-only";
import { createHash } from "node:crypto";
import type { AppServiceCaller } from "@/lib/app-services/contracts";
import { getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { getDelegationExecution } from "@/lib/delegation/execution-store";
import { revalidateDelegationGrantsV1 } from "@/lib/delegation/grant-resolver";
import { executionScopeFromDelegationContract } from "@/lib/delegation/runtime";
import { listStreamEvents } from "@/lib/events/store";
import { getAgentRun, getAgentRunExecutionScope, getAgentRunIdentityPin } from "@/lib/runs/store";
import { deriveExecutionScope, executionScopesEqual } from "@/lib/security/execution-scope";
import { getToolExecution } from "@/lib/tools/audit-store";
import { governedToolExecutionId } from "@/lib/tools/execution-id";
import { getToolExecutionScopeBinding } from "@/lib/tools/execution-scope";

const watchReadTools = new Set(["app.watches.list", "app.watches.show"]);

/**
 * A background child is not a signed-in human session. Admit only these saved
 * watch reads through its current, persisted delegation and governed call.
 * Returning an owner does not create a session, mutation grant, or new child.
 */
export async function resolveDelegatedWatchReadOwner(
  caller: AppServiceCaller,
  toolId: "app.watches.list" | "app.watches.show",
) {
  const { context, executionScope: scope, idempotencyKey } = caller;
  requireBound(watchReadTools.has(toolId) && context.source === "default" &&
    context.role === "operator" && /^actor:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(context.actorId) &&
    scope && scope.tenantId === context.tenantId && scope.initiatingActorId === context.actorId &&
    scope.executingPrincipalType === "agent" && scope.executingPrincipalId &&
    scope.delegationId && scope.causationId && scope.purpose === "agent.tool.execute" && idempotencyKey);
  const owner = { tenantId: context.tenantId, actorId: context.actorId };
  return runWithDatabaseActorScope(owner.tenantId, [owner.actorId], async () => {
    const rows = await getSql()`
      SELECT execution_id FROM omni_delegation_executions
      WHERE tenant_id = ${owner.tenantId} AND owner_actor_id = ${owner.actorId}
        AND delegation_id = ${scope.delegationId}
      LIMIT 2
    `;
    requireBound(rows.length === 1 && typeof rows[0].execution_id === "string");
    const execution = await getDelegationExecution({
      tenantId: owner.tenantId, ownerActorId: owner.actorId, executionId: rows[0].execution_id,
    });
    const contract = execution.contract;
    const childScope = executionScopeFromDelegationContract(contract);
    // The direct OpenAI loop uses run:call; the provider-neutral loop includes
    // its contracted provider. Both cross the executor as the hashed call ID.
    const governedCallIds = [
      `${execution.childRunId}:${scope.causationId}`,
      `${execution.childRunId}:${contract.runtimeAssignment.providerId}:${scope.causationId}`,
    ].map(key => governedToolExecutionId(owner.tenantId, key));
    requireBound(execution.state === "running" && Date.parse(execution.completeBy) > Date.now() &&
      execution.childRunId === execution.executionId && execution.delegationId === scope.delegationId &&
      execution.rootExecutionId === scope.correlationId && execution.parentExecutionId === execution.rootExecutionId &&
      contract.grants.governedToolIds.includes(toolId) &&
      executionScopesEqual(scope, deriveExecutionScope(childScope, {
        causationId: scope.causationId, purpose: "agent.tool.execute",
      })) &&
      governedCallIds.includes(idempotencyKey));

    const [run, runScope, childPin, tool, toolBinding] = await Promise.all([
      getAgentRun(execution.childRunId, { tenantId: owner.tenantId }),
      getAgentRunExecutionScope(execution.childRunId, { tenantId: owner.tenantId }),
      getAgentRunIdentityPin(execution.childRunId, { tenantId: owner.tenantId }),
      getToolExecution(idempotencyKey, { tenantId: owner.tenantId }),
      getToolExecutionScopeBinding(idempotencyKey, { tenantId: owner.tenantId }),
    ]);
    requireBound(run && run.status === "running" && run.tenantId === owner.tenantId &&
      run.ownerActorId === owner.actorId && run.agentId === execution.delegateAgentId &&
      runScope && executionScopesEqual(runScope, childScope) && childPin &&
      childPin.runId === run.id && childPin.tenantId === owner.tenantId && childPin.actorId === owner.actorId &&
      childPin.logicalAgentId === run.agentId && childPin.principalId === scope.executingPrincipalId &&
      childPin.pinSha256 === contract.delegateIdentity.identityPinSha256 &&
      tool && tool.id === idempotencyKey && tool.tenantId === owner.tenantId && tool.actorId === owner.actorId &&
      tool.toolId === toolId && tool.status === "executing" && !tool.dryRun &&
      toolBinding && toolBinding.toolId === toolId && toolBinding.requesterRole === context.role &&
      executionScopesEqual(toolBinding.executionScope, scope));

    // Only the immutable return binding may add the original legacy owner to
    // these parent reads. It is never used to expand the watch's owner scope.
    const parentOwner = contract.conversationDelivery?.parentOwnerActorId || owner.actorId;
    requireBound(contract.lineage.parentOwnerActorIdSha256
      ? createHash("sha256").update(parentOwner).digest("hex") === contract.lineage.parentOwnerActorIdSha256
      : parentOwner === owner.actorId);
    const [parent, parentScope, parentPin, parentEvents] = await runWithDatabaseActorScope(
      owner.tenantId, [...new Set([owner.actorId, parentOwner])], () => Promise.all([
        getAgentRun(execution.parentExecutionId, { tenantId: owner.tenantId }),
        getAgentRunExecutionScope(execution.parentExecutionId, { tenantId: owner.tenantId }),
        getAgentRunIdentityPin(execution.parentExecutionId, { tenantId: owner.tenantId }),
        listStreamEvents(`run:${execution.parentExecutionId}`, {
          tenantId: owner.tenantId, actorId: parentOwner, limit: 200, order: "asc",
        }),
      ]),
    );
    requireBound(parent && ["running", "resuming", "completed"].includes(parent.status) &&
      parent.id === execution.parentExecutionId && parent.tenantId === owner.tenantId && parent.ownerActorId === parentOwner &&
      parentScope && parentScope.tenantId === owner.tenantId && parentScope.initiatingActorId === parentOwner &&
      parentScope.correlationId === parent.id && parentScope.executingPrincipalType === "agent" &&
      parentScope.delegationId === null && parentScope.purpose === "agent.run" && parentPin &&
      parentPin.runId === parent.id && parentPin.tenantId === owner.tenantId && parentPin.actorId === owner.actorId &&
      parentPin.logicalAgentId === parent.agentId && parentPin.principalId === parentScope.executingPrincipalId &&
      parentPin.pinSha256 === contract.delegatorIdentity.identityPinSha256);
    const grants = await revalidateDelegationGrantsV1({
      contract, parentIdentityPin: parentPin, delegateIdentityPin: childPin, parentEvents,
    });
    requireBound(grants.governedToolIds.includes(toolId));

    // Grant resolution may await current capability records. Fence cancellation
    // and expiry again before the service opens saved watch state. The watch
    // store independently rechecks the current account, membership, and RLS.
    const [current, currentRun, currentParent] = await runWithDatabaseActorScope(
      owner.tenantId, [...new Set([owner.actorId, parentOwner])], () => Promise.all([
        getDelegationExecution({ tenantId: owner.tenantId, ownerActorId: owner.actorId, executionId: execution.executionId }),
        getAgentRun(execution.childRunId, { tenantId: owner.tenantId }),
        getAgentRun(execution.parentExecutionId, { tenantId: owner.tenantId }),
      ]),
    );
    requireBound(current.state === "running" && current.lifecycleRevision === execution.lifecycleRevision &&
      current.contractSha256 === execution.contractSha256 && Date.parse(current.completeBy) > Date.now() &&
      currentRun?.status === "running" && currentParent && ["running", "resuming", "completed"].includes(currentParent.status));
    return owner;
  });
}

function requireBound(value: unknown): asserts value {
  if (!value) throw new Error("This saved-watch read is outside the active delegated authority.");
}
