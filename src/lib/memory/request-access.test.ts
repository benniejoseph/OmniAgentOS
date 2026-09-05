import { describe, expect, it } from "vitest";

import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import type { SecurityContext } from "@/lib/security/types";

const sessionContext = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
} satisfies SecurityContext;

describe("request memory access", () => {
  it("uses the canonical auth actor for an exact private-memory scope", () => {
    const access = requestMemoryAccessFromSecurityContext(sessionContext, {
      purposeId: MEMORY_PURPOSE_IDS.read,
      auditPurpose: "api.memory.read",
      correlationId: "memory_read_test",
    });

    expect(access).toMatchObject({
      actorBinding: {
        canonicalActorId:
          "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
      },
      executionScope: {
        initiatingActorId:
          "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
        workspaceId: null,
      },
      databaseAccessScope: {
        purposeId: MEMORY_PURPOSE_IDS.read,
        executingPrincipalType: "user",
      },
    });
    expect(Object.isFrozen(access)).toBe(true);
  });

  it("keeps non-session compatibility contexts unbound", () => {
    expect(requestMemoryAccessFromSecurityContext({
      ...sessionContext,
      source: "headers",
      auth: undefined,
    }, {
      purposeId: MEMORY_PURPOSE_IDS.read,
      auditPurpose: "api.memory.read",
      correlationId: "memory_read_test",
    })).toBeUndefined();
  });
});
