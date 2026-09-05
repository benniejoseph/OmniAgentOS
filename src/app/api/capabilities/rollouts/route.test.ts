import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  forbiddenResponse: vi.fn(),
  getCurrent: vi.fn(),
  register: vi.fn(),
  transition: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: mocks.forbiddenResponse,
}));

vi.mock("@/lib/rollouts/tenant-capability-rollouts", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/lib/rollouts/tenant-capability-rollouts")
  >();
  return {
    ...original,
    getCurrentTenantCapabilityRollout: mocks.getCurrent,
    registerTenantCapabilityRollout: mocks.register,
    transitionTenantCapabilityRolloutStatus: mocks.transition,
  };
});

import { GET, POST } from "@/app/api/capabilities/rollouts/route";

const securityContext = {
  tenantId: "tenant-alpha",
  actorId: "system-release-controller",
  role: "system" as const,
  source: "headers" as const,
};

const rollout = {
  schemaVersion: 1,
  tenantId: "tenant-alpha",
  capabilityId: "run-contracts-v1",
  rolloutGeneration: 1,
  engineVersion: "agent-loop-v1",
  contractVersionId: "run-contract-envelope-v1",
  configurationSha256: "a".repeat(64),
  mode: "shadow",
  status: "registered",
  lifecycleRevision: 0,
  createdByActorId: "system-release-controller",
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(securityContext);
  mocks.forbiddenResponse.mockReturnValue(
    Response.json({ error: "Forbidden" }, { status: 403 }),
  );
  mocks.getCurrent.mockResolvedValue(rollout);
  mocks.register.mockResolvedValue(rollout);
  mocks.transition.mockResolvedValue({
    ...rollout,
    status: "active",
    lifecycleRevision: 1,
  });
});

describe("tenant capability rollout route", () => {
  it("reads only the authenticated tenant's current generation", async () => {
    const response = await GET(
      new Request(
        "https://example.test/api/capabilities/rollouts?capabilityId=run-contracts-v1",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({ rollout });
    expect(mocks.getCurrent).toHaveBeenCalledWith({
      tenantId: "tenant-alpha",
      capabilityId: "run-contracts-v1",
    });
  });

  it("registers a scoped immutable generation through system authority", async () => {
    const response = await POST(jsonRequest({
      action: "register",
      capabilityId: "run-contracts-v1",
      rolloutGeneration: 1,
      engineVersion: "agent-loop-v1",
      contractVersionId: "run-contract-envelope-v1",
      configurationSha256: "a".repeat(64),
      mode: "shadow",
    }));

    expect(response.status).toBe(201);
    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-alpha",
      capabilityId: "run-contracts-v1",
      rolloutGeneration: 1,
      executionScope: expect.objectContaining({
        tenantId: "tenant-alpha",
        initiatingActorId: "system-release-controller",
        executingPrincipalType: "system",
        executingPrincipalId: "system-release-controller",
        correlationId: "request-rollout-test",
        purpose: "capability.rollout.register",
      }),
    }));
  });

  it("compare-and-swaps lifecycle transitions", async () => {
    const response = await POST(jsonRequest({
      action: "transition",
      capabilityId: "run-contracts-v1",
      expectedRolloutGeneration: 1,
      expectedStatus: "registered",
      nextStatus: "active",
    }));

    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-alpha",
      capabilityId: "run-contracts-v1",
      expectedRolloutGeneration: 1,
      expectedStatus: "registered",
      nextStatus: "active",
      executionScope: expect.objectContaining({
        purpose: "capability.rollout.transition",
      }),
    }));
  });

  it("rejects malformed requests before authorization", async () => {
    const response = await POST(jsonRequest({
      action: "transition",
      capabilityId: "run-contracts-v1",
      expectedRolloutGeneration: 0,
      expectedStatus: "registered",
      nextStatus: "active",
    }));

    expect(response.status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("does not expose rollout error messages", async () => {
    const { TenantCapabilityRolloutError } = await import(
      "@/lib/rollouts/tenant-capability-rollouts"
    );
    mocks.transition.mockRejectedValue(
      new TenantCapabilityRolloutError("status_conflict", "private detail"),
    );
    const response = await POST(jsonRequest({
      action: "transition",
      capabilityId: "run-contracts-v1",
      expectedRolloutGeneration: 1,
      expectedStatus: "registered",
      nextStatus: "active",
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Capability rollout operation failed",
      code: "status_conflict",
    });
  });
});

function jsonRequest(body: unknown) {
  return new Request("https://example.test/api/capabilities/rollouts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-rollout-test",
    },
    body: JSON.stringify(body),
  });
}
