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
      currentVersion: 25,
      previousVersion: 20,
      supportedVersions: [25, 20],
      versions: [
        { version: 25, state: "current", openapi: "/native-contracts/v25/openapi.json" },
        { version: 20, state: "previous", openapi: "/native-contracts/v20/openapi.json" },
      ],
    });
  });
});
