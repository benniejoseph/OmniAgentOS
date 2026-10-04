import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NATIVE_API_CURRENT_VERSION, nativeContractSchemas, nativeOperationsForVersion } from "./contracts";

const added = ["memory.personal-context-consent.get", "memory.personal-context-consent.decide", "memory.personal-context-consent.decision.get",
  "meetings.calendar.get", "meetings.calendar.sync", "meetings.calendar.sync.get"];
describe("native consent and calendar publication", () => {
  it("adds only the six reviewed operations and preserves every older operation", () => {
    const prior = nativeOperationsForVersion(35)!;
    const current = nativeOperationsForVersion(36)!;
    expect(current.filter(({ id }) => !added.includes(id))).toEqual(prior);
    expect(current.filter(({ id }) => added.includes(id)).map(({ id }) => id)).toEqual(added);
    for (const operation of current.filter(({ id }) => added.includes(id))) {
      expect(operation.auth).toBe("bearer"); expect(operation.queryPolicy).toBe("exact");
      expect(operation.responseHeaders).toContainEqual(expect.objectContaining({ name: "cache-control", constValue: "private, no-store" }));
      expect(nativeContractSchemas[operation.responseSchema as keyof typeof nativeContractSchemas].safeParse({}).success).toBe(false);
      if (operation.method !== "GET") {
        expect(operation.requestBodyMaxBytes).toBe(4096);
        expect(operation.headerParameters).toContainEqual(expect.objectContaining({ name: "Idempotency-Key", required: true }));
      }
    }
  });
  it("publishes exact key recovery bounds and valid generated Dart identifiers", async () => {
    const wire = JSON.parse(await readFile(new URL(`../../../public/native-contracts/v${NATIVE_API_CURRENT_VERSION}/openapi.json`, import.meta.url), "utf8"));
    const consent = wire.paths["/api/memory/personal-context-consent/decisions/{id}"].get;
    expect(consent.parameters).toContainEqual({ name: "id", in: "path", required: true, schema: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" } });
    const calendar = wire.paths["/api/meetings/calendar/sync/{id}"].get;
    expect(calendar.parameters).toContainEqual({ name: "acceptanceKeySha256", in: "query", required: true, schema: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" } });
    const dart = await readFile(new URL("../../../apps/flutter/lib/generated/native_contract.g.dart", import.meta.url), "utf8");
    expect(dart).toContain("static String memoryPersonalContextConsentGet({required String contract})");
    expect(dart).toContain("static String memoryPersonalContextConsentDecisionGet(String id)");
    expect(dart).not.toContain("static String memoryPersonal-context");
  });
});
