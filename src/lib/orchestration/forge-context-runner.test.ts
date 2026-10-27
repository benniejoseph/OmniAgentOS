import { describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { createForgeHandoff } from "@/lib/self-improvement/forge-handoff";
import { collectForgeContext } from "./forge-context-runner";
import type { ToolDefinition } from "@/lib/tools/types";
import type { executeGovernedTool } from "@/lib/tools/executor";

const runId = "11111111-1111-4111-8111-111111111111", sessionId = `app_build_${"a".repeat(48)}`;
const scope = createExecutionScope({ tenantId: "t", initiatingActorId: "owner", executingPrincipalType: "agent", executingPrincipalId: "forge", projectId: "p", correlationId: runId, purpose: "self_improvement.cycle.v1" });
const plan = { summary: "Synthetic", sourcePaths: ["src/feature.ts"], newSourcePaths: [], focusedTestPaths: ["src/feature.test.ts"], adjacentTestPaths: ["src/adjacent.test.ts"], acceptanceCriteria: ["Fallback"] };
function fixture(mode: "normal" | "no_budget" | "partial" | "pause" = "normal") {
  const assertCurrent = vi.fn(async () => { if (mode === "pause" && assertCurrent.mock.calls.length > 2) throw new Error("private pause details"); });
  const handoff = createForgeHandoff({ runId, sessionId, plan: { phase: "reproduce", plan, expectedHashes: { "src/feature.ts": "a".repeat(64) } }, assertCurrent,
    verifyRead: async (request, observed) => ({ executionId: observed.executionId, path: request.path, sha256: "a".repeat(64), inputSha256: "b".repeat(64), scopeSha256: "c".repeat(64),
      startLine: request.startLine, endLine: request.startLine === 1 ? 200 : 311, totalLines: request.path === "src/feature.ts" ? 311 : 200 }) });
  const execute = vi.fn(async input => ({ record: { id: `execution-${execute.mock.calls.length}`, toolId: input.toolId, status: mode === "partial" && execute.mock.calls.length === 2 ? "failed" : "executed", dryRun: false }, result: {} }));
  const reserve = vi.fn(), before = vi.fn(), after = vi.fn();
  const collection = collectForgeContext({ handoff, binding: { projectId: "p", sessionId, readOnly: false, allowedToolIds: ["app.projects.builder.file.read"], assertCurrent },
    tool: { id: "app.projects.builder.file.read", name: "Read", riskLevel: 0, approvalRequired: false } as ToolDefinition,
    runId, scope, context: { tenantId: "t", actorId: "owner", role: "operator", source: "service" },
    allowed: true, maxPerRound: 5, remainingCalls: () => 48 - reserve.mock.calls.length, remainingRounds: 16,
    canReserveFollowUp: async () => mode !== "no_budget", reserveTools: reserve, execute: execute as unknown as typeof executeGovernedTool,
    checkpointBefore: before, checkpointAfter: after,
    observe: execution => ({ executionId: execution.record.id, toolId: execution.record.toolId, modelOutput: '{"data":{"result":{"file":{"content":"untrusted fixture"}}}}' }) });
  return { collection, execute, reserve, after, handoff };
}
async function drain(collection: ReturnType<typeof collectForgeContext>) {
  const events = []; let next = await collection.next();
  while (!next.done) { events.push(next.value); next = await collection.next(); }
  return { events, result: next.value };
}
describe("Forge governed known-plan context", () => {
  it("uses real read calls and canonical scopes, charges only calls, and delivers attributed untrusted pages", async () => {
    const f = fixture(); const { result, events } = await drain(f.collection);
    expect(result).toMatchObject({ complete: true, toolRounds: 1, observation: { type: "observation", untrusted: true } });
    expect(f.execute.mock.calls.map(([call]) => call.input)).toEqual([
      { projectId: "p", sessionId, path: "src/feature.ts", startLine: 1, lineCount: 200 },
      { projectId: "p", sessionId, path: "src/feature.ts", startLine: 201, lineCount: 111 },
      { projectId: "p", sessionId, path: "src/adjacent.test.ts", startLine: 1, lineCount: 200 },
    ]);
    expect(f.reserve).toHaveBeenCalledTimes(3); expect(f.after).toHaveBeenCalledTimes(3);
    for (const [call] of f.execute.mock.calls) expect(call).toMatchObject({ requireReadOnly: true, approved: false, agentRunId: runId, executionScope: { purpose: "agent.tool.execute", correlationId: runId } });
    expect(f.execute.mock.calls[0][0].executionScope.causationId).toBe("forge-workflow-read-1");
    expect(events.at(-1)).toMatchObject({ type: "status", forgeHandoff: { outcome: "context_collected" } });
    expect(JSON.parse(result.observation!.content)).toMatchObject({ origin: "forge_workflow" });
    expect(f.handoff.modelAttempted()).toBe(false);
  });
  it.each(["no_budget", "partial", "pause"] as const)("retains bounded %s without replay or an invented model call", async mode => {
    const f = fixture(mode); const { result, events } = await drain(f.collection);
    expect(result.complete).toBe(false); expect(result.observation).toBeUndefined(); expect(f.handoff.modelAttempted()).toBe(false);
    expect(events.at(-1)).toMatchObject({ forgeHandoff: { outcome: "incomplete", reason: mode === "no_budget" ? "budget_unavailable" : mode === "pause" ? "authority_unavailable" : "evidence_unavailable" } });
    expect(f.reserve).toHaveBeenCalledTimes(mode === "no_budget" ? 0 : mode === "pause" ? 1 : 2);
    expect(JSON.stringify(events)).not.toContain("private pause details");
  });
});
