import { describe, expect, it } from "vitest";

import { buildAgentCouncilMap } from "@/lib/agents/council-map";
import { buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { buildSharedMissionArtifactV1 } from "@/lib/delegation/channel";
import { buildDelegationAuthorityReceiptV1 } from "@/lib/delegation/authority-receipt";
import { buildCouncilMemberDelegationContractV1 } from "@/lib/delegation/council-adapter";
import {
  buildDelegationTaskV1,
  transitionDelegationTaskV1,
} from "@/lib/delegation/lifecycle";
import {
  buildDelegationExecutionRecordV1,
  transitionDelegationExecutionRecordV1,
} from "@/lib/delegation/execution-record";
import { buildExecutionContract } from "@/lib/delegation/test-fixtures";
import { DEFAULT_AGENT_RUN_BUDGET_LIMITS } from "@/lib/runs/budgets";
import { createExecutionScope, deriveExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

describe("P11.5 Agent Council map", () => {
  it("projects identity, exact grants, output, cost, confidence, and verifier", () => {
    const contract = contractFixture();
    const proposed = buildDelegationTaskV1(contract);
    const accepted = transitionDelegationTaskV1({
      task: proposed,
      transition: { to: "accepted" },
      at: "2026-09-07T06:00:00.001Z",
    }).task;
    const task = transitionDelegationTaskV1({
      task: accepted,
      transition: { to: "working" },
      at: "2026-09-07T06:00:00.002Z",
    }).task;
    const authority = buildDelegationAuthorityReceiptV1(contract, proposed);
    const delegateScope = deriveExecutionScope(contractFixtureScope(contract), {
      executingPrincipalType: "agent",
      executingPrincipalId: task.delegatePrincipalId,
      delegationId: task.delegationId,
      contextGrantIds: authority.grants.contextGrantIds,
      capabilityGrantIds: authority.grants.capabilityGrantIds,
      purpose: "delegation.task.proposed.v1",
    });
    const scout = buildBuiltInAgentIdentityV1({
      agentId: "scout",
      tenantId: task.tenantId,
      controllerActorId: task.ownerActorId,
    });
    const sentinel = buildBuiltInAgentIdentityV1({
      agentId: "sentinel",
      tenantId: task.tenantId,
      controllerActorId: task.ownerActorId,
    });
    const artifact = buildSharedMissionArtifactV1({
      task,
      missionId: "mission-one",
      recipients: { parent: true, delegationTaskIds: [] },
      kind: "analysis",
      title: "Evidence review",
      mediaType: "text/plain",
      content: "The release evidence is internally consistent.",
      createdAt: "2026-09-07T06:00:00.003Z",
    });

    const map = buildAgentCouncilMap({
      generatedAt: "2026-09-07T06:01:00.000Z",
      source: {
        state: "available",
        tasks: [task],
        runs: [{
          id: "run-one", ownerActorId: "actor-one", status: "running",
          prompt: "Verify the release evidence.", startedAt: "2026-09-07T06:00:00.000Z",
        }],
        authorityEvents: [{
          id: "event-one", seq: 1, streamId: `delegation:${task.delegationId}`,
          type: "delegation.task.proposed", tenantId: task.tenantId,
          actorId: task.ownerActorId, at: task.createdAt, executionScope: delegateScope,
          payload: {
            taskId: task.taskId,
            delegationId: task.delegationId,
            detailSha256: task.contractSha256,
            authority,
          },
        }],
        identities: [
          { ownerActorId: task.ownerActorId, definition: scout.definition },
          { ownerActorId: task.ownerActorId, definition: sentinel.definition },
        ],
        memberEvents: [{
          id: "member-one", runId: "run-one", taskId: task.taskId,
          agentId: "scout", status: "completed", summary: "Evidence verified.",
          confidence: 0.91, createdAt: "2026-09-07T06:00:00.004Z",
        }],
        channels: [{
          ownerActorId: task.ownerActorId, missionId: "mission-one",
          state: "available", records: [{ type: "artifact", value: artifact }],
        }],
        memberUsage: [{
          key: task.delegationId, receiptCount: 1, unknownCostReceiptCount: 0,
          totalTokens: 420, knownEstimatedCostMicrousd: 1_250,
        }],
        verifierUsage: [{
          key: "run-one", receiptCount: 1, unknownCostReceiptCount: 0,
          totalTokens: 120, knownEstimatedCostMicrousd: 400,
        }],
      },
    });

    expect(map.summary).toMatchObject({ executionCount: 1, memberCount: 1, activeMemberCount: 1 });
    expect(map.executions[0].verifierCost).toMatchObject({ state: "exact", knownEstimatedCostMicrousd: 400 });
    expect(map.executions[0].members[0]).toMatchObject({
      identity: { name: "Scout", definitionVersion: 1, source: "agent_definition" },
      authority: {
        source: "delegation_grants",
        context: { state: "granted", grantCount: 1 },
        capabilities: { state: "none", grantCount: 0 },
        scope: { projectId: "project-one", missionId: "mission-one" },
      },
      outputs: { state: "shared" },
      cost: { state: "exact", totalTokens: 420, knownEstimatedCostMicrousd: 1_250 },
      confidence: 0.91,
      verifier: { identity: { name: "Sentinel" }, verdict: "pending" },
    });
    expect(map.executions[0].members[0].outputs.items).toHaveLength(2);
  });

  it("does not infer historical authority when no immutable receipt exists", () => {
    const contract = contractFixture();
    const task = buildDelegationTaskV1(contract);
    const map = buildAgentCouncilMap({
      source: {
        state: "available", tasks: [task], runs: [], authorityEvents: [], identities: [],
        memberEvents: [], channels: [], memberUsage: [], verifierUsage: [],
      },
    });
    expect(map.executions[0].status).toBe("unavailable");
    expect(map.executions[0].members[0].authority).toMatchObject({
      source: "historical_unavailable",
      context: { state: "unavailable" },
      tools: { state: "unavailable" },
    });
  });

  it("projects execution-contract v2 children into the same live-work map", () => {
    let record = buildDelegationExecutionRecordV1({
      contract: buildExecutionContract(),
      budgetLedgerRevision: 1,
    });
    record = transitionDelegationExecutionRecordV1({
      record,
      transition: { to: "running" },
      at: "2026-09-22T12:00:30.000Z",
    }).record;
    record = transitionDelegationExecutionRecordV1({
      record,
      transition: {
        to: "completed_proposed",
        result: {
          status: "completed",
          summary: "The bounded evidence review is ready.",
          artifacts: [{
            artifactId: "artifact:v2:one",
            artifactSha256: "f".repeat(64),
            kind: "result",
            mediaType: "text/plain",
            byteCount: 39,
            evidenceIds: ["evidence:v2:one"],
          }],
          acceptanceChecks: [{
            criterionId: "criterion:execution:one",
            passed: true,
            evidenceIds: ["evidence:v2:one"],
            note: "Evidence is attached.",
          }],
          evidenceIds: ["evidence:v2:one"],
          toolExecutionIds: [],
          modelReceiptSha256s: ["1".repeat(64)],
          usageReceiptSha256s: [],
        },
      },
      at: "2026-09-22T12:02:00.000Z",
    }).record;
    record = transitionDelegationExecutionRecordV1({
      record,
      transition: {
        to: "verified",
        verification: {
          verifierAgentId: record.contract.verifier.identity.logicalAgentId,
          verifierDefinitionVersion:
            record.contract.verifier.identity.definitionVersion,
          verifierPrincipalId: record.contract.verifier.identity.principalId,
          verifierRuntimeAssignmentId:
            record.contract.verifier.runtimeAssignment.assignmentId,
          verifierRuntimeAssignmentSha256:
            record.contract.verifier.runtimeAssignment.assignmentSha256,
          verifierProviderId:
            record.contract.verifier.runtimeAssignment.providerId,
          verifierModelId: record.contract.verifier.runtimeAssignment.modelId,
          verifierModelTier:
            record.contract.verifier.runtimeAssignment.modelTier,
          verifierModelReceiptSha256: "2".repeat(64),
          score: 0.92,
          acceptanceChecksSha256: canonicalJsonSha256(
            record.result!.acceptanceChecks,
          ),
          evidenceIds: ["evidence:v2:one"],
          note: "Sentinel accepted the result.",
        },
      },
      at: "2026-09-22T12:03:00.000Z",
    }).record;
    const scout = buildBuiltInAgentIdentityV1({
      agentId: "scout",
      tenantId: record.tenantId,
      controllerActorId: record.ownerActorId,
    });
    const sentinel = buildBuiltInAgentIdentityV1({
      agentId: "sentinel",
      tenantId: record.tenantId,
      controllerActorId: record.ownerActorId,
    });

    const map = buildAgentCouncilMap({
      generatedAt: "2026-09-22T12:04:00.000Z",
      source: {
        state: "available",
        tasks: [],
        executionRecords: [record],
        runs: [{
          id: record.parentExecutionId,
          ownerActorId: record.ownerActorId,
          status: "completed",
          prompt: "Coordinate the evidence review.",
          startedAt: record.createdAt,
          completedAt: record.terminalAt || undefined,
        }],
        authorityEvents: [],
        identities: [
          { ownerActorId: record.ownerActorId, definition: scout.definition },
          { ownerActorId: record.ownerActorId, definition: sentinel.definition },
        ],
        memberEvents: [],
        channels: [],
        memberUsage: [],
        verifierUsage: [],
      },
    });

    expect(map.summary).toMatchObject({
      executionCount: 1,
      memberCount: 1,
      acceptedMemberCount: 1,
    });
    expect(map.executions[0].members[0]).toMatchObject({
      taskId: record.executionId,
      state: "result_accepted",
      canCancel: false,
      currentWork: record.contract.objective,
      identity: { name: "Scout", source: "agent_definition" },
      authority: {
        source: "delegation_grants",
        receiptSha256: record.contractSha256,
        tools: { state: "none", ids: [] },
      },
      outputs: {
        state: "shared",
        proposalReceiptSha256: record.resultSha256,
      },
      confidence: 0.92,
      verifier: {
        identity: { name: "Sentinel" },
        verdict: "accepted",
        score: 0.92,
      },
    });
  });

  it("exposes cancellation only for active V2 child records", () => {
    const record = transitionDelegationExecutionRecordV1({
      record: buildDelegationExecutionRecordV1({
        contract: buildExecutionContract(),
        budgetLedgerRevision: 1,
      }),
      transition: { to: "running" },
      at: "2026-09-22T12:00:30.000Z",
    }).record;
    const map = buildAgentCouncilMap({
      source: {
        state: "available",
        tasks: [],
        executionRecords: [record],
        runs: [],
        authorityEvents: [],
        identities: [],
        memberEvents: [],
        channels: [],
        memberUsage: [],
        verifierUsage: [],
      },
    });

    expect(map.executions[0].members[0]).toMatchObject({
      taskId: record.executionId,
      state: "working",
      canCancel: true,
      lifecycleRevision: 1,
    });
  });
});

function contractFixtureScope(contract: ReturnType<typeof contractFixture>) {
  const atlas = buildBuiltInAgentIdentityV1({
    agentId: "atlas",
    tenantId: contract.scope.tenantId,
    controllerActorId: contract.scope.initiatingActorId,
  });
  return createExecutionScope({
    tenantId: contract.scope.tenantId,
    initiatingActorId: contract.scope.initiatingActorId,
    executingPrincipalType: "agent",
    executingPrincipalId: atlas.principal.principalId,
    workspaceId: contract.scope.workspaceId || undefined,
    projectId: contract.scope.projectId || undefined,
    missionId: contract.scope.missionId || undefined,
    delegationId: contract.scope.parentDelegationId || undefined,
    correlationId: "run-one",
    contextGrantIds: ["context-one"],
    capabilityGrantIds: ["capability-one"],
    purpose: "agent.run",
  });
}

function contractFixture() {
  const atlas = buildBuiltInAgentIdentityV1({
    agentId: "atlas",
    tenantId: "tenant-one",
    controllerActorId: "actor-one",
  });
  const executionScope = createExecutionScope({
    tenantId: "tenant-one",
    initiatingActorId: "actor-one",
    executingPrincipalType: "agent",
    executingPrincipalId: atlas.principal.principalId,
    projectId: "project-one",
    missionId: "mission-one",
    correlationId: "run-one",
    contextGrantIds: ["context-one"],
    capabilityGrantIds: ["capability-one"],
    purpose: "agent.run",
  });
  return buildCouncilMemberDelegationContractV1({
    authority: {
      parentExecutionId: "run-one",
      executionScope,
      delegator: {
        principalId: atlas.principal.principalId,
        agentId: atlas.definition.logicalAgentId,
        definitionVersion: atlas.definition.definitionVersion,
      },
      parentBudgets: DEFAULT_AGENT_RUN_BUDGET_LIMITS,
      remainingWallTimeMs: 120_000,
      governedToolIds: [],
      connectorTargets: [],
    },
    agentId: "scout",
    goal: "Verify the release evidence.",
    mode: "research",
    contextBlock: "Authorized evidence context.",
    attempt: 1,
    createdAt: "2026-09-07T06:00:00.000Z",
  });
}
