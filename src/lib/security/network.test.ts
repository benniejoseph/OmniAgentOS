import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, isPrivateIpAddress } from "@/lib/security/network";

describe("isPrivateIpAddress", () => {
  it("flags private and special-use IPv4 ranges", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "0.0.0.0", "100.64.0.1", "224.0.0.1"]) {
      expect(isPrivateIpAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4 addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(isPrivateIpAddress(ip), ip).toBe(false);
    }
  });

  it("flags private IPv6 addresses", () => {
    for (const ip of ["::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateIpAddress(ip), ip).toBe(true);
    }
  });

  it("treats malformed IPv4 as private (fail closed)", () => {
    expect(isPrivateIpAddress("999.1.1.1")).toBe(true);
  });
});

describe("assertPublicHttpUrl", () => {
  it("rejects non-http protocols", async () => {
    await expect(assertPublicHttpUrl("ftp://example.com")).rejects.toThrow(/http or https/);
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow(/http or https/);
  });

  it("rejects embedded credentials", async () => {
    await expect(assertPublicHttpUrl("https://user:pass@example.com")).rejects.toThrow(/credentials/);
  });

  it("rejects blocked internal hostnames", async () => {
    await expect(assertPublicHttpUrl("http://localhost:3000")).rejects.toThrow(/internal hostname/);
    await expect(assertPublicHttpUrl("http://metadata.google.internal")).rejects.toThrow(/internal hostname/);
    await expect(assertPublicHttpUrl("http://foo.internal")).rejects.toThrow(/internal hostname/);
  });

  it("rejects literal private IPs", async () => {
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/private IP/);
    await expect(assertPublicHttpUrl("http://10.1.2.3")).rejects.toThrow(/private IP/);
  });

  it("rejects invalid URLs", async () => {
    await expect(assertPublicHttpUrl("not a url")).rejects.toThrow(/valid URL/);
  });
});
