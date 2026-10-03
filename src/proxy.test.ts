import { NextRequest } from "next/server";
// This installed Next build retains the Middleware name for the test helper.
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "@/proxy";

afterEach(() => { vi.unstubAllEnvs(); });

describe("canonical Asael origin", () => {
  it("permanently redirects the exact legacy public host with path and query intact", () => {
    const response = proxy(
      new NextRequest(
        "https://omniagent-os.vercel.app/app/command?conversation=active",
      ),
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://asael.bennierichard.com/app/command?conversation=active",
    );
  });

  it("does not redirect staged Vercel deployment hosts", () => {
    const response = proxy(
      new NextRequest(
        "https://omniagent-preview-benniejosephs-projects.vercel.app/api/health",
      ),
    );

    expect(response.headers.get("location")).toBeNull();
  });

  it("allows only the reviewed Vercel Sandbox frame family", () => {
    const response = proxy(
      new NextRequest("https://asael.bennierichard.com/app/projects"),
    );
    const policy = response.headers.get("content-security-policy") || "";
    const frameSource = policy
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("frame-src "));

    expect(frameSource).toBe(
      "frame-src 'self' blob: https://*.vercel.run",
    );
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("frame-src *");
  });
});

describe("forwarded private return destination", () => {
  it("replaces an incoming destination with the exact requested path and query", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "test");
    const path = "/app/meetings/meeting%3Asample.v2?view=notes&source=a%2Fb";
    const response = proxy(new NextRequest(`https://asael.bennierichard.com${path}`, {
      headers: { "x-asael-return-path": "/app/security?spoofed=1" },
    }));
    expect(response.headers.get("x-middleware-request-x-asael-return-path")).toBe(path);
    expect(response.headers.get("x-asael-return-path")).toBeNull();
    const nonce = response.headers.get("x-middleware-request-x-nonce");
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(response.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`);
    expect(response.headers.get("x-middleware-request-content-security-policy"))
      .toBe(response.headers.get("content-security-policy"));
  });

  it("removes supplied destinations on public routes and unsafe app paths", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "test");
    for (const path of ["/login?next=https://outside.invalid", "/app/results/a%5Cb", "/app/results/%252e%252e/opaque"]) {
      const response = proxy(new NextRequest(`https://asael.bennierichard.com${path}`, {
        headers: { "x-asael-return-path": "/app/security" },
      }));
      expect(response.headers.get("x-middleware-request-x-asael-return-path")).toBeNull();
    }
  });

  it("runs on private paths containing dots while keeping static assets excluded", () => {
    for (const url of ["/app", "/app/meetings/meeting%3Asample.v2?view=notes", "/app/results/agent%3Arun%2Fopaque.json"]) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
    }
    for (const url of ["/_next/static/chunk.js", "/_next/image?url=x", "/favicon.ico", "/asael-mark-128.webp"]) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
    }
  });

  it("retains the production storage guard instead of using the return path to bypass it", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("OMNIAGENT_ALLOW_DEMO_STORAGE", "false");
    const response = proxy(new NextRequest("https://asael.bennierichard.com/app/command?thread=sample"));
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
