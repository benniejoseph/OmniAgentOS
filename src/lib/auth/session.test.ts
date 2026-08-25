import { describe, expect, it } from "vitest";
import { AUTH_SESSION_COOKIE, clearSessionCookie, sessionCookie } from "@/lib/auth/session";

describe("session cookies", () => {
  it("uses host-scoped production attributes and high priority", () => {
    const cookie = sessionCookie("opaque", "2030-01-01T00:00:00.000Z");
    expect(cookie).toContain(`${AUTH_SESSION_COOKIE}=opaque`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Priority=High");
    expect(cookie).toContain("Path=/");
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
});
