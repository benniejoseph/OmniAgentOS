import { describe, expect, it } from "vitest";
import {
  publicGroundingReport,
  type GroundingReport,
} from "@/lib/rag/citations";
import { agentRunOutcomeEvent } from "@/lib/runs/public";
import type { AgentRunContinuation, AgentRunRecord } from "@/lib/runs/types";

function run(overrides: Partial<AgentRunRecord>): AgentRunRecord {
  return {
    id: "run-outcome",
    tenantId: "tenant-outcome",
    ownerActorId: "actor-a",
    mode: "orchestrate",
    status: "running",
    prompt: "Summarize my week.",
    messages: [{ role: "user", content: "Summarize my week." }],
    agentId: "atlas",
    specialistIds: ["atlas"],
    memoryContextCount: 0,
    consolidationCount: 0,
    startedAt: "2026-09-27T00:00:00.000Z",
    ...overrides,
  };
}

const pausedContinuation = {
  conversationItems: [],
  instructions: "test",
  response: "partial",
  toolSteps: 1,
  outputsBeforeApproval: [],
  pendingToolCall: {
    callId: "call_1",
    toolId: "computer.local",
    toolName: "This Mac",
    riskLevel: 2,
    executionId: "exec-outcome",
  },
  context: { tenantId: "tenant-outcome", actorId: "actor-a", role: "operator" },
  createdAt: "2026-09-27T00:00:00.000Z",
} as AgentRunContinuation;

// Only the fields the public projection keeps are real; the rest stand in
// for the private claim evidence a stored run carries.
const grounding = {
  status: "verified",
  citedIds: ["memory:a"],
  invalidIds: [],
  sources: [{
    citationId: "memory:a",
    evidenceId: "a",
    kind: "memory",
    title: "Weekly notes",
    confidence: 0.9,
  }],
  claimEvidence: {
    claimEvidenceMap: {
      claimEvidenceMapId: "map-a",
      claimEvidenceMapSha256: "f".repeat(64),
      answer: { answerId: "answer-a", text: "PRIVATE ANSWER TEXT" },
      evaluatedAt: "2026-09-27T00:00:00.000Z",
      coverage: { materialClaimCount: 1, coverageBps: 10_000 },
      claims: [{
        claim: {
          claimId: "claim-a",
          startUtf16: 0,
          endUtf16Exclusive: 7,
          materiality: "material",
          text: "PRIVATE CLAIM TEXT",
        },
        supportState: "supported",
        supportReason: "cited",
        consideredEvidenceUnitIds: ["unit-a"],
        evidenceExcerpt: "PRIVATE EVIDENCE EXCERPT",
      }],
    },
    structuralVerification: {
      structuralVerificationId: "verification-a",
      detail: "PRIVATE VERIFICATION DETAIL",
    },
  },
} as unknown as GroundingReport;

describe("agentRunOutcomeEvent", () => {
  it("ends a completed run with its answer and only the public grounding", () => {
    const event = agentRunOutcomeEvent(run({
      status: "completed",
      response: "Answer.",
      grounding,
    }));

    expect(event).toEqual({
      type: "done",
      response: "Answer.",
      grounding: publicGroundingReport(grounding),
    });
    expect(event).toMatchObject({
      grounding: {
        claimEvidence: { claimEvidenceMapId: "map-a", answerId: "answer-a" },
      },
    });
    expect(JSON.stringify(event)).not.toContain("PRIVATE");
    expect(agentRunOutcomeEvent(run({ status: "completed" }))).toEqual({
      type: "done",
      response: "",
    });
  });

  it("redacts and bounds a failed run's error", () => {
    const secret = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789";
    const event = agentRunOutcomeEvent(run({
      status: "failed",
      error: `Provider rejected ${secret}. ${"x".repeat(2_000)}`,
    }));

    expect(event?.type).toBe("error");
    const message = (event as { message: string }).message;
    expect(message).toMatch(/^Provider rejected /);
    expect(message).not.toContain(secret);
    expect(message.length).toBe(1_000);
    expect(agentRunOutcomeEvent(run({ status: "failed" }))).toEqual({
      type: "error",
      message: "Agent run failed.",
    });
  });

  it("reports a cancellation with the caller's wording when it has one", () => {
    expect(agentRunOutcomeEvent(run({ status: "canceled" }))).toEqual({
      type: "canceled",
      message: "The Agent run was canceled.",
    });
    expect(agentRunOutcomeEvent(run({ status: "canceled" }), {
      canceledMessage: "Stopped before it finished.",
    })).toEqual({ type: "canceled", message: "Stopped before it finished." });
  });

  it("pauses on the call waiting for approval or the clarification asked", () => {
    expect(agentRunOutcomeEvent(run({
      status: "waiting_approval",
      continuation: pausedContinuation,
    }))).toEqual({
      type: "waiting_approval",
      executionId: "exec-outcome",
      toolId: "computer.local",
      message: expect.stringContaining("Approval will resume"),
    });
    expect(agentRunOutcomeEvent(run({
      status: "waiting_clarification",
      threadId: "thread-a",
      response: "Which project do you mean?",
    }))).toEqual({
      type: "clarification",
      threadId: "thread-a",
      runId: "run-outcome",
      message: "Which project do you mean?",
      reasonCode: "ambiguous_read_target",
    });
    expect(agentRunOutcomeEvent(run({
      status: "waiting_clarification",
      threadId: "thread-a",
    }))).toMatchObject({
      type: "clarification",
      message: expect.stringContaining("exact item"),
    });
  });

  it.each([
    ["queued", {}],
    ["running", {}],
    ["resuming", {}],
    ["waiting_approval", {}],
    ["waiting_clarification", { response: "Which one?" }],
  ] as const)(
    "has no outcome for a %s run that is still working or incomplete",
    (status, overrides) => {
      expect(agentRunOutcomeEvent(run({ status, ...overrides }))).toBeUndefined();
    },
  );
});
