import { describe, expect, it } from "vitest";
import { buildExecutionFailureFixture, compareExecutionBehavior } from "@/lib/agents/execution-improvement";
import type { AgentRunRecord } from "@/lib/runs/types";
import type { ToolExecutionRecord } from "@/lib/tools/types";
const run = (id: string, status: AgentRunRecord["status"] = "completed") => ({ id, tenantId: "tenant", ownerActorId: "owner", status, prompt: "Save the proposal.", messages: [], mode: "execute", memoryContextCount: 0, startedAt: "2026-10-19T08:00:00.000Z" } as AgentRunRecord);
const receipt = (id: string, status: ToolExecutionRecord["status"], saved: boolean) => ({ id, tenantId: "tenant", actorId: "owner", toolId: "app.knowledge.ingest", toolName: "Save", status, dryRun: false, approvalRequired: false, riskLevel: 1, input: { content: "Draft" }, output: { saved }, createdAt: "2026-10-19T08:00:01.000Z" } as ToolExecutionRecord);
const setup = () => ({ baseline: run("baseline", "failed"), candidate: run("candidate"), baselineReceipts: [receipt("before", "failed", false)], candidateReceipts: [receipt("after", "executed", true)], assertions: [{ toolId: "app.knowledge.ingest", path: ["saved"], equals: true }] });
describe("execution improvement evidence", () => {
  it("compares actual saved fields instead of final-answer wording", () => {
    const input = setup(); input.candidate.response = "I fixed everything.";
    expect(compareExecutionBehavior(input)).toMatchObject({ verdict: "improved", baselinePassed: 0, candidatePassed: 1, activation: "not_performed" });
    input.candidateReceipts = [];
    expect(compareExecutionBehavior(input).verdict).toBe("no_change");
  });
  it("does not claim a dry-run fixed the failure", () => {
    const input = setup(); input.candidateReceipts[0].dryRun = true;
    expect(compareExecutionBehavior(input).candidatePassed).toBe(0);
  });
  it("requires matching owners and the same task", () => {
    const input = setup(); input.candidate.ownerActorId = "other";
    expect(compareExecutionBehavior(input).verdict).toBe("incomplete");
    input.candidate.ownerActorId = "owner"; input.candidate.prompt = "Do something easier.";
    expect(compareExecutionBehavior(input).verdict).toBe("incomplete");
  });
  it("detects regressions on previously passing assertions", () => {
    const input = setup(); input.baselineReceipts[0] = receipt("before", "executed", true); input.candidateReceipts[0].output = { saved: false };
    expect(compareExecutionBehavior(input).verdict).toBe("regressed");
  });
  it("captures immutable failure data without making a mutation replayable", () => {
    const input = setup(); const fixture = buildExecutionFailureFixture(input.baseline, input.baselineReceipts);
    expect(fixture.observations[0].input).toBeNull();
    expect(fixture.replay.automaticallyExecutable).toBe(false);
    expect(fixture.activation.automatic).toBe(false);
    expect(fixture.fixtureSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
