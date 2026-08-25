import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppBaseUrl } from "@/lib/config";

describe("getAppBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("removes surrounding whitespace and trailing slashes", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", " https://asael.example/\n");

    expect(getAppBaseUrl()).toBe("https://asael.example");
  });

  it("normalizes the Vercel host fallback", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "asael.example\n");

    expect(getAppBaseUrl()).toBe("https://asael.example");
  });
});
