import { describe, expect, it } from "vitest";
import {
  AUTH_SESSION_COOKIE,
  clearLegacySessionCookies,
  clearSessionCookie,
  getSessionToken,
  sessionCookie,
} from "@/lib/auth/session";

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

  it("reads the canonical cookie before a legacy transition cookie", () => {
    const request = new Request("https://asael.bennierichard.com/app", {
      headers: {
        cookie: `omniagent_session=legacy; ${AUTH_SESSION_COOKIE}=canonical`,
      },
    });

    expect(getSessionToken(request)).toBe("canonical");
  });

  it("keeps existing sessions readable and clears both legacy cookie names", () => {
    const request = new Request("https://asael.bennierichard.com/app", {
      headers: { cookie: "omniagent_session=legacy" },
    });

    expect(getSessionToken(request)).toBe("legacy");
    expect(clearLegacySessionCookies()).toHaveLength(2);
    expect(clearLegacySessionCookies().join("\n")).toContain(
      "omniagent_session=",
    );
  });
});
