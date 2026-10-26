import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationJobRecord } from "@/lib/operations/job-queue";
import type { StoredSelfImprovementCycle } from "./store";
import { assertSelfImprovementCycleTransition, createSelfImprovementPolicy } from "./policy";
import { initialSelfImprovementRuntime, selfImprovementRuntimeSchema } from "./runtime";

const mocks = vi.hoisted(() => ({
  stored: null as unknown as StoredSelfImprovementCycle, paused: false, generation: 1, noChange: false,
  unknownUsage: false, modelFailure: false, failBaseline: true, failChecks: 0, comparisonMismatch: false,
  models: [] as string[], tools: [] as string[], commandCount: 0,
  reserve: vi.fn(), settle: vi.fn(),
}));
vi.mock("./store", () => ({
  assertConfiguredSelfImprovementOwner: vi.fn(),
  assertSelfImprovementOwnerAuthority: vi.fn(),
  getSelfImprovementCycle: async () => mocks.stored,
  getSelfImprovementConfiguration: async () => ({ id: mocks.stored.configurationId, tenantId: mocks.stored.cycle.scope.tenantId,
    ownerActorId: mocks.stored.cycle.scope.ownerActorId, projectId: mocks.stored.projectId, repositoryId: mocks.stored.repositoryId,
    repository: mocks.stored.cycle.scope.repository, policy: mocks.stored.cycle.policy, paused: mocks.paused, generation: mocks.generation }),
  listSelfImprovementCycles: async () => [],
  renewSelfImprovementCycleLease: async () => {
    mocks.stored = { ...mocks.stored, leaseToken: "lease", leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() }; return mocks.stored;
  },
  releaseSelfImprovementExecutionLease: async () => { mocks.stored = { ...mocks.stored, leaseExpiresAt: new Date(0).toISOString() }; return mocks.stored; },
  updateSelfImprovementCycleRuntime: async (input: { runtime: Record<string, unknown>; patch?: object }) => {
    mocks.stored = { ...mocks.stored, runtime: input.runtime, cycle: { ...mocks.stored.cycle, ...input.patch, revision: mocks.stored.cycle.revision + 1 } }; return mocks.stored;
  },
  transitionSelfImprovementCycle: async (input: { nextStage: StoredSelfImprovementCycle["cycle"]["stage"]; patch?: object }) => {
    const cycle = { ...mocks.stored.cycle, ...input.patch, revision: mocks.stored.cycle.revision + 1, stage: input.nextStage };
    assertSelfImprovementCycleTransition(mocks.stored.cycle, cycle);
    mocks.stored = { ...mocks.stored, cycle }; return mocks.stored;
  },
  reserveSelfImprovementPhaseBudget: mocks.reserve,
  settleSelfImprovementPhaseBudget: mocks.settle,
}));
vi.mock("@/lib/runs/store", () => ({ listAgentRuns: async () => [] }));
vi.mock("@/lib/projects/store", () => ({ getProject: async () => ({ title: "Engineering", objective: "Maintain the application." }) }));
vi.mock("@/lib/tools/audit-store", () => ({ listToolExecutions: async () => [] }));
vi.mock("@/lib/tools/execution-scope", () => ({ getToolExecutionScopeBinding: vi.fn() }));
vi.mock("@/lib/app-builder/store", () => ({
  getProjectBuilderSession: async () => ({ id: "session", sandboxName: "sandbox", revision: 1 }),
  getBuilderCheckpoint: async () => ({ id: "checkpoint", workspaceSha256: "c".repeat(64) }),
  getBuilderVerification: async () => ({ id: "verification", status: "passed" }),
}));
vi.mock("@/lib/app-builder/delivery-store", () => ({
  getBuilderRepositoryBinding: async () => ({ id: "binding", revision: 1, baseSha: "a".repeat(40) }),
  listBuilderDeliveries: async () => [{ id: "delivery", checkpointId: "checkpoint", verificationId: "verification", status: "pull_request_open", commitSha: "b".repeat(40), pullRequestUrl: "https://github.com/asael/app/pull/1" }],
}));
vi.mock("@/lib/app-builder/github", () => ({
  readBuilderGithubCandidateComparison: async () => ({ changedLines: 12, files: (mocks.comparisonMismatch ? ["src/unexpected.ts"] : ["src/feature.test.ts", "src/feature.ts"]).map(path => ({ path })) }),
}));
vi.mock("@/lib/app-builder/sandbox", () => ({
  getBuilderWorkspaceManifest: async () => ({ sha256: "c".repeat(64) }),
  readBuilderFile: async (_sandbox: string, path: string) => ({ path, sha256: "d".repeat(64) }),
  readBuilderRepositoryChanges: async () => [
    { kind: "upsert", previousSha256: null, file: { path: "src/feature.test.ts", sha256: "d".repeat(64), mode: "100644" } },
    ...(mocks.stored.runtime.phase === "reproduce" ? [] : [{ kind: "upsert", previousSha256: "d".repeat(64), file: { path: "src/feature.ts", sha256: "e".repeat(64), mode: "100644" } }]),
  ],
}));
vi.mock("./agent", () => ({
  executeImprovementTool: async (input: { toolId: string; parameters: { command?: string } }) => {
    mocks.tools.push(input.toolId);
    let data: object = {};
    if (input.toolId.endsWith("builder.create")) data = { session: { id: "session", status: "ready" } };
    if (input.toolId.endsWith("repository.bind")) data = { repositoryBinding: { baseSha: "a".repeat(40) } };
    if (input.toolId.endsWith("checkpoint.create")) data = { checkpoint: { id: "checkpoint" } };
    if (input.toolId.endsWith("verification.run")) data = { verification: { id: "verification", status: "passed" } };
    if (input.toolId.endsWith("sentinel.record")) data = { sentinel: { verdict: "passed" } };
    if (input.toolId.endsWith("command.run")) {
      mocks.commandCount++;
      const baseline = mocks.stored.runtime.phase === "baseline_check";
      const fail = baseline ? mocks.failBaseline : mocks.failChecks-- > 0;
      const test = input.parameters.command === "test_focused";
      data = { result: { exitCode: fail ? 1 : 0, stdout: fail ? "Expected observable behavior failed" : "passed", stderr: "",
        ...(test ? { testSummary: { totalTests: 2, failedTests: fail ? 1 : 0, passedTests: fail ? 1 : 2 } } : {}) } };
    }
    return { executionId: `execution:${mocks.tools.length}`, data };
  },
  runImprovementAgent: async (input: { agentId: string; onRunStarted: (id: string) => Promise<void> }) => {
    const runId = randomUUID(); await input.onRunStarted(runId); mocks.models.push(input.agentId);
    if (mocks.modelFailure) throw new Error("Provider stream interrupted.");
    const response = input.agentId === "atlas" ? JSON.stringify(mocks.noChange ? { decision: "no_change", summary: "No supported defect." } : {
      decision: "repair", plan: { summary: "Handle empty feature name.", sourcePaths: ["src/feature.ts"], focusedTestPaths: ["src/feature.test.ts"], adjacentTestPaths: ["src/adjacent.test.ts"], acceptanceCriteria: ["Empty names return the fallback."] },
    }) : input.agentId === "sentinel" ? "PASS\nArchitecture impact: minor\nThe original failing case and adjacent behavior now pass." : '{"summary":"Phase complete"}';
    return { runId, response, measuredCostUsd: mocks.unknownUsage ? null : 0.01 };
  },
}));

import { executeSelfImprovementJob } from "./worker";
const job = { tenantId: "tenant", payload: { actorId: "owner", cycleId: "cycle" } } as unknown as OperationJobRecord;
const step = () => executeSelfImprovementJob(job, new AbortController().signal);
async function advanceTo(phase: string) {
  for (let i = 0; i < 25 && mocks.stored.runtime.phase !== phase; i++) await step();
  expect(mocks.stored.runtime.phase).toBe(phase);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.paused = mocks.noChange = mocks.unknownUsage = mocks.comparisonMismatch = mocks.modelFailure = false;
  mocks.failBaseline = true; mocks.failChecks = 0; mocks.commandCount = 0; mocks.models = []; mocks.tools = []; mocks.generation = 1;
  const now = new Date().toISOString();
  mocks.stored = { configurationId: "config", configurationGeneration: 1, projectId: "project", repositoryId: "1", day: now.slice(0, 10),
    leaseExpiresAt: new Date(0).toISOString(), runtime: initialSelfImprovementRuntime(), spendUsd: 0, usageState: "known", controllerId: null, controllerHold: null,
    cycle: { id: "cycle", scope: { tenantId: "tenant", ownerActorId: "owner", repository: { owner: "asael", name: "app", defaultBranch: "main" }, baseRevision: "a".repeat(40) },
      policy: createSelfImprovementPolicy({}), stage: "observing", revision: 1, signal: null, candidate: null, validation: null, approval: null, release: null, releaseReceipt: null,
      correctionsUsed: 0, dailyReservationUsd: 100, createdAt: now, updatedAt: now } };
  mocks.reserve.mockImplementation(async () => ({ outcome: "reserved", cycle: mocks.stored }));
  mocks.settle.mockImplementation(async () => mocks.stored);
});
describe("durable self-improvement worker", () => {
  it("fences a direct phase request against a newer revision before any execution", async () => {
    await expect(executeSelfImprovementJob(job, new AbortController().signal, mocks.stored.cycle.revision - 1)).rejects.toThrow(/revision changed/);
    expect(mocks.tools).toEqual([]); expect(mocks.models).toEqual([]); expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("reproduces, repairs, checks once, independently reviews, and delivers an exact candidate across resumed jobs", async () => {
    await advanceTo("release_wait");
    expect(mocks.models).toEqual(["atlas", "forge", "forge", "sentinel"]);
    expect(mocks.commandCount).toBe(5); // one failing baseline, four candidate checks
    expect(mocks.stored.cycle.stage).toBe("ready_for_release");
    expect(mocks.stored.cycle.validation?.baselineReproduction?.failedCases).toBe(1);
    expect(mocks.stored.cycle.validation?.checks.filter(item => item.kind.endsWith("regression")).map(item => item.executedCases)).toEqual([2, 2]);
    expect(mocks.reserve).toHaveBeenCalledTimes(4); expect(mocks.settle).toHaveBeenCalledTimes(4);
    const counts = [mocks.models.length, mocks.tools.length]; await step();
    expect([mocks.models.length, mocks.tools.length]).toEqual(counts);
  });
  it("stays quiet when Atlas finds no supported change", async () => {
    mocks.noChange = true; await advanceTo("done");
    expect(mocks.stored.cycle.stage).toBe("no_change"); expect(mocks.models).toEqual(["atlas"]); expect(mocks.commandCount).toBe(0);
  });
  it("requires a genuine executed failing baseline before source edits", async () => {
    mocks.failBaseline = false; await advanceTo("baseline_check");
    await expect(step()).rejects.toThrow(/did not reproduce/);
    expect(mocks.stored.cycle.stage).toBe("failed"); expect(mocks.models).toEqual(["atlas", "forge"]);
  });
  it("limits correction to one and preserves the original reproduction", async () => {
    await advanceTo("verify"); mocks.failChecks = 2;
    await step(); expect(mocks.stored.cycle.correctionsUsed).toBe(1);
    const originalBaseline = selfImprovementRuntimeSchema.parse(mocks.stored.runtime).baseline;
    await step(); await expect(step()).rejects.toThrow(/still fails/);
    expect(mocks.stored.cycle.stage).toBe("failed"); expect(mocks.stored.runtime.baseline).toEqual(originalBaseline);
  });
  it("does not replay an interrupted paid phase or act after pause", async () => {
    mocks.stored = { ...mocks.stored, runtime: { ...initialSelfImprovementRuntime(), phase: "inspect", phaseAttempt: { key: "inspect:0", phase: "inspect", startedAt: new Date().toISOString(), costCeilingUsd: 10 } } };
    await expect(step()).rejects.toThrow(/interrupted paid phase/); expect(mocks.models).toEqual([]);
  });
  it("records unknown metering and stops before another paid phase", async () => {
    mocks.unknownUsage = true; await advanceTo("inspect"); await expect(step()).rejects.toThrow(/usage could not/);
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ actualUsd: null })); expect(mocks.models).toEqual(["atlas"]);
  });
  it("refuses a committed diff that differs from the validated workspace", async () => {
    await advanceTo("deliver"); mocks.comparisonMismatch = true; await expect(step()).rejects.toThrow(/committed diff/);
    expect(mocks.stored.cycle.stage).toBe("failed");
  });
  it("settles an interrupted provider attempt as unknown instead of reporting zero spend", async () => {
    await advanceTo("inspect"); mocks.modelFailure = true; await expect(step()).rejects.toThrow(/Provider stream/);
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ actualUsd: null }));
    expect(mocks.stored.cycle.stage).toBe("failed"); expect(mocks.models).toEqual(["atlas"]);
    expect(mocks.stored.runtime.phaseAttempt).toBeTruthy();
  });
  it("defers a paused scheduled delivery without failing or spending the saved candidate", async () => {
    const before = structuredClone(mocks.stored);
    mocks.paused = true; await expect(step()).resolves.toMatchObject({ __deferOperation: true, delaySeconds: 60 });
    expect(mocks.stored).toEqual(before); expect(mocks.tools).toEqual([]); expect(mocks.models).toEqual([]);
    mocks.paused = false; mocks.generation = 3; await step();
    expect(mocks.stored.cycle.stage).toBe("observing"); expect(mocks.stored.runtime.setupStep).toBe("bind");
  });
  it("continues an unchanged admitted policy after pause and resume increment configuration generation", async () => {
    mocks.generation = 3;
    await step();
    expect(mocks.stored.cycle.stage).toBe("observing"); expect(mocks.stored.runtime.setupStep).toBe("bind");
    expect(mocks.tools).toEqual(["app.projects.builder.create"]);
  });
});
