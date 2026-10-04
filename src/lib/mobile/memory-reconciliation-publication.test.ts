import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NATIVE_API_CURRENT_VERSION, nativeOperationsForVersion } from "./contracts";

describe("native Memory reconciliation publication", () => {
  it("adds only bounded private review operations to the frozen v34 surface", () => {
    const previous = nativeOperationsForVersion(34)!;
    const current = nativeOperationsForVersion(35)!;
    expect(current.filter(({ id }) => !id.startsWith("memory.reconciliation."))).toEqual(previous);
    expect(current.filter(({ id }) => id.startsWith("memory.reconciliation.")).map(({ id, method, path }) => [id, method, path])).toEqual([
      ["memory.reconciliation.list", "GET", "/api/memory/reconciliation"],
      ["memory.reconciliation.read", "GET", "/api/memory/reconciliation/{id}"],
      ["memory.reconciliation.resolve", "PATCH", "/api/memory/reconciliation"],
    ]);
  });
  it("publishes strict queries, private receipts and a bounded stable-key mutation", async () => {
    const document = JSON.parse(await readFile(new URL(`../../../public/native-contracts/v${NATIVE_API_CURRENT_VERSION}/openapi.json`, import.meta.url), "utf8"));
    const list = document.paths["/api/memory/reconciliation"].get;
    const read = document.paths["/api/memory/reconciliation/{id}"].get;
    const change = document.paths["/api/memory/reconciliation"].patch;
    for (const wire of [list, read, change]) {
      expect(wire["x-asael-query-policy"]).toEqual({ unknownParameters: "reject", repeatedParameters: "reject" });
      expect(wire.responses["200"].headers["cache-control"].schema.const).toBe("private, no-store");
      expect(wire.responses["403"].content["application/json"].schema.$ref).toBe("#/components/schemas/NativeMemoryReconciliationError");
    }
    expect(list.parameters).toContainEqual(expect.objectContaining({ name: "contract", required: true, schema: { type: "string", enum: ["asael-memory-reconciliation-read:1"] } }));
    expect(list.parameters).toContainEqual(expect.objectContaining({ name: "limit", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } }));
    expect(read.parameters).toContainEqual(expect.objectContaining({ name: "acceptanceKeySha256", schema: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" } }));
    expect(change.parameters).toContainEqual(expect.objectContaining({ name: "Idempotency-Key", in: "header", required: true }));
    expect(change.requestBody["x-asael-max-bytes"]).toBe(4096);
    expect(Object.keys(change.responses).sort()).toEqual(["200", "400", "401", "403", "404", "409", "413", "415", "503"]);
  });
});
