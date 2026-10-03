import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { SecurityContext } from "@/lib/security/types";
import { draftFixture as draft, ownerFixture as owner, nowFixture as now } from "./test-fixtures";
import { prepareResponsibilityChange, responsibilityId, reviewPreview } from "./state";
const mocks = vi.hoisted(() => ({ sql: Object.assign(vi.fn(), { transaction: vi.fn() }), scope: vi.fn(), privateProcedures: vi.fn(), thread: vi.fn(), asset: vi.fn(), meeting: vi.fn(), access: vi.fn(), procedures: vi.fn(), snapshot: vi.fn(), identity: vi.fn(), builtIn: vi.fn(), isBuiltIn: vi.fn(), pin: vi.fn(), tool: vi.fn(), operationClass: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getSql: () => mocks.sql, hasDatabaseUrl: () => true, runWithDatabaseActorScope: mocks.scope }));
vi.mock("./procedure-reference", () => ({ readOwnedResponsibilityProcedures: mocks.privateProcedures }));
vi.mock("@/lib/threads/store", () => ({ getOwnedThread: mocks.thread }));
vi.mock("@/lib/capture/assets", () => ({ getCaptureAssetForRequest: mocks.asset }));
vi.mock("@/lib/meetings/store", () => ({ getMeeting: mocks.meeting }));
vi.mock("@/lib/memory/shared-context", () => ({ requestSharedMemoryAccessFromSecurityContext: mocks.access }));
vi.mock("@/lib/workspaces/contracts", () => ({ parseCanonicalWorkItemV1: (value: unknown) => value }));
vi.mock("@/lib/workflows/saved-procedures", () => ({ listSavedProcedures: mocks.procedures, buildWorkflowProcedureSnapshot: mocks.snapshot }));
vi.mock("@/lib/agents/identity-store", () => ({ resolveCustomAgentIdentityWithSql: mocks.identity }));
vi.mock("@/lib/agents/identity-contracts", () => ({ buildAgentRunIdentityPinV1: mocks.pin, buildBuiltInAgentIdentityV1: mocks.builtIn, isBuiltInAgentIdentityId: mocks.isBuiltIn }));
vi.mock("@/lib/tools/registry", () => ({ getGovernedTool: mocks.tool }));
vi.mock("@/lib/tools/executor", () => ({ governedToolOperationClass: mocks.operationClass }));
import { resolveResponsibilityPins } from "./references";
const context: SecurityContext = { tenantId: owner.tenantId, actorId: "owner@example.test", role: "operator", source: "session",
  auth: { userId: owner.actorId.slice(6), email: "owner@example.test", sessionId: "session-a", tenantName: "Fixture" } };
const id = responsibilityId(owner, "create");
const record = prepareResponsibilityChange({ owner, id, key: "create", now, mutation: { action: "create", expectedRevision: 0, draft } }).current;
const projection = { tenantId: owner.tenantId, ...draft.work, ownerActorIds: [owner.actorId] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockImplementation((_tenant: string, _actors: string[], operation: () => unknown) => operation());
  mocks.sql.mockResolvedValue([{ projection, projection_sha256: canonicalJsonSha256(projection) }]);
  mocks.sql.transaction.mockImplementation((work: (sql: unknown) => unknown) => work(mocks.sql));
  mocks.privateProcedures.mockResolvedValue([]);
  mocks.thread.mockResolvedValue({ id: draft.sources[0].id, tenantId: owner.tenantId, actorId: context.actorId, updatedAt: now, title: "Private title omitted from pin" });
  mocks.procedures.mockResolvedValue([{ id: draft.procedureId, aliases: ["Meeting brief"] }]);
  mocks.snapshot.mockReturnValue({ id: draft.procedureId, snapshotSha256: "a".repeat(64), toolBindings: [{ toolId: "memory.search", input: { query: "private exact query" } }] });
  mocks.tool.mockReturnValue({ id: "memory.search", status: "active", riskLevel: 0, approvalRequired: false, operationClass: "read_only" });
  mocks.operationClass.mockReturnValue("read_only");
  mocks.identity.mockResolvedValue({ principal: { authorityMode: "explicit_grants", toolGrantIds: ["memory.search"] } });
  mocks.builtIn.mockReturnValue({ principal: { authorityMode: "server_policy", toolGrantIds: [] } });
  mocks.isBuiltIn.mockReturnValue(false);
  mocks.pin.mockReturnValue({ tenantId: owner.tenantId, actorId: owner.actorId, logicalAgentId: "atlas", definitionVersionId: "atlas:v1", principalVersionId: "atlas-principal:v1", pinSha256: "b".repeat(64), policyPins: [{ id: "policy", sha256: "c".repeat(64) }] });
});
describe("Responsibility source and reference checks", () => {
  it("includes only the exact owner's scoped private procedure lane and refuses cross-lane duplicate IDs", async () => {
    mocks.procedures.mockResolvedValue([]);
    mocks.privateProcedures.mockResolvedValue([{ id: draft.procedureId, aliases: ["Meeting brief"] }]);
    await expect(resolveResponsibilityPins(context, owner, record)).resolves.toMatchObject({ procedure: { id: draft.procedureId } });
    expect(mocks.privateProcedures).toHaveBeenCalledWith(mocks.sql, owner, { lock: false, now: expect.any(String) });
    mocks.procedures.mockResolvedValue([{ id: draft.procedureId, aliases: ["Meeting brief"] }]);
    await expect(resolveResponsibilityPins(context, owner, record)).rejects.toMatchObject({ status: 409 });
  });
  it("pins only selected metadata with exact tenant/canonical owner and existing readable-owner binding", async () => {
    const pins = await resolveResponsibilityPins(context, owner, record);
    expect(mocks.thread).toHaveBeenCalledWith(draft.sources[0].id, expect.objectContaining({ tenantId: owner.tenantId, actorId: context.actorId, requestActorBinding: expect.objectContaining({ canonicalActorId: owner.actorId }) }));
    expect(mocks.scope).toHaveBeenCalledWith(owner.tenantId, [owner.actorId, context.actorId], expect.any(Function));
    expect(mocks.sql.mock.calls[0].slice(1)).toEqual([owner.tenantId, draft.work!.workspaceId, draft.work!.projectId, draft.work!.workItemId, [owner.actorId]]);
    expect(JSON.stringify(pins)).not.toContain("Private title"); expect(JSON.stringify(pins)).not.toContain("private exact query");
    expect(mocks.asset).not.toHaveBeenCalled(); expect(mocks.meeting).not.toHaveBeenCalled();
  });
  it("refuses a missing/cross-owner source before checking broader references", async () => {
    for (const thread of [null, { id: draft.sources[0].id, tenantId: owner.tenantId, actorId: "other@example.test", updatedAt: now }]) {
      mocks.thread.mockResolvedValueOnce(thread);
      await expect(resolveResponsibilityPins(context, owner, record)).rejects.toMatchObject({ code: "responsibility_reference_unavailable" });
    }
    expect(mocks.procedures).not.toHaveBeenCalled(); expect(mocks.sql).not.toHaveBeenCalled();
  });
  it("rejects ambiguous or inconsistent canonical Work and duplicate saved procedure IDs", async () => {
    mocks.sql.mockResolvedValueOnce([{ projection }, { projection }]);
    await expect(resolveResponsibilityPins(context, owner, record)).rejects.toMatchObject({ status: 409 });
    mocks.sql.mockResolvedValueOnce([{ projection: { ...projection, ownerActorIds: ["other"] }, projection_sha256: canonicalJsonSha256(projection) }]);
    await expect(resolveResponsibilityPins(context, owner, record)).rejects.toMatchObject({ status: 409 });
    mocks.procedures.mockResolvedValueOnce([{ id: draft.procedureId }, { id: draft.procedureId }]);
    await expect(resolveResponsibilityPins(context, owner, record)).rejects.toMatchObject({ status: 409 });
  });
  it("refuses mutable/dynamic procedures and foreign Agent identity without executing anything", async () => {
    mocks.operationClass.mockReturnValueOnce("mutation");
    await expect(resolveResponsibilityPins(context, owner, record)).rejects.toMatchObject({ code: "responsibility_procedure_not_read_only" });
    mocks.snapshot.mockReturnValueOnce({ id: draft.procedureId, snapshotSha256: "a".repeat(64), toolBindings: [{ toolId: "memory.search", input: { query: "{{newTarget}}" } }] });
    await expect(resolveResponsibilityPins(context, owner, record)).rejects.toMatchObject({ code: "responsibility_procedure_not_read_only" });
    mocks.pin.mockReturnValueOnce({ tenantId: owner.tenantId, actorId: "foreign-owner", logicalAgentId: "atlas" });
    await expect(resolveResponsibilityPins(context, owner, record)).rejects.toMatchObject({ code: "responsibility_reference_unavailable" });
    mocks.identity.mockResolvedValueOnce({ principal: { authorityMode: "explicit_grants", toolGrantIds: [] } });
    await expect(resolveResponsibilityPins(context, owner, record)).rejects.toMatchObject({ code: "responsibility_agent_policy_changed" });
  });
  it("changes review identity when the same source ID has a new metadata revision", async () => {
    const first = await resolveResponsibilityPins(context, owner, record);
    mocks.thread.mockResolvedValueOnce({ id: draft.sources[0].id, tenantId: owner.tenantId, actorId: context.actorId, updatedAt: "2026-10-04T01:00:00.000Z" });
    const second = await resolveResponsibilityPins(context, owner, record);
    expect(reviewPreview(record, first).reviewSha256).not.toBe(reviewPreview(record, second).reviewSha256);
  });
  it("checks exact meeting workspace and capture ownership through existing metadata readers", async () => {
    const meetingSource = { kind: "meeting" as const, id: "meeting-a", workspaceId: "workspace:owner" };
    const captureSource = { kind: "capture_asset" as const, id: "asset-a" };
    const selected = { ...record, draft: { ...draft, sources: [meetingSource, captureSource] } };
    mocks.access.mockResolvedValue({ authority: { tenantId: owner.tenantId, workspaceId: meetingSource.workspaceId }, actorBinding: { canonicalActorId: owner.actorId, readableOwnerActorIds: [owner.actorId, context.actorId] } });
    mocks.meeting.mockResolvedValue({ meetingId: meetingSource.id, tenantId: owner.tenantId, workspaceId: meetingSource.workspaceId, meetingSha256: "d".repeat(64) });
    mocks.asset.mockResolvedValue({ id: captureSource.id, tenantId: owner.tenantId, actorId: context.actorId, contentSha256: "e".repeat(64), updatedAt: now, extractionStatus: "completed", status: "indexed" });
    expect((await resolveResponsibilityPins(context, owner, selected)).sources).toHaveLength(2);
    expect(mocks.meeting).toHaveBeenCalledWith(expect.objectContaining({ tenantId: owner.tenantId, workspaceId: meetingSource.workspaceId, canonicalActorId: owner.actorId }), meetingSource.id);
    mocks.access.mockResolvedValueOnce({ authority: { tenantId: "other", workspaceId: meetingSource.workspaceId } });
    await expect(resolveResponsibilityPins(context, owner, selected)).rejects.toMatchObject({ status: 409 });
  });

  it("retains a canonical authored owner across a changed request email and exact projected source reads", async () => {
    const email = "renamed-owner@example.test";
    const renamed = { ...context, actorId: email, auth: { ...context.auth!, email } };
    const selected = { ...record, draft: { ...draft, sources: [draft.sources[0], { kind: "capture_asset" as const, id: "canonical-asset" }] } };
    mocks.thread.mockImplementation(async (id: string, scope: { actorId: string; requestActorBinding: { canonicalActorId: string } }) => {
      expect(scope.requestActorBinding.canonicalActorId).toBe(owner.actorId);
      return { id, tenantId: owner.tenantId, actorId: scope.actorId, updatedAt: now };
    });
    mocks.asset.mockImplementation(async (id: string, scope: { actorId: string; requestActorBinding: { canonicalActorId: string } }) => {
      expect(scope.requestActorBinding.canonicalActorId).toBe(owner.actorId);
      return { id, tenantId: owner.tenantId, actorId: scope.actorId, contentSha256: "e".repeat(64), updatedAt: now, extractionStatus: "completed", status: "indexed", manageable: false };
    });
    await expect(resolveResponsibilityPins(renamed, owner, selected)).resolves.toMatchObject({ sources: expect.any(Array) });
    expect(mocks.identity).toHaveBeenCalledWith({ tenantId: owner.tenantId, ownerActorId: owner.actorId, agentId: "atlas", sql: mocks.sql });
    expect(record.actorId).toBe(owner.actorId);
    mocks.asset.mockResolvedValueOnce({ id: "canonical-asset", tenantId: owner.tenantId, actorId: "unrelated@example.test" });
    await expect(resolveResponsibilityPins(renamed, owner, selected)).rejects.toMatchObject({ code: "responsibility_reference_unavailable" });
  });
  it("refuses a mismatched authored owner before any reference read", async () => {
    await expect(resolveResponsibilityPins(context, { ...owner, actorId: "unrelated" }, record)).rejects.toMatchObject({ status: 409 });
    await expect(resolveResponsibilityPins(context, owner, { ...record, tenantId: "other-tenant" })).rejects.toMatchObject({ status: 409 });
    expect(mocks.scope).not.toHaveBeenCalled(); expect(mocks.thread).not.toHaveBeenCalled(); expect(mocks.identity).not.toHaveBeenCalled();
  });
  it("builds a pure built-in pin without the execution resolver or a custom-store lookup", async () => {
    mocks.isBuiltIn.mockReturnValue(true);
    await resolveResponsibilityPins(context, owner, record);
    expect(mocks.builtIn).toHaveBeenCalledExactlyOnceWith({ tenantId: owner.tenantId, controllerActorId: owner.actorId, agentId: "atlas" });
    expect(mocks.identity).not.toHaveBeenCalled();
  });
});
