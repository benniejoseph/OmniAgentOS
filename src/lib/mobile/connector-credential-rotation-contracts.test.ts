import { describe, expect, it } from "vitest";
import { APP_SERVICE_BOUNDARY_VERSION, type AppServiceReceipt } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeAcceptanceId, connectorNativePreparationId, sealConnectorNativePin } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeCredentialPreparationIntent, buildConnectorNativeCredentialRotationIntent,
  connectorNativeCredentialPreparationAbandonmentId, connectorNativeCredentialPreparationSchema,
  connectorNativeCredentialPrepareRequestSchema, connectorNativeCredentialRotationActionSchema,
  connectorNativeCredentialRotationRequestSchema } from "@/lib/connectors/native-credential-rotation-contracts";
import { nativeConnectorActionResponseSchema } from "@/lib/mobile/connector-native-contracts";
import { nativeConnectorCredentialRemovalSubmitResponseSchema } from "@/lib/mobile/connector-credential-removal-contracts";
import { nativeConnectorTrashSubmitResponseSchema } from "@/lib/mobile/connector-trash-contracts";
import { assertNativeConnectorCredentialPreparationResponseScope, assertNativeConnectorCredentialRotationResponseScope,
  nativeConnectorCredentialPreparationSubmitResponseSchema, nativeConnectorCredentialPreparationReadResponseSchema,
  nativeConnectorCredentialPreparationAbandonResponseSchema, nativeConnectorCredentialRotationSubmitResponseSchema,
  nativeConnectorCredentialRotationReadResponseSchema } from "@/lib/mobile/connector-credential-rotation-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const scope = { tenantId: "rotation-publication", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
const prepareKey = "prepare-publication-once", rotationKey = "rotate-publication-once";
const pin = sealConnectorNativePin({ kind: "mcp", connectorId: "connector-one", connectorSha256: "a".repeat(64),
  contractsSha256: canonicalJsonSha256([]), configurationSha256: "b".repeat(64), reviewFingerprint: null, credentialVersion: 0 });
const { reviewSha256: _reviewSha256, ...pinBody } = pin;
const token = "synthetic-private-bearer";
const prepareRequest = connectorNativeCredentialPrepareRequestSchema.parse({ contract: "asael-connector-prepare:1", operation: "rotate_mcp", connectorId: pin.connectorId,
  nonce: "11111111-1111-4111-8111-111111111111", review: pin,
  declaration: { name: "Notes", endpoint: "https://example.test/mcp", endpointRedacted: true, authType: "bearer_vault",
    authTokenEnv: null, authHeaderName: null, defaultRiskLevel: 2, approvalRequired: true, specSource: "none", specUrl: null, specUrlRedacted: false },
  payload: { endpoint: null, specUrl: null, specText: null, bearerToken: token } });
const preparationIntent = buildConnectorNativeCredentialPreparationIntent(scope, prepareKey, prepareRequest);
const { contract: _intentContract, ...intentFields } = preparationIntent;
const proofBody = { contract: "asael-connector-preparation:1", ...intentFields, id: connectorNativePreparationId(scope, preparationIntent.keySha256),
  intentSha256: canonicalJsonSha256(preparationIntent), configurationSha256: pin.configurationSha256,
  preparedAt: "2026-10-05T08:00:00.000Z", expiresAt: "2026-10-05T08:15:00.000Z" };
const preparation = connectorNativeCredentialPreparationSchema.parse({ ...proofBody, preparationSha256: canonicalJsonSha256(proofBody) });
const ready = { preparation, availability: "ready" as const, consumedBy: null, consumedKeySha256: null };
const rotationRequest = connectorNativeCredentialRotationRequestSchema.parse({ contract: "asael-connector-prepared-action:1", kind: "mcp",
  connectorId: pin.connectorId, action: "rotate_mcp", preparationId: preparation.id, preparationSha256: preparation.preparationSha256, review: pin });
const rotationIntent = buildConnectorNativeCredentialRotationIntent(scope, rotationKey, rotationRequest);
const acceptanceBody = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, rotationIntent.keySha256), scope,
  keySha256: rotationIntent.keySha256, requestSha256: canonicalJsonSha256(rotationIntent), kind: "mcp", connectorId: pin.connectorId,
  action: "rotate_mcp", reviewSha256: preparation.preparationSha256, acceptedAt: "2026-10-05T08:01:00.000Z" };
const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptanceBody.id, settledAt: "2026-10-05T08:01:00.001Z",
  result: { kind: "mcp", connectorId: pin.connectorId, operation: "rotate_mcp", status: "complete", connectorStatus: "disabled", contractCount: 0,
    credentialVersion: 1, connectorSha256: "c".repeat(64), contractsSha256: canonicalJsonSha256([]), configurationSha256: "d".repeat(64), trash: null, failureCode: null } };
const action = connectorNativeCredentialRotationActionSchema.parse({ acceptance: { ...acceptanceBody, acceptanceSha256: canonicalJsonSha256(acceptanceBody) },
  state: "settled", settlement: { ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) } });
const consumed = { preparation, availability: "consumed" as const, consumedBy: acceptanceBody.id, consumedKeySha256: rotationIntent.keySha256 };
function abandoned(prepared = false) {
  const body = { contract: "asael-connector-credential-preparation-abandonment:1", id: connectorNativeCredentialPreparationAbandonmentId(scope, preparationIntent.keySha256),
    scope, keySha256: preparationIntent.keySha256, intentSha256: canonicalJsonSha256(preparationIntent), preparationSha256: prepared ? preparation.preparationSha256 : null,
    abandonedAt: "2026-10-05T08:02:00.000Z" };
  return { intent: preparationIntent, preparation: prepared ? preparation : null, availability: "abandoned" as const,
    consumedBy: null, consumedKeySha256: null, abandonment: { ...body, abandonmentSha256: canonicalJsonSha256(body) } };
}
const executionScope = createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: scope.ownerActorId, executingPrincipalType: "user",
  executingPrincipalId: scope.ownerActorId, correlationId: "rotation-publication", causationId: pin.connectorId, purpose: "api.connectors.native.action" });
const cleanupScope = createExecutionScope({ ...executionScope, purpose: "api.connectors.native.preparation.abandon" });
const operations = { prepare: "app.connectors.native.credentialPreparations.submit", preparationRead: "app.connectors.native.credentialPreparations.read",
  abandon: "app.connectors.native.credentialPreparations.abandon", rotate: "app.connectors.native.credentialRotations.submit", rotationRead: "app.connectors.native.credentialRotations.read" } as const;
type Kind = keyof typeof operations;
function envelope(body: Record<string, unknown>, kind: Kind, overrides: Partial<AppServiceReceipt> = {}, role = "admin") {
  const data = { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope, ...body }, mutation = kind === "prepare" || kind === "abandon" || kind === "rotate";
  const proof = { schemaVersion: 1 as const, receiptKind: "app_service_receipt" as const, boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    ...getAppServiceOperationContract(operations[kind]), authoritySha256: canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
      tenantId: scope.tenantId, actorId: scope.ownerActorId, role, executionScope: mutation ? kind === "abandon" ? cleanupScope : executionScope : null }),
    idempotencyKeySha256: mutation ? kind === "rotate" ? rotationIntent.keySha256 : preparationIntent.keySha256 : null,
    outcomeSha256: canonicalJsonSha256(data), resourceCount: body.prepared || body.action ? 1 : 0, occurredAt: "2026-10-05T08:02:00.001Z", ...overrides };
  return { ...data, serviceReceipt: { ...proof, receiptSha256: canonicalJsonSha256(proof) } };
}
const authority = { scope, requestActorId: scope.ownerActorId, role: "admin" };

describe("native prepared MCP credential publication", () => {
  it("binds safe preparation evidence to its exact original intent without exposing the transient token", () => {
    const response = nativeConnectorCredentialPreparationSubmitResponseSchema.parse(envelope({ prepared: ready, replayed: false }, "prepare"));
    const expected = { ...authority, executionScope, idempotencyKey: prepareKey, intent: preparationIntent };
    expect(() => assertNativeConnectorCredentialPreparationResponseScope(response, expected)).not.toThrow();
    expect(JSON.stringify(response)).not.toContain(token);
    expect(JSON.stringify(response)).not.toContain(prepareKey);
    for (const changed of [{ ...expected, idempotencyKey: "another-key" }, { ...expected, role: "viewer" },
      { ...expected, intent: { ...preparationIntent, nonce: "22222222-2222-4222-8222-222222222222" } },
      { ...expected, scope: { ...scope, canonicalActorId: "actor:22222222-2222-4222-8222-222222222222" } }]) {
      expect(() => assertNativeConnectorCredentialPreparationResponseScope(response, changed)).toThrow();
    }
  });
  it("distinguishes read-only null, ready, expired and exact consumed recovery", () => {
    for (const prepared of [null, ready, { ...ready, availability: "expired" }, consumed, abandoned(), abandoned(true)]) {
      const response = nativeConnectorCredentialPreparationReadResponseSchema.parse(envelope({ prepared }, "preparationRead", {}, "viewer"));
      expect(() => assertNativeConnectorCredentialPreparationResponseScope(response, { ...authority, role: "viewer", keySha256: preparationIntent.keySha256 })).not.toThrow();
      expect(response.serviceReceipt).toMatchObject({ action: "read", accessMode: "read", idempotencyKeySha256: null, resourceCount: prepared ? 1 : 0 });
    }
    expect(nativeConnectorCredentialPreparationReadResponseSchema.safeParse(envelope({ prepared: { ...consumed, consumedKeySha256: "f".repeat(64) } }, "preparationRead")).success).toBe(false);
    expect(nativeConnectorCredentialPreparationReadResponseSchema.safeParse(envelope({ prepared: { ...ready, consumedBy: consumed.consumedBy } }, "preparationRead")).success).toBe(false);
    const response = nativeConnectorCredentialPreparationReadResponseSchema.parse(envelope({ prepared: ready }, "preparationRead"));
    expect(() => assertNativeConnectorCredentialPreparationResponseScope(response, { ...authority, keySha256: "f".repeat(64) })).toThrow("key");
  });
  it("admits abandonment as an owner mutation after management loss, including an honest absent-key tombstone", () => {
    for (const prepared of [abandoned(), abandoned(true)]) {
      const response = nativeConnectorCredentialPreparationAbandonResponseSchema.parse(envelope({ prepared, replayed: false }, "abandon", {}, "viewer"));
      const expected = { ...authority, role: "viewer", executionScope: cleanupScope, idempotencyKey: prepareKey,
        keySha256: preparationIntent.keySha256, intent: preparationIntent };
      expect(() => assertNativeConnectorCredentialPreparationResponseScope(response, expected)).not.toThrow();
      expect(response.serviceReceipt).toMatchObject({ action: "read", accessMode: "mutation", eventContract: "connector-native-credential-preparation-events.v1", resourceCount: 1 });
      expect(() => assertNativeConnectorCredentialPreparationResponseScope(response, { ...expected, executionScope })).toThrow("authority");
    }
    const tombstone = abandoned();
    expect(tombstone.preparation).toBeNull(); expect(tombstone.abandonment.preparationSha256).toBeNull();
    expect(JSON.stringify(tombstone)).not.toContain("expiresAt"); expect(JSON.stringify(tombstone)).not.toContain("preparedAt");
    expect(nativeConnectorCredentialPreparationAbandonResponseSchema.safeParse(envelope({ prepared: { ...tombstone, preparation }, replayed: false }, "abandon")).success).toBe(false);
  });
  it("keeps prepare and abandon success branches disjoint", () => {
    expect(nativeConnectorCredentialPreparationSubmitResponseSchema.safeParse(envelope({ prepared: abandoned(), replayed: true }, "prepare")).success).toBe(false);
    for (const prepared of [ready, consumed, null]) {
      expect(nativeConnectorCredentialPreparationAbandonResponseSchema.safeParse(envelope({ prepared, replayed: false }, "abandon")).success).toBe(false);
    }
    expect(nativeConnectorCredentialPreparationSubmitResponseSchema.parse(envelope({ prepared: consumed, replayed: true }, "prepare")).replayed).toBe(true);
  });
  it("binds final local save to the prepared proof and the original reviewed version", () => {
    const response = nativeConnectorCredentialRotationSubmitResponseSchema.parse(envelope({ action, replayed: false }, "rotate"));
    const expected = { ...authority, executionScope, idempotencyKey: rotationKey, request: rotationRequest };
    expect(() => assertNativeConnectorCredentialRotationResponseScope(response, expected)).not.toThrow();
    expect(response.action.settlement?.result).toMatchObject({ operation: "rotate_mcp", connectorStatus: "disabled", contractCount: 0, credentialVersion: 1 });
    for (const changed of [{ ...expected, idempotencyKey: prepareKey }, { ...expected, request: { ...rotationRequest, preparationSha256: "e".repeat(64) } },
      { ...expected, request: { ...rotationRequest, review: sealConnectorNativePin({ ...pinBody, credentialVersion: 1 }) } }]) {
      expect(() => assertNativeConnectorCredentialRotationResponseScope(response, changed)).toThrow();
    }
    const changedSettlement = { ...settlementBody, result: { ...settlementBody.result, credentialVersion: 2 } };
    const changedAction = { ...action, settlement: { ...changedSettlement, settlementSha256: canonicalJsonSha256(changedSettlement) } };
    const changedResponse = nativeConnectorCredentialRotationSubmitResponseSchema.parse(envelope({ action: changedAction, replayed: false }, "rotate"));
    expect(() => assertNativeConnectorCredentialRotationResponseScope(changedResponse, expected)).toThrow("frozen action");
  });
  it("recovers final evidence by its exact action key without management or preparation mutation", () => {
    const response = nativeConnectorCredentialRotationReadResponseSchema.parse(envelope({ action }, "rotationRead", {}, "viewer"));
    const expected = { ...authority, role: "viewer", keySha256: rotationIntent.keySha256 };
    expect(() => assertNativeConnectorCredentialRotationResponseScope(response, expected)).not.toThrow();
    expect(() => assertNativeConnectorCredentialRotationResponseScope(response, { ...expected, keySha256: preparationIntent.keySha256 })).toThrow("key");
    expect(nativeConnectorCredentialRotationReadResponseSchema.parse(envelope({ action: null }, "rotationRead")).action).toBeNull();
  });
  it("rejects resealed operation, mode, event, key, count, resource and scope substitutions", () => {
    const cases = [
      { body: { prepared: ready, replayed: false }, kind: "prepare" as const, schema: nativeConnectorCredentialPreparationSubmitResponseSchema },
      { body: { prepared: abandoned(), replayed: false }, kind: "abandon" as const, schema: nativeConnectorCredentialPreparationAbandonResponseSchema },
      { body: { action, replayed: false }, kind: "rotate" as const, schema: nativeConnectorCredentialRotationSubmitResponseSchema },
    ];
    for (const sample of cases) {
      for (const overrides of [{ operation: "app.connectors.native.act" }, { accessMode: "read" as const }, { eventContract: "read_only:no_domain_mutation" },
        { idempotencyKeySha256: "f".repeat(64) }, { resourceCount: 0 }, { resourceType: "unrelated_resource" }, { outcomeSha256: "f".repeat(64) }]) {
        expect(sample.schema.safeParse(envelope(sample.body, sample.kind, overrides)).success).toBe(false);
      }
      const valid = envelope(sample.body, sample.kind);
      expect(sample.schema.safeParse({ ...valid, replayed: true }).success).toBe(false);
      expect(sample.schema.safeParse(envelope({ ...sample.body, scope: { ...scope, ownerActorId: "other@example.test" } }, sample.kind)).success).toBe(false);
    }
    expect(nativeConnectorCredentialPreparationAbandonResponseSchema.safeParse(envelope({ prepared: abandoned(), replayed: false }, "abandon", { action: "manage.connector" })).success).toBe(false);
    expect(nativeConnectorCredentialPreparationReadResponseSchema.safeParse(envelope({ prepared: ready }, "preparationRead", { idempotencyKeySha256: preparationIntent.keySha256 })).success).toBe(false);
    expect(nativeConnectorCredentialRotationReadResponseSchema.safeParse(envelope({ action }, "rotationRead", { eventContract: "connector-native-credential-rotation-events.v1" })).success).toBe(false);
  });
  it("refuses any secret-bearing response field and preserves old action families", () => {
    for (const extra of [{ bearerToken: token }, { sealedCredential: {} }, { tokenCommitment: "e".repeat(64) }]) {
      expect(nativeConnectorCredentialPreparationSubmitResponseSchema.safeParse(envelope({ prepared: { ...ready, ...extra }, replayed: false }, "prepare")).success).toBe(false);
      expect(nativeConnectorCredentialPreparationSubmitResponseSchema.safeParse(envelope({ prepared: ready, replayed: false, ...extra }, "prepare")).success).toBe(false);
    }
    const response = envelope({ action, replayed: false }, "rotate");
    for (const schema of [nativeConnectorActionResponseSchema, nativeConnectorCredentialRemovalSubmitResponseSchema, nativeConnectorTrashSubmitResponseSchema]) {
      expect(schema.safeParse(response).success).toBe(false);
    }
  });
});
