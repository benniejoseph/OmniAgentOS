import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildContextPack: vi.fn(),
  generateModelStructured: vi.fn(),
  resolveRuntimeModelAssignment: vi.fn(),
}));

vi.mock("@/lib/rag/context-engine", () => ({
  AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES: Object.freeze({
    memory: "authorized_only",
    knowledge: "canonical_authorized",
    topicGraph: "exclude",
    entityGraph: "authorized",
  }),
  AUTHORIZED_MEMORY_ONLY_RETRIEVAL_SOURCES: Object.freeze({
    memory: "authorized_only",
    knowledge: "exclude",
    topicGraph: "exclude",
    entityGraph: "exclude",
  }),
  buildContextPack: mocks.buildContextPack,
}));
vi.mock("@/lib/capabilities/toolbox", () => ({
  loadProgressiveAgentTools: vi.fn(async () => ({
    definitions: [],
    omittedToolIds: [],
    schemaBytes: 0,
  })),
}));
vi.mock("@/lib/settings/runtime-models", () => ({
  resolveRuntimeModelAssignment: mocks.resolveRuntimeModelAssignment,
}));
vi.mock("@/lib/models/gateway", () => ({
  generateModelStructured: mocks.generateModelStructured,
}));

const tenantId = "tenant-plan-interruption";

const modelNode = (id: string, kind: string, dependsOn: string[]) => ({
  id,
  label: id,
  kind,
  description: `Complete ${id}.`,
  dependsOn,
  toolIds: [],
  connectorTargets: [],
  riskLevel: 0,
  approvalRequired: false,
  policy: "auto",
  acceptanceCriteria: [`${id} is complete.`],
  expectedOutputs: [`${id} notes`],
});
const modelAnswer = {
  provider: "openai",
  model: "gpt-planner-test",
  text: JSON.stringify({
    objective: "Summarize this week's workflow runs",
    summary: "Read the week's runs, check them, and report.",
    mode: "orchestrate",
    assumptions: [],
    constraints: [],
    risks: [],
    acceptanceCriteria: ["The report covers this week's runs."],
    nodes: [
      modelNode("research", "research", []),
      modelNode("verify", "verify", ["research"]),
      modelNode("report", "report", ["verify"]),
    ],
    edges: [
      { from: "research", to: "verify", condition: "completed" },
      { from: "verify", to: "report", condition: "completed" },
    ],
    selectedToolIds: [],
    connectorTargets: [],
    executionPolicy: {
      highestRiskLevel: 0,
      requiresApproval: false,
      defaultPolicy: "auto",
      notes: [],
    },
    verificationPlan: [],
    memoryPlan: [],
    confidence: 0.8,
  }),
};

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "asael-plan-interruption-"),
  );
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  mocks.buildContextPack.mockReset().mockResolvedValue({
    contextBlock: "",
    trace: undefined,
  });
  mocks.generateModelStructured.mockReset();
  mocks.resolveRuntimeModelAssignment.mockReset().mockResolvedValue({
    configured: true,
    source: "deployment_environment",
    warnings: [],
    bind: <T>(request: T) => request,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function planRequest(workflowRunId: string) {
  return {
    tenantId,
    actorId: "owner@example.test",
    goal: "Summarize this week's workflow runs",
    workflowRunId,
  };
}

/**
 * A model call that never answers. Like fetch, it rejects with its signal's
 * reason once that signal aborts. Resolves with the signal once called.
 */
function hangingModelCall() {
  return new Promise<AbortSignal>((started) => {
    mocks.generateModelStructured.mockImplementationOnce(
      (request: { abortSignal: AbortSignal }) => new Promise((_, reject) => {
        const signal = request.abortSignal;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        started(signal);
      }),
    );
  });
}

function settle(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

async function storedPlan(workflowRunId: string) {
  const { getWorkflowPlanForRun } = await import("@/lib/workflows/planner");
  return getWorkflowPlanForRun(workflowRunId, { tenantId });
}

describe("workflow planner interruption", () => {
  it("passes on a model call the caller stopped, saves nothing, and plans with the model next time", async () => {
    const { buildDynamicWorkflowPlan } = await import("@/lib/workflows/planner");
    const runId = "workflow-plan-stopped";
    const caller = new AbortController();
    const stopped = new Error("The model request was aborted.");
    mocks.generateModelStructured.mockImplementationOnce(async () => {
      caller.abort();
      throw stopped;
    });

    await expect(buildDynamicWorkflowPlan({
      ...planRequest(runId),
      abortSignal: caller.signal,
    })).rejects.toBe(stopped);
    await expect(storedPlan(runId)).resolves.toBeNull();

    mocks.generateModelStructured.mockResolvedValueOnce(modelAnswer);
    const planned = await buildDynamicWorkflowPlan(planRequest(runId));

    expect(planned).toMatchObject({
      workflowRunId: runId,
      planner: "openai",
      model: "gpt-planner-test",
    });
  });

  it("never saves a plan the model finished after the caller stopped", async () => {
    const { buildDynamicWorkflowPlan } = await import("@/lib/workflows/planner");
    const runId = "workflow-plan-answered-late";
    const caller = new AbortController();
    mocks.generateModelStructured.mockImplementationOnce(async () => {
      caller.abort();
      return modelAnswer;
    });

    const outcome = await settle(buildDynamicWorkflowPlan({
      ...planRequest(runId),
      abortSignal: caller.signal,
    }));

    expect(outcome).toEqual({ error: caller.signal.reason });
    await expect(storedPlan(runId)).resolves.toBeNull();
  });

  it("falls back when the model is too slow, then plans with the model instead of reusing that fallback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { buildDynamicWorkflowPlan } = await import("@/lib/workflows/planner");
    const runId = "workflow-plan-slow-model";
    const modelStarted = hangingModelCall();
    const planning = buildDynamicWorkflowPlan(planRequest(runId));
    const modelSignal = await modelStarted;

    await vi.advanceTimersByTimeAsync(44_999);
    expect(modelSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(modelSignal.aborted).toBe(true);

    const fallback = await planning;
    expect(fallback).toMatchObject({
      planner: "deterministic",
      model: "fallback-after-model-error",
    });
    expect(fallback.plan.risks).toContain(
      "Model planner fallback used: Workflow planner timed out.",
    );
    await expect(storedPlan(runId)).resolves.toMatchObject({ id: fallback.id });

    mocks.generateModelStructured.mockResolvedValueOnce(modelAnswer);
    const replanned = await buildDynamicWorkflowPlan(planRequest(runId));

    expect(replanned).toMatchObject({
      planner: "openai",
      model: "gpt-planner-test",
    });
    expect(replanned.id).not.toBe(fallback.id);
    await expect(storedPlan(runId)).resolves.toMatchObject({ id: replanned.id });

    // A plan the model wrote is kept.
    const reused = await buildDynamicWorkflowPlan(planRequest(runId));
    expect(reused.id).toBe(replanned.id);
    expect(mocks.generateModelStructured).toHaveBeenCalledTimes(2);
  });

  it("stops a slow model in time to save its fallback before the caller's deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { buildDynamicWorkflowPlan } = await import("@/lib/workflows/planner");
    const runId = "workflow-plan-before-deadline";
    const caller = new AbortController();
    const modelStarted = hangingModelCall();
    const planning = buildDynamicWorkflowPlan({
      ...planRequest(runId),
      abortSignal: caller.signal,
      deadlineAt: Date.now() + 40_000,
    });
    const modelSignal = await modelStarted;

    await vi.advanceTimersByTimeAsync(37_000);
    expect(modelSignal.aborted).toBe(false);
    // Two seconds before the deadline, with the caller still waiting.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(modelSignal.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);

    await expect(planning).resolves.toMatchObject({
      model: "fallback-after-model-error",
    });
    await expect(storedPlan(runId)).resolves.toMatchObject({
      model: "fallback-after-model-error",
    });
  });

  it("keeps the planner's own timeout when the deadline is further away", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { buildDynamicWorkflowPlan } = await import("@/lib/workflows/planner");
    const runId = "workflow-plan-far-deadline";
    const modelStarted = hangingModelCall();
    const planning = buildDynamicWorkflowPlan({
      ...planRequest(runId),
      abortSignal: new AbortController().signal,
      deadlineAt: Date.now() + 240_000,
    });
    const modelSignal = await modelStarted;

    await vi.advanceTimersByTimeAsync(44_999);
    expect(modelSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(modelSignal.aborted).toBe(true);

    await expect(planning).resolves.toMatchObject({
      model: "fallback-after-model-error",
    });
  });

  it("keeps the model's minimum window when the deadline is nearer, so the deadline stops the call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { buildDynamicWorkflowPlan } = await import("@/lib/workflows/planner");
    const runId = "workflow-plan-short-runway";
    const caller = new AbortController();
    const deadlineAt = Date.now() + 10_000;
    setTimeout(() => caller.abort(), 10_000);
    const modelStarted = hangingModelCall();
    const planning = settle(buildDynamicWorkflowPlan({
      ...planRequest(runId),
      abortSignal: caller.signal,
      deadlineAt,
    }));
    await modelStarted;

    await vi.advanceTimersByTimeAsync(10_000);

    // The plan step runs again on a later tick instead of saving a
    // fallback for a model that had only eight seconds.
    await expect(planning).resolves.toEqual({ error: caller.signal.reason });
    await expect(storedPlan(runId)).resolves.toBeNull();
  });

  it("still reuses a plan built while no planner model was configured", async () => {
    const { buildDynamicWorkflowPlan } = await import("@/lib/workflows/planner");
    const runId = "workflow-plan-no-model";
    mocks.resolveRuntimeModelAssignment.mockResolvedValue({
      configured: false,
      source: "deployment_environment",
      warnings: [],
      bind: <T>(request: T) => request,
    });

    const first = await buildDynamicWorkflowPlan(planRequest(runId));
    const again = await buildDynamicWorkflowPlan(planRequest(runId));

    expect(first).toMatchObject({ planner: "deterministic", model: "fallback" });
    expect(again.id).toBe(first.id);
    expect(mocks.generateModelStructured).not.toHaveBeenCalled();
  });

  it("gives the planning call the caller's attempts and fallback check", async () => {
    const { buildDynamicWorkflowPlan } = await import("@/lib/workflows/planner");
    const beforeRetry = vi.fn(async () => true);
    mocks.generateModelStructured.mockResolvedValueOnce(modelAnswer);

    await buildDynamicWorkflowPlan({
      ...planRequest("workflow-plan-attempts"),
      modelAttempts: { maxAttempts: 2, beforeRetry },
    });

    expect(mocks.generateModelStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "dynamic_workflow_plan",
        maxAttempts: 2,
        beforeRetry,
      }),
    );
  });
});
