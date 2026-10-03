import { beforeEach, describe, expect, it, vi } from "vitest";
const create = vi.hoisted(() => vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth?state=sealed"));
vi.mock("@/lib/auth/google", () => ({ createGooglePrivateAuthorization: create }));
import { GET } from "./route";
beforeEach(() => vi.clearAllMocks());
describe("Google explicit return destination", () => {
  it("passes the exact safe return path into sealed authorization state", async () => {
    const destination = "/app/command?thread=22222222-2222-4222-8222-222222222222";
    const response = await GET(new Request(`https://asael.example/api/auth/google/authorize?returnTo=${encodeURIComponent(destination)}`));
    expect(create).toHaveBeenCalledWith(destination);
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("omits external and ambiguous paths while preserving default authorization", async () => {
    await GET(new Request("https://asael.example/api/auth/google/authorize?next=%2F%2Fevil.test"));
    expect(create).toHaveBeenCalledWith(undefined);
  });
});
