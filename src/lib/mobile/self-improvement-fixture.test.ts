import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createSelfImprovementPolicy, assertSelfImprovementCycleIntegrity } from "@/lib/self-improvement/policy";
import { sealEngineeringSignal } from "@/lib/self-improvement/evidence";
import { sealSelfImprovementApproval, sealSelfImprovementCandidate, sealSelfImprovementReleaseBinding, sealSelfImprovementValidation } from "@/lib/self-improvement/contracts";
import { initialSelfImprovementRuntime } from "@/lib/self-improvement/runtime";
import { improvementCycleResponseSchema, improvementPublicCycleSchema, improvementRepositoriesResponseSchema, improvementStatusResponseSchema } from "@/lib/self-improvement/app-contracts";
import type { SelfImprovementConfiguration, StoredSelfImprovementCycle } from "@/lib/self-improvement/store";
import type { PersonalProject } from "@/lib/projects/types";
import { nativeValidationFixture } from "@/lib/self-improvement/native-test-fixtures";
const mock = vi.hoisted(() => ({ configurations: vi.fn(), cycles: vi.fn(), read: vi.fn(), presence: vi.fn(), repositories: vi.fn(), projects: vi.fn() }));
vi.mock("@/lib/self-improvement/store", async original => ({ ...await original<typeof import("@/lib/self-improvement/store")>(),
  listSelfImprovementConfigurations: mock.configurations, listSelfImprovementCycles: mock.cycles, getSelfImprovementCycle: mock.read, readSelfImprovementControllerPresence: mock.presence }));
vi.mock("@/lib/app-builder/github", () => ({ getBuilderGithubStatus: () => ({ configured: true, missing: [], appSlug: "asael-fixture" }), listBuilderGithubRepositories: mock.repositories }));
vi.mock("@/lib/projects/store", async original => ({ ...await original<typeof import("@/lib/projects/store")>(), listProjects: mock.projects,
  listProjectCollections: async () => ({ tasksByProject: new Map(), artifactsByProject: new Map() }) }));
vi.mock("@/lib/workspaces/read-model", () => ({ canonicalWorkItemSurfaces: async () => [] }));
import { showSelfImprovementService, readSelfImprovementCycleService, listSelfImprovementRepositoriesService, publicSelfImprovementCycle } from "@/lib/app-services/self-improvement";
import { listProjectsService } from "@/lib/app-services/projects";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("shared server-to-native Self-improvement fixture", () => {
  it("matches actual public service envelopes and their sealed evidence", async () => {
    const now = "2026-10-26T12:00:00.000Z", userId = "11111111-1111-4111-8111-111111111111";
    const owner = { tenantId: "default", ownerActorId: `actor:${userId}` }, git = (value: string) => value.repeat(40), sha = (value: string) => value.repeat(64);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(now));
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_TENANT_ID", owner.tenantId); vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
    const caller = createAppServiceCaller({ context: { tenantId: owner.tenantId, actorId: "owner@example.test", role: "admin", source: "mobile",
      auth: { userId, email: "owner@example.test", sessionId: "native-fixture-session", tenantName: "Fixture" }, native: { deviceId: "fixture-mac", platform: "macos", clientContractVersion: 62 } } });
    const policy = createSelfImprovementPolicy({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 10, notifyOutcomes: true });
    const scope = { ...owner, repository: { owner: "benniejoseph", name: "omniagentos", defaultBranch: "main" }, baseRevision: git("a") };
    const signal = sealEngineeringSignal({ version: 1, scope, kind: "code_defect", symptomSha256: sha("a"), summary: "The duplicate action can exceed the connection limit.",
      observations: [{ sourceKind: "source_file", sourceId: "src/components/studio/state.ts", sourceSha256: sha("b"), observedAt: now, outcome: "needs_work", path: "src/components/studio/state.ts", sourceRevision: scope.baseRevision }] });
    const candidate = sealSelfImprovementCandidate({ revision: git("b"), workspaceSha256: sha("c"), diffSha256: sha("d"),
      changedFiles: [{ path: "src/components/studio/state.ts", beforeSha256: sha("e"), afterSha256: sha("f") }], changedLines: 8, architectureImpact: "minor" });
    const validation = sealSelfImprovementValidation({ scope, policySha256: policy.policySha256, signalSha256: signal.signalSha256, candidateSha256: candidate.candidateSha256,
      candidateRevision: candidate.revision, workspaceSha256: candidate.workspaceSha256,
      baselineReproduction: { revision: scope.baseRevision, producerId: "baseline-fixture", evidenceSha256: sha("1"), executedCases: 1, failedCases: 1, completedAt: now },
      checks: (["focused_regression", "adjacent_regression", "typecheck", "independent_review"] as const).map(kind => ({ id: kind, kind, outcome: "passed", producerKind: kind === "independent_review" ? "agent_review" : "command", producerId: `fixture-${kind}`,
        candidateRevision: candidate.revision, workspaceSha256: candidate.workspaceSha256, evidenceSha256: sha("2"), declaredCases: 1, executedCases: 1, failedCases: 0, completedAt: now })) });
    const pullRequestUrl = "https://github.com/benniejoseph/omniagentos/pull/1";
    const approval = sealSelfImprovementApproval({ approvalId: "fixture-approval", ...owner, candidateSha256: candidate.candidateSha256, policySha256: policy.policySha256,
      validationSha256: validation.validationSha256, decision: "approved", approvedAt: now, expiresAt: "2026-10-26T16:00:00.000Z" });
    const release = sealSelfImprovementReleaseBinding({ releaseId: "fixture-release", scope, previousRevision: scope.baseRevision, sourceCandidateRevision: candidate.revision, candidateRevision: git("c"), sourceTree: git("d"), mergedTree: git("d"),
      pullRequestUrl, candidateSha256: candidate.candidateSha256, policySha256: policy.policySha256, validationSha256: validation.validationSha256, runner: "asael_paired_production" });
    const project: PersonalProject = { id: "project-native-fixture", tenantId: owner.tenantId, actorId: "owner@example.test", title: "Asael improvements", objective: "Investigate and repair the observed Studio connection limit defect.",
      status: "active", autonomyMode: "supervised", executionStatus: "idle", taskBudget: 4, tasksDispatched: 0, maxParallelTasks: 1, requireApproval: true, createdAt: now, updatedAt: now };
    const configuration: SelfImprovementConfiguration = { ...owner, id: "configuration-native-fixture", projectId: project.id, repositoryId: "1260961340", repository: scope.repository,
      policy, generation: 2, nextDueAt: "2026-10-27T01:30:00.000Z", paused: false, timeZone: "Asia/Kolkata", dailyHour: 7, createdAt: now, updatedAt: now };
    const stored: StoredSelfImprovementCycle = { configurationId: configuration.id, configurationGeneration: configuration.generation, projectId: project.id, repositoryId: configuration.repositoryId, day: "2026-10-26",
      leaseExpiresAt: now, leaseToken: "private-store-lease", spendUsd: 0.12, usageState: "known", controllerId: "private-controller", controllerHold: null,
      runtime: { ...initialSelfImprovementRuntime(), phase: "done", summary: "The connection limit repair passed its focused checks and was released.",
        agentRuns: (["atlas", "forge", "sentinel"] as const).map((agentId, index) => ({ phase: index === 0 ? "inspect" : index === 1 ? "implement" : "review", agentId, runId: `11111111-1111-4111-8111-11111111111${index + 2}`, costCeilingUsd: 2, completed: true })) },
      cycle: { id: `self_cycle_${sha("a")}`, scope, policy, stage: "succeeded", revision: 12, signal, candidate, validation, approval, release,
        releaseReceipt: { releaseBindingSha256: release.releaseBindingSha256, outcome: "deployed", webRevision: git("c"), workerRevision: git("c"), manifestSha256: sha("3"), healthEvidenceSha256: sha("4"), behaviorEvidenceSha256: validation.validationSha256, evidenceSha256: sha("6"), recordedAt: now },
        correctionsUsed: 0, dailyReservationUsd: 10, pullRequestUrl, leaseToken: "private-cycle-lease", createdAt: now, updatedAt: now } };
    mock.configurations.mockResolvedValue([configuration]); mock.cycles.mockResolvedValue([stored]); mock.read.mockResolvedValue(stored);
    mock.presence.mockResolvedValue({ lastSeenAt: now, controllerStatus: "online" });
    mock.repositories.mockResolvedValue([{ repositoryId: configuration.repositoryId, ...scope.repository, fullName: "benniejoseph/omniagentos", private: true, htmlUrl: "https://github.com/benniejoseph/omniagentos" }]);
    mock.projects.mockResolvedValue([project]);
    const [status, exactCycle, repositories, projects] = await Promise.all([showSelfImprovementService(caller), readSelfImprovementCycleService(caller, stored.cycle.id), listSelfImprovementRepositoriesService(caller), listProjectsService(caller, { limit: 80 })]);
    expect(mock.projects).toHaveBeenCalledWith(80, expect.objectContaining({ tenantId: owner.tenantId, actorId: "owner@example.test",
      requestActorBinding: expect.objectContaining({ canonicalActorId: owner.ownerActorId, legacyOwnerActorIds: ["owner@example.test"] }) }));
    const fixture = {
      status: improvementStatusResponseSchema.parse({ ...status.data, serviceReceipt: status.receipt }),
      exactCycle: improvementCycleResponseSchema.parse({ ...exactCycle.data, serviceReceipt: exactCycle.receipt }),
      repositories: improvementRepositoriesResponseSchema.parse({ ...repositories.data, serviceReceipt: repositories.receipt }),
      projects: { ...projects.data, generatedAt: now, serviceReceipt: projects.receipt },
      nativeCycle: improvementPublicCycleSchema.parse(publicSelfImprovementCycle(nativeStoredFixture(stored))),
    };
    const bytes = `${JSON.stringify(fixture, null, 2)}\n`, path = new URL("../../../apps/flutter/test/fixtures/self_improvement_public_response.json", import.meta.url);
    expect(bytes).not.toMatch(/private-store-lease|private-cycle-lease|private-controller|leaseToken|controllerId/);
    if (process.env.UPDATE_SELF_IMPROVEMENT_NATIVE_FIXTURE === "1") { await mkdir(new URL(".", path), { recursive: true }); await writeFile(path, bytes); }
    expect(await readFile(path, "utf8")).toBe(bytes);
  });
});

function nativeStoredFixture(previous: StoredSelfImprovementCycle): StoredSelfImprovementCycle {
  const shared = nativeValidationFixture(), original = previous.cycle;
  const { candidateSha256: _candidateHash, ...candidateBody } = original.candidate!;
  const candidate = sealSelfImprovementCandidate({ ...candidateBody, releaseTarget: "macos_app",
    workspaceSha256: shared.receipt.workspaceSha256,
    changedFiles: shared.request.snapshot.files.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256 })),
  });
  const native = { requestId: shared.request.requestId, requestSha256: shared.request.requestSha256,
    snapshotSha256: shared.request.snapshot.snapshotSha256, receiptSha256: shared.receipt.receiptSha256,
    artifact: shared.receipt.artifact!, installedBaseline: shared.receipt.installedBaseline, pairedBaseline: shared.receipt.pairedBaseline };
  const { validationSha256: _validationHash, ...validationBody } = original.validation!;
  const validation = sealSelfImprovementValidation({ ...validationBody, native, candidateSha256: candidate.candidateSha256,
    workspaceSha256: candidate.workspaceSha256, checks: [...validationBody.checks.map(check => ({ ...check, workspaceSha256: candidate.workspaceSha256 })),
      { ...validationBody.checks[0], id: "native_build", kind: "build", producerId: shared.receipt.controllerId,
        workspaceSha256: candidate.workspaceSha256, evidenceSha256: shared.receipt.checks[3].outputSha256 }] });
  const { receiptSha256: _approvalHash, ...approvalBody } = original.approval!;
  const approval = sealSelfImprovementApproval({ ...approvalBody, candidateSha256: candidate.candidateSha256, validationSha256: validation.validationSha256,
    nativeArtifactSha256: native.artifact.artifactSha256, nativeBaselineSha256: native.installedBaseline.baselineSha256 });
  const { releaseBindingSha256: _releaseHash, mergeEvidenceSha256: _mergeHash, ...releaseBody } = original.release!;
  const release = sealSelfImprovementReleaseBinding({ ...releaseBody, releaseTarget: "macos_app", native: { ...native, approvalSha256: approval.receiptSha256 },
    runner: "asael_macos_publisher", candidateSha256: candidate.candidateSha256, validationSha256: validation.validationSha256 });
  const result: StoredSelfImprovementCycle = { ...previous, runtime: { ...previous.runtime, summary: "The signed Mac repair was installed and startup was verified." },
    cycle: { ...original, candidate, validation, approval, release, releaseReceipt: { ...original.releaseReceipt!,
      ...native.pairedBaseline, releaseBindingSha256: release.releaseBindingSha256, behaviorEvidenceSha256: validation.validationSha256,
      nativeInstall: { artifactSha256: native.artifact.artifactSha256, baselineSha256: native.installedBaseline.baselineSha256,
        unsignedBundleSha256: native.artifact.unsignedBundleSha256, installedBundleSha256: "7".repeat(64),
        version: native.artifact.version, buildNumber: native.artifact.buildNumber, signingIdentitySha256: native.installedBaseline.signingIdentitySha256,
        designatedRequirementSha256: native.installedBaseline.designatedRequirementSha256, codeSignatureSha256: "8".repeat(64),
        startupEvidenceSha256: "9".repeat(64), installationReceiptSha256: "a".repeat(64) } } } };
  assertSelfImprovementCycleIntegrity(result.cycle);
  return result;
}
