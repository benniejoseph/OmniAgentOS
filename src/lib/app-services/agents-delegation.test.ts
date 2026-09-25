import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelAgentTaskService,
  delegationExecutionDetailProjection,
  delegateAgentTaskService,
  listAgentTasksService,
  showAgentTaskService,
} from "@/lib/app-services/agents";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  buildDelegationExecutionRecordV1,
  transitionDelegationExecutionRecordV1,
  type DelegationExecutionRecordV1,
} from "@/lib/delegation/execution-record";
import type {
  cancelDelegationExecution,
  getDelegationExecution,
  listDelegationExecutions,
} from "@/lib/delegation/execution-store";
import type {
  getLatestDelegationGrantValidation,
} from "@/lib/delegation/grant-validation-events";
import type { delegateAgentTask } from "@/lib/delegation/runtime";
import { buildExecutionContract } from "@/lib/delegation/test-fixtures";
import { createExecutionScope } from "@/lib/security/execution-scope";

const context = {
  tenantId: "tenant-one",
  actorId: "actor-one",
  role: "operator" as const,
  source: "service" as const,
};

const parentExecutionScope = createExecutionScope({
  tenantId: context.tenantId,
  initiatingActorId: context.actorId,
  executingPrincipalType: "agent",
  executingPrincipalId: "principal:atlas:1",
  correlationId: "run-root",
  purpose: "agent.run",
});

function taskRecord() {
  return buildDelegationExecutionRecordV1({
    contract: buildExecutionContract({
      objective: "Research the current state and cite governed evidence.",
    }),
    budgetLedgerRevision: 1,
  });
}

function dependencies(record = taskRecord()) {
  const canceled = transitionDelegationExecutionRecordV1({
    record,
    transition: { to: "canceled", reason: "request:test:idempotency:test" },
    at: "2026-09-22T12:00:30.000Z",
  }).record;
  return {
    delegateTask: vi.fn(async () => record) as typeof delegateAgentTask,
    cancelExecution: vi.fn(async () => ({
      execution: canceled,
      canceledChildRun: true,
      canceledDeliveryCount: 1,
      idempotent: false,
    })) as typeof cancelDelegationExecution,
    getExecution: vi.fn(async () => record) as typeof getDelegationExecution,
    getGrantValidation: vi.fn(async () => ({
      status: "current" as const,
      category: "all_grants" as const,
      validatedAt: "2026-09-22T12:00:15.000Z",
    })) as typeof getLatestDelegationGrantValidation,
    listExecutions: vi.fn(async () => [record]) as typeof listDelegationExecutions,
  };
}

describe("governed Agent delegation application services", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates through the exact parent scope and returns only the public task projection", async () => {
    const deps = dependencies();
    const caller = createAppServiceCaller({
      context,
      executionScope: parentExecutionScope,
      idempotencyKey: "delegate:research:one",
    });
    const result = await delegateAgentTaskService(caller, {
      objective: "Research the current state and cite governed evidence.",
      taskKind: "research",
      acceptanceCriteria: ["Every conclusion cites governed evidence."],
      mode: "fork",
      preferredAgentId: "scout",
    }, deps);

    expect(deps.delegateTask).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      parentExecutionScope,
      idempotencyKey: "delegate:research:one",
      input: {
        objective: "Research the current state and cite governed evidence.",
        taskKind: "research",
        acceptanceCriteria: ["Every conclusion cites governed evidence."],
        mode: "fork",
        preferredAgentId: "scout",
        grants: {
          governedReadToolIds: [],
          skillIds: [],
          plugins: [],
          mcpServers: [],
        },
      },
    });
    expect(result.receipt).toMatchObject({
      operation: "app.agents.delegate",
      action: "run.agent",
      resourceType: "delegation_execution",
      resourceCount: 1,
    });
    expect(result.data.task).toMatchObject({
      executionId: "run-child",
      parentExecutionId: "run-root",
      state: "queued",
      delegateAgentId: "scout",
      objective: "Research the current state and cite governed evidence.",
      runtime: {
        providerId: "configured-provider",
        modelId: "configured-research-model",
      },
    });
    const projectedKeys = allObjectKeys(result.data.task);
    for (const privateKey of [
      "contract",
      "contextCapsule",
      "grants",
      "delegatePrincipalId",
      "identityPinSha256",
      "runtimeAssignment",
    ]) {
      expect(projectedKeys, privateKey).not.toContain(privateKey);
    }
  });

  it("requires governed mutation authority before calling the runtime", async () => {
    const deps = dependencies();
    const caller = createAppServiceCaller({ context });

    await expect(delegateAgentTaskService(caller, {
      objective: "Research the current state.",
      taskKind: "research",
      acceptanceCriteria: ["Return a source-backed summary."],
      mode: "isolated",
    }, deps)).rejects.toThrow("exact execution scope");
    expect(deps.delegateTask).not.toHaveBeenCalled();
  });

  it("projects only the safe persona label and digest", async () => {
    const guidance = "Write like a skeptical investigator and call out uncertainty.";
    const record = buildDelegationExecutionRecordV1({
      contract: buildExecutionContract({
        personaBrief: {
          label: "Skeptical investigator",
          guidance,
          promptSha256: "7".repeat(64),
        },
      }),
      budgetLedgerRevision: 1,
    });
    const deps = dependencies(record);
    const caller = createAppServiceCaller({
      context,
      executionScope: parentExecutionScope,
      idempotencyKey: "delegate:persona:one",
    });

    const result = await delegateAgentTaskService(caller, {
      objective: "Research the current state and cite governed evidence.",
      taskKind: "research",
      acceptanceCriteria: ["Every conclusion cites governed evidence."],
      personaBrief: {
        label: "Skeptical investigator",
        guidance,
      },
    }, deps);

    expect(result.data.task.personaBrief).toEqual({
      label: "Skeptical investigator",
      briefSha256: record.contract.personaBrief?.briefSha256,
    });
    expect(JSON.stringify(result.data.task)).not.toContain(guidance);
    expect(allObjectKeys(result.data.task)).not.toContain("guidance");
    expect(allObjectKeys(result.data.task)).not.toContain("promptSha256");
  });

  it("lists and shows exact actor-owned tasks through execution-store boundaries", async () => {
    const deps = dependencies();
    const caller = createAppServiceCaller({ context });

    const listed = await listAgentTasksService(caller, {
      parentExecutionId: "run-root",
      limit: 12,
    }, deps);
    const shown = await showAgentTaskService(caller, {
      executionId: "run-child",
    }, deps);

    expect(deps.listExecutions).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      parentExecutionId: "run-root",
      limit: 12,
    });
    expect(deps.getExecution).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      executionId: "run-child",
    });
    expect(deps.getGrantValidation).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      executionId: "run-child",
      delegationId: "delegation:execution:one",
      contractSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(listed.data.tasks).toHaveLength(1);
    expect(listed.receipt).toMatchObject({
      operation: "app.agents.tasks.list",
      resourceCount: 1,
    });
    expect(shown.data.task.executionId).toBe("run-child");
    expect(shown.data.task).toMatchObject({
      authority: {
        immutable: true,
        validation: {
          status: "current",
          category: "all_grants",
          validatedAt: "2026-09-22T12:00:15.000Z",
        },
      },
      controls: {
        grantsImmutable: true,
        allowedActions: ["cancel"],
        cancelHref: "/api/agents/tasks/run-child/cancel",
      },
    });
    expect(shown.receipt).toMatchObject({
      operation: "app.agents.tasks.show",
      resourceCount: 1,
    });
    expect(JSON.stringify(shown.data.task)).not.toMatch(
      /contextCapsule|delegatePrincipalId|runtimeAssignment|guidance|credential/i,
    );
  });

  it("projects exact immutable Skill, Plugin, MCP, and native-read pins without private payloads", () => {
    const record = taskRecord();
    const withGrants = {
      ...record,
      contract: {
        ...record.contract,
        grants: {
          grantRequestSha256: "1".repeat(64),
          contextGrantIds: [],
          capabilityGrantIds: ["capability:skill", "capability:plugin", "capability:mcp"],
          governedToolIds: ["knowledge.search", "mcp:server-one:lookup"],
          connectorTargets: ["connector-one"],
          skills: [{
            capabilityGrantId: "capability:skill",
            skillId: "skill-one",
            skillVersion: 3,
            skillVersionId: "skill-version-one",
            skillSha256: "2".repeat(64),
            privatePrompt: "never project this",
          }],
          plugins: [{
            capabilityGrantId: "capability:plugin",
            installationId: "installation-one",
            installationRevision: 4,
            installationSha256: "3".repeat(64),
            pluginId: "plugin-one",
            pluginVersion: "1.2.3",
            manifestSha256: "4".repeat(64),
            componentIds: ["skill:research"],
            manifest: { instructions: "never project this" },
          }],
          mcpServers: [{
            capabilityGrantId: "capability:mcp",
            serverId: "connector-one",
            serverVersionId: "mcp-server-version-one",
            serverContractSha256: "5".repeat(64),
            governedToolIds: ["mcp:server-one:lookup"],
            connectorTargetIds: ["connector-one"],
            credential: "never project this",
          }],
        },
      },
    } as unknown as DelegationExecutionRecordV1;

    const projected = delegationExecutionDetailProjection(withGrants, {
      status: "changed",
      category: "capability_binding",
      validatedAt: "2026-09-22T12:04:00.000Z",
    });

    expect(projected.authority).toMatchObject({
      immutable: true,
      nativeReadTools: [{ toolId: "knowledge.search", managementHref: "/app/automation" }],
      skills: [{
        capabilityGrantId: "capability:skill",
        skillId: "skill-one",
        skillVersion: 3,
        skillSha256: "2".repeat(64),
      }],
      plugins: [{
        installationId: "installation-one",
        installationRevision: 4,
        manifestSha256: "4".repeat(64),
      }],
      mcpServers: [{
        serverId: "connector-one",
        serverContractSha256: "5".repeat(64),
        governedToolIds: ["mcp:server-one:lookup"],
      }],
      validation: { status: "changed", category: "capability_binding" },
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /never project this|privatePrompt|credential|"manifest":/i,
    );
  });

  it("cancels through exact actor authority without projecting private contracts", async () => {
    const deps = dependencies();
    const executionScope = createExecutionScope({
      tenantId: context.tenantId,
      initiatingActorId: context.actorId,
      executingPrincipalType: "user",
      executingPrincipalId: context.actorId,
      correlationId: "cancel-request-one",
      causationId: "run-child",
      purpose: "delegation.execution.cancel",
    });
    const caller = createAppServiceCaller({
      context,
      executionScope,
      idempotencyKey: "cancel:delegation:one",
    });

    const result = await cancelAgentTaskService(caller, {
      executionId: "run-child",
      expectedRevision: 0,
      reason: "Stop this research task.",
    }, deps);

    expect(deps.cancelExecution).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      executionId: "run-child",
      expectedRevision: 0,
      requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      idempotencyKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      executionScope,
    }));
    expect(result.receipt).toMatchObject({
      operation: "app.agents.tasks.cancel",
      action: "run.agent",
      resourceType: "delegation_execution",
    });
    expect(result.data).toMatchObject({
      canceledChildRun: true,
      canceledDeliveryCount: 1,
      idempotent: false,
      task: { executionId: "run-child", state: "canceled", canCancel: false },
    });
    expect(JSON.stringify(result.data)).not.toMatch(
      /contextCapsule|delegatePrincipalId|runtimeAssignment|capabilityGrant/i,
    );
  });

  it("requires governed cancellation authority before touching the store", async () => {
    const deps = dependencies();
    await expect(cancelAgentTaskService(createAppServiceCaller({ context }), {
      executionId: "run-child",
      expectedRevision: 0,
    }, deps)).rejects.toThrow("exact execution scope");
    expect(deps.cancelExecution).not.toHaveBeenCalled();
  });
});

function allObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allObjectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...allObjectKeys(nested)]);
}
