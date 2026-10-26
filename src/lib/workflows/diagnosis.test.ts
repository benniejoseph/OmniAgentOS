import { describe, expect, it } from "vitest";
import { diagnoseWorkflow } from "./diagnosis";
import type { WorkflowRunDetail } from "./types";

function fixture(): WorkflowRunDetail {
  const at = "2026-10-26T19:55:55.275Z";
  return {
    run: { id: "wf-research", tenantId: "tenant-a", workflowType: "agent.workflow.v1", status: "paused",
      goal: "Produce a plan", input: { goal: "Produce a plan", mode: "research" }, currentStep: "execute",
      attempt: 0, maxAttempts: 3, approvalRequired: false, pausedAt: at, error: "Report writing timed out after 180 seconds.", createdAt: at, updatedAt: at },
    steps: [{ id: "step-a", tenantId: "tenant-a", workflowRunId: "wf-research", stepKey: "execute", label: "Execute", status: "pending",
      attempt: 0, maxAttempts: 3, input: {}, output: { researchStateV1: { schemaVersion: 1, phase: "writing",
        searches: Array(6).fill({}), reads: Array(9).fill({ content: "untrusted source" }),
        plan: { questions: ["Who is the audience?"] }, models: { report: { status: "started" } } } }, createdAt: at, updatedAt: at }],
    events: [{ id: "pause-a", tenantId: "tenant-a", workflowRunId: "wf-research", type: "workflow.paused", createdAt: at,
      payload: { reason: "research_model_receipt_missing", requiresExplicitResume: true,
        modelFailure: { schemaVersion: 1, modelStep: "report", kind: "timeout", timeoutMs: 180000, elapsedMs: 180156, arbitraryContent: "not exposed" } } }],
  };
}

describe("workflow diagnosis", () => {
  it("explains the captured writer timeout without inventing clarification or a saved draft", () => {
    const result = diagnoseWorkflow(fixture());
    expect(result).toMatchObject({ classification: "model_completion_unconfirmed", status: "paused",
      modelFailure: { modelStep: "report", kind: "timeout", timeoutMs: 180000 },
      retainedResearch: { searches: 6, sourcesRead: 9, draftSaved: false, researchQuestionsAreUserClarifications: false },
      recovery: { signal: "resume", requiresUserRequest: true, subjectToGovernedApproval: true,
        priorModelCompletionUnknown: true, mayStartNewPaidAttempt: true, preservesSavedWorkAndBudgets: true } });
    expect(JSON.stringify(result)).not.toMatch(/untrusted source|Who is the audience|not exposed/);
  });
  it("reports saved draft only when text is actually present", () => {
    const detail = fixture();
    Object.assign(detail.steps[0].output!.researchStateV1 as object, { response: "Saved report", phase: "reviewing" });
    expect(diagnoseWorkflow(detail).retainedResearch).toMatchObject({ draftSaved: true, phase: "reviewing" });
  });
  it("accepts a pause event written after its run transition timestamp", () => {
    const detail = fixture();
    detail.events[0].createdAt = "2026-10-26T19:55:55.276Z";
    expect(diagnoseWorkflow(detail)).toMatchObject({ classification: "model_completion_unconfirmed", modelFailure: { kind: "timeout" } });
  });
  it.each(["running", "completed", "waiting_approval"] as const)("does not reuse old timeout as current recovery for %s", status => {
    const detail = fixture(); detail.run.status = status;
    const result = diagnoseWorkflow(detail);
    expect(result.classification).toBe(status);
    expect(result.modelFailure).toBeUndefined();
    expect(result.recovery.signal).toBeNull();
    expect(result.recovery.priorModelCompletionUnknown).toBe(false);
  });
  it.each(["foreign run", "foreign tenant", "old pause", "invalid failure"])("rejects %s metadata", kind => {
    const detail = fixture();
    if (kind === "foreign run") detail.events[0].workflowRunId = "wf-other";
    if (kind === "foreign tenant") detail.events[0].tenantId = "tenant-b";
    if (kind === "old pause") detail.events[0].createdAt = "2026-10-25T19:55:55.275Z";
    if (kind === "invalid failure") (detail.events[0].payload.modelFailure as Record<string, unknown>).kind = "ask_the_user";
    expect(diagnoseWorkflow(detail).modelFailure).toBeUndefined();
  });
  it("keeps a manual pause distinct from an approval or missing user information", () => {
    const detail = fixture(); detail.events = []; detail.run.error = undefined;
    expect(diagnoseWorkflow(detail)).toMatchObject({ classification: "paused", reason: null,
      recovery: { signal: "resume", priorModelCompletionUnknown: false } });
  });
});
