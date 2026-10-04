import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestAccess: vi.fn(),
  getAccount: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveStart: vi.fn(),
  saveOutcome: vi.fn(),
  replayOutcome: vi.fn(),
  createProject: vi.fn(),
  createTasks: vi.fn(),
  showProject: vi.fn(),
  nativeStart: vi.fn(), nativeOutcome: vi.fn(), nativeRun: vi.fn(), nativeAcceptance: vi.fn(),
}));
vi.mock("@/lib/customer-success/workflow-native-store", () => ({
  submitCustomerSuccessWorkflowNativeStart: mocks.nativeStart, submitCustomerSuccessWorkflowNativeOutcome: mocks.nativeOutcome,
  getCustomerSuccessWorkflowNativeRun: mocks.nativeRun, readCustomerSuccessWorkflowNativeAcceptance: mocks.nativeAcceptance,
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
  findCustomerSuccessWorkflowOutcomeReplay: mocks.replayOutcome,
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
  startCustomerSuccessWorkflowNativeService, recordCustomerSuccessWorkflowNativeOutcomeService,
  showCustomerSuccessWorkflowNativeService, readCustomerSuccessWorkflowNativeAcceptanceService,
} from "@/lib/app-services/customer-success-workflows";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  buildCustomerSuccessOutcomeReceipt,
  buildCustomerSuccessWorkflowRunRevision,
  customerSuccessRunId,
  getCustomerSuccessWorkflowDefinition,
  CUSTOMER_SUCCESS_WORKFLOW_IDS,
} from "@/lib/customer-success/workflow-contracts";
import { workflowAccess, workflowActorId, workflowCaller, workflowFixture } from "@/lib/customer-success/workflow-mutation.test-fixtures";
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
  mocks.nativeStart.mockReset(); mocks.nativeOutcome.mockReset(); mocks.nativeRun.mockReset(); mocks.nativeAcceptance.mockReset();
  mocks.requestAccess.mockReset().mockResolvedValue(access());
  mocks.getAccount.mockReset().mockResolvedValue({ account: account() });
  mocks.listRuns.mockReset().mockResolvedValue([]);
  mocks.getRun.mockReset().mockResolvedValue(undefined);
  mocks.saveStart.mockReset().mockImplementation(async ({ run }) => run);
  mocks.replayOutcome.mockReset().mockResolvedValue(null);
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

describe("native workflow app-service boundary", () => {
  it.each(CUSTOMER_SUCCESS_WORKFLOW_IDS)("uses the atomic native store for %s without partial setup calls", async (workflowId) => {
    const fixture = workflowFixture(workflowId);
    mocks.requestAccess.mockResolvedValue(workflowAccess()); mocks.nativeStart.mockResolvedValue(fixture.committed);
    const result = await startCustomerSuccessWorkflowNativeService(workflowCaller("start"), { accountId: fixture.accountId, ...fixture.start });
    expect(result.data.acceptance).toEqual(fixture.acceptance);
    expect(mocks.nativeStart.mock.calls[0][0].authority).toMatchObject({ canonicalActorId: workflowActorId, readableActorIds: [workflowActorId],
      executionScope: { purpose: "customer.success.workflow.start", causationId: fixture.accountId, executingPrincipalId: workflowActorId } });
    expect(mocks.createProject).not.toHaveBeenCalled(); expect(mocks.createTasks).not.toHaveBeenCalled(); expect(mocks.saveStart).not.toHaveBeenCalled();
    expect(mocks.showProject).not.toHaveBeenCalled();
  });
  it("returns stable outcome acceptance without a later artifact or definition read", async () => {
    const fixture = workflowFixture("risk_escalation", "outcome");
    mocks.requestAccess.mockResolvedValue(workflowAccess()); mocks.nativeOutcome.mockResolvedValue({ ...fixture.committed, replayed: true,
      currentAccount: { ...fixture.currentAccount, revision: 5, revisionId: `${fixture.accountId}:v5`, accountSha256: "e".repeat(64) } });
    const result = await recordCustomerSuccessWorkflowNativeOutcomeService(workflowCaller("outcome"), { accountId: fixture.accountId, ...fixture.outcome });
    expect(result.data.replayed).toBe(true); expect(result.data.acceptance.runAccountRevision).toBe(3);
    expect(result.data.acceptance.reviewedAccountRevision).toBe(4); expect(result.data.currentAccount.revision).toBe(5);
    expect(mocks.getRun).not.toHaveBeenCalled(); expect(mocks.showProject).not.toHaveBeenCalled(); expect(mocks.saveOutcome).not.toHaveBeenCalled();
  });
  it("returns a nullable exact receipt with reader authority and never reads a project", async () => {
    const fixture = workflowFixture(); mocks.requestAccess.mockResolvedValue(workflowAccess(false));
    mocks.nativeAcceptance.mockResolvedValue({ currentAccount: fixture.currentAccount, acceptance: null });
    const caller = workflowCaller();
    const result = await readCustomerSuccessWorkflowNativeAcceptanceService({ ...caller, context: { ...caller.context, role: "viewer" } }, {
      workspaceId: fixture.workspaceId, accountId: fixture.accountId, runId: fixture.run.runId, keySha256: fixture.intent.idempotencyKeySha256,
    });
    expect(result.data.acceptance).toBeNull(); expect(result.receipt.resourceCount).toBe(0);
    expect(mocks.nativeAcceptance.mock.calls[0][0].readableActorIds).toEqual([workflowActorId]);
    expect(mocks.showProject).not.toHaveBeenCalled();
  });
  it("keeps current run available when optional project progress fails", async () => {
    const fixture = workflowFixture(); mocks.requestAccess.mockResolvedValue(workflowAccess(false));
    mocks.nativeRun.mockResolvedValue({ currentAccount: fixture.currentAccount, run: fixture.run }); mocks.showProject.mockRejectedValue(new Error("unavailable"));
    const result = await showCustomerSuccessWorkflowNativeService(workflowCaller(), { workspaceId: fixture.workspaceId, accountId: fixture.accountId, runId: fixture.run.runId });
    expect(result.data.run).toEqual(fixture.run); expect(result.data.projectProgress).toEqual({ state: "unavailable" });
    expect(mocks.nativeStart).not.toHaveBeenCalled(); expect(mocks.nativeOutcome).not.toHaveBeenCalled();
  });
  it("rejects silent redaction and nonhuman or mismatched request authority before submission", async () => {
    const fixture = workflowFixture(); mocks.requestAccess.mockResolvedValue(workflowAccess());
    await expect(startCustomerSuccessWorkflowNativeService(workflowCaller("start"), { accountId: fixture.accountId,
      ...fixture.start, input: { ...fixture.start.input, objective: `Bearer ${"a".repeat(32)}` } })).rejects.toThrow("sensitive material");
    for (const override of [{ executingPrincipalType: "agent" }, { executingPrincipalId: "other" }, { workspaceId: "workspace:other" },
      { delegationId: "delegation:other" }, { contextGrantIds: ["grant:other"] }, { capabilityGrantIds: ["grant:other"] },
      { causationId: "another-account" }, { purpose: "project.execute" }]) {
      const caller = workflowCaller("start");
      await expect(startCustomerSuccessWorkflowNativeService({ ...caller, executionScope: { ...caller.executionScope!, ...override } } as typeof caller,
        { accountId: fixture.accountId, ...fixture.start })).rejects.toThrow();
    }
    expect(mocks.nativeStart).not.toHaveBeenCalled();
  });
  it("rejects an inconsistent post-commit receipt without inventing a refusal", async () => {
    const fixture = workflowFixture(); mocks.requestAccess.mockResolvedValue(workflowAccess());
    mocks.nativeStart.mockResolvedValue({ ...fixture.committed, currentAccount: { ...fixture.currentAccount, accountSha256: "f".repeat(64) } });
    await expect(startCustomerSuccessWorkflowNativeService(workflowCaller("start"), { accountId: fixture.accountId, ...fixture.start })).rejects.not.toHaveProperty("admission");
  });
});

describe("customer-success workflow app services", () => {
  it("returns the original accepted legacy outcome before fresh artifact checks or another timestamp", async () => {
    const { schemaVersion, contractVersion, runRevisionId, previousRunRevisionId, inputSha256, runSha256, ...body } = workflowRun();
    void [schemaVersion, contractVersion, runRevisionId, previousRunRevisionId, inputSha256, runSha256];
    const semantics = { status: "blocked" as const, summary: "Waiting for customer confirmation.",
      artifactReceipts: [{ artifactKey: "risk_brief", projectArtifactId: "artifact-no-longer-listed", evidenceKeys: ["risk_signal"], evidenceRefs: ["fact:risk:v1"] }],
      nextAction: "Confirm the customer decision." };
    const accepted = buildCustomerSuccessWorkflowRunRevision({ ...body, revision: 2,
      outcome: buildCustomerSuccessOutcomeReceipt({ ...semantics, recordedByActorId: canonicalActorId, recordedAt: "2026-09-07T01:00:00.000Z" }) });
    mocks.replayOutcome.mockResolvedValue(accepted);
    mocks.showProject.mockResolvedValue({ data: { project: { id: accepted.projectId, tasks: [], artifacts: [] } } });
    const result = await recordCustomerSuccessWorkflowOutcomeService(caller("accepted-outcome"), {
      accountId, runId: accepted.runId, expectedRevision: 1, ...semantics,
    });
    expect(result.data.run).toBe(accepted);
    expect(result.data.run.outcome.recordedAt).toBe("2026-09-07T01:00:00.000Z");
    expect(result.data.project).not.toBeNull(); expect(result.data.definition).not.toBeNull();
    expect(mocks.replayOutcome).toHaveBeenCalledWith(expect.objectContaining({ accountId, runId: accepted.runId, expectedRevision: 1, ...semantics }));
    expect(mocks.getRun).not.toHaveBeenCalled(); expect(mocks.saveOutcome).not.toHaveBeenCalled();
  });
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
