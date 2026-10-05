import { describe, expect, it } from "vitest";
import { APP_SERVICE_BOUNDARY_VERSION, type AppServiceReceipt } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT } from "@/lib/connectors/native-control-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { nativeMcpDiscoveryFixture } from "../../../tests/fixtures/native-mcp-discovery";
import { assertNativeConnectorMcpDiscoveryResponseScope, nativeConnectorMcpDiscoverySubmitResponseSchema,
  nativeConnectorMcpDiscoveryReadResponseSchema, nativeConnectorMcpDiscoveryCloseResponseSchema } from "./connector-mcp-discovery-contracts";
const f = nativeMcpDiscoveryFixture(), { scope } = f;
const executionScope = createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: scope.ownerActorId, executingPrincipalType: "user",
  executingPrincipalId: scope.ownerActorId, causationId: f.connectorId, correlationId: "discovery-publication", purpose: "api.connectors.native.mcp_discovery" });
const cleanupScope = createExecutionScope({ ...executionScope, purpose: "api.connectors.native.mcp_discovery_close" });
function envelope(body: Record<string, unknown>, kind: "submit" | "read" | "close", overrides: Partial<AppServiceReceipt> = {}, role = "admin") {
  const data = { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope, ...body }, mutation = kind !== "read";
  const proof = { schemaVersion: 1 as const, receiptKind: "app_service_receipt" as const, boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    ...getAppServiceOperationContract(`app.connectors.native.mcpDiscoveries.${kind}`), authoritySha256: canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
      tenantId: scope.tenantId, actorId: scope.ownerActorId, role, executionScope: mutation ? kind === "close" ? cleanupScope : executionScope : null }),
    idempotencyKeySha256: mutation ? f.intent.keySha256 : null, outcomeSha256: canonicalJsonSha256(data), resourceCount: body.discovery ? 1 : 0,
    occurredAt: "2026-10-06T08:02:00.001Z", ...overrides };
  return { ...data, serviceReceipt: { ...proof, receiptSha256: canonicalJsonSha256(proof) } };
}
const authority = { scope, requestActorId: scope.ownerActorId, role: "admin" };
describe("native MCP discovery publication", () => {
  it("binds all states to exact original mutation intent and current authority", () => {
    for (const discovery of [f.pending, f.expired, f.settled, ...f.failed, f.closedAttempt, f.closedAbsent]) {
      const response = nativeConnectorMcpDiscoverySubmitResponseSchema.parse(envelope({ discovery, replayed: true }, "submit"));
      const expected = { ...authority, executionScope, idempotencyKey: f.key, request: f.request };
      expect(() => assertNativeConnectorMcpDiscoveryResponseScope(response, expected)).not.toThrow();
      for (const changed of [{ ...expected, role: "viewer" }, { ...expected, idempotencyKey: "other-key" },
        { ...expected, request: nativeMcpDiscoveryFixture("bearer_vault").request }, { ...expected, scope: { ...scope, tenantId: "other" } }]) {
        expect(() => assertNativeConnectorMcpDiscoveryResponseScope(response, changed)).toThrow();
      }
      expect(JSON.stringify(response)).not.toContain(f.key);
    }
  });
  it("keeps null, expiry and every terminal recovery read-only", () => {
    for (const discovery of [null, f.pending, f.expired, f.settled, ...f.failed, f.closedAbsent]) {
      const response = nativeConnectorMcpDiscoveryReadResponseSchema.parse(envelope({ discovery }, "read"));
      expect(() => assertNativeConnectorMcpDiscoveryResponseScope(response, { ...authority, keySha256: f.intent.keySha256 })).not.toThrow();
      expect(response.serviceReceipt).toMatchObject({ accessMode: "read", idempotencyKeySha256: null, resourceCount: discovery ? 1 : 0 });
      if (discovery) expect(() => assertNativeConnectorMcpDiscoveryResponseScope(response, { ...authority, keySha256: "f".repeat(64) })).toThrow("key");
    }
  });
  it("allows only permanent closure or preexisting settlement after explicit close", () => {
    for (const discovery of [f.closedAbsent, f.closedAttempt, f.settled, ...f.failed]) {
      const response = nativeConnectorMcpDiscoveryCloseResponseSchema.parse(envelope({ discovery, replayed: false }, "close", {}, "viewer"));
      const expected = { ...authority, role: "viewer", executionScope: cleanupScope, idempotencyKey: f.key, intent: f.intent };
      expect(() => assertNativeConnectorMcpDiscoveryResponseScope(response, expected)).not.toThrow();
      expect(response.serviceReceipt).toMatchObject({ action: "read", accessMode: "mutation" });
      expect(() => assertNativeConnectorMcpDiscoveryResponseScope(response, { ...expected, executionScope })).toThrow("authority");
    }
    for (const discovery of [null, f.pending, f.expired]) expect(nativeConnectorMcpDiscoveryCloseResponseSchema.safeParse(envelope({ discovery, replayed: false }, "close")).success).toBe(false);
  });
  it("rejects mismatched service operation, action, scope, count, key and event even under a resealed receipt", () => {
    for (const overrides of [{ action: "read" }, { resourceType: "connector_native_action" }, { resourceCount: 0 },
      { eventContract: "connector-native-events.v1" }, { idempotencyKeySha256: "f".repeat(64) },
      { outcomeSha256: "e".repeat(64) }, { operation: "app.connectors.native.mcpDiscoveries.close" }] as Partial<AppServiceReceipt>[]) {
      expect(nativeConnectorMcpDiscoverySubmitResponseSchema.safeParse(envelope({ discovery: f.settled, replayed: false }, "submit", overrides)).success).toBe(false);
    }
  });
  it("rejects private catalogs, credentials and old action-family envelopes", () => {
    for (const body of [{ discovery: f.settled, replayed: false, schemas: [] }, { action: f.settled, replayed: false },
      { discovery: { ...f.pending, bearerToken: "fixture-private" }, replayed: false }]) {
      expect(nativeConnectorMcpDiscoverySubmitResponseSchema.safeParse(envelope(body, "submit")).success).toBe(false);
    }
  });
});
