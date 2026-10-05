import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { sealConnectorNativePin } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeCredentialPreparationIntent, connectorNativeCredentialPreparationAbandonmentId,
  connectorNativeCredentialPrepareRequestSchema } from "@/lib/connectors/native-credential-rotation-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), preparationRead: vi.fn(), abandon: vi.fn(), rotate: vi.fn(), rotationRead: vi.fn() }));
vi.mock("@/lib/connectors/native-credential-rotation-store", () => ({ prepareNativeConnectorCredential: mocks.prepare,
  readNativeConnectorCredentialPreparation: mocks.preparationRead, abandonNativeConnectorCredentialPreparation: mocks.abandon,
  submitNativeConnectorCredentialRotation: mocks.rotate, readNativeConnectorCredentialRotation: mocks.rotationRead }));
import { abandonNativeConnectorCredentialPreparationService, prepareNativeConnectorCredentialService,
  readNativeConnectorCredentialPreparationService, readNativeConnectorCredentialRotationService } from "@/lib/app-services/connector-credential-rotation";

const context: SecurityContext = { tenantId: "rotation-service", actorId: "owner@example.test", role: "viewer", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", sessionId: "session-one", tenantName: "Test" } };
const scope = { tenantId: context.tenantId, ownerActorId: context.actorId, canonicalActorId: `actor:${context.auth!.userId}` };
const key = "preparation-service-once";
const pin = sealConnectorNativePin({ kind: "mcp", connectorId: "connector-one", connectorSha256: "a".repeat(64),
  contractsSha256: canonicalJsonSha256([]), configurationSha256: "b".repeat(64), reviewFingerprint: null, credentialVersion: 0 });
const prepare = connectorNativeCredentialPrepareRequestSchema.parse({ contract: "asael-connector-prepare:1", operation: "rotate_mcp", connectorId: pin.connectorId,
  nonce: "11111111-1111-4111-8111-111111111111", review: pin,
  declaration: { name: "Notes", endpoint: "https://example.test/mcp", endpointRedacted: false, authType: "bearer_vault", authTokenEnv: null,
    authHeaderName: null, defaultRiskLevel: 2, approvalRequired: true, specSource: "none", specUrl: null, specUrlRedacted: false },
  payload: { endpoint: null, specUrl: null, specText: null, bearerToken: "synthetic-service-bearer" } });
const intent = buildConnectorNativeCredentialPreparationIntent(scope, key, prepare);
const request = { contract: "asael-connector-credential-preparation-abandon:1" as const, intent };
const abandonmentBody = { contract: "asael-connector-credential-preparation-abandonment:1", id: connectorNativeCredentialPreparationAbandonmentId(scope, intent.keySha256),
  scope, keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent), preparationSha256: null, abandonedAt: "2026-10-05T08:00:00.000Z" };
const prepared = { intent, preparation: null, availability: "abandoned", consumedBy: null, consumedKeySha256: null,
  abandonment: { ...abandonmentBody, abandonmentSha256: canonicalJsonSha256(abandonmentBody) } };
const executionScope = createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: scope.ownerActorId, executingPrincipalType: "user",
  executingPrincipalId: scope.ownerActorId, causationId: pin.connectorId, correlationId: "abandon-service", purpose: "api.connectors.native.preparation.abandon" });

describe("credential preparation application boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.abandon.mockResolvedValue({ prepared, replayed: false });
    mocks.preparationRead.mockResolvedValue(null); mocks.rotationRead.mockResolvedValue(null);
  });
  it("allows exact owner cleanup with a mutation receipt after manager permission is lost", async () => {
    const caller = createAppServiceCaller({ context, executionScope, idempotencyKey: key });
    const result = await abandonNativeConnectorCredentialPreparationService(caller, request, { keySha256: intent.keySha256 });
    expect(mocks.abandon).toHaveBeenCalledExactlyOnceWith({ authority: { scope, executionScope }, request, idempotencyKey: key, keySha256: intent.keySha256 });
    expect(result.data).toMatchObject({ prepared, replayed: false });
    expect(result.receipt).toMatchObject({ operation: "app.connectors.native.credentialPreparations.abandon", action: "read", accessMode: "mutation",
      resourceType: "connector_native_preparation", idempotencyKeySha256: intent.keySha256, resourceCount: 1 });
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.rotate).not.toHaveBeenCalled();
  });
  it("rejects changed path, original header, body key and owner before the staging writer", async () => {
    const caller = createAppServiceCaller({ context, executionScope, idempotencyKey: key });
    await expect(abandonNativeConnectorCredentialPreparationService(caller, request, { keySha256: "c".repeat(64) })).rejects.toThrow("original");
    await expect(abandonNativeConnectorCredentialPreparationService({ ...caller, idempotencyKey: "different-key" }, request, { keySha256: intent.keySha256 })).rejects.toThrow("original");
    await expect(abandonNativeConnectorCredentialPreparationService(caller, { ...request, intent: { ...intent, keySha256: "d".repeat(64) } }, { keySha256: intent.keySha256 })).rejects.toThrow("original");
    await expect(abandonNativeConnectorCredentialPreparationService(caller, { ...request, intent: { ...intent, scope: { ...scope, ownerActorId: "other@example.test" } } }, { keySha256: intent.keySha256 })).rejects.toThrow("original");
    expect(mocks.abandon).not.toHaveBeenCalled();
  });
  it("requires management for preparation and exact mutation attribution for abandonment", async () => {
    const caller = createAppServiceCaller({ context, executionScope, idempotencyKey: key });
    await expect(prepareNativeConnectorCredentialService(caller, prepare)).rejects.toThrow();
    await expect(abandonNativeConnectorCredentialPreparationService({ context }, request, { keySha256: intent.keySha256 })).rejects.toThrow();
    await expect(abandonNativeConnectorCredentialPreparationService({ context, executionScope }, request, { keySha256: intent.keySha256 })).rejects.toThrow();
    await expect(abandonNativeConnectorCredentialPreparationService({ ...caller, context: { ...context, auth: undefined } }, request, { keySha256: intent.keySha256 })).rejects.toThrow("authenticated");
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.abandon).not.toHaveBeenCalled();
  });
  it("keeps exact recovery read-only and canonical-owner bound", async () => {
    for (const read of [readNativeConnectorCredentialPreparationService, readNativeConnectorCredentialRotationService]) {
      const result = await read({ context }, { keySha256: intent.keySha256 });
      expect(result.receipt).toMatchObject({ action: "read", accessMode: "read", idempotencyKeySha256: null, resourceCount: 0 });
      await expect(read({ context, executionScope }, { keySha256: intent.keySha256 })).rejects.toThrow("authenticated");
      await expect(read({ context, idempotencyKey: key }, { keySha256: intent.keySha256 })).rejects.toThrow("authenticated");
      await expect(read({ context: { ...context, actorId: "other@example.test" } }, { keySha256: intent.keySha256 })).rejects.toThrow("authenticated");
    }
    for (const mock of [mocks.preparationRead, mocks.rotationRead]) expect(mock).toHaveBeenCalledExactlyOnceWith({ scope }, intent.keySha256);
  });
});
