import { describe, expect, it } from "vitest";
import { GET as beginGoogleLogin } from "@/app/api/auth/google/authorize/route";
import { GET as finishGoogleLogin } from "@/app/api/auth/google/callback/route";

describe("unwrapped private API cache boundary", () => {
  it("keeps Google login state and callback redirects out of caches", async () => {
    const authorization = await beginGoogleLogin();
    expect(authorization.headers.get("cache-control")).toBe("private, no-store");

    const callback = await finishGoogleLogin(
      new Request("https://asael.example/api/auth/google/callback"),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("cache-control")).toBe("private, no-store");
  });
});
