import { describe, expect, it } from "vitest";
import { APP_SERVICE_BOUNDARY_VERSION, type AppServiceReceipt } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeAcceptanceId, connectorNativeRequestSchema, sealConnectorNativePin } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeCredentialRemovalIntent, connectorNativeCredentialRemovalActionSchema,
  connectorNativeCredentialRemovalRequestSchema } from "@/lib/connectors/native-credential-removal-contracts";
import { nativeConnectorActionResponseSchema, nativeConnectorReadResponseSchema } from "@/lib/mobile/connector-native-contracts";
import { assertNativeConnectorCredentialRemovalResponseScope, nativeConnectorCredentialRemovalReadResponseSchema,
  nativeConnectorCredentialRemovalSubmitResponseSchema } from "@/lib/mobile/connector-credential-removal-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const scope = { tenantId: "connector-removal-fixture", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
const idempotencyKey = "remove-credential-fixture";
const pinBody = { kind: "mcp" as const, connectorId: "connector-one", connectorSha256: "a".repeat(64),
  contractsSha256: "b".repeat(64), configurationSha256: "c".repeat(64), reviewFingerprint: null, credentialVersion: 2 };
const pin = sealConnectorNativePin(pinBody);
const request = connectorNativeCredentialRemovalRequestSchema.parse({ contract: "asael-connector-lifecycle-action:1", kind: "mcp",
  connectorId: "connector-one", action: "remove_credential", review: pin, preview: null });
const intent = buildConnectorNativeCredentialRemovalIntent(scope, idempotencyKey, request);
const executionScope = createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: scope.ownerActorId,
  executingPrincipalType: "user", executingPrincipalId: scope.ownerActorId, correlationId: "credential-removal-fixture",
  causationId: request.connectorId, purpose: "api.connectors.native.action" });
const acceptanceBody = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, intent.keySha256), scope,
  keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent), kind: "mcp", connectorId: request.connectorId,
  action: "remove_credential", reviewSha256: pin.reviewSha256, acceptedAt: "2026-10-05T01:00:00.000Z" };
const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptanceBody.id, settledAt: "2026-10-05T01:00:00.001Z",
  result: { kind: "mcp", connectorId: request.connectorId, operation: "remove_credential", status: "complete", connectorStatus: "disabled",
    contractCount: 0, credentialVersion: 3, connectorSha256: "d".repeat(64), contractsSha256: canonicalJsonSha256([]),
    configurationSha256: "e".repeat(64), trash: null, failureCode: null } };
const action = connectorNativeCredentialRemovalActionSchema.parse({
  acceptance: { ...acceptanceBody, acceptanceSha256: canonicalJsonSha256(acceptanceBody) }, state: "settled",
  settlement: { ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) },
});

function envelope<T extends { action: typeof action | null }>(body: T, mutation: boolean, overrides: Partial<AppServiceReceipt> = {}) {
  const data = { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope, ...body };
  const proof = {
    schemaVersion: 1 as const, receiptKind: "app_service_receipt" as const, boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    ...getAppServiceOperationContract(`app.connectors.native.credentialRemovals.${mutation ? "submit" : "read"}`),
    authoritySha256: canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: scope.tenantId,
      actorId: scope.ownerActorId, role: "admin", executionScope: mutation ? executionScope : null }),
    idempotencyKeySha256: mutation ? intent.keySha256 : null, outcomeSha256: canonicalJsonSha256(data),
    resourceCount: body.action ? 1 : 0, occurredAt: "2026-10-05T01:00:00.002Z", ...overrides,
  };
  return { ...data, serviceReceipt: { ...proof, receiptSha256: canonicalJsonSha256(proof) } };
}

const expected = { scope, requestActorId: scope.ownerActorId, role: "admin", executionScope, idempotencyKey, request };

describe("native saved MCP credential removal publication", () => {
  it("accepts its exact immutable acceptance and complete local settlement", () => {
    const response = nativeConnectorCredentialRemovalSubmitResponseSchema.parse(envelope({ action, replayed: false }, true));
    expect(() => assertNativeConnectorCredentialRemovalResponseScope(response, expected)).not.toThrow();
    expect(response.action.settlement?.result).toMatchObject({ operation: "remove_credential", connectorStatus: "disabled", contractCount: 0, credentialVersion: 3 });
  });

  it("publishes no preparation, discovery, Trash or arbitrary lifecycle request", () => {
    for (const action of ["enable", "discover", "upgrade_github", "trash", "rotate_mcp", "register_mcp", "import_openapi"]) {
      expect(connectorNativeCredentialRemovalRequestSchema.safeParse({ ...request, action }).success, action).toBe(false);
    }
    expect(connectorNativeCredentialRemovalRequestSchema.safeParse({ ...request, bearerToken: "unpublished" }).success).toBe(false);
    expect(connectorNativeCredentialRemovalRequestSchema.safeParse({ ...request, preview: {} }).success).toBe(false);
    expect(connectorNativeRequestSchema.safeParse(request).success).toBe(false);
  });

  it("leaves v40 state-action responses strict against removal receipts", () => {
    expect(nativeConnectorActionResponseSchema.safeParse(envelope({ action, replayed: false }, true)).success).toBe(false);
    expect(nativeConnectorReadResponseSchema.safeParse(envelope({ action }, false)).success).toBe(false);
  });

  it("binds response content, service operation, event contract and immutable key", () => {
    const valid = envelope({ action, replayed: false }, true);
    expect(nativeConnectorCredentialRemovalSubmitResponseSchema.safeParse({ ...valid, replayed: true }).success).toBe(false);
    for (const overrides of [{ operation: "app.connectors.native.act" }, { eventContract: "connector-native-events.v1" },
      { idempotencyKeySha256: "f".repeat(64) }, { resourceCount: 0 }, { accessMode: "read" as const }, { action: "read" }]) {
      expect(nativeConnectorCredentialRemovalSubmitResponseSchema.safeParse(envelope({ action, replayed: false }, true, overrides)).success).toBe(false);
    }
  });

  it("binds the current response owner and exact frozen intent", () => {
    const response = nativeConnectorCredentialRemovalSubmitResponseSchema.parse(envelope({ action, replayed: true }, true));
    for (const changed of [
      { ...expected, scope: { ...scope, tenantId: "another-tenant" } },
      { ...expected, role: "viewer" }, { ...expected, idempotencyKey: "another-key" },
      { ...expected, request: { ...request, review: sealConnectorNativePin({ ...pinBody, credentialVersion: 3 }) } },
    ]) expect(() => assertNativeConnectorCredentialRemovalResponseScope(response, changed)).toThrow();
  });

  it("requires an exact single credential-version advancement even with valid receipt digests", () => {
    const changedBody = { ...settlementBody, result: { ...settlementBody.result, credentialVersion: 4 } };
    const changed = connectorNativeCredentialRemovalActionSchema.parse({ ...action,
      settlement: { ...changedBody, settlementSha256: canonicalJsonSha256(changedBody) } });
    const response = nativeConnectorCredentialRemovalSubmitResponseSchema.parse(envelope({ action: changed, replayed: false }, true));
    expect(() => assertNativeConnectorCredentialRemovalResponseScope(response, expected)).toThrow("frozen action");
  });

  it("supports exact read-only recovery and authenticated absence without admitting mutation evidence", () => {
    const response = nativeConnectorCredentialRemovalReadResponseSchema.parse(envelope({ action }, false));
    expect(() => assertNativeConnectorCredentialRemovalResponseScope(response, {
      scope, requestActorId: scope.ownerActorId, role: "admin", keySha256: intent.keySha256,
    })).not.toThrow();
    expect(() => assertNativeConnectorCredentialRemovalResponseScope(response, {
      scope, requestActorId: scope.ownerActorId, role: "admin", keySha256: "f".repeat(64),
    })).toThrow("recovery key");
    expect(nativeConnectorCredentialRemovalReadResponseSchema.parse(envelope({ action: null }, false)).action).toBeNull();
    expect(nativeConnectorCredentialRemovalReadResponseSchema.safeParse(envelope({ action }, true)).success).toBe(false);
    expect(nativeConnectorCredentialRemovalReadResponseSchema.safeParse(envelope({ action: null }, false, { resourceCount: 1 })).success).toBe(false);
  });
});
