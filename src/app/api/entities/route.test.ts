import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  readEntityRegistry: vi.fn(),
  reviewEntityMerge: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/entities/store", () => ({
  readEntityRegistry: routeMocks.readEntityRegistry,
  reviewEntityMerge: routeMocks.reviewEntityMerge,
}));

import { GET, POST } from "@/app/api/entities/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};

const entity = {
  entityId: "entity-a",
  entityTypeId: "person",
  canonicalLabel: "Ada Lovelace",
  state: "active",
  mergedIntoEntityId: null,
  lineage: [{ kind: "memory", referenceId: "memory-a" }],
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  accessBinding: { accessScopeSha256: "secret-scope-contract" },
  entitySha256: "secret-entity-contract",
};
const review = {
  reviewId: "review-a",
  resolutionId: "resolution-a",
  sourceEntityId: "entity-a",
  targetEntityId: "entity-b",
  decision: "approved",
  previousReviewId: null,
  reviewedAt: "2026-09-06T00:01:00.000Z",
  tenantId: "tenant-a",
  ownerActorId: "actor:private",
  accessScopeSha256: "secret-scope-contract",
  reviewerActorId: "actor:private",
  reviewSha256: "secret-review-contract",
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.readEntityRegistry.mockReset().mockResolvedValue({
    schemaVersion: 1,
    entities: [entity],
    aliases: [],
    resolutions: [],
    mergeReviews: [],
  });
  routeMocks.reviewEntityMerge.mockReset().mockResolvedValue(review);
});

describe("private entity registry API", () => {
  it("reads the canonical actor registry without exposing internal contracts", async () => {
    const response = await GET(new Request("http://localhost/api/entities"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.readEntityRegistry).toHaveBeenCalledWith({
      actorBinding: expect.objectContaining({
        canonicalActorId:
          "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
      }),
      accessBinding: expect.objectContaining({
        visibility: "user_private",
        sensitivity: "confidential",
      }),
      executionScope: expect.objectContaining({
        purpose: "entity.read.v1",
      }),
    });
    const payload = await response.json();
    expect(payload.entities).toEqual([expect.objectContaining({
      entityId: "entity-a",
      canonicalLabel: "Ada Lovelace",
      lineageCount: 1,
    })]);
    expect(JSON.stringify(payload)).not.toContain("secret-");
  });

  it("applies an exact reviewed merge with a canonical user scope", async () => {
    const response = await POST(jsonRequest({
      action: "review_merge",
      resolutionId: "resolution-a",
      sourceEntityId: "entity-a",
      targetEntityId: "entity-b",
      decision: "approved",
    }));

    expect(response.status).toBe(200);
    expect(routeMocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "write.memory",
      resourceType: "entity_registry",
    }));
    expect(routeMocks.reviewEntityMerge).toHaveBeenCalledWith({
      resolutionId: "resolution-a",
      sourceEntityId: "entity-a",
      targetEntityId: "entity-b",
      decision: "approved",
      previousReviewId: undefined,
      executionScope: expect.objectContaining({
        purpose: "entity.review.v1",
        initiatingActorId:
          "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
      }),
    });
    const payload = await response.json();
    expect(payload.review).toEqual(expect.objectContaining({ reviewId: "review-a" }));
    expect(JSON.stringify(payload)).not.toContain("secret-");
  });

  it("rejects malformed reversals before touching the registry", async () => {
    const response = await POST(jsonRequest({
      action: "review_merge",
      resolutionId: "resolution-a",
      sourceEntityId: "entity-a",
      targetEntityId: "entity-b",
      decision: "reversed",
    }));

    expect(response.status).toBe(400);
    expect(routeMocks.reviewEntityMerge).not.toHaveBeenCalled();
  });

  it("keeps non-canonical compatibility identities outside the registry", async () => {
    routeMocks.authorizeRequest.mockResolvedValueOnce({
      ...context,
      source: "headers",
      auth: undefined,
    });

    const response = await GET(new Request("http://localhost/api/entities"));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.readEntityRegistry).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/entities", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify(body),
  });
}
