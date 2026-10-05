import { describe, expect, it } from "vitest";
import { APP_SERVICE_BOUNDARY_VERSION, type AppServiceReceipt } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeAcceptanceId, connectorNativeReviewSchema,
  connectorNativeTrashTarget, sealConnectorNativePin } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeTrashIntent, connectorNativeTrashActionSchema, connectorNativeTrashCompensation,
  connectorNativeTrashEffectSummary, connectorNativeTrashRequestSchema } from "@/lib/connectors/native-trash-contracts";
import { nativeConnectorActionResponseSchema, nativeConnectorReadResponseSchema } from "@/lib/mobile/connector-native-contracts";
import { nativeConnectorCredentialRemovalReadResponseSchema, nativeConnectorCredentialRemovalSubmitResponseSchema } from "@/lib/mobile/connector-credential-removal-contracts";
import { assertNativeConnectorTrashResponseScope, nativeConnectorTrashPreviewResponseSchema,
  nativeConnectorTrashReadResponseSchema, nativeConnectorTrashSubmitResponseSchema } from "@/lib/mobile/connector-trash-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { buildTrashActionPreviewV1 } from "@/lib/trash/contracts";

const scope = { tenantId: "trash-publication", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
const idempotencyKey = "trash-publication-once";
const connector = { kind: "mcp" as const, id: "connector-one", name: "Notes", endpoint: "https://example.test/mcp", endpointRedacted: true,
  status: "active" as const, authType: "bearer_vault" as const, authTokenEnv: null, authHeaderName: null, credentialConfigured: true,
  credentialVersion: 2, credentialOriginMatch: false, defaultRiskLevel: 2 as const, approvalRequired: true, contractCount: 0,
  discoveredAt: null, updatedAt: "2026-10-05T01:00:00.000Z" };
const pin = sealConnectorNativePin({ kind: "mcp", connectorId: connector.id, connectorSha256: canonicalJsonSha256(connector),
  contractsSha256: canonicalJsonSha256([]), configurationSha256: "c".repeat(64), reviewFingerprint: null, credentialVersion: 2 });
const review = connectorNativeReviewSchema.parse({ connector, contracts: [], pin, availableActions: [], unavailableReason: null });
const preview = buildTrashActionPreviewV1({ version: "p9.3-trash-preview:1", action: "trash", trashId: null, resourceType: "mcp_connector",
  resourceId: connector.id, lifecycleRevision: 0, targetSha256: canonicalJsonSha256(connectorNativeTrashTarget(pin)),
  effectSummary: connectorNativeTrashEffectSummary(review), reversible: true, issuedAt: "2026-10-05T01:00:00.000Z", expiresAt: "2026-10-05T01:10:00.000Z" });
const compensation = connectorNativeTrashCompensation(review);
const request = connectorNativeTrashRequestSchema.parse({ contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: connector.id,
  action: "trash", review: pin, preview });
const intent = buildConnectorNativeTrashIntent(scope, idempotencyKey, request);
const executionScope = createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: scope.ownerActorId,
  executingPrincipalType: "user", executingPrincipalId: scope.ownerActorId, correlationId: "trash-publication", causationId: connector.id,
  purpose: "api.connectors.native.action" });
const acceptanceBody = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, intent.keySha256), scope,
  keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent), kind: "mcp", connectorId: connector.id,
  action: "trash", reviewSha256: pin.reviewSha256, acceptedAt: "2026-10-05T01:00:01.000Z" };
const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptanceBody.id, settledAt: "2026-10-05T01:00:01.001Z",
  result: { kind: "mcp", connectorId: connector.id, operation: "trash", status: "complete", connectorStatus: null, contractCount: null,
    credentialVersion: null, connectorSha256: null, contractsSha256: null, configurationSha256: null, failureCode: null,
    trash: { trashId: "trash:11111111-1111-4111-8111-111111111111", proofSha256: "d".repeat(64), restoreUntil: "2026-11-04T01:00:01.000Z",
      compensation: compensation.kind, limitation: compensation.limitation } } };
const action = connectorNativeTrashActionSchema.parse({ acceptance: { ...acceptanceBody, acceptanceSha256: canonicalJsonSha256(acceptanceBody) },
  state: "settled", settlement: { ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) } });

function envelope(body: Record<string, unknown>, kind: "preview" | "submit" | "read", overrides: Partial<AppServiceReceipt> = {}) {
  const data = { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope, ...body }, mutation = kind === "submit";
  const proof = { schemaVersion: 1 as const, receiptKind: "app_service_receipt" as const, boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    ...getAppServiceOperationContract(`app.connectors.native.trash.${kind}`),
    authoritySha256: canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: scope.tenantId,
      actorId: scope.ownerActorId, role: "admin", executionScope: mutation ? executionScope : null }),
    idempotencyKeySha256: mutation ? intent.keySha256 : null, outcomeSha256: canonicalJsonSha256(data),
    resourceCount: kind === "preview" ? body.review ? 1 : 0 : body.action ? 1 : 0, occurredAt: "2026-10-05T01:00:01.002Z", ...overrides };
  return { ...data, serviceReceipt: { ...proof, receiptSha256: canonicalJsonSha256(proof) } };
}
const expected = { scope, requestActorId: scope.ownerActorId, role: "admin", executionScope, idempotencyKey, request };

describe("native MCP Trash publication", () => {
  it("binds a manager-only read preview to its exact review, compensation and target", () => {
    const response = nativeConnectorTrashPreviewResponseSchema.parse(envelope({ review, preview, compensation }, "preview"));
    expect(response.serviceReceipt).toMatchObject({ action: "manage.connector", accessMode: "read", idempotencyKeySha256: null });
    const authority = { scope, requestActorId: scope.ownerActorId, role: "admin", connectorId: connector.id };
    expect(() => assertNativeConnectorTrashResponseScope(response, authority)).not.toThrow();
    expect(() => assertNativeConnectorTrashResponseScope(response, { ...authority, connectorId: "another-connector" })).toThrow("target");
    expect(nativeConnectorTrashPreviewResponseSchema.safeParse(envelope({ review, preview, compensation }, "preview", { action: "read" })).success).toBe(false);
    expect(nativeConnectorTrashPreviewResponseSchema.safeParse(envelope({ review, preview: null, compensation }, "preview")).success).toBe(false);
    expect(nativeConnectorTrashPreviewResponseSchema.safeParse(envelope({ review, preview, compensation: { kind: "exact_restore", handlerId: "trash.restore.mcp_connector", limitation: null } }, "preview")).success).toBe(false);
  });

  it("reports authenticated missing or unavailable review without inventing a Trash preview", () => {
    const absent = nativeConnectorTrashPreviewResponseSchema.parse(envelope({ review: null, preview: null, compensation: null }, "preview"));
    expect(absent.serviceReceipt.resourceCount).toBe(0);
    const unavailable = { ...review, pin: null, availableActions: [], unavailableReason: "scope_too_large" };
    expect(nativeConnectorTrashPreviewResponseSchema.parse(envelope({ review: unavailable, preview: null, compensation: null }, "preview")).serviceReceipt.resourceCount).toBe(1);
    expect(nativeConnectorTrashPreviewResponseSchema.safeParse(envelope({ review: null, preview, compensation }, "preview")).success).toBe(false);
  });

  it("accepts only its exact intent and local Trash settlement", () => {
    const response = nativeConnectorTrashSubmitResponseSchema.parse(envelope({ action, replayed: false }, "submit"));
    expect(() => assertNativeConnectorTrashResponseScope(response, expected)).not.toThrow();
    expect(response.action.settlement?.result).toMatchObject({ operation: "trash", connectorStatus: null, credentialVersion: null,
      trash: { compensation: "equivalent_action", limitation: compensation.limitation } });
    const { previewSha256: _previewSha256, ...previewBody } = preview;
    const changedPreview = buildTrashActionPreviewV1({ ...previewBody, issuedAt: "2026-10-05T01:01:00.000Z", expiresAt: "2026-10-05T01:11:00.000Z" });
    const changedRequest = connectorNativeTrashRequestSchema.parse({ ...request, preview: changedPreview });
    for (const changed of [{ ...expected, idempotencyKey: "another-key" }, { ...expected, request: changedRequest },
      { ...expected, role: "viewer" }, { ...expected, scope: { ...scope, canonicalActorId: "actor:22222222-2222-4222-8222-222222222222" } }]) {
      expect(() => assertNativeConnectorTrashResponseScope(response, changed)).toThrow();
    }
  });

  it("keeps earlier state and credential-removal response families strict", () => {
    const submit = envelope({ action, replayed: false }, "submit"), read = envelope({ action }, "read");
    expect(nativeConnectorActionResponseSchema.safeParse(submit).success).toBe(false);
    expect(nativeConnectorReadResponseSchema.safeParse(read).success).toBe(false);
    expect(nativeConnectorCredentialRemovalSubmitResponseSchema.safeParse(submit).success).toBe(false);
    expect(nativeConnectorCredentialRemovalReadResponseSchema.safeParse(read).success).toBe(false);
    for (const operation of ["remove_credential", "restore", "purge", "discover", "enable", "register_mcp"]) {
      expect(connectorNativeTrashRequestSchema.safeParse({ ...request, action: operation }).success).toBe(false);
    }
    expect(connectorNativeTrashRequestSchema.safeParse({ ...request, bearerToken: "unpublished" }).success).toBe(false);
  });

  it("rejects resealed service-operation, outcome, key, authority-mode and event mismatches", () => {
    const valid = envelope({ action, replayed: false }, "submit");
    expect(nativeConnectorTrashSubmitResponseSchema.safeParse({ ...valid, replayed: true }).success).toBe(false);
    for (const overrides of [{ operation: "app.connectors.native.act" }, { eventContract: "connector-native-events.v1" },
      { idempotencyKeySha256: "f".repeat(64) }, { resourceCount: 0 }, { accessMode: "read" as const }, { action: "read" }]) {
      expect(nativeConnectorTrashSubmitResponseSchema.safeParse(envelope({ action, replayed: false }, "submit", overrides)).success).toBe(false);
    }
  });

  it("recovers by exact key after target removal and preview expiry using current read authority", () => {
    const response = nativeConnectorTrashReadResponseSchema.parse(envelope({ action }, "read"));
    const authority = { scope, requestActorId: scope.ownerActorId, role: "admin", keySha256: intent.keySha256 };
    expect(() => assertNativeConnectorTrashResponseScope(response, authority)).not.toThrow();
    expect(() => assertNativeConnectorTrashResponseScope(response, { ...authority, keySha256: "e".repeat(64) })).toThrow("key");
    expect(() => assertNativeConnectorTrashResponseScope(response, { ...authority, requestActorId: "different@example.test" })).toThrow("authority");
    expect(nativeConnectorTrashReadResponseSchema.parse(envelope({ action: null }, "read")).action).toBeNull();
    expect(nativeConnectorTrashReadResponseSchema.safeParse(envelope({ action }, "read", { idempotencyKeySha256: intent.keySha256 })).success).toBe(false);
    expect(nativeConnectorTrashReadResponseSchema.safeParse(envelope({ action }, "read", { eventContract: "connector-native-trash-events.v1" })).success).toBe(false);
    expect(nativeConnectorTrashReadResponseSchema.safeParse(envelope({ action }, "read", { resourceCount: 0 })).success).toBe(false);
  });
});
