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
      currentVersion: 8,
      previousVersion: 7,
      supportedVersions: [8, 7],
      versions: [
        { version: 8, state: "current", openapi: "/native-contracts/v8/openapi.json" },
        { version: 7, state: "previous", openapi: "/native-contracts/v7/openapi.json" },
      ],
    });
  });
});
