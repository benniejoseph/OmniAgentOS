import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  invalidateTodaySnapshot: vi.fn(),
}));

vi.mock("@/lib/today/snapshot-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/today/snapshot-cache")>();
  return {
    ...actual,
    invalidateTodaySnapshot: cacheMocks.invalidateTodaySnapshot,
  };
});

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "asael-today-cache-routes-"),
  );
  process.env.OMNIAGENT_TRUST_UNSIGNED_IDENTITY_HEADERS = "true";
  process.env.OMNIAGENT_ALLOWED_READ_AUDIT_SAMPLE_RATE = "0";
  delete process.env.DATABASE_URL;
  delete process.env.OPENAI_API_KEY;
});

beforeEach(() => {
  cacheMocks.invalidateTodaySnapshot.mockClear();
});

describe("Today route cache invalidation", () => {
  it("expires the owner snapshot after creating and updating a focus item", async () => {
    const owner = { tenantId: "today-cache-tenant", actorId: "today-cache-owner" };
    const { POST } = await import("@/app/api/today/route");
    const createResponse = await POST(todayRequest("/api/today", owner, {
      method: "POST",
      body: { title: "Verify cache invalidation" },
    }));
    const created = await createResponse.json() as { item: { id: string } };

    expect(createResponse.status).toBe(201);
    expect(cacheMocks.invalidateTodaySnapshot).toHaveBeenCalledWith(
      expect.objectContaining(owner),
    );

    cacheMocks.invalidateTodaySnapshot.mockClear();
    const { PATCH } = await import("@/app/api/today/[id]/route");
    const updateResponse = await PATCH(
      todayRequest(`/api/today/${created.item.id}`, owner, {
        method: "PATCH",
        body: { status: "done" },
      }),
      { params: Promise.resolve({ id: created.item.id }) },
    );

    expect(updateResponse.status).toBe(200);
    expect(cacheMocks.invalidateTodaySnapshot).toHaveBeenCalledWith(
      expect.objectContaining(owner),
    );
  });

  it("does not invalidate when an item mutation did not change data", async () => {
    const owner = { tenantId: "today-cache-tenant", actorId: "today-cache-owner" };
    const { PATCH } = await import("@/app/api/today/[id]/route");
    const response = await PATCH(
      todayRequest("/api/today/missing", owner, {
        method: "PATCH",
        body: { status: "done" },
      }),
      { params: Promise.resolve({ id: "missing" }) },
    );

    expect(response.status).toBe(404);
    expect(cacheMocks.invalidateTodaySnapshot).not.toHaveBeenCalled();
  });

  it("expires the owner snapshot after daily brief preference changes", async () => {
    const owner = { tenantId: "brief-cache-tenant", actorId: "brief-cache-owner" };
    const { PATCH } = await import("@/app/api/today/brief/route");
    const response = await PATCH(todayRequest("/api/today/brief", owner, {
      method: "PATCH",
      body: { briefTime: "07:30", timezone: "Asia/Kolkata" },
    }));

    expect(response.status).toBe(200);
    expect(cacheMocks.invalidateTodaySnapshot).toHaveBeenCalledWith(
      expect.objectContaining(owner),
    );
  });

  it("expires the owner snapshot after generating a daily brief", async () => {
    const owner = { tenantId: "brief-generate-tenant", actorId: "brief-generate-owner" };
    const { POST } = await import("@/app/api/today/brief/route");
    const response = await POST(todayRequest("/api/today/brief", owner, {
      method: "POST",
      body: { force: true },
    }));

    expect(response.status).toBe(200);
    expect(cacheMocks.invalidateTodaySnapshot).toHaveBeenCalledWith(
      expect.objectContaining(owner),
    );
  });
});

function todayRequest(
  pathname: string,
  owner: { tenantId: string; actorId: string },
  options: { method: "POST" | "PATCH"; body: Record<string, unknown> },
) {
  return new Request(`http://asael.test${pathname}`, {
    method: options.method,
    headers: {
      "content-type": "application/json",
      "x-omni-tenant-id": owner.tenantId,
      "x-omni-user-id": owner.actorId,
      "x-omni-user-role": "admin",
    },
    body: JSON.stringify(options.body),
  });
}
