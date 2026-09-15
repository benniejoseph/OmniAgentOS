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
      currentVersion: 6,
      previousVersion: 5,
      supportedVersions: [6, 5],
      versions: [
        { version: 6, state: "current", openapi: "/native-contracts/v6/openapi.json" },
        { version: 5, state: "previous", openapi: "/native-contracts/v5/openapi.json" },
      ],
    });
  });
});
