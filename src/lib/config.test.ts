import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAppBaseUrl,
  getOpenAIGatewayConfig,
  OPENAI_GATEWAY_PRODUCTION_BASE_URL,
} from "@/lib/config";

const gatewayToken = "a".repeat(64);

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

describe("getOpenAIGatewayConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes an HTTPS gateway URL to an OpenAI-compatible v1 base", () => {
    vi.stubEnv(
      "OMNIAGENT_OPENAI_GATEWAY_URL",
      " https://gateway.asael.example/ ",
    );
    vi.stubEnv("OMNIAGENT_OPENAI_GATEWAY_TOKEN", ` ${gatewayToken} `);

    expect(getOpenAIGatewayConfig()).toEqual({
      baseURL: "https://gateway.asael.example/v1",
      token: gatewayToken,
    });
  });

  it("does not duplicate an existing v1 suffix", () => {
    vi.stubEnv(
      "OMNIAGENT_OPENAI_GATEWAY_URL",
      "https://gateway.asael.example/openai/v1/",
    );
    vi.stubEnv("OMNIAGENT_OPENAI_GATEWAY_TOKEN", gatewayToken);

    expect(getOpenAIGatewayConfig()?.baseURL).toBe(
      "https://gateway.asael.example/openai/v1",
    );
  });

  it.each([
    OPENAI_GATEWAY_PRODUCTION_BASE_URL,
    `${OPENAI_GATEWAY_PRODUCTION_BASE_URL}/`,
    "https://omniagent-os-worker.fly.dev:443/v1",
  ])("accepts the pinned production gateway at the default HTTPS port: %s", (url) => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("OMNIAGENT_OPENAI_GATEWAY_URL", url);
    vi.stubEnv("OMNIAGENT_OPENAI_GATEWAY_TOKEN", gatewayToken);

    expect(getOpenAIGatewayConfig()).toEqual({
      baseURL: OPENAI_GATEWAY_PRODUCTION_BASE_URL,
      token: gatewayToken,
    });
  });

  it.each([
    ["a missing token", OPENAI_GATEWAY_PRODUCTION_BASE_URL, ""],
    ["a missing URL", "", gatewayToken],
    ["a short token", OPENAI_GATEWAY_PRODUCTION_BASE_URL, "short-token"],
    ["a control character in the token", OPENAI_GATEWAY_PRODUCTION_BASE_URL, `${gatewayToken.slice(0, 32)}\n${gatewayToken.slice(32)}`],
    ["HTTP", "http://omniagent-os-worker.fly.dev/v1", gatewayToken],
    ["credentials", "https://owner:secret@omniagent-os-worker.fly.dev/v1", gatewayToken],
    ["a query", "https://omniagent-os-worker.fly.dev/v1?target=openai", gatewayToken],
    ["a fragment", "https://omniagent-os-worker.fly.dev/v1#openai", gatewayToken],
    ["a relative URL", "/internal/openai", gatewayToken],
    ["a spoofed hostname suffix", "https://omniagent-os-worker.fly.dev.attacker.example/v1", gatewayToken],
    ["a user-info hostname spoof", "https://omniagent-os-worker.fly.dev@attacker.example/v1", gatewayToken],
    ["an alternate HTTPS port", "https://omniagent-os-worker.fly.dev:8443/v1", gatewayToken],
    ["the gateway origin without the pinned path", "https://omniagent-os-worker.fly.dev/", gatewayToken],
    ["an alternate path", "https://omniagent-os-worker.fly.dev/openai/v1", gatewayToken],
    ["a dot-segment path", "https://omniagent-os-worker.fly.dev/safe/../v1", gatewayToken],
    ["an encoded dot-segment path", "https://omniagent-os-worker.fly.dev/%2e%2e/v1", gatewayToken],
  ])("fails closed in production for %s", (_case, url, token) => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("OMNIAGENT_OPENAI_GATEWAY_URL", url);
    vi.stubEnv("OMNIAGENT_OPENAI_GATEWAY_TOKEN", token);

    expect(() => getOpenAIGatewayConfig()).toThrow(
      "OpenAI gateway configuration is invalid.",
    );
  });

  it("falls back to direct provider configuration outside production", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("OMNIAGENT_OPENAI_GATEWAY_URL", "http://unsafe.example");
    vi.stubEnv("OMNIAGENT_OPENAI_GATEWAY_TOKEN", gatewayToken);

    expect(getOpenAIGatewayConfig()).toBeUndefined();
  });
});
