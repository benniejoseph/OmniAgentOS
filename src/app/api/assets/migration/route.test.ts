import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  forbiddenResponse: vi.fn(),
  getCurrent: vi.fn(),
  register: vi.fn(),
  transition: vi.fn(),
  getLatestMigration: vi.fn(),
  startMigration: vi.fn(),
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

vi.mock("@/lib/storage/object-migration", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/lib/storage/object-migration")
  >();
  return {
    ...original,
    getLatestAssetObjectMigration: mocks.getLatestMigration,
    startAssetObjectMigration: mocks.startMigration,
  };
});

import { POST } from "@/app/api/assets/migration/route";

const context = {
  tenantId: "tenant-alpha",
  actorId: "actor:11111111-1111-4111-8111-111111111111",
  role: "owner" as const,
  source: "session" as const,
};
const migration = {
  id: `asset_migration_${"a".repeat(48)}`,
  tenantId: context.tenantId,
  ownerActorId: context.actorId,
  generation: 1,
  status: "completed" as const,
  cursorKind: "capture_asset" as const,
  cursorId: "asset-a",
  totalCount: 8,
  readyCount: 8,
  pendingCount: 0,
  failedCount: 0,
  missingCount: 0,
  mismatchCount: 0,
  verificationSha256: "b".repeat(64),
  operationJobId: "job-a",
  executionScope: {},
  startedAt: "2026-09-06T00:00:00.000Z",
  completedAt: "2026-09-06T00:01:00.000Z",
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:01:00.000Z",
};
const shadow = {
  capabilityId: "asset-object-read-v1",
  rolloutGeneration: 1,
  mode: "shadow" as const,
  status: "active" as const,
};
const canary = {
  ...shadow,
  rolloutGeneration: 2,
  mode: "canary" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(context);
  mocks.forbiddenResponse.mockReturnValue(
    Response.json({ error: "Forbidden" }, { status: 403 }),
  );
  mocks.getLatestMigration.mockResolvedValue(migration);
  mocks.startMigration.mockResolvedValue({ ...migration, status: "queued" });
  mocks.register.mockResolvedValue({ ...shadow, status: "registered" });
  mocks.transition.mockResolvedValue(shadow);
});

describe("asset object migration route", () => {
  it("starts in shadow mode and queues the owner-scoped migration", async () => {
    mocks.getCurrent.mockResolvedValue(null);

    const response = await POST(jsonRequest("start"));

    expect(response.status).toBe(202);
    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      capabilityId: "asset-object-read-v1",
      rolloutGeneration: 1,
      mode: "shadow",
    }));
    expect(mocks.startMigration).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      executionScope: expect.objectContaining({
        initiatingActorId: context.actorId,
        purpose: "asset.object.migration.start",
      }),
    }));
  });

  it("refuses read cutover until parity verification completes", async () => {
    mocks.getLatestMigration.mockResolvedValue({
      ...migration,
      status: "verifying",
      verificationSha256: null,
    });

    const response = await POST(jsonRequest("activate"));

    expect(response.status).toBe(409);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("supersedes shadow with a canary reader after verified parity", async () => {
    mocks.getCurrent.mockResolvedValue(shadow);
    mocks.register.mockResolvedValue({ ...canary, status: "registered" });
    mocks.transition.mockResolvedValue(canary);

    const response = await POST(jsonRequest("activate"));

    expect(response.status).toBe(200);
    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({
      rolloutGeneration: 2,
      mode: "canary",
    }));
    expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({
      expectedRolloutGeneration: 2,
      expectedStatus: "registered",
      nextStatus: "active",
    }));
  });

  it("rolls back by pausing the reader without touching the migration", async () => {
    mocks.getCurrent.mockResolvedValue(canary);
    mocks.transition.mockResolvedValue({ ...canary, status: "paused" });

    const response = await POST(jsonRequest("rollback"));

    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({
      expectedRolloutGeneration: 2,
      expectedStatus: "active",
      nextStatus: "paused",
    }));
    expect(mocks.startMigration).not.toHaveBeenCalled();
  });
});

function jsonRequest(action: "start" | "activate" | "rollback") {
  return new Request("https://example.test/api/assets/migration", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-migration-test",
    },
    body: JSON.stringify({ action }),
  });
}
