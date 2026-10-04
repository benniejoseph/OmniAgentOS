import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPANION_PREFERENCES } from "@/lib/companion/model";
import { UNAVAILABLE_COMPANION_LANGUAGE_STYLE } from "@/lib/companion/language-style";
import { resolveDirectConversationLanguageStyle } from "@/lib/companion/language-style-resolver";
import { ownerConflict, type StoredCompanion } from "@/lib/companion/state";
import type { CompanionStore } from "@/lib/companion/store";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

vi.mock("@/lib/security/context", () => ({
  canPerform: (role: string, action: string) =>
    ["viewer", "operator", "admin", "system"].includes(role) && action === "read",
}));

const context: SecurityContext = {
  tenantId: "tenant-a", actorId: "owner@example.test", role: "operator", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", sessionId: "session-a", tenantName: "Tenant A" },
};
const canonicalActorId = `actor:${context.auth!.userId}`;
const now = "2026-10-04T10:00:00.000Z";
function directRequest() {
  return {
    runId: "run-direct", tenantId: context.tenantId, actorId: context.actorId, role: context.role,
    securityContext: context,
    executionScope: executionScopeFromSecurityContext(context, {
      executingPrincipalType: "agent", executingPrincipalId: "different-agent-owner-principal",
      correlationId: "run-direct", purpose: "agent.run",
    }),
  };
}
function current(): StoredCompanion {
  return {
    schemaVersion: 1, tenantId: context.tenantId, actorId: canonicalActorId, revision: 3,
    preferences: { ...DEFAULT_COMPANION_PREFERENCES, intensity: "expressive", visible: false, motion: "off" },
    createdAt: now, updatedAt: now,
  };
}
function dependencies() {
  return { read: vi.fn<CompanionStore["read"]>().mockResolvedValue(current()) };
}

describe("direct conversation Companion preference resolution", () => {
  it.each(["session", "mobile"] as const)("reads only the exact initiating %s owner once", async (source) => {
    const deps = dependencies();
    const request = directRequest();
    request.securityContext = { ...context, source };
    const selected = await resolveDirectConversationLanguageStyle(request, deps);
    expect(deps.read).toHaveBeenCalledExactlyOnceWith({
      tenantId: context.tenantId, actorId: context.actorId,
      requestActorBinding: expect.objectContaining({ canonicalActorId, legacyOwnerActorIds: [context.actorId] }),
    });
    expect(selected).toEqual({ version: "companion-language:1", source: "saved", intensity: "expressive", preferenceRevision: 3 });
    expect(Object.isFrozen(selected)).toBe(true);
    expect(JSON.stringify(selected)).not.toContain("owner");
    expect(JSON.stringify(selected)).not.toContain("motion");
  });

  it("accepts the exact legacy owner and defaults only after a confirmed absent read", async () => {
    const deps = dependencies();
    deps.read.mockResolvedValueOnce({ ...current(), actorId: context.actorId }).mockResolvedValueOnce(undefined);
    expect(await resolveDirectConversationLanguageStyle(directRequest(), deps)).toMatchObject({ source: "saved", intensity: "expressive" });
    expect(await resolveDirectConversationLanguageStyle(directRequest(), deps)).toEqual({
      version: "companion-language:1", source: "default", intensity: "balanced", preferenceRevision: 0,
    });
  });

  it("uses neutral uncertainty for errors, owner conflicts or invalid/cross-owner records", async () => {
    const deps = dependencies();
    deps.read.mockRejectedValueOnce(new Error("PRIVATE_DATABASE_ERROR"));
    expect(await resolveDirectConversationLanguageStyle(directRequest(), deps)).toEqual(UNAVAILABLE_COMPANION_LANGUAGE_STYLE);
    deps.read.mockRejectedValueOnce(ownerConflict());
    expect(await resolveDirectConversationLanguageStyle(directRequest(), deps)).toEqual(UNAVAILABLE_COMPANION_LANGUAGE_STYLE);
    for (const record of [
      { ...current(), tenantId: "other-tenant" },
      { ...current(), actorId: "different-agent-owner-principal" },
      { ...current(), actorId: "other@example.test" },
      { ...current(), revision: -1 },
    ]) {
      deps.read.mockResolvedValueOnce(record);
      expect(await resolveDirectConversationLanguageStyle(directRequest(), deps)).toEqual(UNAVAILABLE_COMPANION_LANGUAGE_STYLE);
    }
  });

  it("bounds a slow read and does not turn timeout into a Balanced default", async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      deps.read.mockImplementation(() => new Promise(() => {}));
      const selected = resolveDirectConversationLanguageStyle(directRequest(), deps);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await selected).toEqual(UNAVAILABLE_COMPANION_LANGUAGE_STYLE);
      expect(deps.read).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not read for untrusted, mismatched, delegated, preclaimed, durable or canary requests", async () => {
    const base = directRequest();
    const requests: Parameters<typeof resolveDirectConversationLanguageStyle>[0][] = [
      { ...base, securityContext: undefined },
      ...(["headers", "default", "service"] as const).map((source) => ({ ...base, securityContext: { ...context, source } })),
      { ...base, securityContext: { ...context, auth: undefined } },
      { ...base, securityContext: { ...context, auth: { ...context.auth!, email: "other@example.test" } } },
      { ...base, actorId: "other@example.test" },
      { ...base, tenantId: "other-tenant" },
      { ...base, role: "viewer" },
      { ...base, runId: undefined },
      { ...base, preclaimedRunId: "run-direct" },
      { ...base, executionScope: undefined },
      { ...base, executionScope: { ...base.executionScope, correlationId: "other-run" } },
      { ...base, executionScope: { ...base.executionScope, initiatingActorId: "other@example.test" } },
      { ...base, executionScope: { ...base.executionScope, tenantId: "other-tenant" } },
      { ...base, executionScope: { ...base.executionScope, delegationId: "delegation-a" } },
      { ...base, executionScope: { ...base.executionScope, executingPrincipalType: "system" } },
      ...["agent.run.legacy", "workflow.execute", "agent.loop.v2.model_text_canary"].map((purpose) => ({
        ...base, executionScope: { ...base.executionScope, purpose },
      })),
    ];
    const deps = dependencies();
    for (const request of requests) expect(await resolveDirectConversationLanguageStyle(request, deps)).toBeUndefined();
    expect(deps.read).not.toHaveBeenCalled();
  });
});
