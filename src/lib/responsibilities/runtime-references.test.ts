import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db/sql-types";
import { AgentIdentityResolutionError } from "@/lib/agents/identity-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { observationRecord, sourceReadFixture } from "./observation-test-fixtures";
import { runtimeConfiguration, runtimeNow, runtimeOwner, runtimeSource } from "./runtime-test-fixtures";
const mocks = vi.hoisted(() => ({ identity: vi.fn(), procedures: vi.fn(), snapshot: vi.fn(), read: vi.fn(), pin: vi.fn(), tool: vi.fn() }));
vi.mock("@/lib/agents/identity-store", () => ({ resolveCustomAgentIdentityWithSql: mocks.identity }));
vi.mock("@/lib/agents/identity-contracts", async (original) => ({ ...await original<typeof import("@/lib/agents/identity-contracts")>(), buildAgentRunIdentityPinV1: mocks.pin }));
vi.mock("./procedure-reference", () => ({ readOwnedResponsibilityProcedures: mocks.procedures }));
vi.mock("@/lib/workflows/saved-procedures", () => ({ buildWorkflowProcedureSnapshot: mocks.snapshot }));
vi.mock("@/lib/workflows/triggers", () => ({ nextWorkflowScheduleOccurrence: () => undefined }));
vi.mock("./observation-references", () => ({ responsibilityObservationReader: () => mocks.read }));
vi.mock("@/lib/workspaces/contracts", () => ({ parseCanonicalWorkItemV1: (value: unknown) => value }));
vi.mock("@/lib/tools/registry", () => ({ getGovernedTool: mocks.tool, getGovernedTools: () => [] }));
import { assertCurrentRuntimePrincipal, resolveResponsibilityPilot, resolveRuntimeOwnerContext } from "./runtime-references";
const work = { ...runtimeConfiguration.pins.work, tenantId: runtimeOwner.tenantId, ownerActorIds: [runtimeOwner.actorId] };
const tool = { id: "app.meetings.show", status: "active", riskLevel: 0, approvalRequired: false };
const principal = { ...runtimeOwner, controllerActorId: runtimeOwner.actorId, state: "active" as const, expiresAt: null, authorityMode: "explicit_grants", toolGrantIds: [tool.id] };
function fixture(options: { principalRows?: number; releaseRows?: number; email?: string } = {}) {
  const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray) => {
    const query = parts.join("?");
    if (query.includes("omni_auth_users")) return [{ id: runtimeOwner.actorId.slice(6), email: options.email ?? "current@example.test", role: "operator", name: "Fixture" }];
    if (query.includes("omni_tenant_workspace_memberships")) return [{ workspace_id: runtimeSource.workspaceId }];
    if (query.includes("omni_work_items")) return [{ projection: work, projection_sha256: canonicalJsonSha256(work) }];
    if (query.includes("omni_tenant_execution_principals")) return Array.from({ length: options.principalRows ?? 1 }, () => ({ principal_id: "principal-custom" }));
    if (query.includes("omni_agent_release_channels")) return Array.from({ length: options.releaseRows ?? 1 }, () => ({ agent_definition_id: "custom-agent" }));
    throw new Error("Unexpected fixture read");
  }), { transactionScoped: true }) as unknown as SqlClient;
  const record = { ...observationRecord, draft: { ...observationRecord.draft, sources: [runtimeSource], agentId: "custom-agent" },
    review: { ...observationRecord.review!, pins: { ...runtimeConfiguration.pins,
      sources: [{ source: runtimeSource, revisionSha256: "b".repeat(64) }], work: { ...runtimeConfiguration.pins.work, projectionSha256: canonicalJsonSha256(work) },
      procedure: { ...runtimeConfiguration.pins.procedure, toolBindingsSha256: canonicalJsonSha256([{ id: tool.id, inputSha256: canonicalJsonSha256(runtimeConfiguration.tool.input), contractSha256: canonicalJsonSha256(tool) }]) } } } };
  return { sql, record };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ ...sourceReadFixture(), source: runtimeSource });
  mocks.procedures.mockResolvedValue([{ id: observationRecord.draft.procedureId, aliases: ["Observe meeting"] }]);
  mocks.snapshot.mockReturnValue({ ...runtimeConfiguration.pins.procedure, toolBindings: [{ toolId: tool.id, input: runtimeConfiguration.tool.input }] });
  mocks.tool.mockReturnValue(tool); mocks.identity.mockResolvedValue({ principal });
  mocks.pin.mockReturnValue({ pinSha256: runtimeConfiguration.pins.agent.identityPinSha256, policyPins: [] });
});
describe("Responsibility current runtime authority", () => {
  it("re-resolves the immutable canonical owner to the current live request email", async () => {
    const f = fixture({ email: "renamed@example.test" });
    expect(await resolveRuntimeOwnerContext(f.sql, runtimeOwner)).toMatchObject({ actorId: "renamed@example.test", auth: { userId: runtimeOwner.actorId.slice(6), email: "renamed@example.test" } });
    await expect(resolveRuntimeOwnerContext(f.sql, { ...runtimeOwner, actorId: "untrusted-alias@example.test" })).rejects.toMatchObject({ code: "responsibility_owner_revoked" });
  });
  it.each([{ principalRows: 0 }, { releaseRows: 0 }, { principalRows: 2 }])("turns a revoked/missing/ambiguous locked Agent into a typed authority stop", async (options) => {
    const f = fixture(options);
    await expect(resolveResponsibilityPilot(f.sql, runtimeOwner, f.record, runtimeNow, false)).rejects.toMatchObject({ code: "responsibility_authority_changed" });
    expect(mocks.identity).not.toHaveBeenCalled();
  });
  it("maps only known identity revocation, leaving SQL infrastructure failure uncommittable", async () => {
    const f = fixture();
    mocks.identity.mockRejectedValueOnce(new AgentIdentityResolutionError());
    await expect(resolveResponsibilityPilot(f.sql, runtimeOwner, f.record, runtimeNow, false)).rejects.toMatchObject({ code: "responsibility_authority_changed" });
    const sqlFailure = new Error("connection lost"); mocks.identity.mockRejectedValueOnce(sqlFailure);
    await expect(resolveResponsibilityPilot(f.sql, runtimeOwner, f.record, runtimeNow, false)).rejects.toBe(sqlFailure);
  });
  it("refuses unchanged expired, foreign or revoked principal pins against the current database instant", () => {
    expect(() => assertCurrentRuntimePrincipal(principal, runtimeOwner, runtimeNow)).not.toThrow();
    for (const patch of [{ expiresAt: runtimeNow }, { expiresAt: "2026-10-03T23:59:59.000Z" }, { state: "revoked" as const }, { tenantId: "foreign" }, { controllerActorId: "unrelated" }]) {
      expect(() => assertCurrentRuntimePrincipal({ ...principal, ...patch }, runtimeOwner, runtimeNow)).toThrowError(expect.objectContaining({ code: "responsibility_authority_changed" }));
    }
  });
});
