import { describe, expect, it } from "vitest";
import { companionOwnerSha256 } from "./owner-binding";

describe("Companion cross-platform owner bytes", () => {
  it("pins the UTF-8 domain-separated digest and preserves exact tenant and actor spelling", () => {
    expect(companionOwnerSha256("tenant-a", "owner@example.test")).toBe("5c5e0f519e7dd43a88298c8a7e4912106e5399b623a54384b5ccb6257c0ef6e2");
    expect(companionOwnerSha256("tenant-a", "Owner@example.test")).not.toBe(companionOwnerSha256("tenant-a", "owner@example.test"));
    expect(companionOwnerSha256("tenant-b", "owner@example.test")).not.toBe(companionOwnerSha256("tenant-a", "owner@example.test"));
  });
});
