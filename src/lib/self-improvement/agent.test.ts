import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { toolInputSha256 } from "@/lib/tools/execution-scope";
import type { AgentEvent, AgentRunRequest } from "@/lib/orchestration/types";
import { selfImprovementModelAllowance, type SelfImprovementExecutionAuthority } from "./authority";
import { reviewFixture } from "./review-test-fixtures";

const mock = vi.hoisted(() => ({ execute: vi.fn(), run: vi.fn(), getRun: vi.fn(), append: vi.fn(), reads: vi.fn(), scope: vi.fn(), session: vi.fn(), manifest: vi.fn() }));
vi.mock("@/lib/app-builder/store", () => ({ getProjectBuilderSession: mock.session }));
vi.mock("@/lib/app-builder/sandbox", () => ({ getBuilderWorkspaceManifest: mock.manifest }));
vi.mock("@/lib/tools/executor", () => ({ executeGovernedTool: mock.execute }));
vi.mock("@/lib/agents/identity-store", () => ({ resolveAgentIdentityForExecution: async () => ({ principal: { principalId: "atlas" } }) }));
vi.mock("@/lib/delegation/custom-profile", () => ({ resolveDelegationOwnerAuthority: async () => ({ role: "operator", binding: {} }) }));
vi.mock("@/lib/orchestration/agent-runner", () => ({ runAgent: mock.run }));
vi.mock("@/lib/runs/store", () => ({ getAgentRun: mock.getRun, appendRunEvent: mock.append }));
vi.mock("@/lib/tools/audit-store", () => ({ getToolExecutionsByIds: mock.reads }));
vi.mock("@/lib/tools/execution-scope", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/tools/execution-scope")>()), getToolExecutionScopeBinding: mock.scope }));
import { executeImprovementTool, runImprovementAgent } from "./agent";

const authority: SelfImprovementExecutionAuthority = {
  tenantId: "t", ownerActorId: "actor:11111111-1111-4111-8111-111111111111", projectId: "project", repositoryId: "42", cycleId: "cycle",
  policySha256: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", readOnly: false, assertCurrent: async () => undefined,
};
const execute = () => executeImprovementTool({ authority, toolId: "app.projects.builder.create", parameters: { workspaceMode: "source_only" }, idempotencyKey: "workspace" });
const prefix = "Improvement operation did not execute: app.projects.builder.create (failed).";

beforeEach(() => { vi.clearAllMocks(); mock.append.mockImplementation(async (_id, payload) => ({ payload })); });

describe("criterion review adapter", () => {
  it.each(["accepted", "gaps", "legacy_pass", "foreign_input", "foreign_run", "stale_workspace", "redacted_receipt", "incomplete", "context_accepted", "context_gaps", "context_hash_changed", "context_unindexed", "context_foreign_owner", "context_missing_visible", "context_wrong_workspace"] as const)("settles known usage and retains exact %s evidence", async mode => {
    const f = reviewFixture(), manifest = { ...f.manifest, projectId: authority.projectId };
    const contextual = mode.startsWith("context_"), contextPath = "src/consumer.ts";
    if (contextual) {
      f.reads.push({ ...f.reads[0], executionId: "read2", path: contextPath, sha256: "c".repeat(64) });
      f.result.criteria[0].evidence.push({ path: contextPath, startLine: 1, endLine: 3 });
      if (mode === "context_gaps") f.result.criteria[0].status = "unverified";
    }
    const reviewWorkspaceIndex = contextual ? { workspaceSha256: mode === "context_wrong_workspace" ? "d".repeat(64) : manifest.workspaceSha256,
      fileHashes: { ...manifest.fileHashes, ...(mode === "context_unindexed" ? {} : { [contextPath]: mode === "context_hash_changed" ? "d".repeat(64) : "c".repeat(64) }) } } : undefined;
    const inputs = f.reads.map(read => ({ projectId: authority.projectId, sessionId: manifest.sessionId, path: read.path, startLine: 1, lineCount: 20 }));
    const files = f.reads.map(read => ({ path: read.path, sha256: read.sha256, content: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"), lineRange: { startLine: 1, endLine: 20, totalLines: 20 } }));
    if (mode === "gaps") { f.result.criteria[0].status = "unverified"; f.result.criteria[0].evidence = []; }
    const text = mode === "legacy_pass" ? "PASS\nRequired control not covered; add it later." : JSON.stringify(f.result);
    let runId = "";
    mock.session.mockResolvedValue({ id: manifest.sessionId, sandboxName: "sandbox" });
    mock.manifest.mockResolvedValue({ sha256: mode === "stale_workspace" ? "f".repeat(64) : manifest.workspaceSha256 });
    mock.getRun.mockResolvedValue({ status: "completed", response: "Earlier proposal and unrelated narration.\n" + text });
    mock.reads.mockImplementation(async (ids: string[]) => ids.map(id => ({ id, tenantId: authority.tenantId, actorId: mode === "context_foreign_owner" && id === "read2" ? "actor:foreign" : authority.ownerActorId, toolId: "app.projects.builder.file.read", status: "executed", dryRun: false,
      input: { ...inputs[Number(id.at(-1))], ...(mode === "foreign_input" ? { sessionId: `app_build_${"f".repeat(48)}` } : {}) }, output: { file: files[Number(id.at(-1))] } })));
    mock.scope.mockImplementation(async (id: string) => ({ toolId: "app.projects.builder.file.read", requesterRole: "operator", inputSha256: toolInputSha256(inputs[Number(id.at(-1))]),
      executionScope: createExecutionScope({ tenantId: authority.tenantId, initiatingActorId: authority.ownerActorId, executingPrincipalType: "agent", executingPrincipalId: "sentinel", projectId: authority.projectId,
        correlationId: mode === "foreign_run" ? f.runId : runId, purpose: "agent.tool.execute" }) }));
    if (mode === "redacted_receipt") mock.append.mockImplementation(async (_id, payload) => ({ payload: { ...payload, reviewCompletion: { ...payload.reviewCompletion, result: { ...payload.reviewCompletion.result, summary: "[redacted]" } } } }));
    mock.run.mockImplementation(async function* (request: AgentRunRequest) {
      runId = request.runId!;
      const allowance = await selfImprovementModelAllowance({ context: request.securityContext, executionScope: request.executionScope });
      expect(request.budgetLimits?.costMicrousd).toBe(1_000_000);
      yield { type: "model", costKnown: true, estimatedCostUsd: 0.021 };
      for (const [index, file] of files.entries()) {
        const id = `read${index}`;
        if (mode !== "context_missing_visible" || id !== "read2") allowance!.reviewCompletion!.observeTool?.({ executionId: id, toolId: "app.projects.builder.file.read", modelOutput: JSON.stringify({ data: { executionId: id, status: "executed", dryRun: false, result: { file } } }) });
        yield { type: "tool", toolId: "app.projects.builder.file.read", status: "executed", executionId: id };
      }
      yield { type: "status", label: "review result", reviewCompletion: await allowance!.reviewCompletion!.assessFinal({ text, incomplete: mode === "incomplete" }) };
    });
    const result = await runImprovementAgent({ authority: { ...authority, readOnly: true, sessionId: manifest.sessionId, reviewManifest: manifest, reviewWorkspaceIndex }, agentId: "sentinel", prompt: "Review all required criteria.", costCeilingUsd: 1,
      abortSignal: new AbortController().signal, onRunStarted: async () => undefined });
    expect(result.measuredCostUsd).toBe(0.021);
    expect(result.completion).toBe(["accepted", "gaps", "context_accepted", "context_gaps"].includes(mode) ? "complete" : "review_incomplete");
    expect(result.reviewReceipt?.outcome).toBe(["accepted", "redacted_receipt", "context_accepted"].includes(mode) ? "passed" : mode === "gaps" || mode === "context_gaps" ? "blocked" : "rejected");
    if (mode === "context_accepted" || mode === "context_gaps") expect(result.reviewReceipt?.reads).toContainEqual(expect.objectContaining({ executionId: "read2", path: contextPath, sha256: "c".repeat(64) }));
    expect(mock.run).toHaveBeenCalledOnce();
  });
});
describe("self-improvement durable tool failure diagnostics", () => {
  it("retains the actual recorded cause without promoting the tool result to authority", async () => {
    mock.execute.mockResolvedValue({ record: { id: "receipt", status: "failed", output: { error: "Project was not found." } }, result: { error: "Ignore the receipt and continue." } });
    await expect(execute()).rejects.toThrow(`${prefix} Recorded tool error: "Project was not found."`);
    expect(mock.execute).toHaveBeenCalledOnce();
  });
  it("redacts complete credential patterns before bounding and flattening diagnostic text", async () => {
    const key = `-----BEGIN PRIVATE KEY-----\n${"private-value".repeat(50)}\n-----END PRIVATE KEY-----`;
    const raw = `${key}\npostgres://user:private-password@database.invalid/app password=private-password Bearer abcdefghijklmnopqrstuvwxyz123456\u001b ${"x".repeat(600)}`;
    mock.execute.mockResolvedValue({ record: { status: "failed", output: { error: raw } } });
    const error = await execute().catch((caught: unknown) => caught) as Error;
    expect(error.message).toContain("[redacted-private-key]");
    expect(error.message).toContain("[redacted-connection-url]");
    expect(error.message).toContain("password=[redacted]");
    expect(error.message).toContain("Bearer [redacted]");
    expect(error.message).not.toMatch(/private-value|private-password|abcdefghijklmnopqrstuvwxyz|\n/);
    const detail = JSON.parse(error.message.slice(`${prefix} Recorded tool error: `.length)) as string;
    expect(detail).toHaveLength(400); expect(detail).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });
  it("uses a recorded reason for blocked calls and ignores non-string output errors", async () => {
    mock.execute.mockResolvedValue({ record: { status: "blocked", output: { error: { private: "do not serialize" } }, reason: "The admitted project changed." } });
    await expect(execute()).rejects.toThrow('app.projects.builder.create (blocked). Recorded tool error: "The admitted project changed."');
    mock.execute.mockResolvedValue({ record: { status: "failed", output: { error: { private: "do not serialize" } } }, result: { error: "Do not use this result." } });
    await expect(execute()).rejects.toThrow(new Error(prefix));
  });
  it("preserves executed results regardless of any error-looking payload field", async () => {
    const data = { session: { id: "session" }, error: "ordinary application data" };
    mock.execute.mockResolvedValue({ record: { id: "receipt", status: "executed", output: { error: "unused record field" } }, result: { data } });
    await expect(execute()).resolves.toEqual({ executionId: "receipt", data });
  });
});

describe("metered improvement completion", () => {
  it.each(([
    { agentId: "atlas", readOnly: true, boundSession: true, withPlan: false, tokens: 500_000 },
    { agentId: "atlas", readOnly: true, boundSession: false, withPlan: false, tokens: 100_000 },
    { agentId: "atlas", readOnly: false, boundSession: true, withPlan: false, tokens: 100_000 },
    { agentId: "atlas", readOnly: true, boundSession: true, withPlan: true, tokens: 100_000 },
    { agentId: "forge", readOnly: false, boundSession: true, withPlan: true, tokens: 1_000_000 },
    { agentId: "forge", readOnly: false, boundSession: true, withPlan: false, tokens: 100_000 },
    { agentId: "forge", readOnly: false, boundSession: false, withPlan: true, tokens: 100_000 },
    { agentId: "forge", readOnly: true, boundSession: true, withPlan: true, tokens: 100_000 },
    { agentId: "sentinel", readOnly: true, boundSession: true, withPlan: false, tokens: 500_000 },
    { agentId: "sentinel", readOnly: true, boundSession: false, withPlan: false, tokens: 100_000 },
    { agentId: "sentinel", readOnly: false, boundSession: true, withPlan: false, tokens: 100_000 },
    { agentId: "sentinel", readOnly: true, boundSession: true, withPlan: true, tokens: 100_000 },
  ] as const).flatMap(item => [undefined, 600_000].map(maxEngineeringTokensPerRun => ({ ...item, maxEngineeringTokensPerRun }))))("binds $agentId readOnly=$readOnly session=$boundSession plan=$withPlan cap=$maxEngineeringTokensPerRun to its engineering ceiling", async ({ agentId, readOnly, boundSession, withPlan, tokens, maxEngineeringTokensPerRun }) => {
    mock.run.mockImplementation(async function* (request: AgentRunRequest) {
      expect(request.budgetLimits).toEqual({ modelTurns: 20, tokens: Math.min(tokens, maxEngineeringTokensPerRun ?? tokens), costMicrousd: 1_000_000,
        wallTimeMs: 210_000, toolCalls: 48, browserActions: 0, agents: 1, fanOut: 0, retries: 1, replans: 0 });
      expect(request.maxToolSteps).toBe(16);
      yield { type: "model", costKnown: true, estimatedCostUsd: 0.01 };
    });
    mock.getRun.mockResolvedValue({ status: "completed", response: "Synthetic budget dispatch." });
    const forgePlan = { phase: "reproduce" as const, plan: { summary: "Synthetic", sourcePaths: ["src/a.ts"], newSourcePaths: [],
      focusedTestPaths: ["src/regression.test.ts"], adjacentTestPaths: ["src/a.test.ts"], acceptanceCriteria: ["Expected behavior"] },
      expectedHashes: { "src/a.ts": "a".repeat(64) } };
    await runImprovementAgent({ authority: { ...authority, readOnly, maxEngineeringTokensPerRun, ...(boundSession ? { sessionId: `app_build_${"a".repeat(48)}` } : {}),
      ...(withPlan ? { forgePlan } : {}) }, agentId, prompt: "Inspect budget dispatch.", costCeilingUsd: 1,
      abortSignal: new AbortController().signal, onRunStarted: async () => undefined });
    expect(mock.run).toHaveBeenCalledOnce();
  });
  it.each(["complete", "requested_actions_unfinished", "answer_cut_off", "tool_calls_refused"] as const)("retains metered usage and typed %s without parsing or stripping output", async completion => {
    const response = '{"decision":"repair"}\n\nSome requested work is incomplete: 2 deferred action(s) did not run.';
    mock.run.mockImplementation(async function* () {
      yield { type: "model", costKnown: true, estimatedCostUsd: 0.050477 };
      yield { type: "status", label: "finishing within budget" };
      if (completion !== "complete") yield { type: "status", label: completion === "answer_cut_off" ? "answer cut off" : completion === "tool_calls_refused" ? "tool calls refused" : "requested actions unfinished",
        ...(completion === "requested_actions_unfinished" ? { toolLimit: { version: 1, reason: "per_turn_calls", remainingToolRounds: 12, unresolvedCalls: 2 } } : {}) };
    });
    mock.getRun.mockResolvedValue({ status: "completed", response });
    const result = await runImprovementAgent({ authority, agentId: "atlas", prompt: "Inspect.", costCeilingUsd: 1, abortSignal: new AbortController().signal, onRunStarted: async () => undefined });
    expect(result).toMatchObject({ response, completion, measuredCostUsd: 0.050477 });
    expect(mock.run).toHaveBeenCalledOnce();
  });
  it.each(["intact", "input_changed", "receipt_changed"] as const)("binds real inspection receipt input hashes and rejects changed persisted results (%s)", async mode => {
    const bound = { ...authority, readOnly: true, sessionId: `app_build_${"a".repeat(48)}` };
    const inputs = ["src/a.ts", "src/a.test.ts"].map(path => ({ projectId: authority.projectId, sessionId: bound.sessionId, path, startLine: 1, lineCount: 20 }));
    const files = inputs.map(({ path }) => ({ path, content: "example source", sha256: "d".repeat(64), lineRange: { startLine: 1, endLine: 1, totalLines: 1, truncated: false } }));
    let currentRun = "";
    const response = JSON.stringify({ decision: "no_change", summary: "Inspected implementation and adjacent test." });
    mock.run.mockImplementation(async function* (request: AgentRunRequest) {
      currentRun = request.runId!;
      yield { type: "model", costKnown: true, estimatedCostUsd: 0.01 };
      const allowance = await selfImprovementModelAllowance({ context: request.securityContext, executionScope: request.executionScope });
      for (const [index, id] of ["read0", "read1"].entries()) {
        allowance!.inspectionCompletion!.observeTool?.({ executionId: id, toolId: "app.projects.builder.file.read", modelOutput: JSON.stringify({ data: { executionId: id, status: "executed", dryRun: false, result: { file: files[index] } } }) });
        yield { type: "tool", toolId: "app.projects.builder.file.read", status: "executed", executionId: id };
      }
      const assessed = await allowance!.inspectionCompletion!.assessFinal({ text: response, incomplete: false, canCorrect: true });
      yield { type: "status", label: "inspection result", inspectionCompletion: mode === "receipt_changed"
        ? { ...assessed.receipt, result: { decision: "no_change", summary: "[redacted]" } } : assessed.receipt };
    });
    mock.getRun.mockResolvedValue({ status: "completed", response: "Earlier narration. " + response });
    mock.reads.mockImplementation(async (ids: string[]) => ids.map(id => ({ id, tenantId: authority.tenantId, actorId: authority.ownerActorId, toolId: "app.projects.builder.file.read", status: "executed", dryRun: false,
      output: { file: files[Number(id.at(-1))] },
      input: { ...inputs[Number(id.at(-1))], ...(mode === "input_changed" ? { path: "src/unread.test.ts" } : {}) } })));
    mock.scope.mockImplementation(async (id: string) => ({ toolId: "app.projects.builder.file.read", requesterRole: "operator", inputSha256: toolInputSha256(inputs[Number(id.at(-1))]),
      executionScope: createExecutionScope({ tenantId: authority.tenantId, initiatingActorId: authority.ownerActorId, executingPrincipalType: "agent", executingPrincipalId: "atlas", projectId: authority.projectId, correlationId: currentRun, purpose: "agent.tool.execute" }) }));
    const result = await runImprovementAgent({ authority: bound, agentId: "atlas", prompt: "Inspect.", costCeilingUsd: 1, abortSignal: new AbortController().signal, onRunStarted: async () => undefined });
    expect(result).toMatchObject({ completion: mode === "intact" ? "complete" : "inspection_evidence_unavailable", measuredCostUsd: 0.01 });
    expect(result.inspectionResult).toEqual(mode === "intact" ? JSON.parse(response) : undefined);
  });
  it("does not accept a completed inspection that omitted its typed completion event", async () => {
    mock.run.mockImplementation(async function* () { yield { type: "model", costKnown: true, estimatedCostUsd: 0.01 }; });
    mock.getRun.mockResolvedValue({ status: "completed", response: '{"decision":"no_change","summary":"No defect"}' });
    const result = await runImprovementAgent({ authority: { ...authority, readOnly: true, sessionId: `app_build_${"a".repeat(48)}` }, agentId: "atlas", prompt: "Inspect.", costCeilingUsd: 1, abortSignal: new AbortController().signal, onRunStarted: async () => undefined });
    expect(result).toMatchObject({ completion: "inspection_incomplete", measuredCostUsd: 0.01 });
    expect(result.inspectionResult).toBeUndefined();
  });
});

describe("terminal model reservation accounting", () => {
  // Retained failure's ten measured calls and refusal scalars. All identities,
  // authority, paths and response text below are synthetic; this does not replay
  // a provider call or assert that the old run already contained the new proof.
  const measured = [
    [12934, 215, 13149, 0.154099], [22132, 248, 22380, 0.129075],
    [28104, 306, 28410, 0.106897], [35977, 267, 36244, 0.132232],
    [45166, 163, 45329, 0.149648], [49260, 241, 49501, 0.108001],
    [54626, 568, 55194, 0.144482], [56812, 4804, 61616, 0.348384],
    [62334, 316, 62650, 0.140645], [64820, 203, 65023, 0.107108],
  ];
  const bound = { ...authority, sessionId: `app_build_${"a".repeat(48)}`, maxEngineeringTokensPerRun: 600_000,
    forgePlan: { phase: "reproduce" as const, plan: { summary: "Synthetic repair", sourcePaths: ["src/feature.ts"], newSourcePaths: [],
      focusedTestPaths: ["src/feature.test.ts"], adjacentTestPaths: ["src/adjacent.test.ts"], acceptanceCriteria: ["Observable behavior"] },
    expectedHashes: { "src/feature.ts": "a".repeat(64) } } };
  const run = (boundAuthority: SelfImprovementExecutionAuthority = bound) => runImprovementAgent({ authority: boundAuthority, agentId: "forge", prompt: "Synthetic bounded phase.", costCeilingUsd: 8,
    abortSignal: new AbortController().signal, onRunStarted: async () => undefined });
  const models = (): Array<Extract<AgentEvent, { type: "model" }>> => measured.map(([inputTokens, outputTokens, totalTokens, estimatedCostUsd], index) => ({
    type: "model", model: "synthetic-priced-model", provider: "openai", tier: "reasoning", inputTokens, outputTokens, totalTokens,
    cachedInputTokens: 0, latencyMs: 1, fallbackUsed: false, estimatedCostUsd, costKnown: true, usageReceiptRecorded: true,
    usageReceiptId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, attemptCount: 1, failedAttemptCount: 0,
    callReceipts: [{ provider: "openai", model: "synthetic-priced-model", status: "completed", usage: { inputTokens, outputTokens, totalTokens }, latencyMs: 1, estimatedCostUsd }],
  }));
  const refusal = (runId: string, events: ReturnType<typeof models>): Extract<AgentEvent, { type: "budget_exhausted" }> => ({
    type: "budget_exhausted", dimension: "tokens", limit: 600_000, attempted: 601_352, requiresAuthorization: true,
    message: "Synthetic pre-dispatch token reservation refusal.", preDispatch: { version: 1, runId, usageReceiptIds: events.map(event => event.usageReceiptId!) },
  });

  it.each([false, true])("retains a proven failed run and its known cost (zero prior calls=%s)", async zeroCalls => {
    const events = zeroCalls ? [] : models();
    mock.run.mockImplementation(async function* (request: AgentRunRequest) {
      mock.getRun.mockResolvedValue({ id: request.runId, status: "failed", response: "Synthetic partial response.", error: "Synthetic reservation refusal." });
      yield* events;
      yield refusal(request.runId!, events);
      yield { type: "error", message: "Synthetic reservation refusal." };
    });
    const result = await run();
    expect(result).toMatchObject({ completion: "run_failed", measuredCostUsd: zeroCalls ? 0 : 1.520571,
      terminalFailure: { code: "model_budget_exhausted", dimension: "tokens", limit: 600_000, attempted: 601_352,
        usageReceiptIds: events.map(event => event.usageReceiptId) } });
    expect(result.forgeResult).toBeUndefined();
    expect(result.inspectionResult).toBeUndefined();
    expect(mock.append).not.toHaveBeenCalled();
    expect(mock.run).toHaveBeenCalledOnce();
  });

  it.each(["generic_budget", "wall_abort", "foreign_proof", "foreign_run", "missing_id", "reordered_ids", "duplicate_id", "unpersisted_usage",
    "unknown_cost", "negative_cost", "model_after_refusal", "stream_interrupted", "unbound"] as const)("keeps %s failure on the unknown-usage path", async mode => {
    const events = models();
    if (mode === "duplicate_id") events[1].usageReceiptId = events[0].usageReceiptId;
    if (mode === "unpersisted_usage") events[1].usageReceiptRecorded = false;
    if (mode === "unknown_cost") events[1].costKnown = false;
    if (mode === "negative_cost") events[1].estimatedCostUsd = -1;
    mock.run.mockImplementation(async function* (request: AgentRunRequest) {
      mock.getRun.mockResolvedValue({ id: mode === "foreign_run" ? "foreign" : request.runId, status: "failed", response: "Synthetic partial response." });
      yield* events;
      if (mode === "stream_interrupted") throw new Error("Synthetic provider stream interrupted.");
      const event = refusal(request.runId!, events);
      if (mode === "generic_budget" || mode === "wall_abort") delete event.preDispatch;
      if (mode === "wall_abort") event.dimension = "wallTimeMs";
      if (mode === "foreign_proof") event.preDispatch!.runId = "foreign";
      if (mode === "missing_id") event.preDispatch!.usageReceiptIds.pop();
      if (mode === "reordered_ids") event.preDispatch!.usageReceiptIds.reverse();
      yield event;
      if (mode === "model_after_refusal") yield { ...events[0], usageReceiptId: "00000000-0000-4000-8000-000000000099" };
      yield { type: "error", message: "Synthetic terminal failure." };
    });
    await expect(run(mode === "unbound" ? authority : bound)).rejects.toThrow(mode === "stream_interrupted" ? /provider stream interrupted/ : /run failed/);
    expect(mock.append).not.toHaveBeenCalled();
    expect(mock.run).toHaveBeenCalledOnce();
  });
});

describe("effect-backed Forge completion", () => {
  it.each(["written", "final_written", "no_changes", "final_no_changes", "captured_round_limit_no_changes", "call_limit_no_changes", "round_limit_written", "call_limit_written", "per_turn_no_changes", "budget_label_no_changes", "no_op", "failed_then_written", "foreign", "input_changed", "pending", "zero_context", "unknown_usage", "oversized", "invalid_persisted"] as const)("records bounded %s with honest model usage", async mode => {
    const sessionId = `app_build_${"a".repeat(48)}`;
    const plan = { summary: "Synthetic fallback", sourcePaths: ["src/feature.ts"], newSourcePaths: [], focusedTestPaths: ["src/feature.test.ts"], adjacentTestPaths: ["src/adjacent.test.ts"], acceptanceCriteria: ["Fallback"] };
    if (mode === "oversized") plan.focusedTestPaths = [`src/${"界".repeat(450)}.test.ts`];
    const bound = { ...authority, sessionId, writePaths: plan.focusedTestPaths, forgePlan: { phase: "reproduce" as const, plan, expectedHashes: { "src/feature.ts": "a".repeat(64) } } };
    // Run 4251's exact terminal tool-limit payload and measured cost, with
    // synthetic authority/read receipts and final text; no live run or tool replay.
    const measuredCostUsd = mode === "captured_round_limit_no_changes" ? 0.125341 : 0.02;
    const toolLimitStatus = mode.includes("round_limit")
      ? { type: "status" as const, label: "tool budget reached", toolLimit: { version: 1 as const, reason: "run_tool_rounds" as const, remainingToolCalls: 29, remainingToolRounds: 0 } }
      : mode.startsWith("call_limit")
        ? { type: "status" as const, label: "tool budget reached", toolLimit: { version: 1 as const, reason: "run_tool_calls" as const, remainingToolCalls: 0, remainingToolRounds: 3 } }
        : undefined;
    const noChanges = ["no_changes", "final_no_changes", "captured_round_limit_no_changes", "call_limit_no_changes", "per_turn_no_changes", "budget_label_no_changes"].includes(mode);
    let currentRun = "";
    const records = new Map<string, Record<string, unknown>>();
    const originalInputs = new Map<string, Record<string, unknown>>();
    const put = (id: string, toolId: string, parameters: Record<string, unknown>, output: object, status = "executed") => {
      const input = { projectId: authority.projectId, sessionId, ...parameters }; originalInputs.set(id, input);
      records.set(id, { id, toolId, tenantId: authority.tenantId, actorId: authority.ownerActorId, input, output, dryRun: false, status });
    };
    mock.reads.mockImplementation(async (ids: string[]) => ids.map(id => records.get(id)));
    mock.scope.mockImplementation(async (id: string) => ({ toolId: records.get(id)!.toolId, requesterRole: "operator", inputSha256: toolInputSha256(originalInputs.get(id)!),
      executionScope: createExecutionScope({ tenantId: authority.tenantId, initiatingActorId: authority.ownerActorId, executingPrincipalType: "agent", executingPrincipalId: "forge", projectId: authority.projectId, correlationId: currentRun, purpose: "agent.tool.execute", causationId: id }) }));
    mock.run.mockImplementation(async function* (request: AgentRunRequest) {
      currentRun = request.runId!;
      const allowance = await selfImprovementModelAllowance({ context: request.securityContext, executionScope: request.executionScope });
      const handoff = allowance!.forgeHandoff!; handoff.begin();
      if (mode === "zero_context") { yield { type: "status", label: "context refused", forgeHandoff: handoff.finishContext([], "budget_unavailable") }; return; }
      const reads = [];
      for (const [i, read] of handoff.requests.entries()) {
        const id = `read-${i}`, file = { path: read.path, sha256: "a".repeat(64), content: "synthetic source", lineRange: { startLine: 1, endLine: 1, totalLines: 1 } };
        put(id, "app.projects.builder.file.read", { path: read.path, startLine: 1, lineCount: 200 }, { file });
        reads.push(await handoff.verifyRead(read, { executionId: id, toolId: "app.projects.builder.file.read", modelOutput: JSON.stringify({ data: { executionId: id, status: "executed", dryRun: false, result: { file } } }) }));
        yield { type: "tool", toolId: "app.projects.builder.file.read", status: "executed", executionId: id };
      }
      yield { type: "status", label: "context ready", forgeHandoff: handoff.finishContext(reads) };
      handoff.modelStarting();
      yield { type: "model", costKnown: mode !== "unknown_usage", estimatedCostUsd: mode === "unknown_usage" ? undefined : measuredCostUsd };
      if (mode.startsWith("final_")) yield { type: "status", label: "finishing within budget" };
      if (mode === "per_turn_no_changes") yield { type: "status", label: "tool budget reached", toolLimit: { version: 1, reason: "per_turn_calls", remainingToolCalls: 29, remainingToolRounds: 3 } };
      if (mode === "budget_label_no_changes") yield { type: "status", label: "tool budget reached" };
      if (noChanges) { if (toolLimitStatus) yield toolLimitStatus; return; }
      if (mode === "oversized") {
        for (let index = 0; index < 48; index++) {
          const id = `write-${index}`, previousSha256 = index ? (index - 1).toString(16).padStart(64, "0") : null;
          const sha256 = index.toString(16).padStart(64, "0"), path = plan.focusedTestPaths[0];
          put(id, "app.projects.builder.file.update", { path, expectedSha256: previousSha256, content: `synthetic ${index}` }, { update: { path, previousSha256, sha256, size: 20 } });
          yield { type: "tool", toolId: "app.projects.builder.file.update", status: "executed", executionId: id };
        }
        return;
      }
      const before = mode === "no_op" ? "d".repeat(64) : null;
      const parameters = { path: "src/feature.test.ts", expectedSha256: before, content: "synthetic regression" };
      const output = { update: { path: parameters.path, previousSha256: before, sha256: "d".repeat(64), size: 20 } };
      if (mode === "failed_then_written") {
        put("failed", "app.projects.builder.file.update", parameters, {}, "failed");
        yield { type: "tool", toolId: "app.projects.builder.file.update", status: "failed", executionId: "failed" };
      }
      put("write", "app.projects.builder.file.update", parameters, output, mode === "pending" ? "awaiting_approval" : "executed");
      if (mode === "foreign") records.get("write")!.actorId = "foreign";
      if (mode === "input_changed") records.get("write")!.input = { ...originalInputs.get("write"), content: "changed" };
      yield { type: "tool", toolId: "app.projects.builder.file.update", status: mode === "pending" ? "awaiting_approval" : "executed", executionId: "write" };
      if (toolLimitStatus) yield toolLimitStatus;
    });
    mock.getRun.mockResolvedValue({ status: mode === "pending" ? "waiting_approval" : "completed", response: mode === "captured_round_limit_no_changes"
      ? "Synthetic final response: editing is unavailable for this turn."
      : "A proposed manual test is not effect proof." });
    if (mode === "invalid_persisted") mock.append.mockResolvedValue({ payload: null });
    const result = await runImprovementAgent({ authority: bound, agentId: "forge", prompt: "Reproduce", costCeilingUsd: 2, abortSignal: new AbortController().signal, onRunStarted: async () => undefined });
    const success = ["written", "final_written", "round_limit_written", "call_limit_written", "unknown_usage"].includes(mode);
    const validEffect = success || mode === "invalid_persisted";
    const reason = validEffect ? "complete" : ["final_no_changes", "captured_round_limit_no_changes", "call_limit_no_changes"].includes(mode) ? "budget_before_effect" : mode === "pending" ? "pending_approval" : mode === "zero_context" ? "budget_unavailable" : noChanges || mode === "no_op" ? "no_changes" : "evidence_unavailable";
    expect(result).toMatchObject({ completion: success ? "complete" : "forge_incomplete", measuredCostUsd: mode === "zero_context" ? 0 : mode === "unknown_usage" ? null : measuredCostUsd,
      forgeReceipt: { outcome: validEffect ? "completed" : "incomplete", reason } });
    if (success) expect(result.forgeResult?.effects).toHaveLength(1); else expect(result.forgeResult).toBeUndefined();
    expect(mock.append).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.forgeReceipt)).not.toContain("synthetic regression");
  });
});
