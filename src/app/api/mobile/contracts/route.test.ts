import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/mobile/contracts/route";
import {
  NATIVE_API_CURRENT_VERSION,
  NATIVE_API_PREVIOUS_VERSION,
} from "@/lib/mobile/contracts";

describe("native contract discovery route", () => {
  it("publishes current and previous immutable contract documents", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=300");
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 1,
      contractId: "asael.native-api",
      currentVersion: NATIVE_API_CURRENT_VERSION,
      previousVersion: NATIVE_API_PREVIOUS_VERSION,
      supportedVersions: [NATIVE_API_CURRENT_VERSION, NATIVE_API_PREVIOUS_VERSION],
      versions: [
        {
          version: NATIVE_API_CURRENT_VERSION,
          state: "current",
          openapi: `/native-contracts/v${NATIVE_API_CURRENT_VERSION}/openapi.json`,
        },
        {
          version: NATIVE_API_PREVIOUS_VERSION,
          state: "previous",
          openapi: `/native-contracts/v${NATIVE_API_PREVIOUS_VERSION}/openapi.json`,
        },
      ],
    });
  });
});
