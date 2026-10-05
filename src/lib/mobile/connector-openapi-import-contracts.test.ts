import { describe, expect, it } from "vitest";
import { APP_SERVICE_BOUNDARY_VERSION, type AppServiceReceipt } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT } from "@/lib/connectors/native-control-contracts";
import { nativeConnectorMcpRegistrationSubmitResponseSchema } from "@/lib/mobile/connector-mcp-registration-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { nativeOpenapiImportFixture } from "../../../tests/fixtures/native-openapi-import";
import {
  assertNativeConnectorOpenapiImportPreparationResponseScope, assertNativeConnectorOpenapiImportResponseScope,
  nativeConnectorOpenapiImportPreparationSubmitResponseSchema, nativeConnectorOpenapiImportPreparationReadResponseSchema,
  nativeConnectorOpenapiImportPreparationAbandonResponseSchema, nativeConnectorOpenapiImportSubmitResponseSchema,
  nativeConnectorOpenapiImportReadResponseSchema,
} from "./connector-openapi-import-contracts";

const f = nativeOpenapiImportFixture("api_key_header_env", "url", true), { scope } = f;
const executionScope = createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: scope.ownerActorId, executingPrincipalType: "user",
  executingPrincipalId: scope.ownerActorId, correlationId: "openapi-publication", causationId: f.connectorId, purpose: "api.connectors.native.action" });
const cleanupScope = createExecutionScope({ ...executionScope, purpose: "api.connectors.native.openapi_import_preparation.abandon" });
const operations = { prepare: "app.connectors.native.openapiImportPreparations.submit", preparationRead: "app.connectors.native.openapiImportPreparations.read",
  abandon: "app.connectors.native.openapiImportPreparations.abandon", submit: "app.connectors.native.openapiImports.submit", read: "app.connectors.native.openapiImports.read" } as const;
type Kind = keyof typeof operations;
function envelope(body: Record<string, unknown>, kind: Kind, overrides: Partial<AppServiceReceipt> = {}, role = "admin") {
  const data = { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope, ...body }, mutation = ["prepare", "abandon", "submit"].includes(kind);
  const proof = { schemaVersion: 1 as const, receiptKind: "app_service_receipt" as const, boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    ...getAppServiceOperationContract(operations[kind]), authoritySha256: canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
      tenantId: scope.tenantId, actorId: scope.ownerActorId, role, executionScope: mutation ? kind === "abandon" ? cleanupScope : executionScope : null }),
    idempotencyKeySha256: mutation ? kind === "submit" ? f.actionIntent.keySha256 : f.intent.keySha256 : null,
    outcomeSha256: canonicalJsonSha256(data), resourceCount: body.prepared || body.action ? 1 : 0, occurredAt: "2026-10-05T08:02:00.001Z", ...overrides };
  return { ...data, serviceReceipt: { ...proof, receiptSha256: canonicalJsonSha256(proof) } };
}
const authority = { scope, requestActorId: scope.ownerActorId, role: "admin" };

describe("native OpenAPI import publication", () => {
  it("binds every admitted preparation state to exact original intent and mutation authority", () => {
    for (const prepared of [f.preparing, f.ready, f.expired, f.expiredAttempt, f.failed, f.consumed, f.abandonedAbsent, f.abandonedPrepared]) {
      const response = nativeConnectorOpenapiImportPreparationSubmitResponseSchema.parse(envelope({ prepared, replayed: prepared !== f.ready }, "prepare"));
      const expected = { ...authority, executionScope, idempotencyKey: f.preparationKey, intent: f.intent };
      expect(() => assertNativeConnectorOpenapiImportPreparationResponseScope(response, expected)).not.toThrow();
      for (const changed of [{ ...expected, idempotencyKey: "different-key" }, { ...expected, role: "viewer" },
        { ...expected, intent: nativeOpenapiImportFixture().intent }, { ...expected, scope: { ...scope, ownerActorId: "other@example.test" } }]) {
        expect(() => assertNativeConnectorOpenapiImportPreparationResponseScope(response, changed)).toThrow();
      }
      for (const privateInput of ["synthetic-private-query", "synthetic-fragment", f.preparationKey, f.finalKey]) expect(JSON.stringify(response)).not.toContain(privateInput);
    }
  });
  it("keeps null and every exact recovery tag read-only and current-owner bound", () => {
    for (const prepared of [null, f.preparing, f.ready, f.expired, f.expiredAttempt, f.failed, f.consumed, f.abandonedAbsent, f.abandonedAttempt, f.abandonedPrepared]) {
      const response = nativeConnectorOpenapiImportPreparationReadResponseSchema.parse(envelope({ prepared }, "preparationRead", {}, "viewer"));
      expect(() => assertNativeConnectorOpenapiImportPreparationResponseScope(response, { ...authority, role: "viewer", keySha256: f.intent.keySha256 })).not.toThrow();
      expect(response.serviceReceipt).toMatchObject({ accessMode: "read", idempotencyKeySha256: null, resourceCount: prepared ? 1 : 0 });
      if (prepared) expect(() => assertNativeConnectorOpenapiImportPreparationResponseScope(response, { ...authority, role: "viewer", keySha256: "f".repeat(64) })).toThrow("key");
    }
  });
  it("exposes complete summary only with ready proof and rejects summary drift even under a fresh service digest", () => {
    const response = nativeConnectorOpenapiImportPreparationReadResponseSchema.parse(envelope({ prepared: f.ready }, "preparationRead"));
    expect(response.prepared?.availability === "ready" && response.prepared.summary.operations).toHaveLength(2);
    for (const prepared of [{ ...f.ready, summary: { ...f.summary, operations: [f.summary.operations[0]] } },
      { ...f.preparing, summary: f.summary }, { ...f.failed, summary: f.summary }, { ...f.consumed, summary: f.summary }]) {
      expect(nativeConnectorOpenapiImportPreparationReadResponseSchema.safeParse(envelope({ prepared }, "preparationRead")).success).toBe(false);
    }
  });
  it("binds owner cleanup to its own purpose and never manufactures absent attempt or proof", () => {
    for (const prepared of [f.abandonedAbsent, f.abandonedAttempt, f.abandonedPrepared]) {
      const response = nativeConnectorOpenapiImportPreparationAbandonResponseSchema.parse(envelope({ prepared, replayed: false }, "abandon", {}, "viewer"));
      const expected = { ...authority, role: "viewer", executionScope: cleanupScope, idempotencyKey: f.preparationKey, intent: f.intent };
      expect(() => assertNativeConnectorOpenapiImportPreparationResponseScope(response, expected)).not.toThrow();
      expect(response.serviceReceipt).toMatchObject({ action: "read", accessMode: "mutation", eventContract: "connector-native-openapi-import-preparation-events.v1" });
      expect(() => assertNativeConnectorOpenapiImportPreparationResponseScope(response, { ...expected, executionScope })).toThrow("authority");
    }
    for (const prepared of [null, f.preparing, f.ready, f.failed, f.consumed]) {
      expect(nativeConnectorOpenapiImportPreparationAbandonResponseSchema.safeParse(envelope({ prepared, replayed: false }, "abandon")).success).toBe(false);
    }
    expect(f.abandonedAbsent.attempt).toBeNull(); expect(f.abandonedAbsent.preparation).toBeNull();
  });
  it("binds final action to its exact preparation and rejects another key, target or operation", () => {
    const response = nativeConnectorOpenapiImportSubmitResponseSchema.parse(envelope({ action: f.action, replayed: false }, "submit"));
    const expected = { ...authority, executionScope, idempotencyKey: f.finalKey, request: f.request };
    expect(() => assertNativeConnectorOpenapiImportResponseScope(response, expected)).not.toThrow();
    for (const changed of [{ ...expected, idempotencyKey: f.preparationKey }, { ...expected, request: { ...f.request, preparationSha256: "e".repeat(64) } },
      { ...expected, request: { ...f.request, connectorId: nativeOpenapiImportFixture().connectorId } }]) {
      expect(() => assertNativeConnectorOpenapiImportResponseScope(response, changed)).toThrow();
    }
    expect(nativeConnectorMcpRegistrationSubmitResponseSchema.safeParse(envelope({ action: f.action, replayed: false }, "submit")).success).toBe(false);
  });
  it("reads final evidence without any mutation or reconstruction of a raw final key", () => {
    for (const action of [null, f.action]) {
      const response = nativeConnectorOpenapiImportReadResponseSchema.parse(envelope({ action }, "read", {}, "viewer"));
      expect(() => assertNativeConnectorOpenapiImportResponseScope(response, { ...authority, role: "viewer", keySha256: f.actionIntent.keySha256 })).not.toThrow();
      expect(response.serviceReceipt).toMatchObject({ action: "read", accessMode: "read", idempotencyKeySha256: null });
    }
    const response = nativeConnectorOpenapiImportReadResponseSchema.parse(envelope({ action: f.action }, "read"));
    expect(() => assertNativeConnectorOpenapiImportResponseScope(response, { ...authority, keySha256: f.intent.keySha256 })).toThrow("key");
  });
  it("refuses a validly hashed service receipt with another operation, authority mode or event family", () => {
    for (const override of [{ operation: operations.read }, { action: "read" }, { accessMode: "read" }, { resourceType: "connector_native_action" },
      { resourceCount: 0 }, { eventContract: "connector-native-mcp-registration-preparation-events.v1" },
      { idempotencyKeySha256: null }, { outcomeSha256: "a".repeat(64) }] as Partial<AppServiceReceipt>[]) {
      expect(nativeConnectorOpenapiImportPreparationSubmitResponseSchema.safeParse(envelope({ prepared: f.ready, replayed: false }, "prepare", override)).success).toBe(false);
    }
  });
});
