import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/sw.js/route";
import { serviceWorkerCacheName } from "@/lib/pwa/service-worker";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /sw.js", () => {
  it("serves an uncached worker script whose cache belongs to this deployment", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_current");
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self'",
    );
    const script = await response.text();
    const cacheName = serviceWorkerCacheName({
      VERCEL_DEPLOYMENT_ID: "dpl_current",
    });
    expect(script).toContain(`const CACHE = "${cacheName}";`);

    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_next");
    expect(await GET().text()).not.toContain(cacheName);
  });
});
