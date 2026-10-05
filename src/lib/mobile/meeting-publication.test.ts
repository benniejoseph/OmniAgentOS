import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NATIVE_API_CURRENT_VERSION, NATIVE_API_PREVIOUS_VERSION, nativeContractSchemas, nativeOperationsForVersion } from "./contracts";
import { nativeMeetingContractSchemas } from "./meeting-contracts";

const expected = [
  ["meetings.list", "GET", "/api/meetings", undefined, "NativeMeetingListResponse"],
  ["meetings.get", "GET", "/api/meetings/{id}", undefined, "NativeMeetingReadResponse"],
  ["meetings.create", "POST", "/api/meetings", "NativeMeetingCreateRequest", "NativeMeetingCreateResponse"],
  ["meetings.update", "PATCH", "/api/meetings/{id}", "NativeMeetingUpdateRequest", "NativeMeetingUpdateResponse"],
  ["meetings.commitments.list", "GET", "/api/meetings/{id}/commitments", undefined, "NativeMeetingCommitmentsResponse"],
  ["meetings.commitments.propose", "POST", "/api/meetings/{id}/commitments", "NativeMeetingCommitmentProposeRequest", "NativeMeetingCommitmentProposeResponse"],
  ["meetings.commitments.resolve", "PATCH", "/api/meetings/{id}/commitments", "NativeMeetingCommitmentResolveRequest", "NativeMeetingCommitmentResolveResponse"],
];

describe("native v33 Meeting publication", () => {
  it("publishes seven typed scoped operations while retaining the v32 operation surface", () => {
    const previous = nativeOperationsForVersion(32)!;
    const current = nativeOperationsForVersion(33)!;
    expect(previous.filter(({ id }) => id.startsWith("meetings.")).map(({ id, responseSchema }) => [id, responseSchema]))
      .toEqual([["meetings.list", "JsonObject"], ["meetings.get", "JsonObject"]]);
    expect(current.filter(({ id }) => id.startsWith("meetings.")).map(({ id, method, path, requestSchema, responseSchema }) => [id, method, path, requestSchema, responseSchema])).toEqual(expected);
    expect(current.filter(({ id }) => !id.startsWith("meetings."))).toEqual(previous.filter(({ id }) => !id.startsWith("meetings.")));
    expect(Object.keys(nativeMeetingContractSchemas)).toHaveLength(14);
    for (const [name, schema] of Object.entries(nativeMeetingContractSchemas)) {
      expect(nativeContractSchemas[name as keyof typeof nativeContractSchemas], name).toBe(schema);
    }
    for (const operation of current.filter(({ id }) => id.startsWith("meetings."))) {
      expect(operation.auth).toBe("bearer");
      expect(operation.queryPolicy).toBeUndefined();
      expect(operation.errorResponseSchema).toBe("NativeMeetingErrorResponse");
      expect(nativeContractSchemas[operation.responseSchema as keyof typeof nativeContractSchemas].safeParse({}).success).toBe(false);
      if (operation.method !== "GET") expect(operation.headerParameters).toEqual([{
        name: "Idempotency-Key", required: true, minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$",
      }]);
    }
  });

  it("generates bounded scoped paths, exact status envelopes and private receipts", async () => {
    const prior = JSON.parse(await readFile(new URL(`../../../public/native-contracts/v${NATIVE_API_PREVIOUS_VERSION}/openapi.json`, import.meta.url), "utf8"));
    const wire = JSON.parse(await readFile(new URL(`../../../public/native-contracts/v${NATIVE_API_CURRENT_VERSION}/openapi.json`, import.meta.url), "utf8"));
    for (const operation of nativeOperationsForVersion(33)!.filter(({ id }) => id.startsWith("meetings."))) {
      expect(wire.paths[operation.path][operation.method.toLowerCase()], operation.id).toEqual(prior.paths[operation.path][operation.method.toLowerCase()]);
    }
    for (const operation of nativeOperationsForVersion(33)!.filter(({ id }) => id.startsWith("meetings."))) {
      const published = wire.paths[operation.path][operation.method.toLowerCase()];
      expect(published["x-asael-query-policy"]).toBeUndefined();
      expect(Object.keys(published.responses).sort()).toEqual([...(operation.successStatuses ?? [200]), ...operation.errorStatuses!].map(String).sort());
      for (const status of operation.successStatuses ?? [200]) {
        expect(published.responses[status].content["application/json"].schema).toEqual({ $ref: `#/components/schemas/${operation.responseSchema}` });
        expect(published.responses[status].headers["cache-control"].schema.const).toBe("private, no-store");
      }
      for (const status of operation.errorStatuses!) expect(published.responses[status].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/NativeMeetingErrorResponse" });
      if (operation.path.includes("{id}")) expect(published.parameters).toContainEqual({ name: "id", in: "path", required: true,
        schema: { type: "string", minLength: 44, maxLength: 44, pattern: "^meeting:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" } });
      if (operation.method !== "GET") {
        const bytes = operation.id === "meetings.commitments.propose" ? 50_000 : operation.id === "meetings.commitments.resolve" ? 100_000 : 250_000;
        expect(published.requestBody["x-asael-max-bytes"]).toBe(bytes);
        expect(published.parameters.some((parameter: { in: string }) => parameter.in === "query")).toBe(false);
      }
    }
    expect(wire.paths["/api/meetings"].get.parameters).toContainEqual(expect.objectContaining({ name: "limit", schema: { type: "integer", minimum: 1, maximum: 200, default: 100 } }));
    expect(wire.paths["/api/meetings"].get.parameters).toContainEqual(expect.objectContaining({ name: "status", schema: { type: "string", enum: ["scheduled", "in_progress", "completed", "cancelled"] } }));
    expect(Object.keys(wire.paths["/api/meetings"].post.responses)).toContain("201");
    expect(Object.keys(wire.paths["/api/meetings/{id}/commitments"].post.responses)).toContain("201");
  });

  it("does not publish Calendar sync, recording completion or source audio by association", () => {
    const operations = nativeOperationsForVersion(33)!;
    expect(operations.filter(({ id }) => id.startsWith("meetings.")).map(({ id }) => id)).toEqual(expected.map(([id]) => id));
    expect(operations.flatMap(({ requestSchema, responseSchema }) => [requestSchema, responseSchema])
      .filter((name) => name && /Meeting.*(Recording|Voice)/.test(name))).toEqual([]);
    expect(operations.some(({ id }) => id.startsWith("meetings.calendar."))).toBe(false);
    expect(operations.find(({ id }) => id === "capture.transcribe")).toEqual(nativeOperationsForVersion(32)!.find(({ id }) => id === "capture.transcribe"));
  });
});
