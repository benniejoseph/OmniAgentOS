import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityContext } from "@/lib/security/types";
import { withSelfImprovementExecution } from "./authority";
import { createSelfImprovementPolicy } from "./policy";
import { nativeValidationFixture } from "./native-test-fixtures";
import { nativeValidationReceiptSchema, nativeValidationRequestSchema, selfImprovementNativeSha } from "./native-contracts";
import { initialSelfImprovementRuntime } from "./runtime";
import { canStopSelfImprovementNativeCheck, type StoredSelfImprovementCycle } from "./store";
const mock = vi.hoisted(() => ({ session: vi.fn(), checkpoint: vi.fn(), manifest: vi.fn(), changes: vi.fn(), read: vi.fn(), list: vi.fn(), configuration: vi.fn(), authority: vi.fn(), claim: vi.fn(), lease: vi.fn(), finish: vi.fn(), renew: vi.fn(), presence: vi.fn() }));
vi.mock("@/lib/app-builder/store", () => ({ getProjectBuilderSession: mock.session, getBuilderCheckpoint: mock.checkpoint }));
vi.mock("@/lib/app-builder/sandbox", () => ({ getBuilderWorkspaceManifest: mock.manifest, readBuilderRepositoryChanges: mock.changes }));
vi.mock("./store", async original => ({ ...await original<typeof import("./store")>(), getSelfImprovementCycle: mock.read, listSelfImprovementCycles: mock.list,
  getSelfImprovementConfiguration: mock.configuration, assertSelfImprovementOwnerAuthority: mock.authority, claimSelfImprovementNativeValidation: mock.claim,
  readSelfImprovementNativeLease: mock.lease, finishSelfImprovementNativeValidation: mock.finish, renewSelfImprovementCycleLease: mock.renew, recordSelfImprovementControllerPresence: mock.presence }));
import { executeSelfImprovementNativeControllerAction, getCompletedSelfImprovementNativeVerification, listSelfImprovementNativeValidationRequests, readSelfImprovementNativeSource } from "./native-service";
let stored: StoredSelfImprovementCycle;
const fixture = (() => {
  const value = nativeValidationFixture();
  const { requestSha256: _request, ...requestBody } = { ...value.request, ownerActorId: "actor:11111111-1111-4111-8111-111111111111" };
  value.request = nativeValidationRequestSchema.parse({ ...requestBody, requestSha256: selfImprovementNativeSha("native_validation_request", requestBody) });
  const { receiptSha256: _receipt, ...receiptBody } = { ...value.receipt, requestSha256: value.request.requestSha256 };
  value.receipt = nativeValidationReceiptSchema.parse({ ...receiptBody, receiptSha256: selfImprovementNativeSha("native_validation_receipt", receiptBody) });
  return value;
})(), request = fixture.request;
const owner = { tenantId: request.tenantId, ownerActorId: request.ownerActorId };
const auth: SecurityContext = { tenantId: owner.tenantId, actorId: "owner@example.test", role: "admin", source: "session", auth: { userId: owner.ownerActorId.slice(6), email: "owner@example.test", sessionId: "session", tenantName: "Native" } };
const getterInput = { owner, projectId: request.projectId, requestId: request.requestId, sessionId: request.sessionId, checkpointId: request.checkpointId };
const governed = (work: () => Promise<unknown>, assertCurrent = vi.fn(async () => undefined)) => withSelfImprovementExecution({ ...owner, projectId: request.projectId, repositoryId: "42", cycleId: request.cycleId, policySha256: request.policySha256,
  expiresAt: "2026-10-26T18:00:00.000Z", readOnly: false, assertCurrent }, work);
beforeEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-26T17:10:00.000Z"));
  vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_TENANT_ID", owner.tenantId); vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
  const policy = createSelfImprovementPolicy({});
  stored = { configurationId: "configuration", configurationGeneration: 1, projectId: request.projectId, repositoryId: "42", day: "2026-10-26", leaseExpiresAt: "2026-10-26T17:15:00.000Z", spendUsd: 0.03, usageState: "known", controllerId: null, controllerHold: null,
    cycle: { id: request.cycleId, revision: 4, stage: "validating", scope: { ...owner, baseRevision: request.snapshot.baseRevision, repository: { owner: "asael", name: "app", defaultBranch: "main" } }, policy,
      signal: null, candidate: null, validation: null, approval: null, release: null, releaseReceipt: null, correctionsUsed: 0, dailyReservationUsd: 10, createdAt: request.createdAt, updatedAt: request.createdAt,
      builderSessionId: request.sessionId, checkpointId: request.checkpointId },
    runtime: { ...initialSelfImprovementRuntime(), phase: "verify", plan: { releaseTarget: "macos_app", summary: "Fix title", sourcePaths: request.analyzePaths.filter(path => path.includes("/lib/")), newSourcePaths: [], focusedTestPaths: request.focusedTestPaths, adjacentTestPaths: request.adjacentTestPaths, acceptanceCriteria: ["Title stays visible"] },
      native: { version: 1, requests: [{ request, status: "completed", controllerId: fixture.receipt.controllerId, receipt: fixture.receipt, holdCategory: null, claimedAt: request.createdAt }], activeRequestId: request.requestId, baselineCheckpointId: null, waitedMs: 1_000, waitStartedAt: null } } };
  mock.read.mockResolvedValue(stored); mock.list.mockResolvedValue([stored]); mock.authority.mockResolvedValue(undefined);
  mock.configuration.mockResolvedValue({ ...owner, id: stored.configurationId, projectId: stored.projectId, repositoryId: stored.repositoryId, repository: stored.cycle.scope.repository, policy, paused: false, generation: 1 });
  mock.session.mockResolvedValue({ id: request.sessionId, sandboxName: "isolated", currentCheckpointId: request.checkpointId });
  mock.checkpoint.mockResolvedValue({ workspaceSha256: request.snapshot.workspaceSha256 });
  mock.manifest.mockResolvedValue({ sha256: request.snapshot.workspaceSha256 });
  mock.changes.mockResolvedValue(fixture.files.map(file => file.content === null ? { kind: "delete", path: file.path, previousSha256: file.beforeSha256, previousMode: file.mode } : { kind: "upsert", previousSha256: file.beforeSha256, file: { path: file.path, sha256: file.afterSha256, mode: file.mode, content: file.content } }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("trusted native validation boundary", () => {
  it("does not import guessed receipts without live server-owned workflow authority", async () => {
    await expect(getCompletedSelfImprovementNativeVerification(getterInput)).rejects.toThrow(/live governed/);
    expect(mock.read).not.toHaveBeenCalled(); expect(mock.session).not.toHaveBeenCalled();
    await expect(governed(() => getCompletedSelfImprovementNativeVerification(getterInput), vi.fn(async () => { throw new Error("revoked"); }))).rejects.toThrow("revoked");
    expect(mock.read).not.toHaveBeenCalled();
  });
  it("imports only the active exact completed candidate receipt and unchanged checkpoint source", async () => {
    const result = await governed(() => getCompletedSelfImprovementNativeVerification(getterInput));
    expect(result).toEqual({ request, snapshot: request.snapshot, receipt: fixture.receipt });
    expect(mock.read).toHaveBeenCalledWith(owner, request.cycleId);
    expect(mock.session).toHaveBeenCalledWith(request.projectId, { tenantId: owner.tenantId, actorId: owner.ownerActorId });
  });
  it("rejects an old completed request after correction selects another active request", async () => {
    stored.runtime.native = { ...(stored.runtime.native as object), activeRequestId: `self_native_${"f".repeat(64)}` };
    await expect(governed(() => getCompletedSelfImprovementNativeVerification(getterInput))).rejects.toThrow(/exact completed/);
    expect(mock.session).not.toHaveBeenCalled();
  });
  it("rejects source content tampering and mutation during snapshot export", async () => {
    mock.changes.mockResolvedValueOnce([{ kind: "upsert", previousSha256: null, file: { ...fixture.files[0], sha256: fixture.files[0].afterSha256, content: "changed" } }]);
    await expect(readSelfImprovementNativeSource(stored, request.checkpointId)).rejects.toThrow(/content.*digest/);
    mock.manifest.mockResolvedValueOnce({ sha256: request.snapshot.workspaceSha256 }).mockResolvedValueOnce({ sha256: "f".repeat(64) });
    await expect(readSelfImprovementNativeSource(stored, request.checkpointId)).rejects.toThrow(/while.*read/);
  });
  it("exports the observed deleted-file mode and refuses legacy changes whose mode was never observed", async () => {
    const deletion = { kind: "delete", path: fixture.files[0].path, previousSha256: "e".repeat(64), previousMode: "100755" };
    mock.changes.mockResolvedValueOnce([deletion]);
    const result = await readSelfImprovementNativeSource(stored, request.checkpointId);
    expect(result.changes).toEqual([{ path: deletion.path, beforeSha256: deletion.previousSha256, afterSha256: null, mode: "100755", content: null }]);
    expect(result.snapshot.files[0].mode).toBe("100755");
    const { previousMode: _mode, ...legacyDeletion } = deletion;
    mock.changes.mockResolvedValueOnce([legacyDeletion]);
    await expect(readSelfImprovementNativeSource(stored, request.checkpointId)).rejects.toThrow(/observed regular-file mode/);
  });
  it("does not expose source or queues to mobile, another owner, or a non-administrator", async () => {
    for (const context of [{ ...auth, source: "mobile" as const }, { ...auth, role: "operator" as const }, { ...auth, tenantId: "foreign" }]) {
      await expect(listSelfImprovementNativeValidationRequests(context)).rejects.toThrow();
    }
    expect(mock.list).not.toHaveBeenCalled();
  });
  it("advertises Stop only with observed settled accounting and no live publisher or release", () => {
    const held = structuredClone(stored);
    const native = held.runtime.native as { requests: Array<{ status: string; holdCategory: string | null }> };
    native.requests[0].status = "held"; native.requests[0].holdCategory = "native_test_no_executed_cases";
    const stoppedLease = { ...held, leaseExpiresAt: "2026-10-26T17:00:00.000Z", unsettledPaidUsage: false };
    expect(canStopSelfImprovementNativeCheck(stoppedLease)).toBe(true);
    expect(canStopSelfImprovementNativeCheck({ ...stoppedLease, unsettledPaidUsage: undefined })).toBe(false);
    expect(canStopSelfImprovementNativeCheck({ ...stoppedLease, unsettledPaidUsage: true })).toBe(false);
    expect(canStopSelfImprovementNativeCheck({ ...stoppedLease, usageState: "unknown" })).toBe(false);
    expect(canStopSelfImprovementNativeCheck({ ...stoppedLease, controllerId: "release-publisher" })).toBe(false);
    expect(canStopSelfImprovementNativeCheck({ ...stoppedLease, leaseExpiresAt: "2026-10-26T17:20:00.000Z" })).toBe(false);
  });
  it("never serves source after pause but permits exact completion reconciliation", async () => {
    const entry = (stored.runtime.native as { requests: unknown[] }).requests[0];
    mock.lease.mockResolvedValue({ stored, entry });
    mock.configuration.mockResolvedValue({ ...await mock.configuration(), paused: true });
    const input = { cycleId: request.cycleId, requestId: request.requestId, controllerId: fixture.receipt.controllerId, leaseToken: "exact-lease" };
    await expect(executeSelfImprovementNativeControllerAction(auth, { action: "source", ...input })).rejects.toThrow(/paused/);
    expect(mock.manifest).not.toHaveBeenCalled();
    mock.finish.mockResolvedValue(stored);
    expect(await executeSelfImprovementNativeControllerAction(auth, { action: "complete", ...input, receipt: fixture.receipt })).toMatchObject({ status: "completed", receiptSha256: fixture.receipt.receiptSha256 });
    expect(mock.finish).toHaveBeenCalledWith(expect.objectContaining({ owner, leaseToken: "exact-lease", receipt: fixture.receipt }));
  });
});
