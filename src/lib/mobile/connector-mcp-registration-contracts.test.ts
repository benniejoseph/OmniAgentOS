import { describe, expect, it } from "vitest";
import { APP_SERVICE_BOUNDARY_VERSION, type AppServiceReceipt } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT } from "@/lib/connectors/native-control-contracts";
import { nativeConnectorActionResponseSchema } from "@/lib/mobile/connector-native-contracts";
import { nativeConnectorCredentialRemovalSubmitResponseSchema } from "@/lib/mobile/connector-credential-removal-contracts";
import { nativeConnectorTrashSubmitResponseSchema } from "@/lib/mobile/connector-trash-contracts";
import { nativeConnectorCredentialPreparationSubmitResponseSchema, nativeConnectorCredentialRotationSubmitResponseSchema } from "@/lib/mobile/connector-credential-rotation-contracts";
import { assertNativeConnectorMcpRegistrationPreparationResponseScope, assertNativeConnectorMcpRegistrationResponseScope,
  nativeConnectorMcpRegistrationPreparationSubmitResponseSchema, nativeConnectorMcpRegistrationPreparationReadResponseSchema,
  nativeConnectorMcpRegistrationPreparationAbandonResponseSchema, nativeConnectorMcpRegistrationSubmitResponseSchema,
  nativeConnectorMcpRegistrationReadResponseSchema } from "@/lib/mobile/connector-mcp-registration-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { nativeMcpRegistrationFixture } from "../../../tests/fixtures/native-mcp-registration";

const fixture = nativeMcpRegistrationFixture("bearer_vault", true);
const { scope, connectorId, preparationKey, registrationKey, preparationIntent, registrationIntent, registrationRequest,
  preparedReady, preparedExpired, preparedConsumed, abandonedAbsent, abandonedPrepared, registrationAction } = fixture;
const executionScope = createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: scope.ownerActorId, executingPrincipalType: "user",
  executingPrincipalId: scope.ownerActorId, correlationId: "registration-publication", causationId: connectorId, purpose: "api.connectors.native.action" });
const cleanupScope = createExecutionScope({ ...executionScope, purpose: "api.connectors.native.mcp_registration_preparation.abandon" });
const operations = { prepare: "app.connectors.native.mcpRegistrationPreparations.submit", preparationRead: "app.connectors.native.mcpRegistrationPreparations.read",
  abandon: "app.connectors.native.mcpRegistrationPreparations.abandon", register: "app.connectors.native.mcpRegistrations.submit", registrationRead: "app.connectors.native.mcpRegistrations.read" } as const;
type Kind = keyof typeof operations;
function envelope(body: Record<string, unknown>, kind: Kind, overrides: Partial<AppServiceReceipt> = {}, role = "admin") {
  const data = { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope, ...body }, mutation = kind === "prepare" || kind === "abandon" || kind === "register";
  const proof = { schemaVersion: 1 as const, receiptKind: "app_service_receipt" as const, boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    ...getAppServiceOperationContract(operations[kind]), authoritySha256: canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
      tenantId: scope.tenantId, actorId: scope.ownerActorId, role, executionScope: mutation ? kind === "abandon" ? cleanupScope : executionScope : null }),
    idempotencyKeySha256: mutation ? kind === "register" ? registrationIntent.keySha256 : preparationIntent.keySha256 : null,
    outcomeSha256: canonicalJsonSha256(data), resourceCount: body.prepared || body.action ? 1 : 0, occurredAt: "2026-10-05T08:02:00.001Z", ...overrides };
  return { ...data, serviceReceipt: { ...proof, receiptSha256: canonicalJsonSha256(proof) } };
}
const authority = { scope, requestActorId: scope.ownerActorId, role: "admin" };

describe("native prepared MCP registration publication", () => {
  it("binds preparation evidence to the original safe intent without private endpoint or token input", () => {
    const response = nativeConnectorMcpRegistrationPreparationSubmitResponseSchema.parse(envelope({ prepared: preparedReady, replayed: false }, "prepare"));
    const expected = { ...authority, executionScope, idempotencyKey: preparationKey, intent: preparationIntent };
    expect(() => assertNativeConnectorMcpRegistrationPreparationResponseScope(response, expected)).not.toThrow();
    for (const privateInput of ["synthetic-fixture-only", "synthetic-private-query", "synthetic-fragment", preparationKey]) {
      expect(JSON.stringify(response)).not.toContain(privateInput);
    }
    for (const changed of [{ ...expected, idempotencyKey: "another-key" }, { ...expected, role: "viewer" },
      { ...expected, intent: { ...preparationIntent, nonce: "22222222-2222-4222-8222-222222222222" } },
      { ...expected, scope: { ...scope, canonicalActorId: "actor:22222222-2222-4222-8222-222222222222" } }]) {
      expect(() => assertNativeConnectorMcpRegistrationPreparationResponseScope(response, changed)).toThrow();
    }
  });
  it("distinguishes read-only null, ready, expired, consumed and abandonment recovery", () => {
    for (const prepared of [null, preparedReady, preparedExpired, preparedConsumed, abandonedAbsent, abandonedPrepared]) {
      const response = nativeConnectorMcpRegistrationPreparationReadResponseSchema.parse(envelope({ prepared }, "preparationRead", {}, "viewer"));
      expect(() => assertNativeConnectorMcpRegistrationPreparationResponseScope(response, { ...authority, role: "viewer", keySha256: preparationIntent.keySha256 })).not.toThrow();
      expect(response.serviceReceipt).toMatchObject({ action: "read", accessMode: "read", idempotencyKeySha256: null, resourceCount: prepared ? 1 : 0 });
    }
    expect(nativeConnectorMcpRegistrationPreparationReadResponseSchema.safeParse(envelope({ prepared: { ...preparedConsumed, consumedKeySha256: "f".repeat(64) } }, "preparationRead")).success).toBe(false);
    expect(nativeConnectorMcpRegistrationPreparationReadResponseSchema.safeParse(envelope({ prepared: { ...preparedReady, consumedBy: "connector-acceptance:" + "f".repeat(64) } }, "preparationRead")).success).toBe(false);
    const response = nativeConnectorMcpRegistrationPreparationReadResponseSchema.parse(envelope({ prepared: preparedReady }, "preparationRead"));
    expect(() => assertNativeConnectorMcpRegistrationPreparationResponseScope(response, { ...authority, keySha256: "f".repeat(64) })).toThrow("key");
  });
  it("binds owner cleanup to its distinct mutation purpose and honest absent-key tombstone", () => {
    for (const prepared of [abandonedAbsent, abandonedPrepared]) {
      const response = nativeConnectorMcpRegistrationPreparationAbandonResponseSchema.parse(envelope({ prepared, replayed: false }, "abandon", {}, "viewer"));
      const expected = { ...authority, role: "viewer", executionScope: cleanupScope, idempotencyKey: preparationKey,
        keySha256: preparationIntent.keySha256, intent: preparationIntent };
      expect(() => assertNativeConnectorMcpRegistrationPreparationResponseScope(response, expected)).not.toThrow();
      expect(response.serviceReceipt).toMatchObject({ action: "read", accessMode: "mutation", eventContract: "connector-native-mcp-registration-preparation-events.v1" });
      expect(() => assertNativeConnectorMcpRegistrationPreparationResponseScope(response, { ...expected, executionScope })).toThrow("authority");
    }
    expect(abandonedAbsent.preparation).toBeNull();
    expect(JSON.stringify(abandonedAbsent)).not.toContain("expiresAt"); expect(JSON.stringify(abandonedAbsent)).not.toContain("preparedAt");
    expect(nativeConnectorMcpRegistrationPreparationAbandonResponseSchema.safeParse(envelope({ prepared: { ...abandonedAbsent, preparation: fixture.preparation }, replayed: false }, "abandon")).success).toBe(false);
  });
  it("keeps prepare success and abandonment disjoint while permitting consumed same-key recovery", () => {
    expect(nativeConnectorMcpRegistrationPreparationSubmitResponseSchema.safeParse(envelope({ prepared: abandonedAbsent, replayed: true }, "prepare")).success).toBe(false);
    for (const prepared of [preparedReady, preparedConsumed, null]) {
      expect(nativeConnectorMcpRegistrationPreparationAbandonResponseSchema.safeParse(envelope({ prepared, replayed: false }, "abandon")).success).toBe(false);
    }
    expect(nativeConnectorMcpRegistrationPreparationSubmitResponseSchema.parse(envelope({ prepared: preparedConsumed, replayed: true }, "prepare")).replayed).toBe(true);
  });
  it("binds local creation to the prepared proof and exact final action identity", () => {
    const response = nativeConnectorMcpRegistrationSubmitResponseSchema.parse(envelope({ action: registrationAction, replayed: false }, "register"));
    const expected = { ...authority, executionScope, idempotencyKey: registrationKey, request: registrationRequest };
    expect(() => assertNativeConnectorMcpRegistrationResponseScope(response, expected)).not.toThrow();
    expect(response.action.settlement?.result).toMatchObject({ operation: "register_mcp", connectorStatus: "disabled", contractCount: 0, credentialVersion: 1 });
    for (const changed of [{ ...expected, idempotencyKey: preparationKey },
      { ...expected, request: { ...registrationRequest, preparationSha256: "e".repeat(64) } },
      { ...expected, request: { ...registrationRequest, connectorId: nativeMcpRegistrationFixture().connectorId } }]) {
      expect(() => assertNativeConnectorMcpRegistrationResponseScope(response, changed)).toThrow();
    }
  });
  it("admits all auth modes and rejects any active, discovered or out-of-range result", () => {
    for (const authType of ["none", "bearer_env", "bearer_vault"] as const) for (const privateEndpoint of [false, true]) {
      const sample = nativeMcpRegistrationFixture(authType, privateEndpoint);
      const response = nativeConnectorMcpRegistrationReadResponseSchema.parse(envelope({ action: sample.registrationAction }, "registrationRead"));
      expect(response.action?.settlement?.result.credentialVersion).toBe(authType === "bearer_vault" ? 1 : 0);
    }
    const settlement = registrationAction.settlement!;
    for (const changed of [{ credentialVersion: 2 }, { connectorStatus: "active" }, { contractCount: 1 }, { contractsSha256: "f".repeat(64) }]) {
      const { settlementSha256: _digest, ...original } = settlement;
      const body = { ...original, result: { ...original.result, ...changed } };
      const action = { ...registrationAction, settlement: { ...body, settlementSha256: canonicalJsonSha256(body) } };
      expect(nativeConnectorMcpRegistrationReadResponseSchema.safeParse(envelope({ action }, "registrationRead")).success).toBe(false);
    }
  });
  it("recovers final evidence by exact key without a preparation write or manager authority", () => {
    const response = nativeConnectorMcpRegistrationReadResponseSchema.parse(envelope({ action: registrationAction }, "registrationRead", {}, "viewer"));
    const expected = { ...authority, role: "viewer", keySha256: registrationIntent.keySha256 };
    expect(() => assertNativeConnectorMcpRegistrationResponseScope(response, expected)).not.toThrow();
    expect(() => assertNativeConnectorMcpRegistrationResponseScope(response, { ...expected, keySha256: preparationIntent.keySha256 })).toThrow("key");
    expect(nativeConnectorMcpRegistrationReadResponseSchema.parse(envelope({ action: null }, "registrationRead")).action).toBeNull();
  });
  it("rejects resealed operation, mode, event, key, count, resource and scope substitutions", () => {
    const cases = [
      { body: { prepared: preparedReady, replayed: false }, kind: "prepare" as const, schema: nativeConnectorMcpRegistrationPreparationSubmitResponseSchema },
      { body: { prepared: abandonedAbsent, replayed: false }, kind: "abandon" as const, schema: nativeConnectorMcpRegistrationPreparationAbandonResponseSchema },
      { body: { action: registrationAction, replayed: false }, kind: "register" as const, schema: nativeConnectorMcpRegistrationSubmitResponseSchema },
    ];
    for (const sample of cases) {
      for (const overrides of [{ operation: "app.connectors.native.act" }, { accessMode: "read" as const }, { eventContract: "read_only:no_domain_mutation" },
        { idempotencyKeySha256: "f".repeat(64) }, { resourceCount: 0 }, { resourceType: "unrelated_resource" }, { outcomeSha256: "f".repeat(64) }]) {
        expect(sample.schema.safeParse(envelope(sample.body, sample.kind, overrides)).success).toBe(false);
      }
      expect(sample.schema.safeParse({ ...envelope(sample.body, sample.kind), replayed: true }).success).toBe(false);
      expect(sample.schema.safeParse(envelope({ ...sample.body, scope: { ...scope, ownerActorId: "other@example.test" } }, sample.kind)).success).toBe(false);
    }
    expect(nativeConnectorMcpRegistrationPreparationAbandonResponseSchema.safeParse(envelope({ prepared: abandonedAbsent, replayed: false }, "abandon", { action: "manage.connector" })).success).toBe(false);
    expect(nativeConnectorMcpRegistrationPreparationReadResponseSchema.safeParse(envelope({ prepared: preparedReady }, "preparationRead", { idempotencyKeySha256: preparationIntent.keySha256 })).success).toBe(false);
    expect(nativeConnectorMcpRegistrationReadResponseSchema.safeParse(envelope({ action: registrationAction }, "registrationRead", { eventContract: "connector-native-mcp-registration-events.v1" })).success).toBe(false);
  });
  it("refuses secret-bearing response fields and preserves the strict earlier families", () => {
    for (const extra of [{ bearerToken: "synthetic-fixture-only" }, { payload: fixture.prepareRequest.payload }, { sealedCredential: {} }, { payloadCommitment: "e".repeat(64) }]) {
      expect(nativeConnectorMcpRegistrationPreparationSubmitResponseSchema.safeParse(envelope({ prepared: { ...preparedReady, ...extra }, replayed: false }, "prepare")).success).toBe(false);
      expect(nativeConnectorMcpRegistrationPreparationSubmitResponseSchema.safeParse(envelope({ prepared: preparedReady, replayed: false, ...extra }, "prepare")).success).toBe(false);
    }
    const response = envelope({ action: registrationAction, replayed: false }, "register");
    for (const schema of [nativeConnectorActionResponseSchema, nativeConnectorCredentialRemovalSubmitResponseSchema,
      nativeConnectorTrashSubmitResponseSchema, nativeConnectorCredentialRotationSubmitResponseSchema]) {
      expect(schema.safeParse(response).success).toBe(false);
    }
    expect(nativeConnectorCredentialPreparationSubmitResponseSchema.safeParse(envelope({ prepared: preparedReady, replayed: false }, "prepare")).success).toBe(false);
  });
});
