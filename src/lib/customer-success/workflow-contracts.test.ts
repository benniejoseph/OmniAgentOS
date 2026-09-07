import { describe, expect, it } from "vitest";

import {
  buildCustomerSuccessOutcomeReceipt,
  buildCustomerSuccessWorkflowRunRevision,
  CUSTOMER_SUCCESS_WORKFLOW_IDS,
  CUSTOMER_SUCCESS_WORKFLOW_PACK,
  customerSuccessRunId,
  getCustomerSuccessWorkflowDefinition,
  validateCompletedWorkflowArtifacts,
} from "@/lib/customer-success/workflow-contracts";

const sha = "a".repeat(64);
const accountId = `customer-account:${"b".repeat(64)}`;
const actorId = "actor:11111111-1111-4111-a111-111111111111";

describe("customer-success workflow contracts", () => {
  it("pins all eight immutable CSM workflows and external-effect boundaries", () => {
    expect(CUSTOMER_SUCCESS_WORKFLOW_PACK.map((item) => item.workflowId))
      .toEqual(CUSTOMER_SUCCESS_WORKFLOW_IDS);
    expect(new Set(CUSTOMER_SUCCESS_WORKFLOW_PACK.map((item) => item.definitionSha256)).size)
      .toBe(8);
    for (const definition of CUSTOMER_SUCCESS_WORKFLOW_PACK) {
      expect(definition.packVersion).toBe("asael-csm-pack:1");
      expect(definition.inputFields.length).toBeGreaterThanOrEqual(3);
      expect(definition.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(definition.artifacts.some((item) => item.required)).toBe(true);
      expect(definition.evidenceRequirements.some((item) => item.required)).toBe(true);
      expect(definition.projectTemplate.tasks.length).toBeGreaterThan(0);
      expect(definition.defaultNextAction).toBeTruthy();
      expect(definition.externalActionPolicy).toMatchObject({
        communicationMode: "draft_only_until_governed_delivery",
        crmMode: "proposal_only_until_governed_write",
        directExternalEffectsAllowed: false,
      });
    }
  });

  it("validates workflow-specific typed inputs", async () => {
    const { customerSuccessWorkflowInputSchema } = await import(
      "@/lib/customer-success/workflow-contracts"
    );
    expect(customerSuccessWorkflowInputSchema.parse({
      workflowId: "risk_escalation",
      objective: "Restore sponsor confidence.",
      targetDate: null,
      riskTitle: "Adoption stalled",
      severity: "high",
      signals: ["Weekly active use dropped."],
    })).toMatchObject({ workflowId: "risk_escalation", executiveSponsorId: null });
    expect(() => customerSuccessWorkflowInputSchema.parse({
      workflowId: "renewal_planning",
      objective: "Renew the account.",
      targetDate: null,
      renewalAt: "2027-01-01T00:00:00.000Z",
      renewalGoals: ["Confirm value."],
      amountMinor: 100,
      currency: null,
    })).toThrow();
  });

  it("seals exact run inputs, owner, project tasks, next action, and outcome", () => {
    const definition = getCustomerSuccessWorkflowDefinition("onboarding");
    const runId = customerSuccessRunId({
      tenantId: "tenant-example",
      workspaceId: "workspace:example",
      accountId,
      idempotencyKey: "start-1",
    });
    const outcome = buildCustomerSuccessOutcomeReceipt({
      status: "in_progress",
      summary: "",
      artifactReceipts: [],
      nextAction: definition.defaultNextAction,
      recordedByActorId: actorId,
      recordedAt: "2026-09-07T00:00:00.000Z",
    });
    const run = buildCustomerSuccessWorkflowRunRevision({
      tenantId: "tenant-example",
      workspaceId: "workspace:example",
      accountId,
      accountRevisionId: `${accountId}:v1`,
      accountRevision: 1,
      accountSha256: sha,
      runId,
      revision: 1,
      workflowId: "onboarding",
      definitionSha256: definition.definitionSha256,
      input: {
        workflowId: "onboarding",
        objective: "Reach first value.",
        targetDate: null,
        successCriteria: ["First team is active."],
      },
      owner: { ownerKind: "actor", ownerId: actorId, displayName: "CSM" },
      ownerActorId: actorId,
      projectId: "project:one",
      projectTaskIds: [{ taskKey: "baseline", projectTaskId: "task:one" }],
      allowedPurposeIds: ["customer_success.account.read"],
      outcome,
    });
    expect(run).toMatchObject({
      runRevisionId: `${runId}:v1`,
      workflowId: "onboarding",
      projectId: "project:one",
      outcome: { status: "in_progress", nextAction: definition.defaultNextAction },
    });
    expect(run.runSha256).toHaveLength(64);
  });

  it("fails a completed receipt without every required artifact and evidence key", () => {
    const definition = getCustomerSuccessWorkflowDefinition("risk_escalation");
    const incomplete = buildCustomerSuccessOutcomeReceipt({
      status: "completed",
      summary: "Contained.",
      artifactReceipts: [{
        artifactKey: "risk_brief",
        projectArtifactId: "artifact:one",
        evidenceKeys: ["account_snapshot"],
        evidenceRefs: ["customer-fact:one:v1"],
      }],
      nextAction: "Monitor recovery.",
      recordedByActorId: actorId,
      recordedAt: "2026-09-07T00:00:00.000Z",
    });
    expect(() => validateCompletedWorkflowArtifacts({ definition, outcome: incomplete }))
      .toThrow("mitigation_plan");
  });
});
