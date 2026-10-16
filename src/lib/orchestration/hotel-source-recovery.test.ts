import type { LookupFunction } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providers = vi.hoisted(() => ({ fetch: vi.fn(), lookup: vi.fn(), search: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: providers.lookup }));
vi.mock("undici", () => ({ Agent: class { constructor(_options: { connect: { lookup: LookupFunction } }) {} }, fetch: providers.fetch }));
vi.mock("@/lib/web-search/search", async (original) => ({
  ...await original<typeof import("@/lib/web-search/search")>(), runLiveWebSearch: providers.search,
}));
vi.mock("@/lib/http/rate-limit", () => ({ checkSharedRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }) }));

import { runNonOpenAIProviderToolLoop } from "@/lib/orchestration/agent-runner";
import { createRunToolRecovery } from "@/lib/orchestration/tool-recovery";
import type { AgentEvent } from "@/lib/orchestration/types";
import type { ModelToolCall, ModelToolTurnRequest, ModelToolTurnResult } from "@/lib/models/types";
import { executeGovernedTool } from "@/lib/tools/executor";
import { getGovernedTool } from "@/lib/tools/registry";
import { listToolExecutions, rejectPendingToolExecution } from "@/lib/tools/audit-store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { citationIdForWebUrl } from "@/lib/rag/citations";
import { createRunBudgetState, DEFAULT_AGENT_RUN_BUDGET_LIMITS, planModelTurnBudget, remainingRunBudget, reserveRunBudget } from "@/lib/runs/budgets";
import { PublicWebReadError } from "@/lib/web-search/read-failure";

const context = { tenantId: "hotel-recovery-tenant", actorId: "hotel-recovery-owner", role: "operator" as const, source: "default" as const };
const runId = "hotel-recovery-run";
const scope = createExecutionScope({ tenantId: context.tenantId, initiatingActorId: context.actorId,
  executingPrincipalType: "agent", executingPrincipalId: "agent:atlas:hotel-recovery", correlationId: runId, purpose: "agent.tool.execute" });
const blockedA = "https://hotel-a.example/offer";
const blockedB = "https://hotel-b.example/offer";
const readable = "https://hotel-c.example/comparison";
const datesAndOccupancy = "19 October 2026 to 21 October 2026; two nights; one room; two adults; no children";
const prompt = `Compare Palm Meadows offers for ${datesAndOccupancy}. Include total stay price with taxes, meals and cancellation terms.`;
const offerText = `Synthetic fixture: Palm Meadows offers for ${datesAndOccupancy}. Refundable room: INR 18,400 total for both nights, including taxes and breakfast. Free cancellation until 17 October 2026. Nonrefundable room: INR 15,200 total for both nights including taxes, without breakfast. No membership discount is required. These are public advertised offers; live inventory has not been confirmed.`;
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "asael-hotel-recovery-"));
  vi.stubEnv("OMNIAGENT_DATA_DIR", directory);
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("OMNIAGENT_GRADUATED_AUTONOMY", "false");
  providers.fetch.mockReset();
  providers.search.mockReset();
  providers.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  providers.fetch.mockImplementation(async (url: string) => new Response(url === readable ? `<main>${offerText}</main>` : null,
    { status: url === readable ? 200 : 403, headers: { "content-type": "text/html" } }));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

function searchResult(query: string, urls: string[]) {
  return { query, searchedAt: "2026-10-15T15:00:00.000Z", provider: "openai.responses.web_search" as const,
    model: "synthetic-search", summary: urls.length ? "Potential public sources; detailed offer terms still require reading." : "No alternative public source found.",
    sources: urls.map((url) => ({ url, title: "Synthetic hotel source", citationId: citationIdForWebUrl(url) })), sourceCount: urls.length };
}
function call(callId: string, name: string, input: Record<string, unknown>): ModelToolCall {
  return { callId, name, argumentsJson: JSON.stringify(input) };
}
function turn(input: { text?: string; toolCalls?: ModelToolCall[] }): ModelToolTurnResult {
  return { text: input.text || "", toolCalls: input.toolCalls || [], provider: "google", model: "synthetic-model",
    continuation: { provider: "google", state: [] }, usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, totalTokens: 20 },
    latencyMs: 1, estimatedCostUsd: 0, costKnown: true, attempts: [{ provider: "google", model: "synthetic-model", status: "completed", latencyMs: 1 }] };
}
function data(request: ModelToolTurnRequest) {
  return request.toolResults?.map((item) => JSON.parse(item.output).data) || [];
}
async function collect(generator: ReturnType<typeof runNonOpenAIProviderToolLoop>) {
  const events: AgentEvent[] = [];
  for (;;) { const next = await generator.next(); if (next.done) return { events, result: next.value }; events.push(next.value); }
}

async function hotelRun({ alternatives = true, toolCalls = 30, noWeb = false }: { alternatives?: boolean; toolCalls?: number; noWeb?: boolean } = {}) {
  let budget = createRunBudgetState({ ...DEFAULT_AGENT_RUN_BUDGET_LIMITS, toolCalls });
  providers.search.mockImplementation(async ({ query }: { query: string }) => searchResult(query,
    providers.search.mock.calls.length === 1 ? [blockedA, blockedB] : alternatives ? [readable] : []));
  let prefetch;
  if (!noWeb) {
    budget = reserveRunBudget(budget, { toolCalls: 1, modelTurns: 1 });
    prefetch = await executeGovernedTool({ toolId: "web.search", input: { query: prompt, limit: 4, searchContextSize: "low" },
      dryRun: false, approved: false, requireReadOnly: true, context, executionScope: scope, agentRunId: runId,
      idempotencyKey: `${runId}:web-prefetch` });
    expect(prefetch.record.status, prefetch.record.reason).toBe("executed");
  }
  let step = 0;
  const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
    step += 1;
    expect(request.input).toContain(datesAndOccupancy);
    expect(JSON.stringify(request.conversation)).toContain("Find cheaper offers and the best refundable option");
    const observations = data(request);
    if (noWeb) {
      if (step === 1) return turn({ toolCalls: [call("unadmitted-search", "web_search", { query: prompt })] });
      expect(JSON.stringify(observations)).toContain("Unknown tool");
      return turn({ text: "I can compare the supplied documents, but this request excludes web access. Current availability remains unverified." });
    }
    if (step === 1) {
      expect(request.instructions).toContain("Potential public sources");
      return turn({ toolCalls: [call("read-a", "web_read", { url: blockedA }), call("read-b", "web_read", { url: blockedB })] });
    }
    if (step === 2) {
      expect(observations).toHaveLength(2);
      expect(observations.every((item) => item.status === "failed" && item.result === null && item.webReadFailure.code === "source_access_restricted")).toBe(true);
      if (toolCalls === 3) {
        expect(request.toolChoice).toBe("none");
        return turn({ text: "Both pages refused automated reading. The remaining tool budget is exhausted, so I cannot verify a comparable offer for these dates and occupancy." });
      }
      return turn({ toolCalls: [call("repeat-a", "web_read", { url: `${blockedA}#prices` }),
        call("alternative-search", "web_search", { query: `${prompt} alternative publicly readable source` })] });
    }
    if (step === 3) {
      expect(observations).toHaveLength(2);
      expect(observations[0]).toMatchObject({ status: "blocked", result: { executed: false,
        webReadRecovery: { reason: "source_already_failed", retrySameSource: false } } });
      expect(observations[1]).toMatchObject({ status: "executed", result: { sourceCount: alternatives ? 1 : 0 } });
      if (!alternatives) return turn({ text: "Both original sources blocked automated reading and the alternative search found no readable offer. I cannot confirm equivalent total prices or refundable availability for the original dates and occupancy." });
      return turn({ toolCalls: [call("read-alternative", "web_read", { url: readable })] });
    }
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ status: "executed", result: { content: expect.stringContaining(offerText), citationId: citationIdForWebUrl(readable) } });
    return turn({ text: `For ${datesAndOccupancy}, the advertised refundable total is INR 18,400 with taxes and breakfast, cancellable until 17 October; nonrefundable is INR 15,200 with taxes and no breakfast. Live availability remains unverified. The two initial sources blocked automated reading. [${citationIdForWebUrl(readable)}]` });
  });
  const definitions = noWeb ? [] : [getGovernedTool("web.read")!, getGovernedTool("web.search")!];
  const functionName = (id: string) => id.replace(".", "_");
  const collected = await collect(runNonOpenAIProviderToolLoop({
    provider: "google", tier: "fast", instructions: `Compare evidence honestly within the existing tool admission and budgets. ${prefetch ? JSON.stringify(prefetch.result) : "Use only supplied documents; do not browse."}`,
    prompt, conversation: [{ type: "message", role: "user", content: prompt }, { type: "message", role: "user", content: "Find cheaper offers and the best refundable option." }],
    tools: definitions.map((definition) => ({ type: "function" as const, name: functionName(definition.id), description: definition.description, parameters: definition.inputSchema })),
    toolbox: { byFunctionName: new Map(definitions.map((definition) => [functionName(definition.id), { definition, functionName: functionName(definition.id) }])) },
    securityContext: context, executionScope: scope, runId, maxToolSteps: 6, requireReadOnly: true,
    beforeModelTurn: async ({ toolsEnabled }) => {
      const plan = planModelTurnBudget(budget, { estimate: { tokens: 100, costMicrousd: 1, followUpTokens: 100, followUpCostMicrousd: 1 }, toolsEnabled, allowRetry: false });
      budget = plan.state;
      return { maxAttempts: 1, finalTurn: plan.finalTurn };
    },
    reserveTools: (definitions) => { budget = reserveRunBudget(budget, { toolCalls: definitions.length }); return undefined; },
    remainingToolCalls: () => remainingRunBudget(budget).toolCalls,
    generateTurn,
  }));
  return { ...collected, generateTurn, budget, records: await listToolExecutions(50, { tenantId: context.tenantId }) };
}

describe("ordinary hotel comparison recovery through the governed loop", () => {
  it("keeps the failed receipts and replaces blocked pages with bounded search and a citable read", async () => {
    const run = await hotelRun();
    expect(providers.search).toHaveBeenCalledTimes(2);
    expect(providers.fetch.mock.calls.map(([url]) => url).sort()).toEqual([blockedA, blockedB, readable].sort());
    expect(run.records).toHaveLength(6);
    expect(run.records.filter((record) => record.status === "failed")).toHaveLength(2);
    expect(run.records.filter((record) => record.status === "blocked")).toEqual([
      expect.objectContaining({ toolId: "web.read", output: { executed: false,
        webReadRecovery: expect.objectContaining({ reason: "source_already_failed" }) } }),
    ]);
    expect(run.records.every((record) => record.tenantId === context.tenantId && record.actorId === context.actorId)).toBe(true);
    expect(run.budget.used.toolCalls).toBe(6);
    expect(run.result.text).toContain("INR 18,400");
    expect(run.result.text).toContain("Live availability remains unverified");
    expect(run.result.text).not.toMatch(/enable.*web|confirmed availability|booked/i);
    expect(run.result.citationSources).toEqual([expect.objectContaining({ url: readable, citationId: citationIdForWebUrl(readable) })]);
  });

  it("reports incomplete evidence when a bounded alternative search finds no source", async () => {
    const run = await hotelRun({ alternatives: false });
    expect(providers.search).toHaveBeenCalledTimes(2);
    expect(providers.fetch).toHaveBeenCalledTimes(2);
    expect(run.records.filter((record) => record.status === "failed")).toHaveLength(2);
    expect(run.records).toHaveLength(5);
    expect(run.budget.used.toolCalls).toBe(5);
    expect(run.result.text).toContain("cannot confirm equivalent total prices");
    expect(run.result.text).not.toMatch(/INR|enable.*web|\[web:/i);
    expect(run.result.citationSources).toEqual([]);
  });

  it("does not extend the remaining tool budget to perform recovery", async () => {
    const run = await hotelRun({ toolCalls: 3 });
    expect(providers.search).toHaveBeenCalledOnce();
    expect(providers.fetch).toHaveBeenCalledTimes(2);
    expect(run.records).toHaveLength(3);
    expect(run.budget.used.toolCalls).toBe(3);
    expect(run.result.text).toContain("remaining tool budget is exhausted");
  });

  it("does not invent admission when the conversation excludes web tools", async () => {
    const run = await hotelRun({ noWeb: true });
    expect(providers.search).not.toHaveBeenCalled();
    expect(providers.fetch).not.toHaveBeenCalled();
    expect(run.records).toEqual([]);
    expect(run.result.text).toContain("this request excludes web access");
    expect(run.budget.used.toolCalls).toBe(0);
  });

  it("keeps a failed source blocked across a saved approval pause and rejection without replaying either request", async () => {
    const recoveryScope = { tenantId: context.tenantId, actorId: context.actorId, runId };
    const recovery = createRunToolRecovery(recoveryScope);
    const definitions = [getGovernedTool("web.read")!, getGovernedTool("http.request")!];
    const functionName = (id: string) => id.replace(".", "_");
    let consumed = 0;
    const common = {
      provider: "google" as const, tier: "fast" as const,
      instructions: "Use the admitted tools within the original dates and occupancy; respect approval decisions.", prompt,
      tools: definitions.map((definition) => ({ type: "function" as const, name: functionName(definition.id), description: definition.description, parameters: definition.inputSchema })),
      toolbox: { byFunctionName: new Map(definitions.map((definition) => [functionName(definition.id), { definition, functionName: functionName(definition.id) }])) },
      securityContext: context, executionScope: scope, runId, maxToolSteps: 6,
      reserveTools: (items: readonly unknown[]) => { consumed += items.length; return undefined; },
      remainingToolCalls: () => 10 - consumed,
    };
    let firstStep = 0;
    const paused = await collect(runNonOpenAIProviderToolLoop({ ...common, toolRecovery: recovery,
      generateTurn: async (request) => {
        if (++firstStep === 1) return turn({ toolCalls: [call("read-before-pause", "web_read", { url: blockedA })] });
        expect(data(request)).toMatchObject([{ status: "failed", webReadFailure: { code: "source_access_restricted" } }]);
        return turn({ toolCalls: [call("reviewed-get", "http_request", { url: "https://reviewed.example/offers", method: "GET" })] });
      },
    }));
    const pending = paused.result.waitingApproval;
    expect(pending).toMatchObject({ toolId: "http.request" });
    expect(providers.fetch).toHaveBeenCalledTimes(1);
    const snapshot = JSON.parse(JSON.stringify(recovery.snapshot()));
    expect(JSON.stringify(snapshot)).not.toContain("https://");
    const before = await listToolExecutions(50, { tenantId: context.tenantId });
    expect(before.map((record) => record.status).sort()).toEqual(["approval_required", "failed"]);
    const rejected = await rejectPendingToolExecution({ id: pending!.executionId, tenantId: context.tenantId,
      rejectedBy: context.actorId, reason: "Use existing public evidence only." });
    expect(rejected.outcome).toBe("rejected");
    const restored = createRunToolRecovery(recoveryScope, snapshot);
    restored.observe({ record: rejected.record!, result: null });
    let resumedStep = 0;
    const resumed = await collect(runNonOpenAIProviderToolLoop({ ...common, toolRecovery: restored,
      toolSteps: paused.result.toolSteps, continuation: pending!.providerState.continuation,
      toolResults: [{ callId: pending!.providerState.pendingCall.callId, name: pending!.providerState.pendingCall.name,
        output: JSON.stringify({ provenance: "tool_result", trust: "untrusted_data", data: { executionId: rejected.record!.id,
          status: rejected.record!.status, result: null } }), isError: true }],
      generateTurn: async (request) => {
        expect(request.input).toContain(datesAndOccupancy);
        if (++resumedStep === 1) {
          expect(data(request)).toEqual([{ executionId: pending!.executionId, status: "rejected", result: null }]);
          return turn({ toolCalls: [call("read-after-resume", "web_read", { url: `${blockedA}#offer` })] });
        }
        expect(data(request)).toMatchObject([{ status: "blocked", result: { executed: false,
          webReadRecovery: { reason: "source_already_failed", priorExecutionId: before.find((record) => record.status === "failed")!.id } } }]);
        return turn({});
      },
    }));
    expect(resumed.result.waitingApproval).toBeUndefined();
    expect(providers.fetch.mock.calls.map(([url]) => url)).toEqual([blockedA]);
    expect(providers.search).not.toHaveBeenCalled();
    const after = await listToolExecutions(50, { tenantId: context.tenantId });
    expect(after.map((record) => record.status).sort()).toEqual(["blocked", "failed", "rejected"]);
    expect(after.find((record) => record.status === "failed")).toEqual(before.find((record) => record.status === "failed"));
    expect(consumed).toBe(3);
  });

  it("does not treat an agent's raw approved flag as reviewed permission to repeat a failed source", async () => {
    const recovery = createRunToolRecovery({ tenantId: context.tenantId, actorId: context.actorId, runId });
    const execute = recovery.wrap(executeGovernedTool);
    const request = { toolId: "web.read", input: { url: blockedA }, dryRun: false,
      requireReadOnly: true, context, executionScope: scope, agentRunId: runId };
    const failed = await execute({ ...request, approved: false, idempotencyKey: `${runId}:failed-before-raw-approval` });
    expect(failed.record.status).toBe("failed");
    const denied = await execute({ ...request, approved: true, idempotencyKey: `${runId}:raw-approval-repeat` });
    expect(denied.record.status).toBe("blocked");
    expect(denied.result).toMatchObject({ executed: false, webReadRecovery: { reason: "source_already_failed", priorExecutionId: failed.record.id } });
    expect(providers.fetch.mock.calls.map(([url]) => url)).toEqual([blockedA]);
    expect((await listToolExecutions(50, { tenantId: context.tenantId })).map((record) => record.status).sort()).toEqual(["blocked", "failed"]);
  });

  it("matches a failed redacted audit URL to the same raw sensitive-query request", async () => {
    const recovery = createRunToolRecovery({ tenantId: context.tenantId, actorId: context.actorId, runId });
    const execute = recovery.wrap(executeGovernedTool);
    const url = `${blockedA}?access_token=synthetic123`;
    const request = { toolId: "web.read", input: { url }, dryRun: false,
      requireReadOnly: true, context, executionScope: scope, agentRunId: runId };
    const failed = await execute({ ...request, idempotencyKey: `${runId}:sensitive-query-first` });
    expect(failed.record.status).toBe("failed");
    expect(failed.record.input.url).toBe(`${blockedA}?access_token=[redacted]`);
    const restored = createRunToolRecovery({ tenantId: context.tenantId, actorId: context.actorId, runId },
      JSON.parse(JSON.stringify(recovery.snapshot())));
    const denied = await restored.wrap(executeGovernedTool)({ ...request, idempotencyKey: `${runId}:sensitive-query-repeat` });
    expect(denied.record.status).toBe("blocked");
    expect(denied.result).toMatchObject({ executed: false,
      webReadRecovery: { reason: "source_already_failed", priorExecutionId: failed.record.id } });
    expect(providers.fetch.mock.calls.map(([requestedUrl]) => requestedUrl)).toEqual([url]);
    expect(JSON.stringify(recovery.snapshot())).not.toContain("synthetic123");
    expect(JSON.stringify(denied)).not.toContain("synthetic123");
  });

  it("stops further page reads at saved failure capacity even with a larger configured call allowance", async () => {
    const recoveryScope = { tenantId: context.tenantId, actorId: context.actorId, runId };
    const recovery = createRunToolRecovery(recoveryScope);
    // A bounded fixture of prior governed failures under a raised server allowance.
    // No HTTP calls or fictional project changes are used to construct this history.
    for (let index = 0; index < 128; index += 1) {
      recovery.observe({ record: {
        id: `prior-failure-${index}`, tenantId: context.tenantId, actorId: context.actorId,
        toolId: "web.read", toolName: "Read public page", riskLevel: 0, status: "failed",
        dryRun: false, approvalRequired: false, createdAt: "2026-10-15T15:00:00.000Z",
        input: { url: `https://prior.example/source-${index}` },
        output: { webReadFailure: new PublicWebReadError("source_access_restricted", { httpStatus: 403 }).details },
      } });
    }
    const saved = JSON.parse(JSON.stringify(recovery.snapshot()));
    const restored = createRunToolRecovery(recoveryScope, saved);
    let budget = createRunBudgetState({ ...DEFAULT_AGENT_RUN_BUDGET_LIMITS, toolCalls: 150 }, { used: { toolCalls: 128 } });
    providers.search.mockResolvedValue(searchResult(prompt, []));
    const definitions = [getGovernedTool("web.read")!, getGovernedTool("web.search")!];
    const functionName = (id: string) => id.replace(".", "_");
    let modelTurn = 0;
    await collect(runNonOpenAIProviderToolLoop({
      provider: "google", tier: "fast", instructions: "Respect the saved source recovery fence and remaining budget.", prompt,
      tools: definitions.map((definition) => ({ type: "function" as const, name: functionName(definition.id), description: definition.description, parameters: definition.inputSchema })),
      toolbox: { byFunctionName: new Map(definitions.map((definition) => [functionName(definition.id), { definition, functionName: functionName(definition.id) }])) },
      securityContext: context, executionScope: scope, runId, maxToolSteps: 2, requireReadOnly: true, toolRecovery: restored,
      beforeModelTurn: async ({ toolsEnabled }) => {
        const plan = planModelTurnBudget(budget, { estimate: { tokens: 100, costMicrousd: 1, followUpTokens: 100, followUpCostMicrousd: 1 }, toolsEnabled, allowRetry: false });
        budget = plan.state;
        return { maxAttempts: 1, finalTurn: plan.finalTurn };
      },
      reserveTools: (items) => { budget = reserveRunBudget(budget, { toolCalls: items.length }); return undefined; },
      remainingToolCalls: () => remainingRunBudget(budget).toolCalls,
      generateTurn: async (request) => {
        if (++modelTurn === 1) return turn({ toolCalls: [
          call("after-cap-read", "web_read", { url: readable }),
          call("after-cap-search", "web_search", { query: prompt }),
        ] });
        expect(data(request)).toMatchObject([
          { status: "blocked", result: { executed: false, webReadRecovery: { reason: "failure_capacity_reached" } } },
          { status: "executed", result: { sourceCount: 0 } },
        ]);
        return turn({ text: "The page-read failure limit was reached. No new page was fetched, and the permitted search found no further evidence." });
      },
    }));
    expect(providers.fetch).not.toHaveBeenCalled();
    expect(providers.search).toHaveBeenCalledOnce();
    expect(budget.used.toolCalls).toBe(130);
    expect(remainingRunBudget(budget).toolCalls).toBe(20);
    expect(restored.snapshot()).toEqual(saved);
    const receipts = await listToolExecutions(50, { tenantId: context.tenantId });
    expect(receipts.map((record) => record.status).sort()).toEqual(["blocked", "executed"]);
  });
});
