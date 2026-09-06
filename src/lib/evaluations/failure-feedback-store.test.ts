import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HarnessRuleReviewConflictError,
  listEvaluationFailureFeedback,
  recordEvaluationResultFeedback,
  reviewHarnessRuleProposal,
} from "@/lib/evaluations/failure-feedback-store";
import type {
  EvalCaseDefinition,
  EvalResultRecord,
} from "@/lib/evaluations/types";

const evalCase: EvalCaseDefinition = {
  id: "workflow.dynamic_planner",
  name: "Dynamic planner",
  description: "Plans a bounded workflow.",
  type: "workflow",
  input: { goal: "private fixture content" },
  expected: { validDag: true },
  governance: {
    safetyMode: "synthetic",
    riskLevel: 1,
    writesToDatabase: true,
    cleanup: "self_cleaning",
    production: {
      allowedByDefault: true,
      requiresAdmin: false,
      requiresMutationApproval: false,
    },
    notes: [],
  },
};

let dataDirectory = "";
const previousDataDirectory = process.env.OMNIAGENT_DATA_DIR;

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "asael-failure-feedback-"));
  process.env.OMNIAGENT_DATA_DIR = dataDirectory;
  delete process.env.DATABASE_URL;
});

afterEach(async () => {
  if (previousDataDirectory === undefined) delete process.env.OMNIAGENT_DATA_DIR;
  else process.env.OMNIAGENT_DATA_DIR = previousDataDirectory;
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("recurring evaluation failure feedback", () => {
  it("creates one minimized replay cluster and review-only proposal after repetition", async () => {
    const first = await observe(result("result-1", "fail", "Zod schema validation failed at field 1"));
    const second = await observe(result("result-2", "fail", "Zod schema validation failed at field 2"));
    const duplicate = await observe(result("result-2", "fail", "Zod schema validation failed at field 2"));
    const snapshot = await listEvaluationFailureFeedback({ tenantId: "tenant-a" });

    expect(first.cluster?.consecutiveFailures).toBe(1);
    expect(first.proposal).toBeUndefined();
    expect(second.cluster?.consecutiveFailures).toBe(2);
    expect(second.proposal).toMatchObject({
      version: 1,
      kind: "tool_contract",
      status: "proposed",
      proposal: { reviewRequired: true, automaticApplication: false },
    });
    expect(duplicate.processed).toBe(false);
    expect(snapshot.summary).toMatchObject({
      observations: 2,
      activeRecurring: 1,
      proposedRules: 1,
    });
    expect(JSON.stringify(snapshot)).not.toContain("private fixture content");
    expect(JSON.stringify(snapshot)).not.toContain("field 1");
  });

  it("requires an explicit final review and resolves after two focused passes", async () => {
    await observe(result("failure-1", "fail", "Request timed out after 1 second"));
    const repeated = await observe(result("failure-2", "fail", "Request timed out after 2 seconds"));
    const proposalId = repeated.proposal?.id || "";
    const approved = await reviewHarnessRuleProposal({
      tenantId: "tenant-a",
      proposalId,
      actorId: "operator-a",
      decision: "approved",
      reason: "Reviewed against the minimized replay contract.",
    });
    const retried = await reviewHarnessRuleProposal({
      tenantId: "tenant-a",
      proposalId,
      actorId: "operator-a",
      decision: "approved",
      reason: "Reviewed against the minimized replay contract.",
    });

    expect(approved.status).toBe("approved");
    expect(retried).toEqual(approved);
    await expect(reviewHarnessRuleProposal({
      tenantId: "tenant-a",
      proposalId,
      actorId: "operator-a",
      decision: "rejected",
      reason: "Attempt a conflicting second decision.",
    })).rejects.toBeInstanceOf(HarnessRuleReviewConflictError);

    await observe(result("pass-1", "pass"));
    await observe(result("pass-2", "pass"));
    const snapshot = await listEvaluationFailureFeedback({ tenantId: "tenant-a" });
    expect(snapshot.summary).toMatchObject({
      activeRecurring: 0,
      resolvedClusters: 1,
      approvedRules: 1,
    });
    expect(snapshot.clusters[0]).toMatchObject({
      status: "resolved",
      consecutivePasses: 2,
      consecutiveFailures: 0,
    });
  });
});

function result(
  id: string,
  status: EvalResultRecord["status"],
  error?: string,
): EvalResultRecord {
  return {
    id,
    tenantId: "tenant-a",
    evalRunId: `run-${id}`,
    caseId: evalCase.id,
    caseName: evalCase.name,
    caseType: evalCase.type,
    status,
    score: status === "pass" ? 1 : 0,
    latencyMs: 10,
    estimatedCostUsd: 0,
    input: evalCase.input,
    output: status === "pass" ? { validDag: true } : undefined,
    error,
    createdAt: new Date().toISOString(),
  };
}

function observe(observation: EvalResultRecord) {
  return recordEvaluationResultFeedback({
    tenantId: "tenant-a",
    actorId: "evaluation-harness",
    suite: "focused-replay",
    evalCase,
    result: observation,
  });
}
