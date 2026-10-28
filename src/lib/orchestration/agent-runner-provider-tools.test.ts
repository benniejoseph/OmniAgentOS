import { createInspectionCompletionGate, type InspectionReadReceipt } from "@/lib/self-improvement/inspection-completion";
import { createForgeHandoff, FORGE_FINAL_BUDGET_INSTRUCTIONS } from "@/lib/self-improvement/forge-handoff";
import { describe, expect, it, vi } from "vitest";
import {
  runNonOpenAIProviderToolLoop,
} from "@/lib/orchestration/agent-runner";
import {
  DYNAMIC_DELEGATION_CHILD_BUDGET,
  dynamicDelegationMaxToolSteps,
} from "@/lib/delegation/runtime-policy";
import type { AgentEvent } from "@/lib/orchestration/types";
import { AGENT_MAX_OUTPUT_TOKENS, AGENT_MAX_TOOL_STEPS, AGENT_REASONING_EFFORT, AGENT_RUN_BUDGET_LIMITS, LOCAL_COMPUTER_MAX_TOOL_STEPS } from "@/lib/config";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { withSelfImprovementExecution, type SelfImprovementExecutionAuthority } from "@/lib/self-improvement/authority";
import { createRunBudgetState, estimateModelInputTokens, planModelTurnBudget, remainingRunBudget, reserveRunBudget } from "@/lib/runs/budgets";
import { AgentRunTerminatedError } from "@/lib/runs/cancellation";
import type {
  ModelToolCall,
  ModelToolTurnRequest,
  ModelToolTurnResult,
} from "@/lib/models/types";
import type { ToolDefinition, ToolExecutionRecord } from "@/lib/tools/types";

describe("non-OpenAI governed provider tool loop", () => {
  it.each(["edit", "exhausted"] as const)("replays captured discovery into the bounded Forge write window (%s)", async mode => {
    const fixture = forgeWindowFixture();
    // Public tool-kind sequence from correction 4251b45c; its prelude consumed
    // one round/four reads. The edit branch is explicitly counterfactual.
    const captured = ["search", "read", "read", "search", "read", "search", "search", "search", "search", "read", "search", "read", "search", "read", "read"];
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      const number = generateTurn.mock.calls.length;
      if (number <= 12) expect(request.tools.map(tool => tool.name)).toContain("search");
      else {
        expect(request.tools.map(tool => tool.name)).not.toContain("search");
        expect(request.tools.map(tool => tool.name)).not.toContain("tree");
        expect(request.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["read", "edit"]));
      }
      if (mode === "edit" && number === 15) return turn({ text: "Saved the justified change.", cost: 0.001 });
      if (number === 16) {
        expect(request.toolChoice).toBe("none");
        expect(request.instructions).toContain(FORGE_FINAL_BUDGET_INSTRUCTIONS);
        return turn({ text: "No change was saved before the tool-round budget ended.", cost: 0.001 });
      }
      const name = mode === "edit" && number >= 13 ? number === 13 ? "read" : "edit" : captured[number - 1];
      return turn({ toolCalls: [fixture.call(name, `call-${number}`)], cost: 0.001 });
    });
    const result = await fixture.run(generateTurn);
    expect(result.events.filter(event => event.type === "status" && event.label === "Forge write window")).toHaveLength(1);
    expect(result.result.toolSteps).toBe(mode === "edit" ? 15 : 16);
    expect(generateTurn).toHaveBeenCalledTimes(mode === "edit" ? 15 : 16);
    expect(fixture.charged()).toBe(18); // four prelude reads plus fourteen dispatched calls
    if (mode === "edit") {
      expect(fixture.executeTool.mock.calls.filter(([request]) => request.toolId.endsWith(".edit"))).toHaveLength(1);
      expect(result.result.deferredToolCallHashes).toEqual([]);
      expect(result.events.some(event => event.type === "status" && event.label === "requested actions unfinished")).toBe(false);
    } else {
      expect(fixture.executeTool.mock.calls.some(([request]) => request.toolId.endsWith(".edit"))).toBe(false);
      expect(result.events).toContainEqual(expect.objectContaining({ type: "status", toolLimit: expect.objectContaining({ reason: "run_tool_rounds", remainingToolRounds: 0 }) }));
      const blocked = result.events.filter(event => event.type === "tool" && event.status === "blocked");
      expect(blocked).toHaveLength(1); expect(blocked[0]).not.toHaveProperty("executionId");
      expect(result.result.deferredToolCallHashes).toHaveLength(1);
    }
  });

  it("refuses cached parallel discovery before reservation while preserving an exact read", async () => {
    const fixture = forgeWindowFixture({ toolSteps: 13 });
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      if (generateTurn.mock.calls.length === 1) return turn({ toolCalls: [fixture.call("search", "search"), fixture.call("tree", "tree"), fixture.call("read", "read")] });
      expect(request.toolResults?.slice(0, 2).map(result => JSON.parse(result.output).data)).toEqual([
        expect.objectContaining({ executed: false, reason: "forge_write_window" }),
        expect.objectContaining({ executed: false, reason: "forge_write_window" }),
      ]);
      return turn({ text: "The two withdrawn discovery requests did not run." });
    });
    const before = fixture.charged(), result = await fixture.run(generateTurn);
    expect(fixture.executeTool).toHaveBeenCalledTimes(1);
    expect(fixture.executeTool.mock.calls[0][0].toolId).toBe("app.projects.builder.file.read");
    expect(fixture.charged() - before).toBe(1);
    expect(result.result.toolSteps).toBe(14);
    expect(result.result.deferredToolCallHashes).toHaveLength(2);
  });

  it.each(["ordinary", "unbound"] as const)("leaves %s discovery unchanged", async mode => {
    const fixture = forgeWindowFixture({ mode, toolSteps: mode === "ordinary" ? 5 : 13 });
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      expect(request.tools.map(tool => tool.name)).toContain("search");
      expect(request.instructions).not.toContain("Forge write window");
      return generateTurn.mock.calls.length === 1 ? turn({ toolCalls: [fixture.call("search", "search")] }) : turn({ text: "Done" });
    });
    const result = await fixture.run(generateTurn);
    expect(fixture.executeTool).toHaveBeenCalledTimes(1);
    expect(result.events.some(event => event.type === "status" && event.label === "Forge write window")).toBe(false);
  });

  it.each(["rounds", "calls"] as const)("gives truthful Forge guidance for exhausted tool %s without a planner finalTurn", async dimension => {
    const fixture = forgeWindowFixture({ toolSteps: dimension === "rounds" ? 16 : 13, usedCalls: dimension === "calls" ? 48 : 19 });
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      expect(request.toolChoice).toBe("none");
      expect(request.instructions).toContain(FORGE_FINAL_BUDGET_INSTRUCTIONS);
      return turn({ text: "No edit was saved before the tool budget ended." });
    });
    const result = await fixture.run(generateTurn);
    expect(generateTurn).toHaveBeenCalledTimes(1); expect(fixture.executeTool).not.toHaveBeenCalled();
    expect(result.events).toContainEqual(expect.objectContaining({ type: "status", toolLimit: expect.objectContaining({ reason: dimension === "rounds" ? "run_tool_rounds" : "run_tool_calls" }) }));
    expect(result.events.some(event => event.type === "status" && event.label === "Forge write window")).toBe(false);
  });

  it("preserves approval_required at the final-window edit boundary", async () => {
    const fixture = forgeWindowFixture({ toolSteps: 13, approval: true });
    const generateTurn = vi.fn(async () => turn({ toolCalls: [fixture.call("edit", "approval-edit")] }));
    const result = await fixture.run(generateTurn);
    expect(fixture.executeTool).toHaveBeenCalledWith(expect.objectContaining({ approved: false, forceApproval: true, dryRun: false }));
    expect(result.result.waitingApproval).toMatchObject({ toolId: "app.projects.builder.file.edit" });
    expect(generateTurn).toHaveBeenCalledTimes(1);
  });

  it("stops after a pause observed at window entry before another reservation or model call", async () => {
    const fixture = forgeWindowFixture({ toolSteps: 13 });
    const generateTurn = vi.fn(async () => turn({ text: "Must not run" }));
    const result = await fixture.run(generateTurn, () => fixture.pause());
    expect(fixture.beforeModelTurn).not.toHaveBeenCalled(); expect(generateTurn).not.toHaveBeenCalled();
    expect(fixture.executeTool).not.toHaveBeenCalled();
    expect(result.events).toContainEqual(expect.objectContaining({ type: "status", forgeHandoff: expect.objectContaining({ reason: "authority_unavailable" }) }));
  });

  it.each(["final", "pause", "ordinary"] as const)("preserves the Forge post-context authority and final-only boundary (%s)", async mode => {
    const runId = "11111111-1111-4111-8111-111111111111", sessionId = `app_build_${"a".repeat(48)}`;
    const context = { tenantId: "t", actorId: "actor:owner", role: "operator" as const, source: "service" as const };
    const scope = createExecutionScope({ tenantId: "t", initiatingActorId: context.actorId, executingPrincipalType: "agent", executingPrincipalId: "forge", projectId: "project", correlationId: runId, purpose: "self_improvement.cycle.v1" });
    let checks = 0;
    const assertCurrent = async () => { if (++checks > 1 && mode === "pause") throw new Error("Owner paused after context status."); };
    const forgePlan = { phase: "reproduce" as const, plan: { summary: "Synthetic", sourcePaths: ["src/a.ts"], newSourcePaths: [], focusedTestPaths: ["src/a.test.ts"], adjacentTestPaths: ["src/b.test.ts"], acceptanceCriteria: ["Fallback"] }, expectedHashes: { "src/a.ts": "a".repeat(64) } };
    const handoff = createForgeHandoff({ runId, sessionId, plan: forgePlan, assertCurrent, verifyRead: async () => { throw new Error("Prelude already completed"); } });
    handoff.begin(); handoff.finishContext([{ executionId: "read", path: "src/a.ts", sha256: "a".repeat(64), inputSha256: "b".repeat(64), scopeSha256: "c".repeat(64), startLine: 1, endLine: 20, totalLines: 20 }]);
    const authority: SelfImprovementExecutionAuthority = { tenantId: "t", ownerActorId: context.actorId, projectId: "project", repositoryId: "42", cycleId: "cycle", policySha256: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", readOnly: false, sessionId, forgePlan, forgeHandoff: handoff, writePaths: ["src/a.test.ts"], assertCurrent };
    const generateTurn = vi.fn(async (_request: ModelToolTurnRequest) => turn({ text: '{"summary":"Only recorded effects are complete."}', cost: 0.001 }));
    const beforeModelTurn = vi.fn(async () => ({ maxAttempts: 1, finalTurn: true }));
    const work = () => collect(runNonOpenAIProviderToolLoop({ provider: "google", tier: "reasoning", instructions: "Reproduce", prompt: "Synthetic plan", securityContext: context, executionScope: scope, runId,
      tools: [modelTool("read")], toolbox: { byFunctionName: new Map([["read", { functionName: "read", definition: toolDefinition("app.projects.builder.file.read") }]]) },
      conversation: [{ type: "message", role: "user", content: "Synthetic plan" }, { type: "observation", source: "tool", untrusted: true, content: '{"origin":"forge_workflow","reads":[]}' }],
      toolSteps: 1, beforeModelTurn, generateTurn, remainingToolCalls: () => 46 }));
    const result = mode === "ordinary" ? await work() : await withSelfImprovementExecution(authority, work);
    expect(beforeModelTurn).toHaveBeenCalledTimes(mode === "pause" ? 0 : 1);
    expect(generateTurn).toHaveBeenCalledTimes(mode === "pause" ? 0 : 1);
    if (mode === "pause") {
      expect(result.events).toContainEqual(expect.objectContaining({ type: "status", forgeHandoff: expect.objectContaining({ outcome: "incomplete", reason: "authority_unavailable" }) }));
      expect(handoff.modelAttempted()).toBe(false);
    } else {
      const request = generateTurn.mock.calls[0]?.[0];
      expect(request?.toolChoice).toBe("none");
      if (mode === "final") expect(request?.instructions).toContain(FORGE_FINAL_BUDGET_INSTRUCTIONS);
      else expect(request?.instructions).not.toContain(FORGE_FINAL_BUDGET_INSTRUCTIONS);
    }
  });
  it.each(["complete", "no_headroom", "pause_after_context", "dispatch_failed", "checkpoint_after_failed"] as const)("keeps workflow context attributed and bounded (%s)", async mode => {
    const runId = "11111111-1111-4111-8111-111111111111", sessionId = `app_build_${"a".repeat(48)}`;
    const context = { tenantId: "t", actorId: "actor:owner", role: "operator" as const, source: "service" as const };
    const scope = createExecutionScope({ tenantId: "t", initiatingActorId: context.actorId, executingPrincipalType: "agent", executingPrincipalId: "atlas", projectId: "project", correlationId: runId, purpose: "self_improvement.cycle.v1" });
    const reads: InspectionReadReceipt[] = [];
    let revoked = false, chargedCalls = 0;
    const assertCurrent = async () => { if (revoked) throw new Error("Owner paused."); };
    const gate = createInspectionCompletionGate({ runId, sessionId, assertCurrent, readReceipts: async () => reads,
      contextReads: async () => [{ kind: "adjacent_test", path: "src/a.test.ts", startLine: 1, lineCount: 200, sourceExecutionId: "source", discoveryExecutionId: "search" }] });
    const authority: SelfImprovementExecutionAuthority = { tenantId: "t", ownerActorId: context.actorId, projectId: "project", repositoryId: "42", cycleId: "cycle", policySha256: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", readOnly: true, sessionId, inspectionCompletion: gate, assertCurrent };
    const executeTool = vi.fn(async (request: { input: Record<string, unknown> }) => {
      const id = reads.length ? "workflow-test" : "source";
      if (id === "workflow-test" && mode === "dispatch_failed") throw new Error("Private diagnostic must never enter the receipt.");
      reads.push({ executionId: id, path: String(request.input.path), inputSha256: "b".repeat(64), scopeSha256: "c".repeat(64) });
      if (reads.length > 1) expect(request).toMatchObject({ requireReadOnly: true, approved: false,
        idempotencyKey: `${runId}:inspection-workflow-read-1`, executionScope: { purpose: "agent.tool.execute", causationId: "inspection-workflow-read-1" }, input: { projectId: "project", sessionId } });
      return { record: executionRecord("app.projects.builder.file.read", "executed", { id }), result: { file: { path: request.input.path, content: "evidence", sha256: "d".repeat(64), lineRange: { startLine: 1, endLine: 1, totalLines: 1, truncated: false } } } };
    });
    const sourceCall = { callId: "source-call", name: "read", argumentsJson: '{"path":"src/a.ts","startLine":1,"lineCount":20}' };
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      if (generateTurn.mock.calls.length === 1) return { ...turn({ toolCalls: [sourceCall], cost: 0.001 }), continuation: { provider: "google" as const, state: [], conversation: [
        { type: "message" as const, role: "user" as const, content: "Inspect" }, { type: "tool_call" as const, ...sourceCall },
      ] } };
      expect(request.continuation?.state).toEqual([]);
      const transcript = request.continuation!.conversation!;
      expect(transcript.filter(item => item.type === "tool_call")).toHaveLength(1);
      expect(transcript.at(-1)).toMatchObject({ type: "observation", source: "tool", untrusted: true });
      expect(JSON.stringify(transcript.at(-1))).toContain("inspection_workflow");
      expect(request.toolResults).toBeUndefined();
      return turn({ text: '{"decision":"no_change","summary":"Inspected implementation and test."}', cost: 0.001 });
    });
    const beforeModelTurn = vi.fn(async () => ({ maxAttempts: 1, canContinueToolBatch: () => mode !== "no_headroom" }));
    const collected = await withSelfImprovementExecution(authority, async () => {
      const iterator = runNonOpenAIProviderToolLoop({ provider: "google", tier: "reasoning", instructions: "Inspect", prompt: "Inspect", securityContext: context, executionScope: scope, runId, requireReadOnly: true,
        tools: [modelTool("read")], toolbox: { byFunctionName: new Map([["read", { functionName: "read", definition: toolDefinition("app.projects.builder.file.read") }]]) },
        generateTurn, executeTool: executeTool as never, beforeModelTurn, remainingToolCalls: () => 48 - chargedCalls,
        checkpointAfterTool: async ({ record }) => { if (record.id === "workflow-test" && mode === "checkpoint_after_failed") throw new Error("Private checkpoint error must never enter the receipt."); },
        reserveTools: tools => { chargedCalls += tools.length; return undefined; } });
      const events: AgentEvent[] = [];
      for (;;) { const next = await iterator.next(); if (next.done) return { events, result: next.value }; events.push(next.value);
        if (mode === "pause_after_context" && next.value.type === "status" && next.value.inspectionCompletion?.outcome === "context_collected") revoked = true;
      }
    });
    const receipts = collected.events.flatMap(event => event.type === "status" && event.inspectionCompletion ? [event.inspectionCompletion] : []);
    expect(beforeModelTurn).toHaveBeenCalledTimes(mode === "complete" ? 2 : 1);
    expect(generateTurn).toHaveBeenCalledTimes(mode === "complete" ? 2 : 1);
    expect(executeTool).toHaveBeenCalledTimes(mode === "no_headroom" ? 1 : 2);
    expect(chargedCalls).toBe(mode === "no_headroom" ? 1 : 2);
    expect(receipts.at(-1)?.outcome).toBe(mode === "complete" ? "accepted" : "rejected");
    expect(receipts.at(-1)?.workflowContext?.origin).toBe("inspection_workflow");
    const diagnostic = receipts.at(-1)?.workflowContext;
    if (mode === "checkpoint_after_failed") expect(diagnostic).toMatchObject({ failureStage: "after_checkpoint", failedExecutionId: "workflow-test", refusal: "evidence_unavailable" });
    else if (mode === "dispatch_failed") {
      expect(diagnostic?.failureStage).toBe("dispatch");
      expect(diagnostic?.failedExecutionId).toBeUndefined();
    } else {
      expect(diagnostic?.failureStage).toBeUndefined();
      expect(diagnostic?.failedExecutionId).toBeUndefined();
    }
    expect(JSON.stringify(receipts)).not.toContain("Private");
    expect(collected.result.estimatedCostUsd).toBe(mode === "complete" ? 0.002 : 0.001);
  });

  it.each(["early", "correction", "final_only", "reservation_refused"] as const)("keeps inspection feedback within the same provider run and budget (%s)", async mode => {
    const runId = "11111111-1111-4111-8111-111111111111", sessionId = `app_build_${"a".repeat(48)}`;
    const context = { tenantId: "tenant-inspection", actorId: "actor:owner", role: "operator" as const, source: "service" as const };
    const scope = createExecutionScope({ tenantId: context.tenantId, initiatingActorId: context.actorId, executingPrincipalType: "agent", executingPrincipalId: "atlas", projectId: "project", correlationId: runId, purpose: "self_improvement.cycle.v1" });
    const reads: InspectionReadReceipt[] = [];
    const plan = { decision: "repair", plan: { summary: "Repair values", sourcePaths: ["src/a.ts"], focusedTestPaths: ["src/new.test.ts"], adjacentTestPaths: ["src/a.test.ts", "src/extra.test.ts"], acceptanceCriteria: ["Valid values"] } };
    const gate = createInspectionCompletionGate({ runId, sessionId, assertCurrent: async () => undefined, readReceipts: async () => reads });
    const authority: SelfImprovementExecutionAuthority = { tenantId: context.tenantId, ownerActorId: context.actorId, projectId: "project", repositoryId: "42", cycleId: "cycle", policySha256: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", readOnly: true, sessionId, inspectionCompletion: gate, assertCurrent: async () => undefined };
    const executeTool = vi.fn(async (request: { input: Record<string, unknown> }) => {
      reads.push({ executionId: `read-${reads.length}`, path: String(request.input.path), inputSha256: "b".repeat(64), scopeSha256: "c".repeat(64) });
      return { record: executionRecord("app.projects.builder.file.read", "executed"), result: { file: { path: request.input.path } } };
    });
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      const index = generateTurn.mock.calls.length;
      if (index === 1) return turn({ toolCalls: [{ callId: "source", name: "read", argumentsJson: '{"path":"src/a.ts"}' }], cost: 0.001 });
      expect(request.instructions).toContain("no existing adjacent test file has been read");
      if ((mode === "early" && index === 2) || (mode === "correction" && index === 3)) {
        if (mode === "correction") expect(request.instructions).toContain("one completion opportunity");
        return turn({ toolCalls: [{ callId: "test", name: "read", argumentsJson: '{"path":"src/a.test.ts"}' }], cost: 0.001 });
      }
      return turn({ text: JSON.stringify(plan), cost: 0.001 });
    });
    let reservations = 0;
    const collected = await withSelfImprovementExecution(authority, () => collect(runNonOpenAIProviderToolLoop({
      provider: "google", tier: "reasoning", instructions: "Inspect source", prompt: "Find one defect", securityContext: context, executionScope: scope, runId, requireReadOnly: true,
      tools: [modelTool("read")], toolbox: { byFunctionName: new Map([["read", { functionName: "read", definition: toolDefinition("app.projects.builder.file.read") }]]) },
      generateTurn, executeTool: executeTool as never, remainingToolCalls: () => 48 - executeTool.mock.calls.length,
      beforeModelTurn: async ({ requireToolRound }) => {
        if (requireToolRound && mode === "reservation_refused") return { reservationRefused: true, finalTurn: true };
        reservations++;
        return { maxAttempts: 1, finalTurn: mode === "final_only" ? reservations === 2 : mode === "early" && reservations === 3 };
      },
    })));
    const receipts = collected.events.flatMap(event => event.type === "status" && event.inspectionCompletion ? [event.inspectionCompletion] : []);
    const accepted = mode === "early" || mode === "correction";
    expect(receipts.at(-1)?.outcome).toBe(accepted ? "accepted" : "rejected");
    expect(generateTurn).toHaveBeenCalledTimes(mode === "early" ? 3 : mode === "correction" ? 4 : 2);
    expect(reservations).toBe(generateTurn.mock.calls.length);
    expect(executeTool).toHaveBeenCalledTimes(accepted ? 2 : 1);
    expect(receipts.filter(receipt => receipt.outcome === "reminder")).toHaveLength(1);
    expect(receipts.filter(receipt => receipt.outcome === "needs_reads")).toHaveLength(mode === "correction" || mode === "reservation_refused" ? 1 : 0);
    if (accepted) expect(receipts.at(-1)?.result).toEqual({ ...plan, plan: { ...plan.plan, newSourcePaths: [] } });
    else expect(receipts.at(-1)?.reason).toBe("completion_budget_unavailable");
    expect(collected.result.estimatedCostUsd).toBe(generateTurn.mock.calls.length * 0.001);
  });

  it.each([1, 2])("stops before another model reservation when inspection authority is revoked after %i paid turns", async revokeAfter => {
    const runId = "11111111-1111-4111-8111-111111111111", sessionId = `app_build_${"a".repeat(48)}`;
    const context = { tenantId: "tenant-inspection", actorId: "actor:owner", role: "operator" as const, source: "service" as const };
    const scope = createExecutionScope({ tenantId: context.tenantId, initiatingActorId: context.actorId, executingPrincipalType: "agent", executingPrincipalId: "atlas", projectId: "project", correlationId: runId, purpose: "self_improvement.cycle.v1" });
    const reads: InspectionReadReceipt[] = [];
    let revoked = false;
    const gate = createInspectionCompletionGate({ runId, sessionId, assertCurrent: async () => { if (revoked) throw new Error("Owner paused."); }, readReceipts: async () => reads });
    const authority: SelfImprovementExecutionAuthority = { tenantId: context.tenantId, ownerActorId: context.actorId, projectId: "project", repositoryId: "42", cycleId: "cycle", policySha256: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", readOnly: true, sessionId, inspectionCompletion: gate, assertCurrent: async () => undefined };
    const executeTool = vi.fn(async (request: { input: Record<string, unknown> }) => {
      reads.push({ executionId: `read-${reads.length}`, path: String(request.input.path), inputSha256: "b".repeat(64), scopeSha256: "c".repeat(64) });
      revoked = reads.length === revokeAfter;
      return { record: executionRecord("app.projects.builder.file.read", "executed"), result: { file: { path: request.input.path } } };
    });
    const generateTurn = vi.fn(async () => turn({ toolCalls: [{ callId: `read-${reads.length}`, name: "read", argumentsJson: JSON.stringify({ path: reads.length ? "src/a.test.ts" : "src/a.ts" }) }], cost: 0.001 }));
    const beforeModelTurn = vi.fn(async () => ({ maxAttempts: 1 }));
    const collected = await withSelfImprovementExecution(authority, () => collect(runNonOpenAIProviderToolLoop({
      provider: "google", tier: "reasoning", instructions: "Inspect source", prompt: "Find one defect", securityContext: context, executionScope: scope, runId, requireReadOnly: true,
      tools: [modelTool("read")], toolbox: { byFunctionName: new Map([["read", { functionName: "read", definition: toolDefinition("app.projects.builder.file.read") }]]) },
      generateTurn, executeTool: executeTool as never, beforeModelTurn, remainingToolCalls: () => 48 - reads.length,
    })));
    const receipts = collected.events.flatMap(event => event.type === "status" && event.inspectionCompletion ? [event.inspectionCompletion] : []);
    expect(beforeModelTurn).toHaveBeenCalledTimes(revokeAfter);
    expect(generateTurn).toHaveBeenCalledTimes(revokeAfter);
    expect(receipts.filter(receipt => receipt.outcome === "reminder")).toHaveLength(revokeAfter - 1);
    expect(receipts.at(-1)).toMatchObject({ outcome: "rejected", reason: "evidence_unavailable" });
    expect(collected.result.estimatedCostUsd).toBe(revokeAfter * 0.001);
  });

  it.each([true, false])("keeps a seven-call proposal recoverable without automatic replay (model continues: %s)", async (continues) => {
    let state = createRunBudgetState(AGENT_RUN_BUDGET_LIMITS);
    const calls = Array.from({ length: 7 }, (_, index) => ({ callId: `read-${index}`, name: "work_show", argumentsJson: JSON.stringify({ workItemId: `task-${index}`, projectId: "client", workspaceId: "client-workspace" }) }));
    const executeTool = vi.fn(async (request: { toolId: string; input: Record<string, unknown> }) => ({
      record: executionRecord(request.toolId, "executed"), result: { saved: request.input },
    }));
    let modelTurn = 0;
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      modelTurn += 1;
      expect(request.toolChoice).not.toBe("none");
      if (modelTurn === 1) return turn({ toolCalls: calls });
      if (modelTurn === 2) {
        expect(executeTool).toHaveBeenCalledTimes(5);
        expect(request.toolResults).toHaveLength(7);
        for (const [index, output] of request.toolResults!.slice(5).entries()) {
          expect(JSON.parse(output.output)).toMatchObject({ trust: "untrusted_data", data: {
            executed: false, skippedCall: { callId: calls[index + 5].callId, toolName: "work_show" },
            toolLimit: { version: 1, reason: "per_turn_calls", proposedCalls: 7, admittedCalls: 5, skippedCalls: 2, remainingToolCalls: 25, remainingToolRounds: 7 },
            nextStep: expect.stringContaining("next model turn"),
          } });
        }
        if (!continues) return turn({ text: "Finished." });
        return turn({ toolCalls: calls.slice(5).map((call, index) => ({ ...call, callId: `retry-${index}`, argumentsJson: JSON.stringify({ workspaceId: "client-workspace", projectId: "client", workItemId: `task-${index + 5}` }) })) });
      }
      if (modelTurn === 3) return turn({ toolCalls: [{ callId: "save-brief", name: "project_update", argumentsJson: JSON.stringify({ projectId: "client", objective: "Reconciled source commitments." }) }] });
      if (modelTurn === 4) return turn({ toolCalls: [{ callId: "verify-brief", name: "project_show", argumentsJson: JSON.stringify({ projectId: "client", includeFullObjective: true }) }] });
      return turn({ text: "Brief saved and read back." });
    });
    const tools = [
      ["work_show", toolDefinition("app.work_items.show")],
      ["project_update", toolDefinition("app.projects.update", { riskLevel: 1 })],
      ["project_show", toolDefinition("app.projects.show")],
    ] as const;
    const collected = await collect(runNonOpenAIProviderToolLoop({
      provider: "google", tier: "fast", instructions: "Reconcile and verify the authorized project.", prompt: "Read seven tasks, then update and read back the project brief.",
      tools: tools.map(([name]) => modelTool(name)),
      toolbox: { byFunctionName: new Map(tools.map(([functionName, definition]) => [functionName, { functionName, definition }])) },
      securityContext: { tenantId: "tenant-client", actorId: "owner", role: "operator", source: "default" },
      runId: "run-recoverable", maxToolSteps: AGENT_MAX_TOOL_STEPS,
      beforeModelTurn: async ({ toolsEnabled }) => {
        const plan = planModelTurnBudget(state, { estimate: { tokens: 1, costMicrousd: 1, followUpTokens: 1, followUpCostMicrousd: 1 }, toolsEnabled, allowRetry: false });
        state = plan.state;
        return { maxAttempts: 1, finalTurn: plan.finalTurn };
      },
      reserveTools: (definitions) => { state = reserveRunBudget(state, { toolCalls: definitions.length }); return undefined; },
      remainingToolCalls: () => remainingRunBudget(state).toolCalls,
      generateTurn, executeTool: executeTool as never,
    }));
    expect(executeTool).toHaveBeenCalledTimes(continues ? 9 : 5);
    expect(generateTurn).toHaveBeenCalledTimes(continues ? 5 : 2);
    expect(collected.result.deferredToolCallHashes).toHaveLength(continues ? 0 : 2);
    expect(collected.events).toContainEqual(expect.objectContaining({ type: "status", label: "tool calls deferred", toolLimit: expect.objectContaining({ reason: "per_turn_calls", skippedCalls: 2 }) }));
    expect(collected.events.some((event) => event.type === "status" && event.label === "requested actions unfinished")).toBe(!continues);
    expect(collected.events.some((event) => event.type === "status" && event.label === "tool budget reached")).toBe(false);
    expect(state.limits).toMatchObject({ toolCalls: 30, modelTurns: AGENT_RUN_BUDGET_LIMITS.modelTurns });
    expect(state.used).toMatchObject({ toolCalls: continues ? 9 : 5, retries: 0 });
    if (continues) {
      expect(executeTool).toHaveBeenNthCalledWith(8, expect.objectContaining({ toolId: "app.projects.update", input: { projectId: "client", objective: "Reconciled source commitments." }, dryRun: false, approved: false,
        idempotencyKey: "run-recoverable:google:save-brief", context: expect.objectContaining({ tenantId: "tenant-client", actorId: "owner" }) }));
      expect(executeTool).toHaveBeenNthCalledWith(9, expect.objectContaining({ toolId: "app.projects.show", input: { projectId: "client", includeFullObjective: true } }));
    }
  });

  it("keeps earlier deferred calls unfinished when they are skipped again on the last allowed round", async () => {
    let requests = 0;
    let usedCalls = 0;
    const deferred = [5, 6].map((id) => ({ callId: `deferred-${id}`, name: "work_show", argumentsJson: JSON.stringify({ id }) }));
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      requests += 1;
      if (requests === 3) {
        expect(request.toolChoice).toBe("none");
        expect(request.toolResults!.slice(5).map((result) => JSON.parse(result.output).data.toolLimit.reason)).toEqual(["run_tool_rounds", "run_tool_rounds"]);
        return turn({ text: "Finished from available results." });
      }
      return turn({ toolCalls: [
        ...Array.from({ length: 5 }, (_, index) => ({ callId: `admitted-${requests}-${index}`, name: "work_show", argumentsJson: JSON.stringify({ id: `${requests}-${index}` }) })),
        ...deferred.map((call) => ({ ...call, callId: `${call.callId}-${requests}` })),
      ] });
    });
    const executeTool = vi.fn(async () => ({ record: executionRecord("app.work_items.show", "executed"), result: { observed: true } }));
    const collected = await collect(runNonOpenAIProviderToolLoop({
      provider: "google", tier: "fast", instructions: "Read saved work.", prompt: "Verify the saved commitments.",
      tools: [modelTool("work_show")],
      toolbox: { byFunctionName: new Map([["work_show", { functionName: "work_show", definition: toolDefinition("app.work_items.show") }]]) },
      securityContext: { tenantId: "tenant-client", actorId: "owner", role: "operator", source: "default" },
      runId: "run-final-deferred", maxToolSteps: 2,
      reserveTools: (tools) => { usedCalls += tools.length; return undefined; },
      remainingToolCalls: () => 30 - usedCalls,
      generateTurn, executeTool: executeTool as never,
    }));
    expect(generateTurn).toHaveBeenCalledTimes(3);
    expect(executeTool).toHaveBeenCalledTimes(10);
    expect(collected.result.deferredToolCallHashes).toHaveLength(2);
    expect(collected.events).toContainEqual(expect.objectContaining({ type: "status", label: "requested actions unfinished", toolLimit: expect.objectContaining({ reason: "run_tool_rounds", unresolvedCalls: 2, remainingToolCalls: 20, remainingToolRounds: 0 }) }));
  });

  it("executes ordinary rounds seven and eight and makes round nine final within 14 model turns", async () => {
    const fixture = budgetedToolLoop({ callsPerTurn: 1, usedModelTurns: 5 });
    const collected = await collect(fixture.loop);
    expect(fixture.executeTool).toHaveBeenCalledTimes(8);
    expect(fixture.generateTurn).toHaveBeenCalledTimes(9);
    expect(fixture.generateTurn.mock.calls.map(([request]) => request.toolChoice))
      .toEqual([...Array(8).fill(undefined), "none"]);
    expect(collected.result).toMatchObject({ text: "Finished from observed results.", toolSteps: 8 });
    expect(fixture.state().used).toMatchObject({ modelTurns: 14, toolCalls: 8 });
  });

  it("finishes after 30 calls even with two tool rounds remaining", async () => {
    const fixture = budgetedToolLoop({ callsPerTurn: 5 });
    const collected = await collect(fixture.loop);
    expect(fixture.executeTool).toHaveBeenCalledTimes(30);
    expect(fixture.generateTurn).toHaveBeenCalledTimes(7);
    expect(fixture.generateTurn.mock.calls.at(-1)?.[0].toolChoice).toBe("none");
    expect(collected.result.toolSteps).toBe(6);
    expect(fixture.state().used.toolCalls).toBe(30);
  });

  it.each([0, 1] as const)("bounds a risk-%s batch to the two remaining calls and answers every skipped call", async (riskLevel) => {
    const fixture = budgetedToolLoop({ callsPerTurn: 5, usedToolCalls: 28, riskLevel });
    await collect(fixture.loop);
    expect(fixture.executeTool).toHaveBeenCalledTimes(2);
    expect(fixture.state().used.toolCalls).toBe(30);
    const final = fixture.generateTurn.mock.calls.at(-1)![0];
    expect(final.toolChoice).toBe("none");
    expect(final.toolResults).toHaveLength(5);
    expect(final.toolResults!.slice(2).every((result) => result.isError && result.output.includes("Run tool-call budget reached"))).toBe(true);
  });

  it("retains call-budget refusals in an approval continuation", async () => {
    const fixture = budgetedToolLoop({ callsPerTurn: 5, usedToolCalls: 29, riskLevel: 1, approval: true });
    const collected = await collect(fixture.loop);
    expect(fixture.executeTool).toHaveBeenCalledOnce();
    expect(collected.result.waitingApproval?.providerState.queuedCalls).toHaveLength(4);
    expect(collected.result.waitingApproval?.providerState.queuedCalls.every((call) => call.skipReason?.includes("Run tool-call budget reached"))).toBe(true);
  });

  it("keeps exact Library content pages and canonical citations intact in the writer's tool envelope", async () => {
    const contentPage = {
      schemaVersion: 1, contentTrust: "untrusted", sourceRevisionId: "revision-client",
      units: [{ knowledgeChunkId: "client-unit", evidenceUnitId: "evidence-client", citationId: "knowledge:client-unit", content: "Acceptance criteria " + "a".repeat(4_300) }],
      next: { versionId: "version-client", contentSha256: "a".repeat(64), unitIndex: 1, characterOffset: 0, extractionReceiptSha256: "b".repeat(64) },
      coverage: { startsAtBeginning: true, endsAtEnd: false, wholeExtractedText: false },
    };
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      if (!request.toolResults) return turn({ toolCalls: [{ callId: "library-call", name: "library_show", argumentsJson: "{}" }] });
      const payload = JSON.parse(request.toolResults[0].output);
      expect(payload.data.result.contentPage).toEqual(contentPage);
      expect(payload.data.admissibleEvidenceIds).toEqual(["knowledge:client-unit"]);
      return turn({ text: "First page read; additional acceptance evidence remains [knowledge:client-unit]." });
    });
    const result = await collect(runNonOpenAIProviderToolLoop({
      provider: "google", tier: "fast", instructions: "Read each returned page.", prompt: "Read the entire client document.",
      tools: [modelTool("library_show")],
      toolbox: { byFunctionName: new Map([["library_show", { definition: toolDefinition("app.library.show"), functionName: "library_show" }]]) },
      securityContext: { tenantId: "tenant-client", actorId: "owner", role: "admin", source: "default" }, runId: "run-library-page",
      generateTurn,
      executeTool: vi.fn(async () => ({ record: executionRecord("app.library.show", "executed"), result: { item: { title: "Client brief" }, contentPage } })) as never,
    }));
    expect(result.result.citationSources).toEqual([expect.objectContaining({ citationId: "knowledge:client-unit", title: "Client brief" })]);
  });

  it.each(["knowledge.search", "app.knowledge.search"])("admits only provenance-bound %s citations and exposes exactly the observed output", async (toolId) => {
    const observations: unknown[] = [];
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      if (!request.toolResults) return turn({ toolCalls: [{ callId: "knowledge-call", name: "knowledge_search", argumentsJson: "{}" }] });
      expect(JSON.parse(request.toolResults[0].output).data.admissibleEvidenceIds).toEqual(["knowledge:canonical-chunk"]);
      expect(observations).toEqual([expect.objectContaining({
        executionId: `execution-${toolId}`, toolId, status: "executed", modelOutput: request.toolResults[0].output,
      })]);
      return turn({ text: "Canonical source [knowledge:canonical-chunk]." });
    });
    const collected = await collect(runNonOpenAIProviderToolLoop({
      provider: "google", tier: "fast", instructions: "Read the source.", prompt: "Read the client.",
      tools: [modelTool("knowledge_search")],
      toolbox: { byFunctionName: new Map([["knowledge_search", { definition: toolDefinition(toolId), functionName: "knowledge_search" }]]) },
      securityContext: { tenantId: "tenant-client", actorId: "owner", role: "admin", source: "default" },
      runId: "run-knowledge-parity", generateTurn,
      onToolObservation: (observation) => observations.push(observation),
      executeTool: vi.fn(async () => ({ record: executionRecord(toolId, "executed"), result: { results: [
        { chunk: { id: "canonical-chunk", title: "Client brief", sourceRevisionId: "revision-1", evidenceUnitId: "unit-1" }, score: 0.9 },
        { chunk: { id: "no-revision", evidenceUnitId: "unit-2" } },
        { chunk: { id: "no-unit", sourceRevisionId: "revision-1" } },
        { chunk: { id: "invalid id", sourceRevisionId: "revision-1", evidenceUnitId: "unit-3" } },
      ] } })) as never,
    }));
    expect(collected.result.citationSources).toEqual([expect.objectContaining({ citationId: "knowledge:canonical-chunk", evidenceId: "canonical-chunk", title: "Client brief" })]);
  });

  it.each([
    { name: "Research report", maxOutputTokens: 6_000, expected: 6_000, resumed: false },
    { name: "ordinary run", maxOutputTokens: undefined, expected: AGENT_MAX_OUTPUT_TOKENS, resumed: false },
    { name: "legacy continuation", maxOutputTokens: undefined, expected: AGENT_MAX_OUTPUT_TOKENS, resumed: true },
  ])("keeps the $name output cap through source reading and final synthesis", async ({ maxOutputTokens, expected, resumed }) => {
    const requests: ModelToolTurnRequest[] = [];
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      requests.push(request);
      return requests.length === 1
        ? turn({ toolCalls: [{ callId: "call-report-source", name: "web_read", argumentsJson: "{}" }] })
        : turn({ text: "Report based on the source evidence." });
    });
    const executeTool = vi.fn(async () => ({
      record: executionRecord("web.read", "executed"),
      result: { content: "Source evidence for the report." },
    }));

    const collected = await collect(runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Research the evidence and write a detailed report.",
      prompt: "Compare the supplied source findings.",
      tools: [modelTool("web_read")],
      toolbox: {
        byFunctionName: new Map([["web_read", {
          definition: toolDefinition("web.read"),
          functionName: "web_read",
        }]]),
      },
      securityContext: { tenantId: "tenant-research", actorId: "owner", role: "operator", source: "default" },
      runId: `run-report-cap-${resumed ? "resumed" : expected}`,
      ...(resumed ? { continuation: turn({}).continuation } : {}),
      maxOutputTokens,
      maxToolSteps: 1,
      requireReadOnly: true,
      generateTurn,
      executeTool: executeTool as never,
    }));

    expect(collected.result).toMatchObject({ text: "Report based on the source evidence.", turns: 2, toolSteps: 1 });
    expect(requests.map((request) => request.maxOutputTokens)).toEqual([expected, expected]);
    expect(requests.map((request) => request.toolChoice)).toEqual([undefined, "none"]);
    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({ toolId: "web.read", requireReadOnly: true }));
  });

  it("keeps a third bounded turn for synthesis after two sequential read rounds", async () => {
    let turnIndex = 0;
    const generateTurn = vi.fn(async () => {
      turnIndex += 1;
      if (turnIndex === 1) {
        return turn({
          toolCalls: [{
            callId: "call-read-a",
            name: "read_a",
            argumentsJson: "{}",
          }],
        });
      }
      if (turnIndex === 2) {
        return turn({
          toolCalls: [{
            callId: "call-read-b",
            name: "read_b",
            argumentsJson: "{}",
          }],
        });
      }
      return turn({ text: "Bounded synthesis complete." });
    });
    const executeTool = vi.fn(async (request: { toolId: string }) => ({
      record: executionRecord(request.toolId, "executed"),
      result: { source: request.toolId },
    }));
    const beforeModelTurn = vi.fn(async (input: { attempt: number }) => {
      if (input.attempt > DYNAMIC_DELEGATION_CHILD_BUDGET.modelTurns) {
        throw new Error("Delegated child model-turn budget exceeded.");
      }
      return { maxAttempts: 1 };
    });

    const collected = await collect(runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Use both granted reads, then synthesize.",
      prompt: "Inspect both sources.",
      tools: [modelTool("read_a"), modelTool("read_b")],
      toolbox: {
        byFunctionName: new Map([
          ["read_a", { definition: toolDefinition("read.a"), functionName: "read_a" }],
          ["read_b", { definition: toolDefinition("read.b"), functionName: "read_b" }],
        ]),
      },
      securityContext: {
        tenantId: "tenant-child",
        actorId: "owner",
        role: "operator",
        source: "default",
      },
      runId: "run-child-three-turns",
      requireReadOnly: true,
      maxToolSteps: 2,
      beforeModelTurn: beforeModelTurn as never,
      generateTurn,
      executeTool: executeTool as never,
    }));

    expect(collected.result).toMatchObject({
      text: "Bounded synthesis complete.",
      turns: 3,
      toolSteps: 2,
    });
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenNthCalledWith(1, expect.objectContaining({
      toolId: "read.a", requireReadOnly: true,
    }));
    expect(executeTool).toHaveBeenNthCalledWith(2, expect.objectContaining({
      toolId: "read.b", requireReadOnly: true,
    }));
    expect(beforeModelTurn).toHaveBeenCalledTimes(3);
  });

  it("keeps required reads available after one bounded unknown-tool repair round", async () => {
    let turnIndex = 0;
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      turnIndex += 1;
      if (turnIndex === 1) {
        expect(request.tools).toHaveLength(2);
        expect(request.toolChoice).toBeUndefined();
        return turn({
          toolCalls: [{
            callId: "call-unknown",
            name: "invented_search",
            argumentsJson: "{}",
          }],
        });
      }
      if (turnIndex === 2) {
        expect(request.toolResults).toHaveLength(1);
        expect(request.toolResults![0].output).toContain("Unknown tool invented_search");
        return turn({
          toolCalls: [{
            callId: "call-knowledge",
            name: "knowledge_search",
            argumentsJson: "{}",
          }],
        });
      }
      if (turnIndex === 3) {
        return turn({
          toolCalls: [{
            callId: "call-memory",
            name: "memory_search",
            argumentsJson: "{}",
          }],
        });
      }
      // The final turn keeps every tool declared and asks for no call.
      expect(request.tools).toEqual([
        modelTool("knowledge_search"),
        modelTool("memory_search"),
      ]);
      expect(request.toolChoice).toBe("none");
      return turn({ text: "Both governed reads completed after repair." });
    });
    const executeTool = vi.fn(async (request: { toolId: string }) => ({
      record: executionRecord(request.toolId, "executed"),
      result: { source: request.toolId },
    }));
    const beforeModelTurn = vi.fn(async (input: { attempt: number }) => {
      if (input.attempt > DYNAMIC_DELEGATION_CHILD_BUDGET.modelTurns) {
        throw new Error("Delegated child model-turn budget exceeded.");
      }
      return { maxAttempts: 1 };
    });

    const collected = await collect(runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use both required reads, then synthesize.",
      prompt: "Inspect knowledge and memory.",
      tools: [modelTool("knowledge_search"), modelTool("memory_search")],
      toolbox: {
        byFunctionName: new Map([
          ["knowledge_search", {
            definition: toolDefinition("knowledge.search"),
            functionName: "knowledge_search",
          }],
          ["memory_search", {
            definition: toolDefinition("memory.search"),
            functionName: "memory_search",
          }],
        ]),
      },
      securityContext: {
        tenantId: "tenant-child",
        actorId: "owner",
        role: "operator",
        source: "default",
      },
      runId: "run-child-tool-repair",
      maxToolSteps: dynamicDelegationMaxToolSteps(
        DYNAMIC_DELEGATION_CHILD_BUDGET,
      ),
      beforeModelTurn: beforeModelTurn as never,
      generateTurn,
      executeTool: executeTool as never,
    }));

    expect(collected.result).toMatchObject({
      text: "Both governed reads completed after repair.",
      turns: 4,
      toolSteps: 3,
    });
    expect(executeTool.mock.calls.map(([request]) => request.toolId)).toEqual([
      "knowledge.search",
      "memory.search",
    ]);
    expect(beforeModelTurn).toHaveBeenCalledTimes(4);
    expect(
      collected.events.filter((event) => event.type === "tool"),
    ).toHaveLength(4);
  });

  it("refuses a fourth tool round once, then fails closed", async () => {
    let turnIndex = 0;
    const requests: ModelToolTurnRequest[] = [];
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      turnIndex += 1;
      requests.push(request);
      if (turnIndex > 5) throw new Error("The loop asked for a sixth turn.");
      return turn({
        toolCalls: [{
          callId: `call-${turnIndex}`,
          name: "knowledge_search",
          argumentsJson: "{}",
        }],
      });
    });
    const executeTool = vi.fn(async () => ({
      record: executionRecord("knowledge.search", "executed"),
      result: { ok: true },
    }));

    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Stay within the delegated tool budget.",
      prompt: "Search knowledge.",
      tools: [modelTool("knowledge_search")],
      toolbox: {
        byFunctionName: new Map([["knowledge_search", {
          definition: toolDefinition("knowledge.search"),
          functionName: "knowledge_search",
        }]]),
      },
      securityContext: {
        tenantId: "tenant-child",
        actorId: "owner",
        role: "operator",
        source: "default",
      },
      runId: "run-child-tool-repair-exhausted",
      maxToolSteps: dynamicDelegationMaxToolSteps(
        DYNAMIC_DELEGATION_CHILD_BUDGET,
      ),
      generateTurn,
      executeTool: executeTool as never,
    });

    await expect(collect(loop)).rejects.toThrow(
      "google returned tool calls after the governed tool-step budget was exhausted.",
    );
    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(requests.map((request) => request.toolChoice)).toEqual([
      undefined,
      undefined,
      undefined,
      "none",
      "none",
    ]);
    expect(requests.map((request) => request.tools)).toEqual(
      requests.map(() => [modelTool("knowledge_search")]),
    );
    // The refused call is answered, so the fifth turn is valid.
    expect(requests[4].toolResults).toEqual([{
      callId: "call-4",
      name: "knowledge_search",
      output: JSON.stringify({
        provenance: "tool_result",
        trust: "untrusted_data",
        data: {
          error: "Tool step budget reached; call not run. Answer in text from the results you already have.",
        },
      }),
      isError: true,
    }]);
  });

  it("estimates each turn from what it sends and settles what it spent", async () => {
    const first = turn({
      toolCalls: [{ callId: "call-read", name: "read_a", argumentsJson: "{}" }],
      inputTokens: 40,
      outputTokens: 5,
    });
    const second = turn({ text: "Done.", inputTokens: 900, outputTokens: 7 });
    const requests: ModelToolTurnRequest[] = [];
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      requests.push(request);
      return requests.length === 1 ? first : second;
    });
    const executeTool = vi.fn(async (request: { toolId: string }) => ({
      record: executionRecord(request.toolId, "executed"),
      result: { excerpt: "x".repeat(2_000) },
    }));
    const settle = vi.fn();
    const beforeModelTurn = vi.fn(async (_input: {
      estimatedInputTokens: number;
      toolsEnabled: boolean;
    }) => ({ maxAttempts: 1, settle }));

    await collect(runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Read once, then answer.",
      prompt: "Inspect the source.",
      tools: [modelTool("read_a")],
      toolbox: {
        byFunctionName: new Map([["read_a", {
          definition: toolDefinition("read.a"),
          functionName: "read_a",
        }]]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-turn-estimates",
      beforeModelTurn: beforeModelTurn as never,
      generateTurn,
      executeTool: executeTool as never,
    }));

    const estimates = beforeModelTurn.mock.calls.map(
      ([call]) => call.estimatedInputTokens,
    );
    expect(estimates).toEqual([
      estimateModelInputTokens([
        "Read once, then answer.",
        [modelTool("read_a")],
        "Inspect the source.",
        undefined,
      ]),
      estimateModelInputTokens([
        "Read once, then answer.",
        [modelTool("read_a")],
        [],
        requests[1].toolResults,
      ]),
    ]);
    // The second turn also sends the 2,000-character read result.
    expect(estimates[1] - estimates[0]).toBeGreaterThanOrEqual(500);
    expect(settle.mock.calls).toEqual([[first], [second]]);
  });

  it("asks for the answer once the run's budget has no room for a tool round", async () => {
    const requests: ModelToolTurnRequest[] = [];
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      requests.push(request);
      return turn({
        toolCalls: [{
          callId: `call-${requests.length}`,
          name: "read_a",
          argumentsJson: "{}",
        }],
      });
    });
    const executeTool = vi.fn(async (request: { toolId: string }) => ({
      record: executionRecord(request.toolId, "executed"),
      result: { source: request.toolId },
    }));
    // Only the second reservation finds the budget final; the third turn
    // must stay final anyway.
    const beforeModelTurn = vi.fn(async (input: {
      attempt: number;
      toolsEnabled: boolean;
    }) => ({ maxAttempts: 1, finalTurn: input.attempt === 2 }));
    const events: AgentEvent[] = [];
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Read, then answer.",
      prompt: "Inspect the source.",
      tools: [modelTool("read_a")],
      toolbox: {
        byFunctionName: new Map([["read_a", {
          definition: toolDefinition("read.a"),
          functionName: "read_a",
        }]]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-budget-final",
      beforeModelTurn: beforeModelTurn as never,
      generateTurn,
      executeTool: executeTool as never,
    });

    await expect((async () => {
      for await (const event of loop) events.push(event);
    })()).rejects.toThrow(
      "google returned tool calls after the run's budget left no room for another tool round.",
    );
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(requests.map((request) => request.toolChoice)).toEqual([
      undefined,
      "none",
      "none",
    ]);
    expect(beforeModelTurn.mock.calls.map(([call]) => call.toolsEnabled))
      .toEqual([true, true, false]);
    expect(events.filter((event) =>
      event.type === "status" && event.label === "finishing within budget"
    )).toHaveLength(1);
    expect(requests[2].toolResults).toEqual([{
      callId: "call-2",
      name: "read_a",
      output: JSON.stringify({
        provenance: "tool_result",
        trust: "untrusted_data",
        data: {
          error: "Run budget reached; call not run. Answer in text from the results you already have.",
        },
      }),
      isError: true,
    }]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      label: "tool calls refused",
      detail: "1 tool call(s) past the run's budget were not run; asking the model again for its final answer.",
    }));
  });

  it("asks once more for the answer when the final turn still calls a tool", async () => {
    const refusedTurnContinuation = {
      provider: "google" as const,
      state: [{ turn: 2 }],
    };
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      // The third turn follows the turn whose calls were refused.
      expect(request.continuation).toBe(refusedTurnContinuation);
      return turn({ text: "Final answer." });
    });
    generateTurn
      .mockImplementationOnce(async () => turn({
        toolCalls: [{ callId: "call-read", name: "read_a", argumentsJson: "{}" }],
      }))
      .mockImplementationOnce(async () => ({
        ...turn({
          text: "One more read first. ",
          toolCalls: [
            { callId: "call-extra-1", name: "read_a", argumentsJson: "{}" },
            { callId: "call-extra-2", name: "read_a", argumentsJson: "{}" },
          ],
        }),
        continuation: refusedTurnContinuation,
      }));
    const executeTool = vi.fn(async (request: { toolId: string }) => ({
      record: executionRecord(request.toolId, "executed"),
      result: { source: request.toolId },
    }));

    const collected = await collect(runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Read once, then answer.",
      prompt: "Inspect the source.",
      tools: [modelTool("read_a")],
      toolbox: {
        byFunctionName: new Map([
          ["read_a", { definition: toolDefinition("read.a"), functionName: "read_a" }],
        ]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-final-turn-refusal",
      maxToolSteps: 1,
      generateTurn,
      executeTool: executeTool as never,
    }));

    expect(executeTool).toHaveBeenCalledOnce();
    expect(collected.result).toMatchObject({
      text: "One more read first. Final answer.",
      turns: 3,
      toolSteps: 1,
    });
    const requests = generateTurn.mock.calls.map(([request]) => request);
    expect(requests.map((request) => request.toolChoice)).toEqual([
      undefined,
      "none",
      "none",
    ]);
    expect(requests.map((request) => request.parallelToolCalls)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(requests[2].toolResults?.map((result) => [
      result.callId,
      result.isError,
      JSON.parse(result.output).data.error,
    ])).toEqual([
      ["call-extra-1", true, "Tool step budget reached; call not run. Answer in text from the results you already have."],
      ["call-extra-2", true, "Tool step budget reached; call not run. Answer in text from the results you already have."],
    ]);
    const statuses = collected.events.filter((event) => event.type === "status");
    expect(statuses).toContainEqual({
      type: "status",
      label: "tool calls refused",
      detail:
        "2 tool call(s) after the tool step budget were not run; asking the model again for its final answer.",
    });
    // Only the first turn's call ran: its start and its result.
    expect(
      collected.events.flatMap((event) =>
        event.type === "tool" ? [event.status] : []
      ),
    ).toEqual(["running", "executed"]);
  });

  it("asks a This Mac run for one tool call per turn", async () => {
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) =>
      request.toolResults
        ? turn({ text: "Observed." })
        : turn({
            toolCalls: [{ callId: "call-observe", name: "local_observe", argumentsJson: "{}" }],
          })
    );

    await collect(runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Observe this Mac.",
      prompt: "Look.",
      tools: [modelTool("local_observe")],
      toolbox: {
        byFunctionName: new Map([["local_observe", {
          definition: toolDefinition("local.macos.observe"),
          functionName: "local_observe",
        }]]),
      },
      securityContext: {
        tenantId: "tenant-local",
        actorId: "owner-local",
        role: "admin",
        source: "default",
      },
      runId: "run-local-one-call",
      maxToolSteps: 1,
      computerUseTarget: "local_macos",
      generateTurn,
      executeTool: vi.fn(async () => ({
        record: executionRecord("local.macos.observe", "executed"),
        result: { observed: true },
      })) as never,
    }));

    expect(generateTurn.mock.calls.map(([request]) => [
      request.toolChoice,
      request.parallelToolCalls,
    ])).toEqual([
      [undefined, false],
      ["none", false],
    ]);
  });

  it("executes safe calls through governance and aggregates every model turn", async () => {
    const firstCalls: ModelToolCall[] = [
      { callId: "call-1", name: "memory_search", argumentsJson: "{\"query\":\"Ada\"}" },
      { callId: "call-2", name: "knowledge_search", argumentsJson: "{\"query\":\"Lovelace\"}" },
    ];
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      if (!request.toolResults) {
        expect(request.input).toBe("Find Ada Lovelace");
        expect(request.conversation).toEqual([
          { type: "message", role: "user", content: "Find Ada." },
          { type: "message", role: "assistant", content: "Which Ada?" },
          {
            type: "observation",
            source: "knowledge",
            content: "Ada Lovelace",
            untrusted: true,
          },
        ]);
        return turn({ toolCalls: firstCalls, inputTokens: 10, outputTokens: 2, cost: 0.001 });
      }
      expect(request.preferredProvider).toBe("google");
      expect(request.allowedProviders).toEqual(["google"]);
      expect(request.allowCrossProviderFallback).toBe(false);
      expect(request.toolResults).toHaveLength(2);
      expect(JSON.parse(request.toolResults![0].output)).toMatchObject({
        provenance: "tool_result",
        data: {
          executionId: "execution-memory.search",
          admissibleEvidenceIds: [],
        },
      });
      expect(JSON.parse(request.toolResults![1].output)).toMatchObject({
        provenance: "tool_result",
        data: {
          executionId: "execution-knowledge.search",
          admissibleEvidenceIds: ["knowledge:chunk-ada"],
        },
      });
      return turn({ text: "Ada Lovelace found.", inputTokens: 12, outputTokens: 4, cost: 0.002 });
    });
    const executeTool = vi.fn(async (request: { toolId: string }) => ({
      record: executionRecord(request.toolId, "executed"),
      result: request.toolId === "knowledge.search"
        ? {
            results: [{
              score: 0.98,
              chunk: {
                id: "chunk-ada",
                sourceRevisionId: "revision-ada",
                evidenceUnitId: "evidence-ada",
                title: "Ada Lovelace",
                content: "Ada Lovelace found.",
              },
            }],
          }
        : { matches: [request.toolId] },
    }));
    const beforeModelTurn = vi.fn(async (_input: {
      attempt: number;
      provider: "openai" | "google" | "anthropic" | "aws_bedrock";
      tier: "fast" | "reasoning";
    }) => ({ maxAttempts: 1 }));

    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use tools when needed.",
      prompt: "Find Ada Lovelace",
      conversation: [
        { type: "message", role: "user", content: "Find Ada." },
        { type: "message", role: "assistant", content: "Which Ada?" },
        {
          type: "observation",
          source: "knowledge",
          content: "Ada Lovelace",
          untrusted: true,
        },
      ],
      tools: [modelTool("memory_search"), modelTool("knowledge_search")],
      toolbox: {
        byFunctionName: new Map([
          ["memory_search", { definition: toolDefinition("memory.search"), functionName: "memory_search" }],
          ["knowledge_search", { definition: toolDefinition("knowledge.search"), functionName: "knowledge_search" }],
        ]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-1",
      modelAttemptOffset: 4,
      beforeModelTurn,
      generateTurn,
      executeTool: executeTool as never,
    });
    const collected = await collect(loop);

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(collected.events.filter((event) => event.type === "tool").map((event) => event.status)).toEqual([
      "running",
      "running",
      "executed",
      "executed",
    ]);
    expect(collected.result).toMatchObject({
      text: "Ada Lovelace found.",
      provider: "google",
      turns: 2,
      latencyMs: 20,
      usage: { inputTokens: 22, outputTokens: 6, totalTokens: 28 },
      estimatedCostUsd: 0.003,
      costKnown: true,
    });
    expect(collected.result.attempts).toHaveLength(2);
    expect(collected.result.citationSources).toEqual([
      expect.objectContaining({
        citationId: "knowledge:chunk-ada",
        evidenceId: "chunk-ada",
        kind: "knowledge",
      }),
    ]);
    expect(generateTurn.mock.calls.every(([request]) => request.maxAttempts === 1))
      .toBe(true);
    expect(beforeModelTurn.mock.calls.map(([call]) => call)).toEqual([
      {
        attempt: 5,
        provider: "google",
        tier: "fast",
        estimatedInputTokens: expect.any(Number),
        toolsEnabled: true,
      },
      {
        attempt: 6,
        provider: "google",
        tier: "fast",
        estimatedInputTokens: expect.any(Number),
        toolsEnabled: true,
      },
    ]);
    expect(
      collected.events
        .filter((event) => event.type === "model")
        .map((event) => event.iteration),
    ).toEqual([5, 6]);
  });

  it("supplies the next provider turn with the governed local Mac observation", async () => {
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      if (!request.toolResults) {
        return turn({
          toolCalls: [{
            callId: "call-observe",
            name: "local_observe",
            argumentsJson: "{\"ref\":\"e7\"}",
          }],
        });
      }
      expect(request.toolResults).toEqual([expect.objectContaining({
        callId: "call-observe",
        output: expect.stringContaining("tool_result"),
        computerObservation: expect.objectContaining({
          executionId: "execution-local-observe",
          accessibilitySnapshot: expect.stringContaining("Success"),
          screenshot: expect.objectContaining({ mimeType: "image/webp" }),
        }),
      })]);
      return turn({ text: "The click succeeded; continue." });
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use what this Mac actually shows.",
      prompt: "Continue",
      tools: [modelTool("local_observe")],
      toolbox: {
        byFunctionName: new Map([["local_observe", {
          definition: toolDefinition("local.macos.observe"),
          functionName: "local_observe",
        }]]),
      },
      securityContext: {
        tenantId: "tenant-1",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-local-observe",
      generateTurn,
      executeTool: vi.fn(async () => ({
        record: executionRecord("local.macos.observe", "executed", {
          id: "execution-local-observe",
        }),
        result: { clicked: true },
        computerObservation: computerObservation(),
      })) as never,
    });

    const collected = await collect(loop);
    expect(collected.result.text).toBe("The click succeeded; continue.");
    expect(generateTurn).toHaveBeenCalledTimes(2);
  });

  it("carries a local Mac observation across exactly one sole app-list turn", async () => {
    let turnIndex = 0;
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      turnIndex += 1;
      if (turnIndex === 1) {
        expect(request.toolResults).toBeUndefined();
        return turn({
          toolCalls: [{
            callId: "call-observe",
            name: "local_observe",
            argumentsJson: "{}",
          }],
        });
      }
      if (turnIndex === 2) {
        expect(request.toolResults).toEqual([
          expect.objectContaining({
            callId: "call-observe",
            computerObservation: expect.objectContaining({
              source: "local_macos",
              snapshotRevision: "c".repeat(64),
            }),
          }),
        ]);
        return turn({
          toolCalls: [{
            callId: "call-list-once",
            name: "local_list_apps",
            argumentsJson: "{}",
          }],
        });
      }
      if (turnIndex === 3) {
        expect(request.toolResults).toEqual([
          expect.objectContaining({
            callId: "call-list-once",
            computerObservation: expect.objectContaining({
              source: "local_macos",
              executionId: "execution-local-observe",
            }),
          }),
        ]);
        return turn({
          toolCalls: [{
            callId: "call-list-twice",
            name: "local_list_apps",
            argumentsJson: "{}",
          }],
        });
      }
      expect(request.toolResults).toEqual([
        expect.not.objectContaining({ computerObservation: expect.anything() }),
      ]);
      return turn({ text: "The observation expired after one app-list hop." });
    });
    const executeTool = vi.fn(async (request: { toolId: string }) =>
      request.toolId === "local.macos.observe"
        ? {
            record: executionRecord(request.toolId, "executed", {
              id: "execution-local-observe",
            }),
            result: { summary: "Observed Finder." },
            computerObservation: localObservation(),
          }
        : {
            record: executionRecord(request.toolId, "executed"),
            result: { applications: ["Finder", "Chrome"] },
          }
    );
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Use fresh local evidence.",
      prompt: "Inspect this Mac.",
      tools: [modelTool("local_observe"), modelTool("local_list_apps")],
      toolbox: {
        byFunctionName: new Map([
          ["local_observe", {
            definition: toolDefinition("local.macos.observe"),
            functionName: "local_observe",
          }],
          ["local_list_apps", {
            definition: toolDefinition("local.macos.list_apps"),
            functionName: "local_list_apps",
          }],
        ]),
      },
      securityContext: {
        tenantId: "tenant-local",
        actorId: "owner-local",
        role: "admin",
        source: "default",
      },
      runId: "run-local-observation-hop",
      generateTurn,
      executeTool: executeTool as never,
    });

    const collected = await collect(loop);
    expect(collected.result.text).toBe(
      "The observation expired after one app-list hop.",
    );
    expect(generateTurn).toHaveBeenCalledTimes(4);
  });

  it("invalidates local Mac evidence after a state-changing action", async () => {
    let turnIndex = 0;
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      turnIndex += 1;
      if (turnIndex === 1) {
        return turn({
          toolCalls: [{
            callId: "call-observe",
            name: "local_observe",
            argumentsJson: "{}",
          }],
        });
      }
      if (turnIndex === 2) {
        expect(request.toolResults?.[0]?.computerObservation).toMatchObject({
          source: "local_macos",
        });
        return turn({
          toolCalls: [{
            callId: "call-activate",
            name: "local_activate_app",
            argumentsJson: "{\"bundleId\":\"com.google.Chrome\"}",
          }],
        });
      }
      expect(request.toolResults?.[0]).not.toHaveProperty(
        "computerObservation",
      );
      return turn({ text: "A fresh observation is required." });
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Observe after every state change.",
      prompt: "Open Chrome.",
      tools: [modelTool("local_observe"), modelTool("local_activate_app")],
      toolbox: {
        byFunctionName: new Map([
          ["local_observe", {
            definition: toolDefinition("local.macos.observe"),
            functionName: "local_observe",
          }],
          ["local_activate_app", {
            definition: toolDefinition("local.macos.activate_app"),
            functionName: "local_activate_app",
          }],
        ]),
      },
      securityContext: {
        tenantId: "tenant-local",
        actorId: "owner-local",
        role: "admin",
        source: "default",
      },
      runId: "run-local-observation-invalidated",
      generateTurn,
      executeTool: vi.fn(async (request: { toolId: string }) =>
        request.toolId === "local.macos.observe"
          ? {
              record: executionRecord(request.toolId, "executed", {
                id: "execution-local-observe",
              }),
              result: { summary: "Observed Finder." },
              computerObservation: localObservation(),
            }
          : {
              record: executionRecord(request.toolId, "executed"),
              result: { activated: true },
            }
      ) as never,
    });

    const collected = await collect(loop);
    expect(collected.result.text).toBe("A fresh observation is required.");
  });

  it("scopes This Mac task authority to the user's own request", async () => {
    const run = async (computerUseTarget?: "local_macos") => {
      const executeTool = vi.fn(async (request: { toolId: string }) => ({
        record: executionRecord(request.toolId, "executed"),
        result: { activated: true },
      }));
      await collect(runNonOpenAIProviderToolLoop({
        provider: "google",
        tier: "reasoning",
        instructions: "Act on This Mac.",
        prompt: "Open tradingview.com in Chrome.",
        tools: [modelTool("local_activate_app")],
        toolbox: {
          byFunctionName: new Map([
            ["local_activate_app", {
              definition: toolDefinition("local.macos.activate_app"),
              functionName: "local_activate_app",
            }],
          ]),
        },
        securityContext: {
          tenantId: "tenant-local",
          actorId: "owner-local",
          role: "admin",
          source: "default",
        },
        runId: "run-local-task-authority",
        computerUseTarget,
        maxToolSteps: 1,
        generateTurn: vi.fn(async (request: ModelToolTurnRequest) =>
          request.toolResults?.length
            ? turn({ text: "Chrome is open." })
            : turn({
                toolCalls: [{
                  callId: "call-activate",
                  name: "local_activate_app",
                  argumentsJson: "{\"bundleId\":\"com.google.Chrome\"}",
                }],
              })),
        executeTool: executeTool as never,
      }));
      return executeTool.mock.calls[0]?.[0];
    };

    expect(await run("local_macos")).toMatchObject({
      localComputerTaskAuthority: {
        objective: "Open tradingview.com in Chrome.",
      },
    });
    expect(await run()).toMatchObject({ localComputerTaskAuthority: undefined });
  });

  it("drops local Mac evidence before an approval continuation", async () => {
    let turnIndex = 0;
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      turnIndex += 1;
      if (turnIndex === 1) {
        return turn({
          toolCalls: [{
            callId: "call-observe",
            name: "local_observe",
            argumentsJson: "{}",
          }],
        });
      }
      expect(request.toolResults?.[0]?.computerObservation).toMatchObject({
        source: "local_macos",
      });
      return turn({
        toolCalls: [{
          callId: "call-approval",
          name: "local_press",
          argumentsJson: "{}",
        }],
      });
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Pause for consequential actions.",
      prompt: "Inspect then press.",
      tools: [modelTool("local_observe"), modelTool("local_press")],
      toolbox: {
        byFunctionName: new Map([
          ["local_observe", {
            definition: toolDefinition("local.macos.observe"),
            functionName: "local_observe",
          }],
          ["local_press", {
            definition: toolDefinition("local.macos.press", {
              riskLevel: 2,
              approvalRequired: true,
            }),
            functionName: "local_press",
          }],
        ]),
      },
      securityContext: {
        tenantId: "tenant-local",
        actorId: "owner-local",
        role: "admin",
        source: "default",
      },
      runId: "run-local-observation-approval",
      serializeToolCalls: true,
      generateTurn,
      executeTool: vi.fn(async (request: { toolId: string }) =>
        request.toolId === "local.macos.observe"
          ? {
              record: executionRecord(request.toolId, "executed", {
                id: "execution-local-observe",
              }),
              result: { summary: "Observed Finder." },
              computerObservation: localObservation(),
            }
          : {
              record: executionRecord(request.toolId, "approval_required"),
              result: null,
            }
      ) as never,
    });

    const collected = await collect(loop);
    expect(JSON.stringify(collected.result.waitingApproval)).not.toContain(
      "LOCAL_PRIVATE_SNAPSHOT",
    );
    expect(
      collected.result.waitingApproval?.providerState.toolResultsBeforeApproval,
    ).toEqual([]);
  });

  it("removes ephemeral computer evidence before parking provider state", async () => {
    const computerDefinition = toolDefinition("local.macos.observe");
    const approvalDefinition = toolDefinition("http.request", {
      riskLevel: 2,
      approvalRequired: true,
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use tools.",
      prompt: "Inspect then submit",
      tools: [modelTool("local_observe"), modelTool("http_request")],
      toolbox: {
        byFunctionName: new Map([
          ["local_observe", {
            definition: computerDefinition,
            functionName: "local_observe",
          }],
          ["http_request", {
            definition: approvalDefinition,
            functionName: "http_request",
          }],
        ]),
      },
      securityContext: {
        tenantId: "tenant-1",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-local-observe-approval",
      serializeToolCalls: true,
      generateTurn: vi.fn(async () => turn({
        toolCalls: [
          { callId: "call-observe", name: "local_observe", argumentsJson: "{}" },
          { callId: "call-approval", name: "http_request", argumentsJson: "{}" },
        ],
      })),
      executeTool: vi.fn(async (request: { toolId: string }) =>
        request.toolId === computerDefinition.id
          ? {
              record: executionRecord(request.toolId, "executed", {
                id: "execution-local-observe",
              }),
              result: { ok: true },
              computerObservation: computerObservation(),
            }
          : {
              record: executionRecord(request.toolId, "approval_required"),
              result: null,
            }
      ) as never,
    });

    const collected = await collect(loop);
    const parked = collected.result.waitingApproval?.providerState
      .toolResultsBeforeApproval[0];
    expect(parked?.output).toContain("tool_result");
    expect(parked).not.toHaveProperty("computerObservation");
  });

  it("parks approval-required calls without advancing the provider turn", async () => {
    const generateTurn = vi.fn(async () => turn({
      toolCalls: [{ callId: "call-approval", name: "http_request", argumentsJson: "{\"url\":\"https://example.com\"}" }],
    }));
    const definition = toolDefinition("http.request", {
      name: "HTTP Request",
      riskLevel: 2,
      approvalRequired: true,
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use tools when needed.",
      prompt: "Call the endpoint",
      tools: [modelTool("http_request")],
      toolbox: {
        byFunctionName: new Map([["http_request", { definition, functionName: "http_request" }]]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-approval",
      generateTurn,
      executeTool: vi.fn(async () => ({
        record: executionRecord("http.request", "approval_required", {
          name: "HTTP Request",
          riskLevel: 2,
          approvalRequired: true,
          reason: "Human approval required.",
        }),
      })) as never,
    });
    const collected = await collect(loop);

    expect(collected.events).toContainEqual(expect.objectContaining({
      type: "tool",
      status: "approval_required",
    }));
    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(collected.result.text).toBe("");
    expect(collected.result.waitingApproval).toMatchObject({
      executionId: "execution-http.request",
      toolId: "http.request",
      toolName: "HTTP Request",
      providerState: {
        provider: "google",
        pendingCall: { callId: "call-approval", name: "http_request" },
        toolResultsBeforeApproval: [],
      },
    });
  });

  it("serializes otherwise parallel reads for a checkpoint chain", async () => {
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) =>
      request.toolResults
        ? turn({ text: "done" })
        : turn({
            toolCalls: [
              { callId: "call-a", name: "memory_search", argumentsJson: "{}" },
              { callId: "call-b", name: "knowledge_search", argumentsJson: "{}" },
            ],
          })
    );
    let activeExecutions = 0;
    let maximumActiveExecutions = 0;
    const executeTool = vi.fn(async (request: { toolId: string }) => {
      activeExecutions += 1;
      maximumActiveExecutions = Math.max(
        maximumActiveExecutions,
        activeExecutions,
      );
      await Promise.resolve();
      activeExecutions -= 1;
      return {
        record: executionRecord(request.toolId, "executed"),
        result: { ok: true },
      };
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use tools.",
      prompt: "Search both stores.",
      tools: [modelTool("memory_search"), modelTool("knowledge_search")],
      toolbox: {
        byFunctionName: new Map([
          ["memory_search", {
            definition: toolDefinition("memory.search"),
            functionName: "memory_search",
          }],
          ["knowledge_search", {
            definition: toolDefinition("knowledge.search"),
            functionName: "knowledge_search",
          }],
        ]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-serialized",
      serializeToolCalls: true,
      generateTurn,
      executeTool: executeTool as never,
    });

    await collect(loop);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(maximumActiveExecutions).toBe(1);
  });

  it("reserves the complete tool batch before starting any governed execution", async () => {
    const executeTool = vi.fn();
    const reserveTools = vi.fn(() => {
      throw new Error("Run tool-call budget is exhausted");
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use tools.",
      prompt: "Search both stores.",
      tools: [modelTool("memory_search"), modelTool("knowledge_search")],
      toolbox: {
        byFunctionName: new Map([
          ["memory_search", {
            definition: toolDefinition("memory.search"),
            functionName: "memory_search",
          }],
          ["knowledge_search", {
            definition: toolDefinition("knowledge.search"),
            functionName: "knowledge_search",
          }],
        ]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-budgeted",
      reserveTools,
      generateTurn: vi.fn(async () => turn({
        toolCalls: [
          { callId: "call-a", name: "memory_search", argumentsJson: "{}" },
          { callId: "call-b", name: "knowledge_search", argumentsJson: "{}" },
        ],
      })),
      executeTool: executeTool as never,
    });

    await expect(collect(loop)).rejects.toThrow("tool-call budget");
    expect(reserveTools).toHaveBeenCalledWith([
      expect.objectContaining({ id: "memory.search" }),
      expect.objectContaining({ id: "knowledge.search" }),
    ]);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("uses a supplied local tool-step cap beyond the ordinary six-step boundary", async () => {
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      if (!request.toolResults) {
        expect(request.tools).toHaveLength(1);
        return turn({
          toolCalls: [{
            callId: "call-local-seven",
            name: "local_observe",
            argumentsJson: "{}",
          }],
        });
      }
      return turn({ text: "The seventh local round completed." });
    });
    const executeTool = vi.fn(async () => ({
      record: executionRecord("local.macos.observe", "executed"),
      result: { observed: true },
    }));
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Observe the selected Mac.",
      prompt: "Continue the local task.",
      tools: [modelTool("local_observe")],
      toolbox: {
        byFunctionName: new Map([["local_observe", {
          definition: toolDefinition("local.macos.observe"),
          functionName: "local_observe",
        }]]),
      },
      securityContext: {
        tenantId: "tenant-local",
        actorId: "owner-local",
        role: "admin",
        source: "default",
      },
      runId: "run-local-cap",
      toolSteps: 6,
      maxToolSteps: 12,
      generateTurn,
      executeTool: executeTool as never,
    });

    const collected = await collect(loop);
    expect(executeTool).toHaveBeenCalledOnce();
    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(collected.result).toMatchObject({
      text: "The seventh local round completed.",
      toolSteps: 7,
    });
  });

  it.each(["ordinary", "read_only", "write"] as const)("keeps the provider allowance scoped to live self-improvement authority (%s)", async mode => {
    const context = { tenantId: "tenant-improvement", actorId: "actor:owner", role: "operator" as const, source: "service" as const };
    const executionScope = createExecutionScope({ tenantId: context.tenantId, initiatingActorId: context.actorId, executingPrincipalType: "agent",
      executingPrincipalId: "forge", projectId: "project-improvement", correlationId: "run-improvement", purpose: "self_improvement.cycle.v1" });
    const assertCurrent = vi.fn(async () => undefined);
    const authority: SelfImprovementExecutionAuthority = { tenantId: context.tenantId, ownerActorId: context.actorId, projectId: "project-improvement",
      repositoryId: "42", cycleId: "cycle-improvement", policySha256: "a".repeat(64), expiresAt: new Date(Date.now()+60_000).toISOString(),
      readOnly: mode === "read_only", assertCurrent };
    let generated = 0;
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      generated++;
      if (request.toolChoice === "none") return turn({ text: "Finished within the admitted allowance." });
      return turn({ toolCalls: [{ callId: `inspection-${generated}`, name: "builder_read", argumentsJson: JSON.stringify({ projectId: authority.projectId, path: "src/feature.ts" }) }] });
    });
    const executeTool = vi.fn(async () => ({ record: executionRecord("app.projects.builder.file.read", "executed"), result: { observed: true } }));
    const run = () => collect(runNonOpenAIProviderToolLoop({ provider: "google", tier: "reasoning", instructions: "Inspect admitted source.", prompt: "Inspect relevant code.",
      tools: [modelTool("builder_read")], toolbox: { byFunctionName: new Map([["builder_read", { functionName: "builder_read", definition: toolDefinition("app.projects.builder.file.read") }]]) },
      securityContext: context, executionScope, runId: "run-improvement", maxToolSteps: 32, generateTurn, executeTool: executeTool as never }));
    const result = mode === "ordinary" ? await run() : await withSelfImprovementExecution(authority, run);
    const expectedSteps = mode === "ordinary" ? Math.max(AGENT_MAX_TOOL_STEPS, LOCAL_COMPUTER_MAX_TOOL_STEPS) : 16;
    expect(result.result.toolSteps).toBe(expectedSteps);
    expect(executeTool).toHaveBeenCalledTimes(expectedSteps); expect(generateTurn).toHaveBeenCalledTimes(expectedSteps+1);
    expect(generateTurn.mock.calls.every(([request]) => request.maxOutputTokens === (mode === "ordinary" ? AGENT_MAX_OUTPUT_TOKENS : mode === "read_only" ? 4_000 : 8_000))).toBe(true);
    expect(assertCurrent).toHaveBeenCalledTimes(mode === "ordinary" ? 0 : 1);
  });

  it.each(["complete", "headroom", "time", "late_time", "before_time", "conflict", "rounds", "calls"] as const)("drains phase-bound reads with unchanged limits and honest %s completion", async scenario => {
    const context = { tenantId: "tenant-bound", actorId: "actor:bound", role: "operator" as const, source: "service" as const };
    const sessionId = `app_build_${"a".repeat(48)}`;
    const scope = createExecutionScope({ tenantId: context.tenantId, initiatingActorId: context.actorId, executingPrincipalType: "agent", executingPrincipalId: "atlas", projectId: "project-bound", correlationId: "run-bound", purpose: "self_improvement.cycle.v1" });
    let authorityReads = 0, lateTime = false;
    const assertCurrent = vi.fn(async () => { authorityReads++; if (scenario === "late_time" && authorityReads >= 2) lateTime = true; });
    const authority: SelfImprovementExecutionAuthority = { tenantId: context.tenantId, ownerActorId: context.actorId, projectId: scope.projectId!, sessionId,
      repositoryId: "42", cycleId: "cycle-bound", policySha256: "a".repeat(64), expiresAt: new Date(Date.now()+60_000).toISOString(), readOnly: true, assertCurrent };
    const calls = Array.from({ length: 7 }, (_, i) => ({ callId: `read-${i}`, name: "builder_read", argumentsJson: JSON.stringify({ path: `src/file${i}.ts`, startLine: 1, lineCount: 20,
      ...(scenario === "conflict" && i === 0 ? { sessionId: sessionId.slice(0, -4) } : {}) }) }));
    let used = 0, generated = 0;
    const cap = scenario === "calls" ? 3 : 48;
    const executeTool = vi.fn(async (request: { toolId: string; input: Record<string, unknown>; idempotencyKey: string }) => {
      expect(request.input).toMatchObject({ projectId: "project-bound", sessionId });
      expect(request.idempotencyKey).toMatch(/^run-bound:google:read-[0-6]$/);
      return { record: executionRecord(request.toolId, "executed", { id: `execution-${used}` }), result: { excerpt: "observed source", sha256: "a".repeat(64) } };
    });
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      generated++;
      expect(request.tools[0].parameters.properties).not.toHaveProperty("sessionId");
      expect(request.tools[0].parameters.properties).not.toHaveProperty("projectId");
      return generated === 1 ? turn({ toolCalls: calls }) : turn({ text: '{"decision":"repair","plan":{}}' });
    });
    const input = {
      provider: "google" as const, tier: "reasoning" as const, instructions: "Inspect source.", prompt: "Inspect source.",
      tools: [{ ...modelTool("builder_read"), parameters: { type: "object", properties: { projectId: { type: "string" }, sessionId: { type: "string" }, path: { type: "string" } }, required: ["projectId", "sessionId", "path"] } }],
      toolbox: { byFunctionName: new Map([["builder_read", { functionName: "builder_read", definition: toolDefinition("app.projects.builder.file.read") }]]) },
      securityContext: context, executionScope: scope, runId: "run-bound", maxToolSteps: scenario === "rounds" ? 1 : 4,
      beforeModelTurn: async () => ({ maxAttempts: 1, canContinueToolBatch: (count: number) => count <= 7 && scenario !== "headroom",
        shouldFinishBeforeTools: () => scenario === "before_time" || lateTime || (scenario === "time" && used >= 5) }),
      reserveTools: (tools: readonly ToolDefinition[]) => { used += tools.length; expect(used).toBeLessThanOrEqual(cap); return undefined; },
      remainingToolCalls: () => cap-used, generateTurn, executeTool: executeTool as never,
    };
    const { events, result } = await withSelfImprovementExecution(authority, () => collect(runNonOpenAIProviderToolLoop(input)));
    const expected = scenario === "complete" ? 7 : scenario === "conflict" ? 6 : scenario === "calls" ? 3 : ["before_time", "late_time"].includes(scenario) ? 0 : 5;
    expect(executeTool).toHaveBeenCalledTimes(expected); expect(generateTurn).toHaveBeenCalledTimes(2); expect(used).toBe(expected);
    expect(result.deferredToolCallHashes).toHaveLength(7-expected);
    expect(result.toolSteps).toBe(scenario === "before_time" ? 0 : scenario === "complete" || scenario === "conflict" ? 2 : 1);
    expect(events.some(event => event.type === "status" && event.label === "requested actions unfinished")).toBe(scenario !== "complete");
    if (["headroom", "time", "late_time", "conflict"].includes(scenario)) expect(events).toContainEqual(expect.objectContaining({ type: "status", label: "read batches unfinished", toolLimit: expect.objectContaining({ pendingCalls: expect.arrayContaining([expect.objectContaining({ toolId: "app.projects.builder.file.read", reason: scenario === "headroom" ? "answer_reservation" : ["time", "late_time"].includes(scenario) ? "time_reserved" : "invalid_arguments" })]) }) }));
    expect(JSON.stringify(events)).not.toContain("src/file");
  });

  it("keeps the six-step fallback when a legacy loop has no persisted cap", async () => {
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      expect(request.tools).toEqual([modelTool("memory_search")]);
      expect(request.toolChoice).toBe("none");
      return turn({ text: "Final answer only." });
    });
    const executeTool = vi.fn();
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Finish within the legacy boundary.",
      prompt: "Finish.",
      tools: [modelTool("memory_search")],
      toolbox: {
        byFunctionName: new Map([["memory_search", {
          definition: toolDefinition("memory.search"),
          functionName: "memory_search",
        }]]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-legacy-cap",
      toolSteps: 6,
      generateTurn,
      executeTool: executeTool as never,
    });

    const collected = await collect(loop);
    expect(collected.result.text).toBe("Final answer only.");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each(["bound", "unbound", "expired", "custom"])('uses saved speech only for bounded Mac work (%s)', async (scenario) => {
    const binding = {
      schemaVersion: 1 as const, tenantId: "default", actorId: "owner",
      sessionId: "33333333-3333-4333-8333-333333333333", conversationId: "22222222-2222-4222-8222-222222222222",
      userInputItemId: "human-item", userTurnId: "44444444-4444-4444-8444-444444444444", requestId: "voice-task",
      objective: "Open YouTube", transcriptSha256: "a".repeat(64),
      expiresAt: new Date(Date.now() + (scenario === "expired" ? -60_000 : 60_000)).toISOString(),
    };
    const executeTool = vi.fn(async (request: { toolId: string }) => ({
      record: executionRecord(request.toolId, "executed"), result: { ok: true },
    }));
    const generateTurn = vi.fn()
      .mockResolvedValueOnce(turn({ toolCalls: [{ callId: "mac", name: "open_site", argumentsJson: "{}" }] }))
      .mockResolvedValueOnce(turn({ toolCalls: [{ callId: "app", name: "app_action", argumentsJson: "{}" }] }))
      .mockResolvedValueOnce(turn({ text: "Finished." }));
    await collect(runNonOpenAIProviderToolLoop({
      provider: "google", tier: "fast", instructions: "Use governed tools", prompt: "Model invented attacker.example",
      tools: [modelTool("open_site"), modelTool("app_action")], toolbox: { byFunctionName: new Map([
        ["open_site", { definition: toolDefinition("local.macos.open_url", { riskLevel: 2 }), functionName: "open_site" }],
        ["app_action", { definition: toolDefinition("app.project.delete", { riskLevel: 2 }), functionName: "app_action" }],
      ]) }, securityContext: { tenantId: "default", actorId: "owner", role: "admin", source: "default" },
      runId: "run-native-voice", computerUseTarget: "local_macos", voiceRiskThreshold: 1,
      voiceTaskBinding: scenario === "unbound" ? undefined : binding,
      forceApprovalAboveRisk: scenario === "custom" ? 0 : undefined,
      generateTurn, executeTool: executeTool as never,
    }));
    expect(executeTool).toHaveBeenNthCalledWith(1, expect.objectContaining({
      toolId: "local.macos.open_url", forceApproval: scenario !== "bound",
      localComputerTaskAuthority: { objective: scenario === "unbound" ? "" : "Open YouTube" },
    }));
    expect(executeTool).toHaveBeenNthCalledWith(2, expect.objectContaining({
      toolId: "app.project.delete", forceApproval: true,
    }));
  });

  it("forces approval only for risk-bearing tools under the voice policy", async () => {
    const executeTool = vi.fn(async (request: {
      toolId: string;
      forceApproval?: boolean;
    }) => ({
      record: executionRecord(request.toolId, "executed"),
      result: { ok: true },
    }));
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use governed tools.",
      prompt: "Read and then update.",
      tools: [modelTool("safe_read"), modelTool("risky_update")],
      toolbox: {
        byFunctionName: new Map([
          ["safe_read", {
            definition: toolDefinition("safe.read"),
            functionName: "safe_read",
          }],
          ["risky_update", {
            definition: toolDefinition("risky.update", { riskLevel: 1 }),
            functionName: "risky_update",
          }],
        ]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-voice-policy",
      forceApprovalAboveRisk: 0,
      generateTurn: vi.fn()
        .mockResolvedValueOnce(turn({
          toolCalls: [
            { callId: "call-read", name: "safe_read", argumentsJson: "{}" },
            { callId: "call-update", name: "risky_update", argumentsJson: "{}" },
          ],
        }))
        .mockResolvedValueOnce(turn({ text: "Finished." })),
      executeTool: executeTool as never,
    });

    await collect(loop);
    expect(executeTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ toolId: "safe.read", forceApproval: false }),
    );
    expect(executeTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ toolId: "risky.update", forceApproval: true }),
    );
  });

  it("closes the observed model boundary when generation fails", async () => {
    const failure = new Error("provider unavailable");
    const afterModelFailure = vi.fn(async () => undefined);
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Answer safely.",
      prompt: "Fail this test turn.",
      tools: [],
      toolbox: { byFunctionName: new Map() },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-failed-model",
      modelAttemptOffset: 2,
      beforeModelTurn: vi.fn(async () => undefined),
      afterModelFailure,
      generateTurn: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(collect(loop)).rejects.toThrow("provider unavailable");
    expect(afterModelFailure).toHaveBeenCalledWith({
      attempt: 3,
      provider: "google",
      tier: "reasoning",
      error: failure,
    });
  });

  it("starts no further provider turn once the run is canceled", async () => {
    const stop = new AbortController();
    const generateTurn = vi.fn(async () => turn({
      toolCalls: [{
        callId: "call-read-a",
        name: "read_a",
        argumentsJson: "{}",
      }],
    }));
    const executeTool = vi.fn(async (request: { toolId: string }) => {
      stop.abort(new AgentRunTerminatedError("run-canceled-mid-loop", "canceled"));
      return {
        record: executionRecord(request.toolId, "executed"),
        result: { source: request.toolId },
      };
    });

    await expect(collect(runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Read the source, then answer.",
      prompt: "Inspect the source.",
      tools: [modelTool("read_a")],
      toolbox: {
        byFunctionName: new Map([
          ["read_a", { definition: toolDefinition("read.a"), functionName: "read_a" }],
        ]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-canceled-mid-loop",
      maxToolSteps: 3,
      abortSignal: stop.signal,
      generateTurn,
      executeTool: executeTool as never,
    }))).rejects.toBeInstanceOf(AgentRunTerminatedError);

    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("asks every provider turn for the agent reasoning effort before a Command selection binds it", async () => {
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) =>
      request.toolResults
        ? turn({ text: "Read complete." })
        : turn({
            toolCalls: [{ callId: "call-read", name: "read_a", argumentsJson: "{}" }],
          })
    );
    const bindModelRequest = vi.fn((request: ModelToolTurnRequest) => ({
      ...request,
      reasoningEffort: "high" as const,
    }));
    const executeTool = vi.fn(async (request: { toolId: string }) => ({
      record: executionRecord(request.toolId, "executed"),
      result: { source: request.toolId },
    }));

    await collect(runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Read the source, then answer.",
      prompt: "Inspect the source.",
      tools: [modelTool("read_a")],
      toolbox: {
        byFunctionName: new Map([
          ["read_a", { definition: toolDefinition("read.a"), functionName: "read_a" }],
        ]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-reasoning-effort",
      maxToolSteps: 2,
      bindModelRequest,
      generateTurn,
      executeTool: executeTool as never,
    }));

    expect(AGENT_REASONING_EFFORT).toBeTruthy();
    expect(bindModelRequest.mock.calls.map(([request]) => request.reasoningEffort))
      .toEqual([AGENT_REASONING_EFFORT, AGENT_REASONING_EFFORT]);
    expect(generateTurn.mock.calls.map(([request]) => request.reasoningEffort))
      .toEqual(["high", "high"]);
  });
});

function budgetedToolLoop(options: {
  callsPerTurn: number;
  usedModelTurns?: number;
  usedToolCalls?: number;
  riskLevel?: 0 | 1;
  approval?: boolean;
}) {
  let state = createRunBudgetState(AGENT_RUN_BUDGET_LIMITS, {
    used: { modelTurns: options.usedModelTurns ?? 0, toolCalls: options.usedToolCalls ?? 0 },
  });
  let modelCalls = 0;
  const definition = toolDefinition("app.work_items.show", { riskLevel: options.riskLevel ?? 0, approvalRequired: options.approval ?? false });
  const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
    modelCalls += 1;
    return request.toolChoice === "none"
      ? turn({ text: "Finished from observed results." })
      : turn({ toolCalls: Array.from({ length: options.callsPerTurn }, (_, index) => ({
        callId: `budget-call-${modelCalls}-${index}`, name: "work_show", argumentsJson: "{}",
      })) });
  });
  const executeTool = vi.fn(async () => ({
    record: executionRecord(definition.id, options.approval ? "approval_required" : "executed", { approvalRequired: options.approval }),
    result: { observed: true },
  }));
  const loop = runNonOpenAIProviderToolLoop({
    provider: "google", tier: "fast", instructions: "Read the exact work item.", prompt: "Verify saved work.",
    tools: [modelTool("work_show")],
    toolbox: { byFunctionName: new Map([["work_show", { definition, functionName: "work_show" }]]) },
    securityContext: { tenantId: "tenant-budget", actorId: "owner", role: "operator", source: "default" },
    runId: "run-budget-boundary", maxToolSteps: AGENT_MAX_TOOL_STEPS,
    beforeModelTurn: async ({ toolsEnabled }) => {
      const plan = planModelTurnBudget(state, {
        estimate: { tokens: 1, costMicrousd: 1, followUpTokens: 1, followUpCostMicrousd: 1 },
        toolsEnabled, allowRetry: false,
      });
      state = plan.state;
      return { maxAttempts: 1, finalTurn: plan.finalTurn };
    },
    reserveTools: (tools) => { state = reserveRunBudget(state, { toolCalls: tools.length }); return undefined; },
    remainingToolCalls: () => remainingRunBudget(state).toolCalls,
    generateTurn, executeTool: executeTool as never,
  });
  return { loop, generateTurn, executeTool, state: () => state };
}

function forgeWindowFixture(options: { mode?: "ordinary" | "unbound"; toolSteps?: number; usedCalls?: number; approval?: boolean } = {}) {
  const runId = "11111111-1111-4111-8111-111111111111", sessionId = `app_build_${"a".repeat(48)}`;
  const context = { tenantId: "t", actorId: "actor:owner", role: "operator" as const, source: "service" as const };
  const scope = createExecutionScope({ tenantId: "t", initiatingActorId: context.actorId, executingPrincipalType: "agent", executingPrincipalId: "forge", projectId: "project", correlationId: runId, purpose: "self_improvement.cycle.v1" });
  let paused = false, charged = options.usedCalls ?? 4 + Math.max(0, (options.toolSteps ?? 1) - 1);
  const assertCurrent = async () => { if (paused) throw new Error("Owner paused."); };
  const forgePlan = { phase: "reproduce" as const, plan: { summary: "Synthetic fixture repair", sourcePaths: ["src/a.ts"], newSourcePaths: [], focusedTestPaths: ["src/a.test.ts"], adjacentTestPaths: ["src/b.test.ts"], acceptanceCriteria: ["Keep a valid control"] }, expectedHashes: { "src/a.ts": "a".repeat(64) } };
  const handoff = createForgeHandoff({ runId, sessionId, plan: forgePlan, assertCurrent, verifyRead: async () => { throw new Error("Prelude already completed"); } });
  handoff.begin(); handoff.finishContext([{ executionId: "read", path: "src/a.ts", sha256: "a".repeat(64), inputSha256: "b".repeat(64), scopeSha256: "c".repeat(64), startLine: 1, endLine: 20, totalLines: 20 }]);
  const authority: SelfImprovementExecutionAuthority = { tenantId: "t", ownerActorId: context.actorId, projectId: "project", repositoryId: "42", cycleId: "cycle", policySha256: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", readOnly: false, sessionId, ...(options.mode === "unbound" ? {} : { forgePlan, forgeHandoff: handoff }), writePaths: ["src/a.test.ts"], assertCurrent };
  const definitions = [
    ["search", toolDefinition("app.projects.builder.search")], ["tree", toolDefinition("app.projects.builder.tree")],
    ["read", toolDefinition("app.projects.builder.file.read")], ["edit", toolDefinition("app.projects.builder.file.edit", { riskLevel: 1 })],
  ] as const;
  let executionCount = 0;
  const executeTool = vi.fn(async (request: { toolId: string; input: Record<string, unknown> }) => {
    const edit = request.toolId.endsWith(".edit"), approval = edit && options.approval;
    const output = edit ? { update: { path: request.input.path, previousSha256: request.input.expectedSha256, sha256: "b".repeat(64) } } : { ok: true };
    return { record: { ...executionRecord(request.toolId, approval ? "approval_required" : "executed", { id: `execution-${++executionCount}`, riskLevel: edit ? 1 : 0, approvalRequired: Boolean(approval) }), input: request.input, output }, result: output };
  });
  const beforeModelTurn = vi.fn(async () => ({ maxAttempts: 1, finalTurn: false }));
  const call = (name: string, callId: string): ModelToolCall => ({ callId, name, argumentsJson: JSON.stringify(name === "edit"
    ? { path: "src/a.test.ts", expectedSha256: "a".repeat(64), edits: [{ oldText: "old", newText: "new" }] }
    : name === "read" ? { path: "src/a.test.ts", startLine: 1, lineCount: 100 } : { query: "fixture" }) });
  return {
    call, executeTool, beforeModelTurn, charged: () => charged, pause: () => { paused = true; },
    run: async (generateTurn: (request: ModelToolTurnRequest) => Promise<ModelToolTurnResult>, onWindow?: () => void) => {
      const work = async () => {
        const generator = runNonOpenAIProviderToolLoop({ provider: "google", tier: "reasoning", instructions: "Make only the justified selected test edit.", prompt: "Synthetic plan", securityContext: context, executionScope: scope, runId,
          tools: definitions.map(([name]) => modelTool(name)), toolbox: { byFunctionName: new Map(definitions.map(([name, definition]) => [name, { functionName: name, definition }])) },
          toolSteps: options.toolSteps ?? 1, maxToolSteps: options.mode === "ordinary" ? 8 : 16, forceApproval: options.approval,
          beforeModelTurn, generateTurn, remainingToolCalls: () => 48 - charged, reserveTools: tools => { charged += tools.length; return undefined; }, executeTool: executeTool as never });
        const events: AgentEvent[] = [];
        for (;;) {
          const next = await generator.next();
          if (next.done) return { events, result: next.value };
          events.push(next.value);
          if (next.value.type === "status" && next.value.label === "Forge write window") onWindow?.();
        }
      };
      return options.mode === "ordinary" ? work() : withSelfImprovementExecution(authority, work);
    },
  };
}

function turn(input: {
  text?: string;
  toolCalls?: ModelToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}): ModelToolTurnResult {
  const inputTokens = input.inputTokens || 0;
  const outputTokens = input.outputTokens || 0;
  return {
    text: input.text || "",
    toolCalls: input.toolCalls || [],
    continuation: { provider: "google", state: [] },
    provider: "google",
    model: "gemini-test",
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      totalTokens: inputTokens + outputTokens,
    },
    latencyMs: 10,
    ...(input.cost === undefined ? {} : { estimatedCostUsd: input.cost }),
    costKnown: input.cost !== undefined,
    attempts: [{
      provider: "google",
      model: "gemini-test",
      status: "completed",
      latencyMs: 10,
    }],
  };
}

function modelTool(name: string) {
  return {
    type: "function" as const,
    name,
    description: `Run ${name}`,
    parameters: { type: "object" },
  };
}

function computerObservation() {
  return {
    schemaVersion: 1 as const,
    source: "local_macos" as const,
    trust: "untrusted_data" as const,
    executionId: "execution-local-observe",
    operation: "local.macos.observe",
    snapshotRevision: "b".repeat(64),
    pageState: { origin: "https://example.test", title: "Success" },
    accessibilitySnapshot: "- heading \"Success\" [level=1]",
    screenshot: {
      mimeType: "image/webp" as const,
      dataBase64: "UklGRgAAAABXRUJQ",
    },
  };
}

function localObservation() {
  return {
    schemaVersion: 1 as const,
    source: "local_macos" as const,
    trust: "untrusted_data" as const,
    executionId: "execution-local-observe",
    operation: "observe",
    snapshotRevision: "c".repeat(64),
    applicationState: {
      name: "Finder",
      bundleId: "com.apple.finder",
      pid: 123,
    },
    accessibilitySnapshot: "LOCAL_PRIVATE_SNAPSHOT",
    screenshot: {
      mimeType: "image/png" as const,
      dataBase64: "iVBORw0KGgo=",
    },
  };
}

function toolDefinition(
  id: string,
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    category: "memory",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: true,
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function executionRecord(
  toolId: string,
  status: ToolExecutionRecord["status"],
  overrides: {
    id?: string;
    name?: string;
    riskLevel?: ToolExecutionRecord["riskLevel"];
    approvalRequired?: boolean;
    reason?: string;
  } = {},
): ToolExecutionRecord {
  return {
    id: overrides.id || `execution-${toolId}`,
    toolId,
    toolName: overrides.name || toolId,
    riskLevel: overrides.riskLevel || 0,
    status,
    dryRun: false,
    approvalRequired: overrides.approvalRequired || false,
    input: {},
    reason: overrides.reason,
    createdAt: new Date(0).toISOString(),
  };
}

async function collect(
  generator: ReturnType<typeof runNonOpenAIProviderToolLoop>,
) {
  const events: AgentEvent[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}
