import { describe, expect, it } from "vitest";
import {
  canonicalAuthUserActorFromSecurityContext,
  CANONICAL_AUTH_USER_ACTOR_VERSION,
} from "@/lib/security/canonical-actor";
import type { SecurityContext } from "@/lib/security/types";

const userId = "00000000-0000-4000-8000-000000000001";
const sessionContext: SecurityContext = {
  tenantId: "tenant:one",
  actorId: "person+memory@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId,
    email: "person+memory@example.test",
    sessionId: "session:one",
    tenantName: "Tenant one",
  },
};

describe("canonicalAuthUserActorFromSecurityContext", () => {
  it("returns the frozen canonical v46 identity for an exact session binding", () => {
    const actor = canonicalAuthUserActorFromSecurityContext(sessionContext);

    expect(actor).toEqual({
      version: CANONICAL_AUTH_USER_ACTOR_VERSION,
      kind: "auth_user",
      authUserId: userId,
      actorId: `actor:${userId}`,
    });
    expect(Object.isFrozen(actor)).toBe(true);
  });

  it.each(["headers", "default", "service"] as const)(
    "does not bind a %s context",
    (source) => {
      expect(canonicalAuthUserActorFromSecurityContext({
        ...sessionContext,
        source,
      })).toBeUndefined();
    },
  );

  it("does not bind a session without authenticated metadata", () => {
    expect(canonicalAuthUserActorFromSecurityContext({
      ...sessionContext,
      auth: undefined,
    })).toBeUndefined();
  });

  it("does not bind a mismatched legacy actor and authenticated email", () => {
    expect(canonicalAuthUserActorFromSecurityContext({
      ...sessionContext,
      actorId: "someone-else@example.test",
    })).toBeUndefined();
  });

  it.each([
    "00000000-0000-4000-8000-00000000000A",
    " 00000000-0000-4000-8000-000000000001",
    "legacy-user",
    "",
  ])("does not normalize or infer the auth user ID %j", (authUserId) => {
    expect(canonicalAuthUserActorFromSecurityContext({
      ...sessionContext,
      auth: {
        ...sessionContext.auth!,
        userId: authUserId,
      },
    })).toBeUndefined();
  });
});
