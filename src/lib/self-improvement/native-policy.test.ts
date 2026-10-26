import { describe, expect, it } from "vitest";
import { nativeValidationFixture } from "./native-test-fixtures";
import { assertNativeValidationReceipt, isSelfImprovementNativePath, nativeValidationRequestSchema, selfImprovementNativeSha } from "./native-contracts";
import { sealSelfImprovementCandidate, sealSelfImprovementValidation, sealSelfImprovementApproval, sealSelfImprovementReleaseBinding, type SelfImprovementCycle } from "./contracts";
import { sealEngineeringSignal } from "./evidence";
import { createSelfImprovementPolicy, classifySelfImprovementChange, assertSelfImprovementCycleIntegrity, assertSelfImprovementCycleTransition } from "./policy";
const sha = "a".repeat(64), git = "b".repeat(40);
function cycle(): SelfImprovementCycle {
  const { request, receipt } = nativeValidationFixture();
  const scope = { tenantId: request.tenantId, ownerActorId: request.ownerActorId, repository: { owner: "benniejoseph", name: "OmniAgentOS", defaultBranch: "main" }, baseRevision: request.snapshot.baseRevision };
  const policy = createSelfImprovementPolicy({});
  const signal = sealEngineeringSignal({ version: 1, scope, kind: "owner_correction", symptomSha256: sha, summary: "The feature title is missing.", observations: [{ sourceKind: "owner_feedback", sourceId: "feedback", sourceSha256: sha, observedAt: request.createdAt, outcome: "needs_work" }] });
  const candidate = sealSelfImprovementCandidate({ releaseTarget: "macos_app", revision: git, workspaceSha256: request.snapshot.workspaceSha256, diffSha256: sha,
    changedFiles: request.snapshot.files.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256 })), changedLines: 12, architectureImpact: "minor" });
  const validation = sealSelfImprovementValidation({ scope, policySha256: policy.policySha256, signalSha256: signal.signalSha256, candidateSha256: candidate.candidateSha256, candidateRevision: git, workspaceSha256: candidate.workspaceSha256,
    native: { requestId: request.requestId, requestSha256: request.requestSha256, snapshotSha256: request.snapshot.snapshotSha256, receiptSha256: receipt.receiptSha256, artifact: receipt.artifact!, installedBaseline: receipt.installedBaseline, pairedBaseline: { ...receipt.pairedBaseline, webRevision: "e".repeat(40), workerRevision: "e".repeat(40) } },
    checks: (["focused_regression", "adjacent_regression", "typecheck", "build", "independent_review"] as const).map(kind => ({ id: kind, kind, outcome: "passed", producerKind: kind === "independent_review" ? "agent_review" : "command", producerId: request.requestId, candidateRevision: git, workspaceSha256: candidate.workspaceSha256, evidenceSha256: sha, declaredCases: 1, executedCases: 1, failedCases: 0, completedAt: receipt.completedAt })) });
  return { id: request.cycleId, scope, policy, stage: "review_required", revision: 1, signal, candidate, validation, approval: null, release: null, releaseReceipt: null, correctionsUsed: 0, dailyReservationUsd: 10, createdAt: request.createdAt, updatedAt: receipt.completedAt };
}
function approved() {
  const before = cycle(), native = before.validation!.native!;
  const approval = sealSelfImprovementApproval({ approvalId: "owner-review", tenantId: before.scope.tenantId, ownerActorId: before.scope.ownerActorId,
    candidateSha256: before.candidate!.candidateSha256, validationSha256: before.validation!.validationSha256, policySha256: before.policy.policySha256,
    nativeArtifactSha256: native.artifact.artifactSha256, nativeBaselineSha256: native.installedBaseline.baselineSha256, decision: "approved", approvedAt: before.updatedAt,
    expiresAt: new Date(Date.parse(before.updatedAt) + 3_600_000).toISOString() });
  return { ...before, stage: "ready_for_release" as const, approval };
}
describe("native exact candidate and approval", () => {
  it("requires explicit native target and owner review while protecting control paths", () => {
    const before = cycle();
    expect(classifySelfImprovementChange({ candidate: before.candidate!, policy: before.policy })).toMatchObject({ disposition: "review_required", protectedFiles: [], reasons: ["native_app_install_approval"] });
    for (const path of ["apps/flutter/lib/features/auth/login.dart", "apps/flutter/lib/features/ambient_voice/verbal_approval.dart", "apps/flutter/lib/features/ambient_voice/voice_task_binding.dart", "apps/flutter/lib/features/computer_use/local_computer.dart", "apps/flutter/lib/features/integrations/connector_credential_rotation_repository.dart", "apps/flutter/lib/features/agents/agent_governance.dart", "apps/flutter/lib/features/agents/task_authority_view.dart", "apps/flutter/lib/features/agents/agent_control_view.dart", "apps/flutter/lib/features/knowledge/knowledge_consent_view.dart", "apps/flutter/lib/features/inbox/inbox.dart", "apps/flutter/lib/features/inbox/macos_inbox_view.dart", "apps/flutter/test/features/ambient_voice/verbal_approval_test.dart", "apps/flutter/lib/features/talk/talk.dart", "apps/flutter/lib/core/update/native_update_readiness.dart", "apps/flutter/macos/Runner/NativeUpdateBridge.swift", "apps/flutter/lib/core/network/api_client.dart", "apps/flutter/lib/features/self_improvement/controller.dart", "apps/flutter/macos/Runner/AppDelegate.swift", "apps/flutter/macos/Runner/Release.entitlements", "apps/flutter/pubspec.yaml"]) expect(isSelfImprovementNativePath(path), path).toBe(false);
    for (const path of ["apps/flutter/lib/features/studio/canvas.dart", "apps/flutter/lib/features/projects/project_card.dart", "apps/flutter/lib/features/agents/agent_adaptation_comparison_view.dart", "apps/flutter/lib/features/inbox/example.dart", "apps/flutter/test/features/inbox/example_test.dart"]) expect(isSelfImprovementNativePath(path), path).toBe(true);
    const { candidateSha256: _old, releaseTarget: _target, ...body } = before.candidate!;
    expect(classifySelfImprovementChange({ candidate: sealSelfImprovementCandidate(body), policy: before.policy }).protectedFiles.length).toBeGreaterThan(0);
  });
  it("binds one owner approval to the exact prepared artifact and installed predecessor", () => {
    const before = approved(); expect(() => assertSelfImprovementCycleIntegrity(before)).not.toThrow();
    const { receiptSha256: _receipt, ...approval } = before.approval!;
    const { nativeArtifactSha256: _artifact, nativeBaselineSha256: _baseline, ...withoutNative } = approval;
    expect(() => assertSelfImprovementCycleIntegrity({ ...before, approval: sealSelfImprovementApproval(withoutNative) })).toThrow(/approval/);
    expect(() => assertSelfImprovementCycleIntegrity({ ...before, approval: sealSelfImprovementApproval({ ...approval, nativeArtifactSha256: sha }) })).toThrow(/approval/);
  });
  it("reconciles a failed native installation against the unchanged server pair and retained old app", () => {
    const before = approved(), native = before.validation!.native!;
    const release = sealSelfImprovementReleaseBinding({ releaseId: "native-release", releaseTarget: "macos_app", scope: before.scope, previousRevision: before.scope.baseRevision,
      sourceCandidateRevision: before.candidate!.revision, candidateRevision: "c".repeat(40), sourceTree: "d".repeat(40), mergedTree: "d".repeat(40), pullRequestUrl: "https://github.com/benniejoseph/OmniAgentOS/pull/1",
      candidateSha256: before.candidate!.candidateSha256, validationSha256: before.validation!.validationSha256, policySha256: before.policy.policySha256, runner: "asael_macos_publisher", native: { ...native, approvalSha256: before.approval!.receiptSha256 } });
    const releasing = { ...before, stage: "releasing" as const, release };
    const receipt = { releaseBindingSha256: release.releaseBindingSha256, outcome: "failed" as const, ...native.pairedBaseline, healthEvidenceSha256: sha, behaviorEvidenceSha256: before.validation!.validationSha256, evidenceSha256: sha, recordedAt: before.updatedAt,
      nativeInstall: { artifactSha256: native.artifact.artifactSha256, baselineSha256: native.installedBaseline.baselineSha256, unsignedBundleSha256: native.artifact.unsignedBundleSha256,
        installedBundleSha256: native.installedBaseline.bundleSha256, version: native.installedBaseline.version, buildNumber: native.installedBaseline.buildNumber,
        signingIdentitySha256: native.installedBaseline.signingIdentitySha256, designatedRequirementSha256: native.installedBaseline.designatedRequirementSha256, codeSignatureSha256: sha, startupEvidenceSha256: sha, installationReceiptSha256: sha } };
    expect(before.scope.baseRevision).not.toBe(native.pairedBaseline.webRevision);
    expect(() => assertSelfImprovementCycleTransition(releasing, { ...releasing, revision: 2, stage: "failed", releaseReceipt: receipt })).not.toThrow();
    expect(() => assertSelfImprovementCycleTransition(releasing, { ...releasing, revision: 2, stage: "failed", releaseReceipt: { ...receipt, webRevision: before.scope.baseRevision } })).toThrow();
  });
  it("subtracts only bounded persisted native waiting without rewriting cycle timestamps", () => {
    const before = cycle(), started = { ...before, stage: "planned" as const, candidate: null, validation: null };
    const after = { ...started, stage: "implementing" as const, revision: 2, updatedAt: new Date(Date.parse(started.createdAt) + 2 * 3_600_000).toISOString() };
    expect(() => assertSelfImprovementCycleTransition(started, after)).toThrow(/deadline/);
    expect(() => assertSelfImprovementCycleTransition(started, after, 90 * 60_000)).not.toThrow();
    expect(() => assertSelfImprovementCycleTransition(started, after, 86_400_001)).toThrow(/waiting/);
    expect(after.createdAt).toBe(started.createdAt);
  });
  it("requires exact paths, command profiles, execution times and non-skipped test counts", () => {
    const { request, receipt } = nativeValidationFixture(); expect(() => assertNativeValidationReceipt(request, receipt)).not.toThrow();
    for (const change of [
      (r: typeof receipt) => { r.checks[0].policySha256 = sha; },
      (r: typeof receipt) => { r.checks[1].testSummary!.pendingTests = 1; },
      (r: typeof receipt) => { r.checks[0].startedAt = "2000-01-01T00:00:00.000Z"; },
      (r: typeof receipt) => { r.checks[1].paths = request.adjacentTestPaths; },
    ]) {
      const copy = structuredClone(receipt); change(copy); const { receiptSha256: _digest, ...body } = copy;
      expect(() => assertNativeValidationReceipt(request, { ...body, receiptSha256: selfImprovementNativeSha("native_validation_receipt", body) })).toThrow();
    }
    const { requestSha256: _requestSha, ...body } = { ...request, adjacentTestPaths: request.focusedTestPaths };
    expect(nativeValidationRequestSchema.safeParse({ ...body, requestSha256: selfImprovementNativeSha("native_validation_request", body) }).success).toBe(false);
  });
});
