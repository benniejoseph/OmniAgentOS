import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveWorkspaceSession = vi.fn();

vi.mock("@/lib/auth/workspace-session", () => ({ resolveWorkspaceSession }));
vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: <Handler>(handler: Handler) => handler,
}));
vi.mock("@/lib/observability/request-timing", () => ({
  measureRequestStage: (_stage: string, operation: () => unknown) => operation(),
}));

describe("workspace session route", () => {
  beforeEach(() => {
    resolveWorkspaceSession.mockReset();
  });

  it("keeps the actor session projection out of browser and shared caches", async () => {
    resolveWorkspaceSession.mockResolvedValue({
      authEnabled: true,
      bootstrapConfigured: true,
      googleLoginConfigured: true,
      authenticated: true,
      context: {
        tenantId: "tenant-a",
        actorId: "actor-a",
        role: "admin",
      },
      user: { id: "actor-a", email: "owner@example.test" },
      tenant: { id: "tenant-a", name: "Private workspace" },
      membership: { role: "admin" },
    });

    const { GET } = await import("@/app/api/auth/session/route");
    const response = await GET(
      new Request("https://asael.example/api/auth/session", {
        headers: { cookie: "omniagent_session=opaque-session" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cache-control")).not.toContain("public");
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      context: { tenantId: "tenant-a", actorId: "actor-a" },
    });
  });
});
