import { describe, expect, it } from "vitest";
import { buildExecutionFailureFixture } from "@/lib/agents/execution-improvement";
import type { AgentRunRecord } from "@/lib/runs/types";
import type { ToolExecutionRecord } from "@/lib/tools/types";
import { collectEngineeringSignalsFromRuns } from "./evidence";
import { selfImprovementSha256 } from "./contracts";

const at = "2026-10-26T12:00:00.000Z";
const scope = { tenantId: "tenant", ownerActorId: "actor:11111111-1111-4111-8111-111111111111", repository: { owner: "asael", name: "app", defaultBranch: "main" }, baseRevision: "a".repeat(40) };
const email = "verified@example.test";
const run: AgentRunRecord = { id: "run", tenantId: scope.tenantId, ownerActorId: email, mode: "execute", status: "failed", prompt: "Save a title.", messages: [], memoryContextCount: 0,
  error: "Recorded failure", startedAt: at, completedAt: at, feedback: { verdict: "needs_work", correction: "Keep the original title.", updatedAt: at } };
const receipt: ToolExecutionRecord = { id: "tool", tenantId: scope.tenantId, actorId: email, toolId: "app.projects.update", toolName: "Update project", input: {}, riskLevel: 1,
  status: "failed", reason: "Recorded failure", dryRun: false, approvalRequired: false, createdAt: at, completedAt: at };

describe("verified owner engineering evidence", () => {
  it("includes current-email failures and feedback without changing source attribution or hashes", () => {
    const original = structuredClone({ run, receipt });
    const signals = collectEngineeringSignalsFromRuns({ scope, verifiedOwnerActorIds: [scope.ownerActorId, email], runs: [{ run, receipts: [receipt] }] });
    expect(signals.map(item => item.kind).sort()).toEqual(["failed_run", "owner_correction", "recurrent_tool_failure"]);
    expect(signals.every(item => item.scope.ownerActorId === scope.ownerActorId)).toBe(true);
    const fixture = buildExecutionFailureFixture(run, [receipt]);
    expect(signals.find(item => item.kind === "failed_run")?.observations[0].sourceSha256).toBe(fixture.fixtureSha256);
    expect(signals.find(item => item.kind === "owner_correction")?.observations[0].sourceSha256).toBe(selfImprovementSha256("owner_feedback", { runId: run.id, feedback: run.feedback, fixtureSha256: fixture.fixtureSha256 }));
    const toolHash = (actorId: string) => selfImprovementSha256("tool_failure", { executionId: receipt.id, tenantId: receipt.tenantId, actorId, toolId: receipt.toolId, status: receipt.status, reason: receipt.reason, createdAt: at, completedAt: at });
    expect(signals.find(item => item.kind === "recurrent_tool_failure")?.observations[0].sourceSha256).toBe(toolHash(email));
    expect(toolHash(email)).not.toBe(toolHash(scope.ownerActorId));
    expect({ run, receipt }).toEqual(original);
  });
  it("keeps canonical evidence eligible and excludes foreign owners, old aliases and tenants", () => {
    const canonical = { ...run, id: "canonical", ownerActorId: scope.ownerActorId };
    const foreign = ["foreign@example.test", "former@example.test"].map(ownerActorId => ({ run: { ...run, id: ownerActorId, ownerActorId }, receipts: [receipt] }));
    const signals = collectEngineeringSignalsFromRuns({ scope, verifiedOwnerActorIds: [scope.ownerActorId, email], runs: [
      ...foreign, { run: { ...run, id: "foreign-tenant", tenantId: "other" }, receipts: [receipt] },
      { run: canonical, receipts: [{ ...receipt, actorId: "foreign@example.test" }, { ...receipt, tenantId: "other" }] },
    ] });
    expect(signals.map(item => item.kind).sort()).toEqual(["failed_run", "owner_correction"]);
    expect(signals.flatMap(item => item.observations).every(item => item.sourceId === canonical.id)).toBe(true);
    expect(collectEngineeringSignalsFromRuns({ scope, runs: [{ run, receipts: [receipt] }] })).toEqual([]);
  });
  it("rejects an invalid or unbound actor set instead of broadening its scope", () => {
    for (const verifiedOwnerActorIds of [[], [email], [scope.ownerActorId, email, "other"], [scope.ownerActorId, ""], [scope.ownerActorId, " old@example.test"], [scope.ownerActorId, "bad\0alias"]]) {
      expect(() => collectEngineeringSignalsFromRuns({ scope, verifiedOwnerActorIds, runs: [] })).toThrow(/verified owner aliases/);
    }
  });
});
