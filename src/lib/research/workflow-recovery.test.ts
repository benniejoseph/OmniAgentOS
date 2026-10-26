import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateModelStructured: vi.fn(),
  resolveRuntimeModelAssignment: vi.fn(),
  executeGovernedTool: vi.fn(),
  getWorkflowRunDetail: vi.fn(),
  getWorkflowRunExecutionAuthority: vi.fn(),
  transitionWorkflowRunWithEvents: vi.fn(),
  updateWorkflowStepForRunFence: vi.fn(),
  appendWorkflowEvent: vi.fn(),
}));

vi.mock("@/lib/models/gateway", () => ({ generateModelStructured: mocks.generateModelStructured }));
vi.mock("@/lib/settings/runtime-models", () => ({ resolveRuntimeModelAssignment: mocks.resolveRuntimeModelAssignment }));
vi.mock("@/lib/tools/executor", () => ({
  executeGovernedTool: mocks.executeGovernedTool,
  EffectReceiptFinalizationError: class EffectReceiptFinalizationError extends Error {},
}));
vi.mock("@/lib/threads/store", () => ({
  appendThreadTurn: vi.fn(),
  workflowThreadActorReadOrder: async (_tenantId: string, actorId: string) => [actorId],
}));
vi.mock("@/lib/subagents/context", () => ({
  buildWorkflowSpecialistContext: vi.fn(),
  inspectWorkflowSpecialistDependencies: async () => ({ state: "ready" }),
}));
vi.mock("@/lib/missions/runtime", () => ({ attachMissionExecutor: vi.fn(), reconcileMissionState: vi.fn() }));
vi.mock("@/lib/memory/consolidator", () => ({ formVerifiedEffectMemories: vi.fn() }));
vi.mock("@/lib/memory/store", () => ({ saveMemory: vi.fn() }));
vi.mock("@/lib/rag/context-engine", () => ({
  AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES: {}, AUTHORIZED_MEMORY_ONLY_RETRIEVAL_SOURCES: {}, buildContextPack: vi.fn(),
}));
vi.mock("@/lib/workflows/planner", () => ({ buildDynamicWorkflowPlan: vi.fn(), getWorkflowPlanById: vi.fn() }));
vi.mock("@/lib/workflows/executor", () => ({
  executeDynamicWorkflowPlan: vi.fn(), listWorkflowPlanNodeExecutionsForRun: vi.fn(), parseWorkflowPlanOutput: vi.fn(),
}));
vi.mock("@/lib/workflows/store", () => ({
  getWorkflowRunDetail: mocks.getWorkflowRunDetail,
  getWorkflowRunExecutionAuthority: mocks.getWorkflowRunExecutionAuthority,
  transitionWorkflowRunWithEvents: mocks.transitionWorkflowRunWithEvents,
  updateWorkflowStepForRunFence: mocks.updateWorkflowStepForRunFence,
  appendWorkflowEvent: mocks.appendWorkflowEvent,
  approveWorkflowRun: vi.fn(), listRunnableWorkflowRuns: vi.fn(), recordWorkflowSpecialistsPending: vi.fn(), updateWorkflowStep: vi.fn(),
  workflowStepDefinitions: ["preflight", "retrieve_context", "plan", "approval_gate", "execute", "verify", "persist_report"]
    .map(key => ({ key, label: key })),
}));

import { buildResearchPlan } from "@/lib/research/plan";
import { researchOptionsSchema } from "@/lib/research/contracts";
import { buildAgentInstructions } from "@/lib/orchestration/prompts";
import { researchReportInstructions } from "@/lib/orchestration/research";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { ModelStructuredRequest } from "@/lib/models/types";
import type { RuntimeModelResolution } from "@/lib/settings/runtime-models";
import { createWorkflowBudgetSession } from "@/lib/workflows/budgets";
import { signalWorkflowRun, tickWorkflowRun } from "@/lib/workflows/runner";
import { workflowStepDefinitions } from "@/lib/workflows/store";
import type { WorkflowEventRecord, WorkflowRunDetail, WorkflowRunRecord, WorkflowStepRecord } from "@/lib/workflows/types";

const tenantId = "tenant-research-recovery";
const actorId = "owner-research-recovery";
const goal = "Compare refundable hotel offers and their cancellation conditions.";
const options = researchOptionsSchema.parse({ depth: "quick", questions: [goal] });
const report = "The retained hotel source lists refundable offers. Compare the cancellation deadline before choosing. [hotel-source]";
const authority = {
  requesterRole: "operator" as const,
  executionScope: createExecutionScope({
    tenantId, initiatingActorId: actorId, executingPrincipalType: "user",
    executingPrincipalId: actorId, correlationId: "research-recovery",
    purpose: "workflow.run",
  }),
};

function collectedState() {
  return {
    schemaVersion: 1,
    plan: buildResearchPlan(goal, options),
    createdAt: "2026-10-27T00:00:00.000Z",
    phase: "writing",
    searches: [{
      query: goal, searchedAt: "2026-10-27T00:00:01.000Z",
      provider: "openai.responses.web_search", model: "search-model",
      summary: "Public hotel cancellation terms were found.", sourceCount: 1,
      sources: [{ citationId: "hotel-source", url: "https://example.com/hotel", title: "Hotel cancellation terms" }],
    }],
    reads: [{
      url: "https://example.com/hotel", title: "Hotel cancellation terms",
      content: "Refundable hotel offers allow cancellation until the deadline stated on the booking.",
      contentType: "text/html", fetchedAt: "2026-10-27T00:00:02.000Z",
      citationId: "hotel-source", truncated: false, contentTrust: "untrusted",
    }],
    pendingQueries: [], searchedQueries: [goal], readUrls: ["https://example.com/hotel"],
    gapRound: 0, planPrepared: true,
    tools: [
      { key: "search-1", toolId: "web.search", input: { query: goal }, executionId: "search-receipt", status: "settled", outcome: "executed" },
      { key: "read-1", toolId: "web.read", input: { url: "https://example.com/hotel" }, executionId: "read-receipt", status: "settled", outcome: "executed" },
    ],
    models: {} as Record<string, { status: string; attempt: number; startedAt: string; requestSha256: string; text?: string; instructions?: string }>,
    limitations: [] as string[],
    response: undefined as string | undefined,
  };
}

let detail: WorkflowRunDetail;
let revision = 0;

function appendEvent(type: string, payload: Record<string, unknown> = {}) {
  const event: WorkflowEventRecord = {
    id: `event-${detail.events.length + 1}`, tenantId, workflowRunId: detail.run.id,
    type, payload: structuredClone(payload), createdAt: new Date().toISOString(),
  };
  detail.events.push(event);
  return structuredClone(event);
}

function savedState(stepKey = "execute") {
  return detail.steps.find(step => step.stepKey === stepKey)!.output!.researchStateV1 as ReturnType<typeof collectedState>;
}

function providerTimeout() {
  mocks.generateModelStructured.mockImplementationOnce((request: ModelStructuredRequest) =>
    new Promise((_resolve, reject) => {
      expect(request.abortSignal).toBeDefined();
      request.abortSignal!.addEventListener("abort", () => reject(request.abortSignal!.reason), { once: true });
    }),
  );
}

async function timeOutWriter() {
  providerTimeout();
  const tick = tickWorkflowRun(detail.run.id, { tenantId })
    .then(result => ({ result }), (error: unknown) => ({ error }));
  await vi.advanceTimersByTimeAsync(180_000);
  const completed = await tick;
  if ("error" in completed) throw completed.error;
  return completed.result;
}

async function resume() {
  // The authorization must be strictly newer than the interrupted attempt.
  await vi.advanceTimersByTimeAsync(1);
  return signalWorkflowRun(detail.run.id, "resume", { tenantId, actorId, executionScope: authority.executionScope });
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-27T00:01:00.000Z");
  revision = 0;
  // Node's native AbortSignal.timeout is not driven by Vitest's fake clock.
  // Keep its signal behavior while exercising the real workflow deadline.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  const createdAt = new Date().toISOString();
  detail = {
    run: {
      id: "workflow-research-recovery", tenantId, workflowType: "agent.workflow.v1",
      status: "queued", goal, currentStep: "execute", attempt: 0, maxAttempts: 3,
      approvalRequired: false, createdAt, updatedAt: createdAt,
      input: {
        goal, mode: "research", executionAuthorityRequired: true,
        budgetLimits: { modelTurns: 6, tokens: 160_000, costMicrousd: 3_000_000, wallTimeMs: 900_000,
          toolCalls: 20, browserActions: 0, agents: 1, fanOut: 2, retries: 2, replans: 0 },
        metadata: { actorId, source: "conversation_research", missionId: "mission-research-recovery",
          missionTaskId: "task-research-recovery", contextScope: "none", researchOptionsV1: options },
      },
    },
    steps: workflowStepDefinitions.map(definition => ({
      id: `step-${definition.key}`, tenantId, workflowRunId: "workflow-research-recovery",
      stepKey: definition.key, label: definition.label,
      status: ["execute", "verify", "persist_report"].includes(definition.key) ? "pending" : "completed",
      attempt: 0, maxAttempts: 3, input: {}, createdAt, updatedAt: createdAt,
      ...(definition.key === "execute" ? { output: { researchStateV1: collectedState() } } : {}),
    })),
    events: [],
  };
  mocks.getWorkflowRunDetail.mockImplementation(async () => structuredClone(detail));
  mocks.getWorkflowRunExecutionAuthority.mockResolvedValue(authority);
  mocks.appendWorkflowEvent.mockImplementation(async (_id: string, type: string, payload: Record<string, unknown>) => appendEvent(type, payload));
  mocks.transitionWorkflowRunWithEvents.mockImplementation(async (
    _id: string, allowed: string[], patch: Partial<WorkflowRunRecord>,
    events: Array<{ type: string; payload?: Record<string, unknown> }>,
    fence: { expectedUpdatedAt?: string } = {},
  ) => {
    if (!allowed.includes(detail.run.status) || (fence.expectedUpdatedAt && fence.expectedUpdatedAt !== detail.run.updatedAt)) return null;
    detail.run = { ...detail.run, ...patch, updatedAt: new Date(Date.now() + ++revision).toISOString() };
    events.forEach(event => appendEvent(event.type, event.payload));
    return structuredClone(detail.run);
  });
  mocks.updateWorkflowStepForRunFence.mockImplementation(async (
    _id: string, stepKey: string, patch: Partial<WorkflowStepRecord>,
    fence: { expectedRunUpdatedAt?: string; events?: Array<{ type: string; payload?: Record<string, unknown> }> } = {},
  ) => {
    if (fence.expectedRunUpdatedAt && fence.expectedRunUpdatedAt !== detail.run.updatedAt) return null;
    const index = detail.steps.findIndex(step => step.stepKey === stepKey);
    detail.steps[index] = { ...detail.steps[index], ...structuredClone(patch) };
    fence.events?.forEach(event => appendEvent(event.type, event.payload));
    return structuredClone(detail.steps[index]);
  });
  mocks.resolveRuntimeModelAssignment.mockResolvedValue({
    configured: true, scope: "planner", source: "deployment_environment", provider: "openai", model: "writer-model",
    warnings: [], reason: "test route", allowCrossProviderFallback: false, usageReceipt: {},
    bind: <T>(request: T) => request,
    withProviderApiKey: async (_provider, operation) => operation(undefined),
  } satisfies RuntimeModelResolution);
  await createWorkflowBudgetSession(detail).reserve(
    { modelTurns: 2, tokens: 12_000, costMicrousd: 200_000, toolCalls: 2 },
    { phase: "research.collected" },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("research writer timeout and explicit recovery", () => {
  it("pauses with the timed-out step and retains sources without inventing a saved draft", async () => {
    const before = structuredClone(savedState());
    const paused = await timeOutWriter();

    expect(paused.run).toMatchObject({ status: "paused", currentStep: "execute" });
    expect(paused.run.error).toContain("Report writing stopped because its AI response timed out after about 180 seconds.");
    expect(paused.steps.find(step => step.stepKey === "execute")).toMatchObject({ status: "pending", attempt: 0 });
    expect(savedState()).toMatchObject({ searches: before.searches, reads: before.reads, tools: before.tools,
      phase: "writing", models: { report: { status: "started", attempt: 1 } } });
    expect(savedState().response).toBeUndefined();
    expect(paused.events.findLast(event => event.type === "workflow.paused")?.payload).toMatchObject({
      reason: "research_model_receipt_missing", requiresExplicitResume: true,
      modelFailure: { modelStep: "report", kind: "timeout", provider: "openai", timeoutMs: 180_000, elapsedMs: 180_000 },
    });
    expect(mocks.generateModelStructured).toHaveBeenCalledTimes(1);
    expect(mocks.executeGovernedTool).not.toHaveBeenCalled();
    expect(savedState().models.report.instructions).toContain("Research started at UTC: 2026-10-27T00:00Z");
  });

  it("does not spend or call the provider again on paused or stale queue redelivery", async () => {
    await timeOutWriter();
    const used = createWorkflowBudgetSession(detail).snapshot().used;
    const reservations = detail.events.filter(event => event.type === "workflow.budget_reserved");
    await tickWorkflowRun(detail.run.id, { tenantId });
    expect(detail.run.status).toBe("paused");

    // A recovered queue lease still cannot authorize the missing response.
    detail.run.status = "queued";
    await tickWorkflowRun(detail.run.id, { tenantId });
    expect(detail.run.status).toBe("paused");
    expect(mocks.generateModelStructured).toHaveBeenCalledTimes(1);
    expect(mocks.executeGovernedTool).not.toHaveBeenCalled();
    expect(detail.events.filter(event => event.type === "workflow.budget_reserved")).toEqual(reservations);
    expect(createWorkflowBudgetSession(detail).snapshot().used).toEqual(used);
  });

  it("uses one explicit resume for a fresh reserved attempt against the same sources and original budget", async () => {
    const limits = structuredClone(detail.run.input.budgetLimits);
    await timeOutWriter();
    const before = createWorkflowBudgetSession(detail).snapshot();
    const sources = structuredClone(savedState().reads);
    const firstRequest = mocks.generateModelStructured.mock.calls[0][0] as ModelStructuredRequest;
    await resume();
    mocks.generateModelStructured.mockResolvedValueOnce({ text: JSON.stringify({ report }), provider: "openai", model: "writer-model" });

    const recovered = await tickWorkflowRun(detail.run.id, { tenantId });

    expect(recovered.run.error).toBeUndefined();
    expect(recovered.run).toMatchObject({ status: "queued", currentStep: "verify" });
    expect(savedState()).toMatchObject({ phase: "reviewing", response: report, reads: sources,
      models: { report: { status: "completed", attempt: 2 } } });
    expect(mocks.generateModelStructured).toHaveBeenCalledTimes(2);
    expect(mocks.generateModelStructured.mock.calls[1][0]).toMatchObject({
      instructions: firstRequest.instructions, input: firstRequest.input,
      schema: firstRequest.schema, name: firstRequest.name, maxOutputTokens: firstRequest.maxOutputTokens,
      maxAttempts: 1,
    });
    expect(mocks.executeGovernedTool).not.toHaveBeenCalled();
    const after = createWorkflowBudgetSession(detail).snapshot();
    expect(after.limits).toEqual(limits);
    expect(detail.run.input.budgetLimits).toEqual(limits);
    expect(after.used.modelTurns).toBe(before.used.modelTurns + 1);
    expect(after.used.tokens).toBeGreaterThan(before.used.tokens);
    expect(after.used.costMicrousd).toBeGreaterThan(before.used.costMicrousd);
    expect(after.used.toolCalls).toBe(before.used.toolCalls);
    expect(after.used.retries).toBe(before.used.retries);
    expect(after.used.wallTimeMs).toBe(before.used.wallTimeMs);
    expect(detail.events.filter(event => event.type === "workflow.budget_reserved" && event.payload.phase === "research.report")).toHaveLength(2);
  });

  it("requires another newer authorization after the resumed attempt also times out", async () => {
    await timeOutWriter();
    await resume();
    // Separate the next call from the resume timestamp to make the old grant explicit.
    await vi.advanceTimersByTimeAsync(1);
    await timeOutWriter();
    expect(detail.run.error).toContain("Report writing stopped because its AI response timed out");
    expect(savedState().models.report.attempt).toBe(2);
    const reservations = detail.events.filter(event => event.type === "workflow.budget_reserved").length;
    detail.run.status = "queued";
    await tickWorkflowRun(detail.run.id, { tenantId });
    expect(detail.run.status).toBe("paused");
    expect(mocks.generateModelStructured).toHaveBeenCalledTimes(2);
    expect(detail.events.filter(event => event.type === "workflow.budget_reserved")).toHaveLength(reservations);
  });

  it("recovers an exact saved completion instead of making another paid call", async () => {
    await timeOutWriter();
    const receipt = { ...savedState().models.report, status: "completed", text: JSON.stringify({ report }) };
    detail.steps.find(step => step.stepKey === "plan")!.output = {
      researchStateV1: { ...structuredClone(savedState()), models: { report: receipt } },
    };
    const reservations = detail.events.filter(event => event.type === "workflow.budget_reserved").length;
    await resume();

    await tickWorkflowRun(detail.run.id, { tenantId });

    expect(detail.run.error).toBeUndefined();
    expect(detail.run).toMatchObject({ status: "queued", currentStep: "verify" });
    expect(savedState().response).toBe(report);
    expect(savedState().models.report).toMatchObject({ status: "completed", attempt: 1 });
    expect(detail.events.some(event => event.type === "research.model.receipt_recovered")).toBe(true);
    expect(mocks.generateModelStructured).toHaveBeenCalledTimes(1);
    expect(detail.events.filter(event => event.type === "workflow.budget_reserved")).toHaveLength(reservations);
  });

  it("does not use a completed receipt for a different frozen request", async () => {
    await timeOutWriter();
    detail.steps.find(step => step.stepKey === "plan")!.output = {
      researchStateV1: { ...structuredClone(savedState()), models: { report: {
        ...savedState().models.report, status: "completed", requestSha256: "f".repeat(64), text: JSON.stringify({ report: "Unrelated result" }),
      } } },
    };
    detail.run.status = "queued";

    await tickWorkflowRun(detail.run.id, { tenantId });

    expect(detail.run.status).toBe("paused");
    expect(savedState().response).toBeUndefined();
    expect(mocks.generateModelStructured).toHaveBeenCalledTimes(1);
    expect(detail.events.some(event => event.type === "research.model.receipt_recovered")).toBe(false);
  });

  it.each([undefined, "pre-self-improvement-v1"] as const)("reconstructs a legacy %s journal with no instruction snapshot or stored clock only when its full hash matches", async researchInstructionVersion => {
    await timeOutWriter();
    const firstRequest = mocks.generateModelStructured.mock.calls[0][0] as ModelStructuredRequest;
    const journal = savedState().models.report;
    const legacyRequest = {
      instructions: `${buildAgentInstructions({ mode: "research", runtimeClock: { now: new Date(journal.startedAt) }, researchInstructionVersion })}\n\n${researchReportInstructions}\nAim for ${savedState().plan.limits.reportWords} words when evidence supports it. Respect a requested shorter format. Return a detailed report, never claim facts were verified merely because citations exist. Keep explicit unknowns. Use only the supplied citation IDs and URLs.`,
      input: firstRequest.input, schema: firstRequest.schema, name: firstRequest.name,
      maxOutputTokens: firstRequest.maxOutputTokens,
    };
    delete journal.instructions;
    journal.requestSha256 = canonicalJsonSha256(legacyRequest);
    const legacyHash = journal.requestSha256;
    await resume();
    mocks.generateModelStructured.mockResolvedValueOnce({ text: JSON.stringify({ report }), provider: "openai", model: "writer-model" });

    await tickWorkflowRun(detail.run.id, { tenantId });

    expect(detail.run.error).toBeUndefined();
    expect(detail.run.currentStep).toBe("verify");
    expect(mocks.generateModelStructured).toHaveBeenCalledTimes(2);
    expect(mocks.generateModelStructured.mock.calls[1][0]).toMatchObject(legacyRequest);
    expect(savedState().models.report).toMatchObject({ requestSha256: legacyHash, instructions: legacyRequest.instructions, attempt: 2 });
    expect(mocks.executeGovernedTool).not.toHaveBeenCalled();
  });

  it("does not trust a modified instruction snapshot even after explicit resume", async () => {
    await timeOutWriter();
    savedState().models.report.instructions += "\nUnrecorded instruction change.";
    await resume();

    await tickWorkflowRun(detail.run.id, { tenantId });

    expect(detail.run.error).toContain("stored research model receipt does not match the current request");
    expect(mocks.generateModelStructured).toHaveBeenCalledTimes(1);
    expect(savedState().response).toBeUndefined();
  });

  it("retains the completed draft and retries only claim review when that later model call times out", async () => {
    mocks.generateModelStructured.mockResolvedValueOnce({ text: JSON.stringify({ report }), provider: "openai", model: "writer-model" });
    await tickWorkflowRun(detail.run.id, { tenantId });
    expect(detail.run.currentStep).toBe("verify");
    const written = structuredClone(savedState());

    await timeOutWriter();

    expect(detail.run).toMatchObject({ status: "paused", currentStep: "verify" });
    expect(detail.run.error).toContain("Claim review stopped because its AI response timed out");
    expect(savedState("verify")).toMatchObject({ response: report, reads: written.reads,
      models: { report: written.models.report, review: { status: "started", attempt: 1 } } });
    await resume();
    // An unavailable review stays honestly partial; it does not discard the report.
    mocks.generateModelStructured.mockResolvedValueOnce({ text: "{}", provider: "openai", model: "writer-model" });
    await tickWorkflowRun(detail.run.id, { tenantId });

    expect(detail.run).toMatchObject({ status: "queued", currentStep: "persist_report" });
    expect(savedState("verify").response).toBe(report);
    expect(mocks.generateModelStructured.mock.calls.map(([request]) => request.name)).toEqual([
      "research_report", "research_claim_review", "research_claim_review",
    ]);
    expect(mocks.executeGovernedTool).not.toHaveBeenCalled();
  });

  it("does not expose historical research instructions to other agent modes", () => {
    expect(() => buildAgentInstructions({ mode: "execute", researchInstructionVersion: "pre-self-improvement-v1" }))
      .toThrow("Historical research instructions require research mode");
  });
});
