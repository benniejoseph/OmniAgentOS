import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestAccess: vi.fn(),
  getAccount: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveStart: vi.fn(),
  saveOutcome: vi.fn(),
  createProject: vi.fn(),
  createTasks: vi.fn(),
  showProject: vi.fn(),
}));

vi.mock("@/lib/memory/shared-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/shared-context")>()),
  requestSharedMemoryAccessFromSecurityContext: mocks.requestAccess,
}));
vi.mock("@/lib/customer-success/store", () => ({
  getCustomerAccount360: mocks.getAccount,
}));
vi.mock("@/lib/customer-success/workflow-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/customer-success/workflow-store")>()),
  listCustomerSuccessWorkflowRuns: mocks.listRuns,
  getCustomerSuccessWorkflowRun: mocks.getRun,
  saveCustomerSuccessWorkflowStart: mocks.saveStart,
  saveCustomerSuccessWorkflowOutcome: mocks.saveOutcome,
}));
vi.mock("@/lib/projects/store", () => ({
  createProject: mocks.createProject,
  createProjectTasks: mocks.createTasks,
}));
vi.mock("@/lib/app-services/projects", () => ({
  showProjectService: mocks.showProject,
}));

import {
  listCustomerSuccessWorkflowsService,
  recordCustomerSuccessWorkflowOutcomeService,
  startCustomerSuccessWorkflowService,
} from "@/lib/app-services/customer-success-workflows";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  buildCustomerSuccessOutcomeReceipt,
  buildCustomerSuccessWorkflowRunRevision,
  customerSuccessRunId,
  getCustomerSuccessWorkflowDefinition,
} from "@/lib/customer-success/workflow-contracts";
import { projectTaskIdForIdempotencyKey } from "@/lib/projects/events";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const authUserId = "11111111-1111-4111-a111-111111111111";
const canonicalActorId = `actor:${authUserId}`;
const workspaceId = `workspace:personal:${authUserId}`;
const accountId = `customer-account:${"a".repeat(64)}`;
const accountSha256 = "b".repeat(64);
const context = {
  tenantId: "tenant-csm",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId: authUserId,
    email: "owner@example.test",
    sessionId: "session-csm",
    tenantName: "CSM tenant",
  },
} satisfies SecurityContext;

function access(canWrite = true) {
  return {
    actorBinding: {
      canonicalActorId,
      readableOwnerActorIds: [canonicalActorId, context.actorId],
    },
    authority: {
      initiatingActorId: canonicalActorId,
      workspaceId,
      accessLevel: canWrite ? "manager" : "reader",
      canWrite,
      authoritySha256: "c".repeat(64),
    },
  };
}

function caller(idempotencyKey?: string) {
  return createAppServiceCaller({
    context,
    ...(idempotencyKey
      ? {
          idempotencyKey,
          executionScope: createExecutionScope({
            tenantId: context.tenantId,
            initiatingActorId: context.actorId,
            executingPrincipalType: "user",
            executingPrincipalId: context.actorId,
            correlationId: idempotencyKey,
            purpose: "api.customer-success-workflow",
          }),
        }
      : {}),
  });
}

beforeEach(() => {
  mocks.requestAccess.mockReset().mockResolvedValue(access());
  mocks.getAccount.mockReset().mockResolvedValue({ account: account() });
  mocks.listRuns.mockReset().mockResolvedValue([]);
  mocks.getRun.mockReset().mockResolvedValue(undefined);
  mocks.saveStart.mockReset().mockImplementation(async ({ run }) => run);
  mocks.saveOutcome.mockReset().mockImplementation(async ({ outcome, expectedRevision }) => ({
    ...workflowRun(),
    revision: expectedRevision + 1,
    outcome,
  }));
  mocks.createProject.mockReset().mockResolvedValue({ id: "project-one" });
  mocks.createTasks.mockReset().mockImplementation(async (projectId, _tasks, options) => [{
    id: projectTaskIdForIdempotencyKey(
      context.tenantId,
      projectId,
      options.mutation.idempotencyKey,
    ),
  }]);
  mocks.showProject.mockReset().mockResolvedValue({
    data: {
      project: {
        id: "project-one",
        tasks: [],
        artifacts: [
          { id: "artifact-risk", evidenceRefs: ["fact:risk:v1"] },
          { id: "artifact-plan", evidenceRefs: ["fact:risk:v1", "health:risk:v1"] },
        ],
      },
    },
  });
});

describe("customer-success workflow app services", () => {
  it("lists the complete pinned pack and account runs through workspace authority", async () => {
    const result = await listCustomerSuccessWorkflowsService(caller(), {
      accountId,
      limit: 20,
    });
    expect(result.receipt.operation).toBe("app.customer_accounts.workflows.list");
    expect(result.data.pack).toHaveLength(8);
    expect(mocks.listRuns).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      workspaceId,
      canonicalActorId,
      purposeId: "customer_success.account.read",
    }), { accountId, limit: 20 });
  });

  it("starts an exact account-bound workflow as a project with dependency-aware tasks", async () => {
    const result = await startCustomerSuccessWorkflowService(caller("start-risk"), {
      accountId,
      expectedAccountRevision: 3,
      expectedAccountSha256: accountSha256,
      input: riskInput(),
    });
    expect(result.receipt.operation).toBe("app.customer_accounts.workflows.start");
    expect(result.data.run).toMatchObject({
      workflowId: "risk_escalation",
      accountRevision: 3,
      projectId: "project-one",
      outcome: { status: "in_progress" },
    });
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({
      title: "Acme · Risk escalation",
      objective: "Restore confidence.",
      mutation: expect.objectContaining({
        executionScope: expect.objectContaining({
          workspaceId,
          purpose: "customer.success.workflow.project",
        }),
      }),
    }));
    expect(mocks.createTasks).toHaveBeenCalledTimes(3);
    expect(mocks.saveStart).toHaveBeenCalledWith(expect.objectContaining({
      authority: expect.objectContaining({
        canonicalActorId,
        executionScope: expect.objectContaining({
          purpose: "customer.success.workflow.start",
        }),
      }),
    }));
  });

  it("records completion only from artifacts and evidence produced by the workflow project", async () => {
    const current = workflowRun();
    mocks.getRun.mockResolvedValue(current);
    const result = await recordCustomerSuccessWorkflowOutcomeService(caller("close-risk"), {
      accountId,
      runId: current.runId,
      expectedRevision: 1,
      status: "completed",
      summary: "Risk is contained and recovery owners are confirmed.",
      artifactReceipts: [
        {
          artifactKey: "risk_brief",
          projectArtifactId: "artifact-risk",
          evidenceKeys: ["account_snapshot", "risk_signal"],
          evidenceRefs: ["fact:risk:v1"],
        },
        {
          artifactKey: "mitigation_plan",
          projectArtifactId: "artifact-plan",
          evidenceKeys: ["account_snapshot", "risk_signal"],
          evidenceRefs: ["fact:risk:v1", "health:risk:v1"],
        },
      ],
      nextAction: "Monitor recovery at the next checkpoint.",
    });
    expect(result.receipt.operation).toBe("app.customer_accounts.workflows.outcome.record");
    expect(mocks.saveOutcome).toHaveBeenCalledWith(expect.objectContaining({
      runId: current.runId,
      expectedRevision: 1,
      outcome: expect.objectContaining({
        status: "completed",
        artifactReceipts: expect.arrayContaining([
          expect.objectContaining({ projectArtifactId: "artifact-risk" }),
        ]),
      }),
    }));
  });

  it("blocks workflow starts for a workspace reader", async () => {
    mocks.requestAccess.mockResolvedValue(access(false));
    await expect(startCustomerSuccessWorkflowService(caller("denied"), {
      accountId,
      expectedAccountRevision: 3,
      expectedAccountSha256: accountSha256,
      input: riskInput(),
    })).rejects.toThrow(/owner access/);
    expect(mocks.createProject).not.toHaveBeenCalled();
  });
});

function account() {
  return {
    accountId,
    revisionId: `${accountId}:v3`,
    revision: 3,
    accountSha256,
    name: "Acme",
    accountOwner: { ownerKind: "actor" as const, ownerId: canonicalActorId, displayName: "CSM" },
    ownerActorId: canonicalActorId,
  };
}

function riskInput() {
  return {
    workflowId: "risk_escalation" as const,
    objective: "Restore confidence.",
    targetDate: null,
    riskTitle: "Adoption stalled",
    severity: "high" as const,
    signals: ["Active use dropped."],
  };
}

function workflowRun() {
  const definition = getCustomerSuccessWorkflowDefinition("risk_escalation");
  const runId = customerSuccessRunId({
    tenantId: context.tenantId,
    workspaceId,
    accountId,
    idempotencyKey: "start-risk",
  });
  return buildCustomerSuccessWorkflowRunRevision({
    tenantId: context.tenantId,
    workspaceId,
    accountId,
    accountRevisionId: `${accountId}:v3`,
    accountRevision: 3,
    accountSha256,
    runId,
    revision: 1,
    workflowId: "risk_escalation",
    definitionSha256: definition.definitionSha256,
    input: riskInput(),
    owner: account().accountOwner,
    ownerActorId: canonicalActorId,
    projectId: "project-one",
    projectTaskIds: definition.projectTemplate.tasks.map((task, index) => ({
      taskKey: task.key,
      projectTaskId: `project-task:${index + 1}`,
    })),
    allowedPurposeIds: ["customer_success.account.read"],
    outcome: buildCustomerSuccessOutcomeReceipt({
      status: "in_progress",
      summary: "",
      artifactReceipts: [],
      nextAction: definition.defaultNextAction,
      recordedByActorId: canonicalActorId,
      recordedAt: "2026-09-07T00:00:00.000Z",
    }),
  });
}
