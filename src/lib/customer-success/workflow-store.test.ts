import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantId = "tenant-a";
const workspaceId = "workspace:tenant-a";
const actorId = "actor:11111111-1111-4111-a111-111111111111";
const accountId = `customer-account:${"b".repeat(64)}`;
const accountSha256 = "a".repeat(64);
const now = "2026-09-07T12:00:00.000Z";
const mocks = vi.hoisted(() => ({
  responses: [] as Record<string, unknown>[][],
  queries: [] as Array<{ text: string; values: unknown[] }>,
  event: vi.fn(),
}));

vi.mock("@/lib/db/client", () => {
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      mocks.queries.push({ text: strings.join("?"), values });
      return mocks.responses.shift() || [];
    },
    { transaction: async (operation: (client: unknown) => Promise<unknown>) => operation(sql) },
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getSql: () => sql,
    hasDatabaseUrl: () => true,
    runWithDatabaseActorScope: async (
      _tenant: string,
      _actors: readonly string[],
      operation: () => Promise<unknown>,
    ) => operation(),
  };
});
vi.mock("@/lib/events/store", () => ({ appendScopedDomainEvent: mocks.event }));

import {
  buildCustomerSuccessOutcomeReceipt,
  buildCustomerSuccessWorkflowRunRevision,
  customerSuccessRunId,
  getCustomerSuccessWorkflowDefinition,
} from "@/lib/customer-success/workflow-contracts";
import {
  getCustomerSuccessWorkflowRun,
  saveCustomerSuccessWorkflowOutcome,
  saveCustomerSuccessWorkflowStart,
} from "@/lib/customer-success/workflow-store";
import { createExecutionScope } from "@/lib/security/execution-scope";

beforeEach(() => {
  mocks.responses = [];
  mocks.queries = [];
  mocks.event.mockReset().mockResolvedValue({ id: "event" });
});

describe("customer-success workflow store", () => {
  it("persists an exact account-bound run and typed start event", async () => {
    const run = workflowRun();
    mocks.responses.push(
      [],
      [],
      [{
        current_revision: 1,
        current_revision_id: `${accountId}:v1`,
        account_sha256: accountSha256,
        owner_actor_id: actorId,
      }],
      [],
      [],
    );
    const saved = await saveCustomerSuccessWorkflowStart({
      authority: mutationAuthority("start-1", "customer.success.workflow.start"),
      run,
    });
    expect(saved.runSha256).toBe(run.runSha256);
    expect(mocks.queries.some((query) =>
      query.text.includes("INSERT INTO omni_customer_success_workflow_run_revisions")
    )).toBe(true);
    expect(mocks.queries.some((query) =>
      query.text.includes("INSERT INTO omni_customer_success_workflow_runs")
    )).toBe(true);
    expect(mocks.event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "customer.success.workflow.started",
        payload: expect.objectContaining({
          workflowId: "risk_escalation",
          projectTaskCount: 3,
          outcomeStatus: "in_progress",
        }),
      }),
      expect.objectContaining({ sql: expect.any(Function) }),
    );
  });

  it("rejects a start after the account evidence changes", async () => {
    mocks.responses.push([], [], [{
      current_revision: 2,
      current_revision_id: `${accountId}:v2`,
      account_sha256: "c".repeat(64),
      owner_actor_id: actorId,
    }]);
    await expect(saveCustomerSuccessWorkflowStart({
      authority: mutationAuthority("start-1", "customer.success.workflow.start"),
      run: workflowRun(),
    })).rejects.toThrow("Account 360 changed");
  });

  it("appends a terminal outcome receipt with optimistic concurrency", async () => {
    const current = workflowRun();
    const outcome = buildCustomerSuccessOutcomeReceipt({
      status: "blocked",
      summary: "Sponsor confirmation is missing.",
      artifactReceipts: [],
      nextAction: "Confirm an executive sponsor.",
      recordedByActorId: actorId,
      recordedAt: "2026-09-07T13:00:00.000Z",
    });
    mocks.responses.push([], [], [{ run_snapshot: current }], [], [{ run_id: current.runId }]);
    const saved = await saveCustomerSuccessWorkflowOutcome({
      authority: mutationAuthority("outcome-1", "customer.success.workflow.outcome"),
      runId: current.runId,
      expectedRevision: 1,
      outcome,
    });
    expect(saved).toMatchObject({ revision: 2, outcome: { status: "blocked" } });
    expect(mocks.event).toHaveBeenCalledWith(
      expect.objectContaining({ type: "customer.success.workflow.outcome_recorded" }),
      expect.anything(),
    );
  });

  it("reads only the tenant/workspace projection", async () => {
    const run = workflowRun();
    mocks.responses.push([{ run_snapshot: run }]);
    const saved = await getCustomerSuccessWorkflowRun(readAuthority(), run.runId);
    expect(saved?.runSha256).toBe(run.runSha256);
    expect(mocks.queries[0]?.text).toContain("workspace_id");
  });
});

function workflowRun() {
  const definition = getCustomerSuccessWorkflowDefinition("risk_escalation");
  const runId = customerSuccessRunId({
    tenantId,
    workspaceId,
    accountId,
    idempotencyKey: "start-1",
  });
  return buildCustomerSuccessWorkflowRunRevision({
    tenantId,
    workspaceId,
    accountId,
    accountRevisionId: `${accountId}:v1`,
    accountRevision: 1,
    accountSha256,
    runId,
    revision: 1,
    workflowId: "risk_escalation",
    definitionSha256: definition.definitionSha256,
    input: {
      workflowId: "risk_escalation",
      objective: "Restore confidence.",
      targetDate: null,
      riskTitle: "Adoption stalled",
      severity: "high",
      signals: ["Active use dropped."],
    },
    owner: { ownerKind: "actor", ownerId: actorId, displayName: "CSM" },
    ownerActorId: actorId,
    projectId: "project:one",
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
      recordedByActorId: actorId,
      recordedAt: now,
    }),
  });
}

function mutationAuthority(
  idempotencyKey: string,
  purpose: "customer.success.workflow.start" | "customer.success.workflow.outcome",
) {
  return {
    tenantId,
    workspaceId,
    canonicalActorId: actorId,
    readableActorIds: [actorId],
    purposeId: "customer_success.account.manage" as const,
    idempotencyKey,
    executionScope: createExecutionScope({
      tenantId,
      workspaceId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: idempotencyKey,
      purpose,
    }),
  };
}

function readAuthority() {
  return {
    tenantId,
    workspaceId,
    canonicalActorId: actorId,
    readableActorIds: [actorId],
    purposeId: "customer_success.account.read" as const,
  };
}
