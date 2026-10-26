import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { createSelfImprovementPolicy } from "./policy";
import { sealEngineeringSignal } from "./evidence";
import { sealSelfImprovementApproval, sealSelfImprovementCandidate, sealSelfImprovementValidation, sealSelfImprovementReleaseBinding, type SelfImprovementCycle } from "./contracts";
import type { StoredSelfImprovementCycle } from "./store";
import { buildSelfImprovementReleaseRequest, executeSelfImprovementControllerAction, getSelfImprovementControllerStatus, selfImprovementControllerOwner } from "./release-service";
const mock = vi.hoisted(() => ({ proof: vi.fn(), configuration: vi.fn(), lease: vi.fn(), transition: vi.fn(), presence: vi.fn(), writePresence: vi.fn(), renew: vi.fn(), settle: vi.fn(), hold: vi.fn() }));
vi.mock("@/lib/app-builder/github", () => ({ readBuilderGithubReleaseProof: mock.proof }));
vi.mock("@/lib/self-improvement/store", async (original) => ({ ...await original<typeof import("./store")>(), getSelfImprovementConfiguration: mock.configuration, readSelfImprovementReleaseLease: mock.lease, transitionSelfImprovementCycle: mock.transition, readSelfImprovementControllerPresence: mock.presence, recordSelfImprovementControllerPresence: mock.writePresence, renewSelfImprovementCycleLease: mock.renew, settleSelfImprovementPhaseBudget: mock.settle, holdSelfImprovementRelease: mock.hold }));
const userId = "11111111-1111-4111-8111-111111111111", owner = { tenantId: "candidate", ownerActorId: `actor:${userId}` };
const auth: SecurityContext = { tenantId: owner.tenantId, actorId: "owner@example.test", role: "admin", source: "session", auth: { userId, email: "owner@example.test", sessionId: "candidate-session", tenantName: "Candidate" } };
const sha = (value: string) => value.repeat(64), git = (value: string) => value.repeat(40);
function fixture(): StoredSelfImprovementCycle {
  const now = new Date().toISOString(), scope = { ...owner, repository: { owner: "asael", name: "app", defaultBranch: "main" }, baseRevision: git("a") }, policy = createSelfImprovementPolicy({ maxCycleBudgetUsd: 100 });
  const signal = sealEngineeringSignal({ version: 1, scope, kind: "owner_correction", symptomSha256: sha("a"), summary: "Saved title is missing", observations: [{ sourceKind: "owner_feedback", sourceId: "run", sourceSha256: sha("b"), observedAt: now, outcome: "needs_work" }] });
  const candidate = sealSelfImprovementCandidate({ revision: git("b"), workspaceSha256: sha("c"), diffSha256: sha("d"), changedFiles: [{ path: "src/lib/studio/graph.ts", beforeSha256: sha("e"), afterSha256: sha("f") }], changedLines: 5, architectureImpact: "minor" });
  const validation = sealSelfImprovementValidation({ scope, policySha256: policy.policySha256, signalSha256: signal.signalSha256, candidateSha256: candidate.candidateSha256, candidateRevision: candidate.revision, workspaceSha256: candidate.workspaceSha256,
    checks: (["focused_regression", "adjacent_regression", "typecheck", "independent_review"] as const).map((kind) => ({ id: kind, kind, outcome: "passed", producerKind: kind === "independent_review" ? "agent_review" : "command", producerId: `receipt:${kind}`, candidateRevision: candidate.revision, workspaceSha256: candidate.workspaceSha256, evidenceSha256: sha("a"), declaredCases: 1, executedCases: 1, failedCases: 0, completedAt: now })) });
  const cycle: SelfImprovementCycle = { id: "cycle", scope, policy, stage: "ready_for_release", revision: 5, signal, candidate, validation, approval: null, release: null, releaseReceipt: null, correctionsUsed: 0, dailyReservationUsd: 100, createdAt: now, updatedAt: now, pullRequestUrl: "https://github.com/asael/app/pull/1", leaseToken: "private-lease-secret" };
  return { cycle, configurationId: "configuration", configurationGeneration: 1, projectId: "project", repositoryId: "42", day: now.slice(0, 10), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), leaseToken: "private-lease-secret", runtime: {}, spendUsd: 1, usageState: "known", controllerId: "controller", controllerHold: null };
}
beforeEach(() => {
  vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_TENANT_ID", owner.tenantId); vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
  for (const fn of Object.values(mock)) fn.mockReset();
  mock.writePresence.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("trusted self-improvement release boundary", () => {
  it("requires the exact authenticated canonical administrator instead of internal headers", () => {
    expect(selfImprovementControllerOwner(auth)).toEqual(owner);
    expect(() => selfImprovementControllerOwner({ ...auth, source: "internal" } as never)).toThrow(/authenticated/);
    expect(() => selfImprovementControllerOwner({ ...auth, role: "operator" })).toThrow(/administrator/);
    expect(() => selfImprovementControllerOwner({ ...auth, tenantId: "other" })).toThrow(/exact owner/);
  });
  it("reports connectivity only from fresh observed controller requests", async () => {
    mock.presence.mockResolvedValue(null); expect(await getSelfImprovementControllerStatus(owner)).toEqual({ status: "not_connected" });
    mock.presence.mockResolvedValue({ lastSeenAt: new Date(Date.now() - 181_000).toISOString(), controllerStatus: "online" }); expect(await getSelfImprovementControllerStatus(owner)).toMatchObject({ status: "offline" });
    mock.presence.mockResolvedValue({ lastSeenAt: new Date().toISOString(), controllerStatus: "held", category: "main_advanced" }); expect(await getSelfImprovementControllerStatus(owner)).toMatchObject({ status: "online", activity: "held", category: "main_advanced" });
  });
  it("does not expose raw leases and refuses failed candidate evidence", () => {
    const stored = fixture(); expect(JSON.stringify(buildSelfImprovementReleaseRequest(stored))).not.toContain("private-lease-secret");
    expect(buildSelfImprovementReleaseRequest(stored).approval).toBeNull();
    expect(() => buildSelfImprovementReleaseRequest({ ...stored, usageState: "unknown" })).toThrow(/verified/);
    expect(() => buildSelfImprovementReleaseRequest({ ...stored, controllerHold: { category: "uncertain", occurredAt: new Date().toISOString() } })).toThrow(/verified/);
  });
  it("keeps protected files on the manual release path even with exact owner approval", () => {
    const stored = fixture(), artifact = stored.cycle.candidate!;
    const { candidateSha256: _candidateDigest, ...candidateBody } = artifact;
    stored.cycle.candidate = sealSelfImprovementCandidate({ ...candidateBody, changedFiles: [{ ...artifact.changedFiles[0], path: "src/proxy.ts" }] });
    const { validationSha256: _validationDigest, ...validationBody } = stored.cycle.validation!;
    stored.cycle.validation = sealSelfImprovementValidation({ ...validationBody, candidateSha256: stored.cycle.candidate.candidateSha256 });
    stored.cycle.approval = sealSelfImprovementApproval({ approvalId: "owner-reviewed", ...owner, candidateSha256: stored.cycle.candidate.candidateSha256, policySha256: stored.cycle.policy.policySha256,
      validationSha256: stored.cycle.validation.validationSha256, decision: "approved", approvedAt: new Date(Date.now()-1_000).toISOString(), expiresAt: new Date(Date.now()+60_000).toISOString() });
    expect(() => buildSelfImprovementReleaseRequest(stored)).toThrow(/manual release/);
  });
  it("checks the actual provider tree before binding the merged release", async () => {
    const stored = fixture(); mock.lease.mockResolvedValue(stored); mock.configuration.mockResolvedValue({ ...owner, id: stored.configurationId,
      projectId: stored.projectId, repositoryId: stored.repositoryId, repository: stored.cycle.scope.repository, policy: stored.cycle.policy, paused: false, generation: 3 });
    mock.proof.mockResolvedValue({ sourceTree: git("d"), mergedCommit: { treeSha: git("e") } });
    await expect(executeSelfImprovementControllerAction(auth, { action: "prepare", cycleId: "cycle", controllerId: "controller", leaseToken: "secret", mergedRevision: git("c"), sourceTree: git("d"), mergedTree: git("d") })).rejects.toThrow(/provider evidence/);
    expect(mock.transition).not.toHaveBeenCalled();
  });
  it("returns the rotated heartbeat token for the next serialized controller action", async () => {
    const stored = fixture(); mock.lease.mockResolvedValue(stored); mock.renew.mockResolvedValue({ ...stored, leaseToken: "rotated" });
    expect(await executeSelfImprovementControllerAction(auth, { action: "heartbeat", cycleId: "cycle", controllerId: "controller", leaseToken: "old" })).toEqual({ leaseToken: "rotated", expiresAt: stored.leaseExpiresAt });
  });
  it("requires independently observed paired revisions before accepting completion", async () => {
    const stored = fixture();
    stored.cycle.stage = "releasing";
    stored.cycle.release = sealSelfImprovementReleaseBinding({ releaseId: "release", scope: stored.cycle.scope, previousRevision: git("a"), sourceCandidateRevision: git("b"), candidateRevision: git("c"), sourceTree: git("d"), mergedTree: git("d"), pullRequestUrl: stored.cycle.pullRequestUrl!, candidateSha256: stored.cycle.candidate!.candidateSha256, policySha256: stored.cycle.policy.policySha256, validationSha256: stored.cycle.validation!.validationSha256, runner: "asael_paired_production" });
    mock.lease.mockResolvedValue(stored); mock.settle.mockResolvedValue(stored); mock.configuration.mockResolvedValue({ paused: true });
    let workerRevision = git("a");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("fly.dev") ? { status: "healthy", service: "asael-openai-egress", revision: workerRevision } : { status: "healthy", revision: git("c"), releaseManifest: "signed-manifest" })));
    const input = { action: "complete", cycleId: "cycle", controllerId: "controller", leaseToken: "secret", releaseUsage: { phaseId: "release:controller", actualUsd: 0.01, evidenceSha256: sha("b") }, receipt: { releaseBindingSha256: stored.cycle.release.releaseBindingSha256, outcome: "deployed", webRevision: git("c"), workerRevision: git("c"), manifestSha256: canonicalJsonSha256("signed-manifest"), healthEvidenceSha256: sha("a"), behaviorEvidenceSha256: stored.cycle.validation!.validationSha256, evidenceSha256: sha("a"), recordedAt: new Date().toISOString() } };
    await expect(executeSelfImprovementControllerAction(auth, input)).rejects.toThrow(/Independent paired revision/); expect(mock.transition).not.toHaveBeenCalled();
    workerRevision = git("c"); mock.transition.mockImplementation(async (input) => ({ ...stored, cycle: { ...stored.cycle, stage: input.nextStage, releaseReceipt: input.patch.releaseReceipt } }));
    expect(await executeSelfImprovementControllerAction(auth, input)).toMatchObject({ stage: "succeeded", receipt: { serverHealthEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(mock.configuration).not.toHaveBeenCalled(); // Future-work pause does not strand exact release reconciliation.
    expect(mock.settle).toHaveBeenCalledWith(expect.objectContaining({ phaseId: "release:controller", actualUsd: 0.01 }));
    mock.transition.mockClear(); mock.settle.mockResolvedValue({ ...stored, usageState: "unknown" });
    await expect(executeSelfImprovementControllerAction(auth, { ...input, releaseUsage: { ...input.releaseUsage, actualUsd: null } })).rejects.toThrow(/usage is unconfirmed/);
    expect(mock.hold).toHaveBeenCalledWith(expect.objectContaining({ category: "release_usage_unconfirmed" })); expect(mock.transition).not.toHaveBeenCalled();
  });
});
