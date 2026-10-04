import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), submit: vi.fn() }));
vi.mock("@/lib/memory/personal-context-consent-store", () => ({ readPersonalContextConsentNative: mocks.read, submitPersonalContextConsentNative: mocks.submit }));
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "./contracts";
import { decidePersonalContextConsentService, inspectPersonalContextConsentService } from "./personal-context-consent";
import { MAIN_AGENT_APP_SERVICE_BINDINGS } from "./registry";
import { buildPersonalContextConsentAuthorityV1, personalContextConsentNotice } from "@/lib/memory/personal-context-consent";
import { personalContextConsentNativeAcceptanceId } from "@/lib/memory/personal-context-consent-native-contracts";
import { nativePersonalContextConsentDecisionReadResponseSchema, nativePersonalContextConsentDecisionResponseSchema, nativePersonalContextConsentResponseSchema } from "@/lib/mobile/personal-context-consent-contracts";
import type { SecurityContext } from "@/lib/security/types";
import type { ExecutionScope } from "@/lib/security/execution-scope";
const context: SecurityContext = { tenantId: "tenant-consent", actorId: "owner@example.test", role: "admin", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", sessionId: "session:test", tenantName: "Private" } };
const owner = `actor:${context.auth!.userId}`, key = "consent-key-one";
const keySha = createHash("sha256").update(key).digest("hex");
const current = { contract: "asael-personal-context-consent-read:1" as const, tenantId: context.tenantId, ownerActorId: owner,
  state: "inactive" as const, consentGeneration: 0, lifecycleRevision: 0, notice: personalContextConsentNotice(), authority: null, decisionToken: "a".repeat(64) };
const request = { contract: "asael-personal-context-consent-decision:1", action: "revoke", noticeSha256: current.notice.sha256,
  expectedState: current.state, expectedConsentGeneration: 0, expectedLifecycleRevision: 0, expectedDecisionToken: current.decisionToken };
const acceptance = { contract: "asael-personal-context-consent-acceptance:1", id: personalContextConsentNativeAcceptanceId(context.tenantId, owner, keySha),
  tenantId: context.tenantId, ownerActorId: owner, action: "revoke", idempotencyKeySha256: keySha, requestSha256: "b".repeat(64),
  noticeSha256: current.notice.sha256, expectedDecisionToken: current.decisionToken,
  before: { state: "inactive", consentGeneration: 0, lifecycleRevision: 0 }, after: { state: "inactive", consentGeneration: 0, lifecycleRevision: 0 },
  acceptedAt: "2026-10-04T03:00:00.000Z", changed: false };
function mutationCaller(role: SecurityContext["role"] = "admin") {
  return createRequestMutationAppServiceCaller(new Request("http://localhost/api/memory/personal-context-consent", { method: "PATCH", headers: { "Idempotency-Key": key } }),
    { ...context, role }, { purpose: "api.memory.personal-context-consent.native.decide", causationId: owner });
}
beforeEach(() => { mocks.read.mockReset(); mocks.submit.mockReset(); mocks.read.mockResolvedValue({ current, acceptance: null }); mocks.submit.mockResolvedValue({ current, acceptance, newlyApplied: true }); });
describe("personal recall application service", () => {
  it("uses canonical private read authority and withholds a viewer decision token", async () => {
    const result = await inspectPersonalContextConsentService(createAppServiceCaller({ context: { ...context, role: "viewer" } }));
    expect(result.data.current.decisionToken).toBeNull();
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ tenantId: context.tenantId, ownerActorId: owner,
      executionScope: expect.objectContaining({ initiatingActorId: owner, purpose: "memory.personal_context_consent.read", contextGrantIds: [], capabilityGrantIds: [] }) }), { acceptanceKeySha256: undefined });
    expect(nativePersonalContextConsentResponseSchema.safeParse({ ...result.data, serviceReceipt: result.receipt }).success).toBe(true);
  });
  it("recovers historical acceptance while returning current state without a write", async () => {
    mocks.read.mockResolvedValue({ current: { ...current, consentGeneration: 2, lifecycleRevision: 2 }, acceptance });
    const result = await inspectPersonalContextConsentService(createAppServiceCaller({ context }), keySha);
    expect(result.data.current.consentGeneration).toBe(2); expect(result.data.acceptance).toEqual(acceptance);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(nativePersonalContextConsentDecisionReadResponseSchema.safeParse({ ...result.data, serviceReceipt: result.receipt }).success).toBe(true);
  });
  it("binds exact decision, stable key and canonical management scope to acceptance", async () => {
    const result = await decidePersonalContextConsentService(mutationCaller(), request);
    expect(mocks.submit).toHaveBeenCalledWith({ authority: expect.objectContaining({ ownerActorId: owner,
      executionScope: expect.objectContaining({ purpose: "memory.personal_context_consent.manage", initiatingActorId: owner }) }), idempotencyKey: key, request });
    expect(result.data.replayed).toBe(false);
    expect(result.receipt.idempotencyKeySha256).not.toBe(keySha);
    expect(nativePersonalContextConsentDecisionResponseSchema.safeParse({ ...result.data, serviceReceipt: result.receipt }).success).toBe(true);
    mocks.submit.mockResolvedValue({ current, acceptance, newlyApplied: false });
    expect((await decidePersonalContextConsentService(mutationCaller(), request)).data.replayed).toBe(true);
  });
  it("rejects missing canonical identity and insufficient current role before store entry", async () => {
    await expect(inspectPersonalContextConsentService(createAppServiceCaller({ context: { ...context, source: "service" } }))).rejects.toMatchObject({ status: 403 });
    await expect(decidePersonalContextConsentService(mutationCaller("viewer"), request)).rejects.toThrow();
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("rejects delegated, granted, shared or differently purposed scopes before canonical adaptation", async () => {
    const caller = mutationCaller();
    const changes: Partial<ExecutionScope>[] = [
      { executingPrincipalType: "agent", executingPrincipalId: "agent:other" },
      { executingPrincipalType: "system", executingPrincipalId: "system:other" },
      { executingPrincipalId: "another-user" }, { delegationId: "delegation:one" },
      { workspaceId: "workspace:shared" }, { projectId: "project:one" }, { missionId: "mission:one" },
      { contextGrantIds: ["grant:context"] }, { capabilityGrantIds: ["grant:capability"] },
      { purpose: "memory.personal_context_consent.read" }, { causationId: "actor:another" },
    ];
    for (const change of changes) {
      await expect(decidePersonalContextConsentService(createAppServiceCaller({ context, idempotencyKey: key,
        executionScope: { ...caller.executionScope!, ...change } }), request)).rejects.toMatchObject({ status: 403 });
    }
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("rejects a current state older than the accepted generation or lifecycle", async () => {
    const after = { state: "inactive", consentGeneration: 1, lifecycleRevision: 2 };
    const historical = { ...acceptance, before: { state: "active", consentGeneration: 1, lifecycleRevision: 1 }, after, changed: true };
    mocks.read.mockResolvedValue({ current, acceptance: historical });
    const result = await inspectPersonalContextConsentService(createAppServiceCaller({ context }), keySha);
    expect(nativePersonalContextConsentDecisionReadResponseSchema.safeParse({ ...result.data, serviceReceipt: result.receipt }).success).toBe(false);
    mocks.read.mockResolvedValue({ current: { ...current, state: "active", consentGeneration: 1, lifecycleRevision: 1,
      authority: buildPersonalContextConsentAuthorityV1({ tenantId: context.tenantId, actorId: owner, consentGeneration: 1, activatedAt: acceptance.acceptedAt }) }, acceptance: historical });
    const earlierLifecycle = await inspectPersonalContextConsentService(createAppServiceCaller({ context }), keySha);
    expect(nativePersonalContextConsentDecisionReadResponseSchema.safeParse({ ...earlierLifecycle.data, serviceReceipt: earlierLifecycle.receipt }).success).toBe(false);
    // A later inactive generation is valid recovery evidence for that decision.
    mocks.read.mockResolvedValue({ current: { ...current, consentGeneration: 2, lifecycleRevision: 2 }, acceptance: historical });
    const later = await inspectPersonalContextConsentService(createAppServiceCaller({ context }), keySha);
    expect(nativePersonalContextConsentDecisionReadResponseSchema.safeParse({ ...later.data, serviceReceipt: later.receipt }).success).toBe(true);
  });
  it("requires a fresh decision response to match its after state while allowing a later replay observation", async () => {
    const later = { ...current, consentGeneration: 2, lifecycleRevision: 2 };
    mocks.submit.mockResolvedValue({ current: later, acceptance, newlyApplied: true });
    const fresh = await decidePersonalContextConsentService(mutationCaller(), request);
    expect(nativePersonalContextConsentDecisionResponseSchema.safeParse({ ...fresh.data, serviceReceipt: fresh.receipt }).success).toBe(false);
    mocks.submit.mockResolvedValue({ current: later, acceptance, newlyApplied: false });
    const replay = await decidePersonalContextConsentService(mutationCaller(), request);
    expect(nativePersonalContextConsentDecisionResponseSchema.safeParse({ ...replay.data, serviceReceipt: replay.receipt }).success).toBe(true);
  });
  it("rejects cross-owner or altered response receipts and grants no agent tool", async () => {
    const result = await inspectPersonalContextConsentService(createAppServiceCaller({ context }));
    expect(nativePersonalContextConsentResponseSchema.safeParse({ ...result.data, current: { ...result.data.current, ownerActorId: "actor:22222222-2222-4222-8222-222222222222" }, serviceReceipt: result.receipt }).success).toBe(false);
    expect(MAIN_AGENT_APP_SERVICE_BINDINGS.some(({ operation }) => operation.startsWith("memory.personal-context-consent."))).toBe(false);
  });
});
