import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exchange: vi.fn(), authenticate: vi.fn(), cookie: vi.fn(() => "asael_session=fixture; HttpOnly; Secure") }));
vi.mock("@/lib/auth/google", () => ({ exchangeGooglePrivateCode: mocks.exchange }));
vi.mock("@/lib/auth/store", () => ({ authenticateFederatedIdentity: mocks.authenticate }));
vi.mock("@/lib/auth/session", () => ({ sessionCookie: mocks.cookie }));
vi.mock("@/lib/config", () => ({ getAppBaseUrl: () => "https://asael.example" }));
import { GET } from "./route";

beforeEach(() => { vi.clearAllMocks(); mocks.exchange.mockResolvedValue({ email: "owner@example.test", name: "Owner" }); mocks.authenticate.mockResolvedValue({ token: "token", identity: { session: { expiresAt: "2026-10-04T00:00:00.000Z" } } }); });
describe("Google authenticated entry", () => {
  it("establishes the cookie then returns to login for a scoped preference read", async () => {
    const response = await GET(new Request("https://asael.example/api/auth/google/callback?code=code&state=sealed&next=https%3A%2F%2Fevil.test"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://asael.example/login");
    expect(response.headers.get("set-cookie")).toContain("asael_session=fixture");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.exchange).toHaveBeenCalledWith("code", "sealed");
  });
  it("uses only the verified sealed target, never callback query targets", async () => {
    const destination = "/app/projects?project=project-a#tasks";
    mocks.exchange.mockResolvedValue({ email: "owner@example.test", name: "Owner", returnTo: destination });
    const response = await GET(new Request("https://asael.example/api/auth/google/callback?code=code&state=sealed&returnTo=%2Fapp%2Factivity"));
    expect(response.headers.get("location")).toBe(`https://asael.example/login?next=${encodeURIComponent(destination)}`);
  });
  it("retains denied/failed handling and never sets a session on failed verification", async () => {
    expect((await GET(new Request("https://asael.example/api/auth/google/callback"))).headers.get("location")).toBe("https://asael.example/login?google=denied");
    expect(mocks.exchange).not.toHaveBeenCalled();
    mocks.exchange.mockRejectedValue(new Error("state failed"));
    const response = await GET(new Request("https://asael.example/api/auth/google/callback?code=code&state=bad"));
    expect(response.headers.get("location")).toBe("https://asael.example/login?google=failed");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });
});
