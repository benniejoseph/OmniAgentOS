import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { resolveBuilderCommandSpecification, type AppBuilderActivity } from "@/lib/app-builder/contracts";
import { projectActorReadOrder } from "@/lib/projects/actor-scope";
import { nativeValidationFixture } from "@/lib/self-improvement/native-test-fixtures";

const mocks = vi.hoisted(() => ({
  getOwnedProject: vi.fn(), getBuilderSession: vi.fn(), getBuilderSessionWorkspaceMode: vi.fn(), getBuilderCheckpoint: vi.fn(), getBuilderVerificationForIdempotency: vi.fn(), listBuilderActivity: vi.fn(), recordBuilderVerification: vi.fn(), recordBuilderActivity: vi.fn(),
  getBuilderWorkspaceManifest: vi.fn(), runBuilderCommand: vi.fn(), listBuilderFilesPage: vi.fn(), editBuilderFile: vi.fn(), recordBuilderWorkspaceChange: vi.fn(),
  createBuilderSessionRecord: vi.fn(), resetSourceOnlyBuilderSessionRecord: vi.fn(), builderSandboxExists: vi.fn(), createBuilderSandbox: vi.fn(), transitionBuilderSession: vi.fn(), getBuilderPreviewUrl: vi.fn(), listBuilderCheckpoints: vi.fn(), listBuilderVerifications: vi.fn(), readBuilderFrameworkDoc: vi.fn(),
  getCompletedSelfImprovementNativeVerification: vi.fn(),
}));
vi.mock("@/lib/projects/store", () => ({ getOwnedProject: mocks.getOwnedProject }));
vi.mock("@/lib/app-builder/store", () => mocks);
vi.mock("@/lib/app-builder/sandbox", () => mocks);
vi.mock("@/lib/self-improvement/native-service", () => ({ getCompletedSelfImprovementNativeVerification: mocks.getCompletedSelfImprovementNativeVerification }));

import { createProjectBuilderService, editProjectBuilderFileService, listProjectBuilderTreeService, readProjectBuilderFrameworkDocService, runProjectBuilderCommandService, runProjectBuilderVerificationService } from "@/lib/app-services/app-builder";

const session = { id: `app_build_${"a".repeat(48)}`, projectId: "project-a", tenantId: "tenant-a", ownerActorId: "actor-a", sandboxName: "fixture", revision: 3, currentCheckpointId: `app_build_checkpoint_${"b".repeat(48)}`, status: "ready" };
const workspaceSha256 = "c".repeat(64);
const caller = () => createAppServiceCaller({ context: { tenantId: "tenant-a", actorId: "actor-a", role: "operator", source: "service" }, idempotencyKey: "builder-focused-fixture",
  executionScope: createExecutionScope({ tenantId: "tenant-a", initiatingActorId: "actor-a", executingPrincipalType: "agent", executingPrincipalId: "main-agent", projectId: session.projectId, correlationId: "builder-fixture", purpose: "tool.app.projects.builder" }),
});
const profile = { projectId: session.projectId, sessionId: session.id, checkpointId: session.currentCheckpointId, expectedSessionRevision: 3,
  focusedTestPaths: ["src/feature.test.ts"], adjacentTestPaths: ["src/neighbor.test.ts"], lintPaths: ["src/feature.ts"], requireCompletedChecks: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOwnedProject.mockResolvedValue({ id: session.projectId });
  mocks.getBuilderSession.mockResolvedValue(session);
  mocks.getBuilderSessionWorkspaceMode.mockResolvedValue("interactive");
  mocks.getBuilderCheckpoint.mockResolvedValue({ id: session.currentCheckpointId, workspaceSha256 });
  mocks.getBuilderVerificationForIdempotency.mockResolvedValue(undefined);
  mocks.getBuilderWorkspaceManifest.mockResolvedValue({ fileCount: 4, sha256: workspaceSha256 });
  mocks.recordBuilderVerification.mockImplementation(async (value) => ({ ...value, tenantId: "tenant-a", ownerActorId: "actor-a", id: "verification-fixture", checkpointId: value.checkpoint.id, workspaceSha256 }));
  mocks.listBuilderActivity.mockResolvedValue(receipts());
  mocks.listBuilderCheckpoints.mockResolvedValue([]);
  mocks.listBuilderVerifications.mockResolvedValue([]);
  mocks.getBuilderPreviewUrl.mockResolvedValue(null);
  mocks.builderSandboxExists.mockResolvedValue(true);
  mocks.createBuilderSandbox.mockResolvedValue({ previewUrl: null, install: { exitCode: 0, durationMs: 0, skipped: true } });
  mocks.transitionBuilderSession.mockImplementation(async (value) => ({ ...value.session, status: value.status, revision: value.session.revision + 1 }));
});

function receipts(): AppBuilderActivity[] {
  return [
    { command: "lint_focused" as const, paths: profile.lintPaths },
    { command: "typecheck_direct" as const },
    { command: "test_focused" as const, paths: profile.focusedTestPaths },
    { command: "test_focused" as const, paths: profile.adjacentTestPaths },
  ].map((item, index) => ({
    id: `activity-${index}`, sessionId: session.id, eventType: "app_builder.command.completed", payloadSha256: "d".repeat(64), occurredAt: new Date(Date.now() - 1000).toISOString(),
    detail: { command: item.command, specification: resolveBuilderCommandSpecification(item), workspaceBeforeSha256: workspaceSha256, workspaceAfterSha256: workspaceSha256, workspaceUnchanged: true,
      exitCode: 0, durationMs: 4, outputSha256: "e".repeat(64), ...(item.command === "test_focused" ? { testSummary: { totalTests: 2, passedTests: 2, failedTests: 0, pendingTests: 0, executedPaths: item.paths, success: true } } : {}) },
  }));
}

describe("governed Builder focused validation", () => {
  function nativeProfile() {
    const { request, receipt } = nativeValidationFixture();
    const nativeSession = { ...session, id: request.sessionId, projectId: request.projectId,
      tenantId: request.tenantId, ownerActorId: request.ownerActorId, currentCheckpointId: request.checkpointId };
    mocks.getBuilderSession.mockResolvedValue(nativeSession);
    mocks.getBuilderCheckpoint.mockResolvedValue({ id: request.checkpointId, workspaceSha256: request.snapshot.workspaceSha256 });
    mocks.getBuilderWorkspaceManifest.mockResolvedValue({ sha256: request.snapshot.workspaceSha256, fileCount: 3 });
    mocks.getCompletedSelfImprovementNativeVerification.mockResolvedValue({ request, snapshot: request.snapshot, receipt });
    const scopedCaller = createAppServiceCaller({ context: { tenantId: request.tenantId, actorId: request.ownerActorId, role: "operator", source: "service" },
      idempotencyKey: "native-verification-fixture", executionScope: createExecutionScope({ tenantId: request.tenantId, initiatingActorId: request.ownerActorId,
        executingPrincipalType: "agent", executingPrincipalId: "atlas", projectId: request.projectId, correlationId: request.cycleId, purpose: "self_improvement.cycle.v1" }) });
    const input = { projectId: request.projectId, sessionId: request.sessionId, checkpointId: request.checkpointId,
      expectedSessionRevision: 3, nativeValidationRequestId: request.requestId, requireCompletedChecks: true };
    return { request, receipt, scopedCaller, input };
  }

  it("imports the exact trusted native candidate without running Linux commands", async () => {
    const { request, receipt, scopedCaller, input } = nativeProfile();
    const result = await runProjectBuilderVerificationService(scopedCaller, input);
    expect(result.data).toMatchObject({ created: true, verification: { status: "passed", checks: [
      { command: "macos_analyze" }, { command: "macos_test_focused", purpose: "regression" },
      { command: "macos_test_focused", purpose: "adjacent" }, { command: "macos_build" },
    ] } });
    expect(mocks.getCompletedSelfImprovementNativeVerification).toHaveBeenCalledWith({
      owner: { tenantId: request.tenantId, ownerActorId: request.ownerActorId }, projectId: request.projectId,
      sessionId: request.sessionId, checkpointId: request.checkpointId, requestId: request.requestId,
    });
    expect(mocks.runBuilderCommand).not.toHaveBeenCalled();
    expect(mocks.recordBuilderActivity).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({
      nativeValidationRequestId: request.requestId, nativeReceiptSha256: receipt.receiptSha256, artifactSha256: receipt.artifact!.artifactSha256,
    }) }));
  });
  it("does not import guessed native requests outside the active workflow", async () => {
    const { scopedCaller, input } = nativeProfile();
    mocks.getCompletedSelfImprovementNativeVerification.mockRejectedValue(new Error("No active governed native validation authority"));
    await expect(runProjectBuilderVerificationService(scopedCaller, input)).rejects.toThrow(/authority/);
    expect(mocks.recordBuilderVerification).not.toHaveBeenCalled();
    expect(mocks.runBuilderCommand).not.toHaveBeenCalled();
  });
  it("does not import a native receipt after the checkpoint workspace changed", async () => {
    const { scopedCaller, input } = nativeProfile();
    mocks.getBuilderWorkspaceManifest.mockResolvedValue({ sha256: "f".repeat(64), fileCount: 3 });
    await expect(runProjectBuilderVerificationService(scopedCaller, input)).rejects.toThrow(/workspace changed/);
    expect(mocks.recordBuilderVerification).not.toHaveBeenCalled();
  });
  it("rejects a native verification idempotency collision with a previous web check", async () => {
    const { request, scopedCaller, input } = nativeProfile();
    mocks.getBuilderVerificationForIdempotency.mockResolvedValue({ checkpointId: request.checkpointId,
      workspaceSha256: request.snapshot.workspaceSha256, checks: [] });
    await expect(runProjectBuilderVerificationService(scopedCaller, input)).rejects.toThrow(/idempotency/);
    expect(mocks.recordBuilderVerification).not.toHaveBeenCalled();
  });
  it("reads the verified project alias while retaining the canonical service owner for writes", async () => {
    const authUserId = "11111111-1111-4111-8111-111111111111", actorId = `actor:${authUserId}`, email = "builder@example.test";
    const binding = { version: 1 as const, kind: "auth_user" as const, authUserId, canonicalActorId: actorId,
      legacyOwnerActorIds: [email], readableOwnerActorIds: [actorId, email] };
    const scopedCaller = createAppServiceCaller({ context: { tenantId: session.tenantId, actorId, role: "operator", source: "service" },
      requestActorBinding: binding, idempotencyKey: "canonical-builder-create",
      executionScope: createExecutionScope({ tenantId: session.tenantId, initiatingActorId: actorId, executingPrincipalType: "agent", executingPrincipalId: "atlas",
        projectId: session.projectId, correlationId: "canonical-builder-create", purpose: "self_improvement.cycle.v1" }),
    });
    mocks.getOwnedProject.mockImplementation(async (_id, options) => projectActorReadOrder(options.actorId, options.requestActorBinding).includes(email) ? { id: session.projectId } : undefined);
    mocks.createBuilderSessionRecord.mockResolvedValue({ session: { ...session, ownerActorId: actorId, workspaceMode: "source_only" }, created: true });
    await createProjectBuilderService(scopedCaller, { projectId: session.projectId, workspaceMode: "source_only" });
    expect(mocks.getOwnedProject).toHaveBeenCalledWith(session.projectId, { tenantId: session.tenantId, actorId: email, requestActorBinding: binding });
    expect(mocks.createBuilderSessionRecord).toHaveBeenCalledWith(expect.objectContaining({ actorId, workspaceMode: "source_only" }));
    expect(mocks.createBuilderSandbox).toHaveBeenCalledWith(expect.objectContaining({ ownerActorId: actorId }));
  });

  it("records exact literal edit provenance without placing source text in the activity receipt", async () => {
    const update = { path: "src/file.ts", previousSha256: "a".repeat(64), sha256: "b".repeat(64), size: 24, replacementCount: 1 };
    const edits = [{ oldText: "const value = 1", newText: "const value = 2" }];
    mocks.editBuilderFile.mockResolvedValue(update);
    mocks.recordBuilderWorkspaceChange.mockResolvedValue({ ...session, revision: 4 });
    const result = await editProjectBuilderFileService(caller(), { projectId: session.projectId, sessionId: session.id, path: update.path, expectedSha256: update.previousSha256, edits });
    expect(result.data).toMatchObject({ session: { revision: 4 }, update });
    expect(mocks.editBuilderFile).toHaveBeenCalledWith({ sandboxName: session.sandboxName, path: update.path, expectedSha256: update.previousSha256, edits });
    expect(mocks.recordBuilderWorkspaceChange).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a", actorId: "actor-a", detail: { action: "edit", ...update } }));
    expect(JSON.stringify(mocks.recordBuilderWorkspaceChange.mock.calls[0][0])).not.toContain("const value");
    mocks.recordBuilderWorkspaceChange.mockClear();
    mocks.editBuilderFile.mockRejectedValueOnce(new Error("changed after inspection"));
    await expect(editProjectBuilderFileService(caller(), { projectId: session.projectId, sessionId: session.id, path: update.path, expectedSha256: update.previousSha256, edits })).rejects.toThrow(/changed after/);
    expect(mocks.recordBuilderWorkspaceChange).not.toHaveBeenCalled();
  });

  it("recovers only source-only unusable sessions and retains duplicate provisioning identity", async () => {
    const failed = { ...session, workspaceMode: "source_only", status: "failed" };
    const reset = { ...failed, sandboxName: "replacement-fixture", revision: 4, status: "provisioning" };
    mocks.createBuilderSessionRecord.mockResolvedValue({ session: failed, created: false });
    mocks.resetSourceOnlyBuilderSessionRecord.mockResolvedValue({ session: reset, reset: true });
    const result = await createProjectBuilderService(caller(), { projectId: session.projectId, workspaceMode: "source_only" });
    expect(result.data).toMatchObject({ created: true, previewUrl: null, session: { status: "ready", revision: 5 } });
    expect(mocks.resetSourceOnlyBuilderSessionRecord).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 3, reason: "failed" }));
    expect(mocks.createBuilderSandbox).toHaveBeenCalledWith(expect.objectContaining({ sandboxName: "replacement-fixture", workspaceMode: "source_only" }));
    mocks.createBuilderSandbox.mockClear();
    mocks.resetSourceOnlyBuilderSessionRecord.mockResolvedValue({ session: reset, reset: false });
    expect((await createProjectBuilderService(caller(), { projectId: session.projectId, workspaceMode: "source_only" })).data.created).toBe(false);
    expect(mocks.createBuilderSandbox).not.toHaveBeenCalled();
    mocks.createBuilderSessionRecord.mockResolvedValue({ session: { ...failed, workspaceMode: "interactive" }, created: false });
    await expect(createProjectBuilderService(caller(), { projectId: session.projectId, workspaceMode: "source_only" })).rejects.toThrow(/different Builder workspace mode/);
  });

  it("requires provider-confirmed absence before rotating a ready engineering workspace", async () => {
    const existing = { ...session, workspaceMode: "source_only" };
    mocks.createBuilderSessionRecord.mockResolvedValue({ session: existing, created: false });
    mocks.builderSandboxExists.mockRejectedValueOnce(new Error("provider timeout"));
    await expect(createProjectBuilderService(caller(), { projectId: session.projectId, workspaceMode: "source_only" })).rejects.toThrow(/timeout/);
    expect(mocks.resetSourceOnlyBuilderSessionRecord).not.toHaveBeenCalled();
    mocks.builderSandboxExists.mockResolvedValueOnce(false);
    mocks.resetSourceOnlyBuilderSessionRecord.mockResolvedValue({ session: { ...existing, revision: 4, status: "provisioning" }, reset: true });
    await createProjectBuilderService(caller(), { projectId: session.projectId, workspaceMode: "source_only" });
    expect(mocks.resetSourceOnlyBuilderSessionRecord).toHaveBeenCalledWith(expect.objectContaining({ reason: "sandbox_missing" }));
  });

  it("does not advance fresh provisioning and reconciles only an old owned workspace with source evidence", async () => {
    const provisioning = { ...session, workspaceMode: "source_only", status: "provisioning", updatedAt: new Date().toISOString() };
    mocks.createBuilderSessionRecord.mockResolvedValue({ session: provisioning, created: false });
    await expect(createProjectBuilderService(caller(), { projectId: session.projectId, workspaceMode: "source_only" })).rejects.toThrow(/not ready/);
    expect(mocks.builderSandboxExists).not.toHaveBeenCalled();
    mocks.createBuilderSessionRecord.mockResolvedValue({ session: { ...provisioning, updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() }, created: false });
    const result = await createProjectBuilderService(caller(), { projectId: session.projectId, workspaceMode: "source_only" });
    expect(result.data).toMatchObject({ created: false, session: { status: "ready", revision: 4 } });
    expect(mocks.transitionBuilderSession).toHaveBeenCalledWith(expect.objectContaining({ status: "ready", detail: expect.objectContaining({ provisioningRecovered: true, workspaceSha256 }) }));
    expect(mocks.resetSourceOnlyBuilderSessionRecord).not.toHaveBeenCalled();
    expect(mocks.createBuilderSandbox).not.toHaveBeenCalled();
  });

  it("rotates stale missing or confirmed-empty source-only provisioning without treating a read timeout as absence", async () => {
    const provisioning = { ...session, workspaceMode: "source_only", status: "provisioning", updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() };
    mocks.createBuilderSessionRecord.mockResolvedValue({ session: provisioning, created: false });
    mocks.builderSandboxExists.mockResolvedValue(false);
    mocks.resetSourceOnlyBuilderSessionRecord.mockResolvedValue({ session: { ...provisioning, sandboxName: "recovered", revision: 4 }, reset: true });
    await createProjectBuilderService(caller(), { projectId: session.projectId, workspaceMode: "source_only" });
    expect(mocks.resetSourceOnlyBuilderSessionRecord).toHaveBeenCalledWith(expect.objectContaining({ reason: "sandbox_missing" }));
    mocks.resetSourceOnlyBuilderSessionRecord.mockClear(); mocks.builderSandboxExists.mockResolvedValue(true);
    mocks.getBuilderWorkspaceManifest.mockRejectedValueOnce(new Error("manifest timeout"));
    await expect(createProjectBuilderService(caller(), { projectId: session.projectId, workspaceMode: "source_only" })).rejects.toThrow(/manifest timeout/);
    expect(mocks.resetSourceOnlyBuilderSessionRecord).not.toHaveBeenCalled();
    mocks.getBuilderWorkspaceManifest.mockRejectedValueOnce(new Error("The builder workspace must contain editable source files."));
    await createProjectBuilderService(caller(), { projectId: session.projectId, workspaceMode: "source_only" });
    expect(mocks.resetSourceOnlyBuilderSessionRecord).toHaveBeenCalledWith(expect.objectContaining({ reason: "failed", expectedRevision: 4 }));
  });

  it("reads installed framework documentation through the exact owned session with a bounded range", async () => {
    mocks.readBuilderFrameworkDoc.mockResolvedValue({ framework: "next", file: { path: "01-app/guide.md", content: "guide", sha256: workspaceSha256 } });
    const result = await readProjectBuilderFrameworkDocService(caller(), { projectId: session.projectId, sessionId: session.id, path: "01-app/guide.md" });
    expect(result.data.documentation.framework).toBe("next");
    expect(mocks.readBuilderFrameworkDoc).toHaveBeenCalledWith("fixture", "01-app/guide.md", { startLine: 1, lineCount: 120 });
    await expect(readProjectBuilderFrameworkDocService(caller(), { projectId: session.projectId, sessionId: session.id, path: "../../private.md" })).rejects.toThrow();
  });

  it("assembles exact regression and adjacent receipts without rerunning checks", async () => {
    const result = await runProjectBuilderVerificationService(caller(), profile);
    expect(result.data.verification).toMatchObject({ status: "passed", checks: [
      { command: "lint_focused", sourceActivityId: "activity-0" }, { command: "typecheck_direct", sourceActivityId: "activity-1" },
      { command: "test_focused", purpose: "regression", testSummary: { totalTests: 2 } }, { command: "test_focused", purpose: "adjacent", testSummary: { totalTests: 2 } },
    ] });
    expect(mocks.runBuilderCommand).not.toHaveBeenCalled();
    expect(mocks.listBuilderActivity).toHaveBeenCalledWith(session.id, { tenantId: "tenant-a", actorId: "actor-a" }, 100);
  });

  it("does not substitute a successful stale receipt when latest exact evidence failed", async () => {
    const activity = receipts();
    activity.push({ ...activity[2], id: "latest-failure", occurredAt: new Date().toISOString(), detail: { ...activity[2].detail, exitCode: 1, testSummary: { totalTests: 2, passedTests: 1, failedTests: 1, pendingTests: 0, executedPaths: profile.focusedTestPaths, success: false } } });
    mocks.listBuilderActivity.mockResolvedValue(activity);
    const result = await runProjectBuilderVerificationService(caller(), profile);
    expect(result.data.verification.status).toBe("failed");
    expect(mocks.runBuilderCommand).not.toHaveBeenCalled();
  });

  it("requires complete receipts and seals source changes during validation", async () => {
    mocks.listBuilderActivity.mockResolvedValue(receipts().slice(0, 3));
    await expect(runProjectBuilderVerificationService(caller(), profile)).rejects.toThrow(/missing or expired/);
    expect(mocks.recordBuilderVerification).not.toHaveBeenCalled();
    mocks.listBuilderActivity.mockResolvedValue(receipts());
    mocks.getBuilderWorkspaceManifest.mockResolvedValueOnce({ sha256: workspaceSha256 }).mockResolvedValueOnce({ sha256: "f".repeat(64) });
    await expect(runProjectBuilderVerificationService(caller(), profile)).rejects.toThrow(/changed the sealed workspace/);
    expect(mocks.recordBuilderVerification).not.toHaveBeenCalled();
  });

  it("records failed reproduction cases and unchanged workspace provenance", async () => {
    const specification = resolveBuilderCommandSpecification({ command: "test_focused", paths: profile.focusedTestPaths });
    mocks.runBuilderCommand.mockResolvedValue({ command: "test_focused", specification, exitCode: 1, stdout: "failed regression", stderr: "", durationMs: 40,
      testSummary: { totalTests: 2, passedTests: 1, failedTests: 1, pendingTests: 0, executedPaths: profile.focusedTestPaths, success: false } });
    const result = await runProjectBuilderCommandService(caller(), { projectId: session.projectId, sessionId: session.id, command: "test_focused", paths: profile.focusedTestPaths });
    expect(result.data.result).toMatchObject({ exitCode: 1, workspaceBeforeSha256: workspaceSha256, workspaceAfterSha256: workspaceSha256, workspaceUnchanged: true, testSummary: { failedTests: 1 } });
    expect(mocks.recordBuilderActivity).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ specification, exitCode: 1, workspaceUnchanged: true }) }));
  });

  it("returns pagination and preserves actor scope", async () => {
    mocks.listBuilderFilesPage.mockResolvedValue({ entries: [{ path: "src/file.ts", kind: "file" }], total: 600, truncated: true, nextCursor: `${"a".repeat(64)}:200` });
    const result = await listProjectBuilderTreeService(caller(), { projectId: session.projectId, sessionId: session.id, limit: 200 });
    expect(result.data).toMatchObject({ total: 600, truncated: true, nextCursor: expect.any(String) });
    expect(mocks.listBuilderFilesPage).toHaveBeenCalledWith("fixture", { limit: 200, cursor: undefined });
  });
});
