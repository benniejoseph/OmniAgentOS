import { describe, expect, it } from "vitest";

import { requestEntityAccessFromSecurityContext } from "@/lib/entities/request-access";
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

describe("request entity access", () => {
  it("builds the stable canonical actor-private registry scope", () => {
    const access = requestEntityAccessFromSecurityContext(sessionContext, {
      purposeId: "entity.read.v1",
      correlationId: "entity_read_test",
    });

    expect(access).toMatchObject({
      actorBinding: {
        canonicalActorId:
          "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
      },
      accessBinding: {
        tenantId: "tenant-a",
        ownerActorId:
          "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
        visibility: "user_private",
        sensitivity: "confidential",
        workspaceId: null,
        projectId: null,
        missionId: null,
      },
      executionScope: {
        purpose: "entity.read.v1",
        executingPrincipalType: "user",
        workspaceId: null,
        projectId: null,
        missionId: null,
      },
    });
    expect(Object.isFrozen(access)).toBe(true);
  });

  it("keeps header compatibility contexts outside the private registry", () => {
    expect(requestEntityAccessFromSecurityContext({
      ...sessionContext,
      source: "headers",
      auth: undefined,
    }, {
      purposeId: "entity.review.v1",
      correlationId: "entity_review_test",
    })).toBeUndefined();
  });
});
