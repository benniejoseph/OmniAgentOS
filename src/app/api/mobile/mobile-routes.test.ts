import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  delete process.env.DATABASE_URL;
  process.env.OMNIAGENT_AUTH_ENABLED = "true";
});

describe("mobile auth route contract", () => {
  it("returns the uniform no-store error shape for an invalid login", async () => {
    const { POST } = await import("@/app/api/mobile/auth/login/route");
    const response = await POST(new Request("https://example.test/api/mobile/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "The sign-in request is invalid." },
    });
  });

  it("fails refresh and bootstrap closed without leaking token details", async () => {
    const [{ POST }, { GET }] = await Promise.all([
      import("@/app/api/mobile/auth/refresh/route"),
      import("@/app/api/mobile/bootstrap/route"),
    ]);
    const refresh = await POST(new Request("https://example.test/api/mobile/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "x", deviceId: "device-0001" }),
    }));
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: { code: "invalid_request" } });

    const bootstrap = await GET(new Request("https://example.test/api/mobile/bootstrap", {
      headers: { authorization: "Bearer invalid" },
    }));
    expect(bootstrap.status).toBe(401);
    expect(await bootstrap.json()).toEqual({
      error: { code: "unauthorized", message: "A valid bearer token is required." },
    });
  });

  it("keeps malformed device lifecycle errors private and versioned", async () => {
    const { POST } = await import("@/app/api/mobile/devices/[id]/route");
    const response = await POST(
      new Request("https://example.test/api/mobile/devices/session-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      { params: Promise.resolve({ id: "session-1" }) },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-asael-native-contract-version")).toBe("13");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "The device lifecycle request is invalid.",
      },
    });
  });

  it("keeps device inventory bearer-only with the native error contract", async () => {
    const { GET } = await import("@/app/api/mobile/devices/route");
    const response = await GET(
      new Request("https://example.test/api/mobile/devices"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-asael-native-contract-version")).toBe("13");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unauthorized",
        message: "A valid bearer token is required.",
      },
    });
  });
});
