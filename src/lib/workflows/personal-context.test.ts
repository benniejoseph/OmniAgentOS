import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActivePersonalContextConsent: vi.fn(),
}));

vi.mock("@/lib/memory/personal-context-consent-store", () => ({
  requireActivePersonalContextConsent:
    mocks.requireActivePersonalContextConsent,
}));

import { personalContextMemoryAccessFromSecurityContext } from "@/lib/memory/personal-context-access";
import { buildPersonalContextConsentAuthorityV1 } from "@/lib/memory/personal-context-consent";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import {
  createWorkflowPersonalContextBinding,
  parseWorkflowPersonalContextBinding,
  resolveWorkflowPersonalContextAccess,
  workflowPersonalPlanContextBoundary,
} from "@/lib/workflows/personal-context";

const authUserId = "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6";
const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId: authUserId,
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
} satisfies SecurityContext;

beforeEach(() => {
  mocks.requireActivePersonalContextConsent.mockReset();
});

describe("workflow personal context", () => {
  it("binds and revalidates exact standing consent", async () => {
    const authority = buildPersonalContextConsentAuthorityV1({
      tenantId: context.tenantId,
      actorId: `actor:${authUserId}`,
      consentGeneration: 1,
      activatedAt: "2026-09-08T00:00:00.000Z",
    });
    const access = personalContextMemoryAccessFromSecurityContext(context, {
      correlationId: "workflow-personal-a",
      consentAuthority: authority,
    });
    expect(access).toBeDefined();
    const workflowExecutionScope = createExecutionScope({
      tenantId: context.tenantId,
      initiatingActorId: context.actorId,
      executingPrincipalType: "user",
      executingPrincipalId: context.actorId,
      correlationId: "workflow-personal-a",
      purpose: "workflow.run",
    });
    const binding = createWorkflowPersonalContextBinding({
      access: access!,
      workflowExecutionScope,
    });
    mocks.requireActivePersonalContextConsent.mockResolvedValue(authority);

    await expect(resolveWorkflowPersonalContextAccess({
      binding,
      workflowExecutionScope,
    })).resolves.toMatchObject({
      databaseAccessScope: access!.databaseAccessScope,
      contextBoundary: workflowPersonalPlanContextBoundary(access!),
    });
    expect(mocks.requireActivePersonalContextConsent).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorBinding: access!.actorBinding,
      expectedAuthoritySha256: authority.authoritySha256,
    });
    expect(parseWorkflowPersonalContextBinding(binding)).toEqual(binding);
  });

  it("rejects tampered bindings before consent lookup", async () => {
    const authority = buildPersonalContextConsentAuthorityV1({
      tenantId: context.tenantId,
      actorId: `actor:${authUserId}`,
      consentGeneration: 1,
      activatedAt: "2026-09-08T00:00:00.000Z",
    });
    const access = personalContextMemoryAccessFromSecurityContext(context, {
      correlationId: "workflow-personal-b",
      consentAuthority: authority,
    })!;
    const workflowExecutionScope = createExecutionScope({
      tenantId: context.tenantId,
      initiatingActorId: context.actorId,
      executingPrincipalType: "user",
      executingPrincipalId: context.actorId,
      correlationId: "workflow-personal-b",
      purpose: "workflow.run",
    });
    const binding = createWorkflowPersonalContextBinding({
      access,
      workflowExecutionScope,
    });

    await expect(resolveWorkflowPersonalContextAccess({
      binding: { ...binding, workflowExecutionScopeSha256: "f".repeat(64) },
      workflowExecutionScope,
    })).rejects.toThrow(/digest/i);
    expect(mocks.requireActivePersonalContextConsent).not.toHaveBeenCalled();
  });
});
