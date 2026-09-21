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
      currentVersion: 20,
      previousVersion: 19,
      supportedVersions: [20, 19],
      versions: [
        { version: 20, state: "current", openapi: "/native-contracts/v20/openapi.json" },
        { version: 19, state: "previous", openapi: "/native-contracts/v19/openapi.json" },
      ],
    });
  });
});
