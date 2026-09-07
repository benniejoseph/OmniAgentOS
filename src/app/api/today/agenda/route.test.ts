import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), show: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorize, forbiddenResponse: vi.fn() }));
vi.mock("@/lib/app-services/cohesive-today", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-services/cohesive-today")>()),
  showCohesiveTodayService: mocks.show,
}));

import { GET } from "@/app/api/today/agenda/route";

beforeEach(() => {
  mocks.authorize.mockReset().mockResolvedValue({ tenantId: "tenant:test", actorId: "actor:test", role: "admin", source: "session" });
  mocks.show.mockReset().mockResolvedValue({ data: { projection: { policyVersion: "p11.1-cohesive-today:1" } }, receipt: { operation: "app.today.agenda.show" } });
});

describe("cohesive Today route", () => {
  it("returns a private bounded projection", async () => {
    const response = await GET(new Request("http://localhost/api/today/agenda?workLimit=8&approvalLimit=6&meetingLimit=20&accountLimit=10"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.show).toHaveBeenCalledWith(expect.any(Object), {
      workLimit: 8, approvalLimit: 6, meetingLimit: 20, accountLimit: 10,
    });
  });

  it("rejects invalid bounds before authorization", async () => {
    const response = await GET(new Request("http://localhost/api/today/agenda?meetingLimit=500"));
    expect(response.status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
