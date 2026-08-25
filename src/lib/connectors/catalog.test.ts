import { describe, expect, it } from "vitest";
import { connectionCatalog } from "@/lib/connectors/catalog";

describe("connection catalog", () => {
  it("models Google personal sources as native read-only connectors", () => {
    const googleSources = connectionCatalog.filter((connector) =>
      ["gmail", "google-drive", "google-calendar"].includes(connector.id),
    );

    expect(googleSources).toHaveLength(3);
    expect(googleSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "gmail", adapter: "native", riskLevel: 0 }),
        expect.objectContaining({ id: "google-drive", adapter: "native", riskLevel: 0 }),
        expect.objectContaining({ id: "google-calendar", adapter: "native", riskLevel: 0 }),
      ]),
    );
    expect(googleSources.every((connector) => connector.status === "ready")).toBe(true);
    expect(googleSources.every((connector) => !connector.approvalRequired)).toBe(true);
  });
});
