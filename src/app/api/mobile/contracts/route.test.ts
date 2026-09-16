import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/mobile/contracts/route";

describe("native contract discovery route", () => {
  it("publishes current and previous immutable contract documents", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=300");
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 1,
      contractId: "asael.native-api",
      currentVersion: 7,
      previousVersion: 6,
      supportedVersions: [7, 6],
      versions: [
        { version: 7, state: "current", openapi: "/native-contracts/v7/openapi.json" },
        { version: 6, state: "previous", openapi: "/native-contracts/v6/openapi.json" },
      ],
    });
  });
});
