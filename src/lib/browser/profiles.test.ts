import { describe, expect, it } from "vitest";
import {
  browserProfileAllowsHostname,
  browserProfileTargetHostname,
  normalizeBrowserProfileDomain,
  normalizeBrowserProfileDomains,
} from "@/lib/browser/profiles";

describe("browser profile contracts", () => {
  it("normalizes explicit HTTPS origins into stable domain scopes", () => {
    expect(normalizeBrowserProfileDomains([
      "https://Accounts.Google.com/",
      "*.google.com",
      "accounts.google.com",
    ])).toEqual(["accounts.google.com", "google.com"]);
  });

  it("matches an exact consented domain and its subdomains only", () => {
    expect(browserProfileAllowsHostname(["example.com"], "example.com")).toBe(true);
    expect(browserProfileAllowsHostname(["example.com"], "login.example.com")).toBe(true);
    expect(browserProfileAllowsHostname(["example.com"], "notexample.com")).toBe(false);
    expect(browserProfileAllowsHostname(["example.com"], "example.com.attacker.test")).toBe(false);
  });

  it("rejects local, credential-bearing, non-HTTPS, and malformed scopes", () => {
    for (const value of [
      "localhost",
      "service.internal",
      "127.0.0.1",
      "http://example.com",
      "https://user:pass@example.com",
      "not a domain",
    ]) {
      expect(() => normalizeBrowserProfileDomain(value)).toThrow();
    }
  });

  it("extracts profile-binding destinations only from HTTPS navigation", () => {
    expect(browserProfileTargetHostname("browser_navigate", {
      url: "https://Login.Example.com/path?secret=value",
    })).toBe("login.example.com");
    expect(browserProfileTargetHostname("browser_click", {
      url: "https://example.com",
    })).toBeUndefined();
    expect(browserProfileTargetHostname("browser_navigate", {
      url: "http://example.com",
    })).toBeUndefined();
  });
});
