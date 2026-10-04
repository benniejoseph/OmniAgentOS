import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NATIVE_API_CURRENT_VERSION, nativeContractSchemas, nativeOperationsForVersion } from "./contracts";

const added = ["customers.health.evaluate", "customers.health.evaluations.get"];
describe("native Account health evaluation publication", () => {
  it("adds only deterministic evaluation and exact receipt recovery to v36", () => {
    const operations = nativeOperationsForVersion(37)!;
    expect(operations.filter(({ id }) => !added.includes(id))).toEqual(nativeOperationsForVersion(36));
    expect(operations.filter(({ id }) => added.includes(id)).map(({ id }) => id)).toEqual(added);
    for (const operation of operations.filter(({ id }) => added.includes(id))) {
      expect(operation).toMatchObject({ auth: "bearer", queryPolicy: "exact", errorResponseSchema: "NativeCustomerHealthEvaluationError" });
      expect(operation.responseHeaders).toContainEqual(expect.objectContaining({ name: "cache-control", constValue: "private, no-store" }));
      expect(nativeContractSchemas[operation.responseSchema as keyof typeof nativeContractSchemas].safeParse({}).success).toBe(false);
    }
    const write = operations.find(({ id }) => id === added[0])!;
    expect(write.requestBodyMaxBytes).toBe(4096);
    expect(write.headerParameters).toContainEqual(expect.objectContaining({ name: "Idempotency-Key", required: true }));
    expect(write.successStatuses).toEqual([200, 201]);
  });

  it("publishes exact receipt coordinates and required workspace query", async () => {
    const wire = JSON.parse(await readFile(new URL(`../../../public/native-contracts/v${NATIVE_API_CURRENT_VERSION}/openapi.json`, import.meta.url), "utf8"));
    const read = wire.paths["/api/customer-accounts/{id}/health/evaluations/{evaluationId}"].get;
    expect(read.parameters).toContainEqual({ name: "id", in: "path", required: true, schema: { type: "string", minLength: 81, maxLength: 81, pattern: "^customer-account:[a-f0-9]{64}$" } });
    expect(read.parameters).toContainEqual({ name: "evaluationId", in: "path", required: true, schema: { type: "string", minLength: 91, maxLength: 91, pattern: "^customer-health-evaluation:[a-f0-9]{64}$" } });
    expect(read.parameters).toContainEqual({ name: "workspaceId", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 240 } });
    const dart = await readFile(new URL("../../../apps/flutter/lib/generated/native_contract.g.dart", import.meta.url), "utf8");
    expect(dart).toContain("static String customersHealthEvaluate(String id)");
    expect(dart).toContain("static String customersHealthEvaluationsGet(String id, String evaluationId, {required String workspaceId})");
  });
});
