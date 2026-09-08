import { beforeEach, describe, expect, it, vi } from "vitest";

const consentMocks = vi.hoisted(() => ({
  requireActivePersonalContextConsent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/memory/personal-context-consent-store", () => ({
  requireActivePersonalContextConsent:
    consentMocks.requireActivePersonalContextConsent,
}));

import {
  personalContextMemoryAccessFromSecurityContext,
  resolvePersonalContextMemoryAccess,
} from "@/lib/memory/personal-context-access";
import { buildPersonalContextConsentAuthorityV1 } from "@/lib/memory/personal-context-consent";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const userId = "11111111-1111-4111-8111-111111111111";
const context: SecurityContext = {
  tenantId: "tenant:test",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId,
    email: "owner@example.test",
    sessionId: "session:test",
    tenantName: "Test",
  },
};
const authority = buildPersonalContextConsentAuthorityV1({
  tenantId: context.tenantId,
  actorId: `actor:${userId}`,
  consentGeneration: 1,
  activatedAt: "2026-09-08T01:00:00.000Z",
});
const agentScope = createExecutionScope({
  tenantId: context.tenantId,
  initiatingActorId: context.actorId,
  executingPrincipalType: "agent",
  executingPrincipalId: "agent:atlas",
  correlationId: "request:test",
  purpose: "agent.run",
});

describe("personal context access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a user-principal retrieval scope and rechecks active consent", async () => {
    const access = personalContextMemoryAccessFromSecurityContext(context, {
      correlationId: "request:test",
      consentAuthority: authority,
    });

    await expect(resolvePersonalContextMemoryAccess(access, {
      agentExecutionScope: agentScope,
      memoryMode: "all",
    })).resolves.toMatchObject({
      tenantId: "tenant:test",
      initiatingActorId: `actor:${userId}`,
      executingPrincipalType: "user",
      purposeId: "memory.retrieve.v1",
    });
    expect(consentMocks.requireActivePersonalContextConsent).toHaveBeenCalledWith({
      tenantId: "tenant:test",
      actorBinding: access?.actorBinding,
      expectedAuthoritySha256: authority.authoritySha256,
    });
  });

  it("rejects correlation drift before consulting consent", async () => {
    const access = personalContextMemoryAccessFromSecurityContext(context, {
      correlationId: "request:other",
      consentAuthority: authority,
    });

    await expect(resolvePersonalContextMemoryAccess(access, {
      agentExecutionScope: agentScope,
      memoryMode: "all",
    })).rejects.toThrow("Automatic personal-memory prompt access is invalid");
    expect(consentMocks.requireActivePersonalContextConsent).not.toHaveBeenCalled();
  });

  it("rejects authority digest tampering", async () => {
    const access = personalContextMemoryAccessFromSecurityContext(context, {
      correlationId: "request:test",
      consentAuthority: authority,
    });

    await expect(resolvePersonalContextMemoryAccess({
      ...access!,
      consentAuthority: {
        ...authority,
        authoritySha256: "0".repeat(64),
      },
    }, {
      agentExecutionScope: agentScope,
      memoryMode: "all",
    })).rejects.toThrow("Automatic personal-memory prompt access is invalid");
  });
});
