import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { nativeOpenapiImportFixture } from "../../../tests/fixtures/native-openapi-import";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), preparationRead: vi.fn(), abandon: vi.fn(), register: vi.fn(), registrationRead: vi.fn() }));
vi.mock("@/lib/connectors/native-openapi-import-store", () => ({ prepareNativeOpenapiImport: mocks.prepare,
  readNativeOpenapiImportPreparation: mocks.preparationRead, abandonNativeOpenapiImportPreparation: mocks.abandon,
  submitNativeOpenapiImport: mocks.register, readNativeOpenapiImport: mocks.registrationRead }));
import { abandonNativeOpenapiImportPreparationService, prepareNativeOpenapiImportService,
  readNativeOpenapiImportPreparationService, readNativeOpenapiImportService,
  submitNativeOpenapiImportService } from "@/lib/app-services/connector-openapi-import";

const fixture = nativeOpenapiImportFixture("api_key_header_env", "url", true);
const { scope, connectorId, preparationKey, intent, abandonRequest } = fixture;
const context: SecurityContext = { tenantId: scope.tenantId, actorId: scope.ownerActorId, role: "viewer", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: scope.ownerActorId, sessionId: "session-one", tenantName: "Test" } };
const cleanupScope = createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: scope.ownerActorId, executingPrincipalType: "user",
  executingPrincipalId: scope.ownerActorId, causationId: connectorId, correlationId: "registration-service", purpose: "api.connectors.native.openapi_import_preparation.abandon" });
const executionScope = createExecutionScope({ ...cleanupScope, purpose: "api.connectors.native.action" });

describe("prepared OpenAPI import application boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.abandon.mockResolvedValue({ prepared: fixture.abandonedAbsent, replayed: false });
    mocks.preparationRead.mockResolvedValue(null); mocks.registrationRead.mockResolvedValue(null);
  });
  it("allows exact owner cleanup after management loss with its own mutation receipt", async () => {
    const caller = createAppServiceCaller({ context, executionScope: cleanupScope, idempotencyKey: preparationKey });
    const result = await abandonNativeOpenapiImportPreparationService(caller, abandonRequest, { keySha256: intent.keySha256 });
    expect(mocks.abandon).toHaveBeenCalledExactlyOnceWith({ authority: { scope, executionScope: cleanupScope }, request: abandonRequest,
      idempotencyKey: preparationKey, keySha256: intent.keySha256 });
    expect(result.data).toMatchObject({ prepared: fixture.abandonedAbsent, replayed: false });
    expect(result.receipt).toMatchObject({ operation: "app.connectors.native.openapiImportPreparations.abandon", action: "read", accessMode: "mutation",
      resourceType: "connector_native_preparation", idempotencyKeySha256: intent.keySha256, resourceCount: 1 });
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.register).not.toHaveBeenCalled();
  });
  it("rejects changed path, original header, intent key and owner before the staging writer", async () => {
    const caller = createAppServiceCaller({ context, executionScope: cleanupScope, idempotencyKey: preparationKey });
    await expect(abandonNativeOpenapiImportPreparationService(caller, abandonRequest, { keySha256: "c".repeat(64) })).rejects.toThrow("original");
    await expect(abandonNativeOpenapiImportPreparationService({ ...caller, idempotencyKey: "different-key" }, abandonRequest,
      { keySha256: intent.keySha256 })).rejects.toThrow("original");
    await expect(abandonNativeOpenapiImportPreparationService(caller, { ...abandonRequest, intent: { ...intent, keySha256: "d".repeat(64) } },
      { keySha256: intent.keySha256 })).rejects.toThrow();
    await expect(abandonNativeOpenapiImportPreparationService(caller,
      { ...abandonRequest, intent: { ...intent, scope: { ...scope, ownerActorId: "other@example.test" } } },
      { keySha256: intent.keySha256 })).rejects.toThrow();
    expect(mocks.abandon).not.toHaveBeenCalled();
  });
  it("requires management for both import stages and mutation attribution for owner cleanup", async () => {
    const caller = createAppServiceCaller({ context, executionScope, idempotencyKey: preparationKey });
    await expect(prepareNativeOpenapiImportService(caller, fixture.prepareRequest)).rejects.toThrow();
    await expect(submitNativeOpenapiImportService(caller, fixture.request)).rejects.toThrow();
    await expect(abandonNativeOpenapiImportPreparationService({ context }, abandonRequest, { keySha256: intent.keySha256 })).rejects.toThrow();
    await expect(abandonNativeOpenapiImportPreparationService({ context, executionScope: cleanupScope }, abandonRequest,
      { keySha256: intent.keySha256 })).rejects.toThrow();
    await expect(abandonNativeOpenapiImportPreparationService({ ...caller, context: { ...context, auth: undefined } }, abandonRequest,
      { keySha256: intent.keySha256 })).rejects.toThrow("authenticated");
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.register).not.toHaveBeenCalled(); expect(mocks.abandon).not.toHaveBeenCalled();
  });
  it("keeps both exact recovery reads free of mutation scope and canonical-owner bound", async () => {
    for (const read of [readNativeOpenapiImportPreparationService, readNativeOpenapiImportService]) {
      const result = await read({ context }, { keySha256: intent.keySha256 });
      expect(result.receipt).toMatchObject({ action: "read", accessMode: "read", idempotencyKeySha256: null, resourceCount: 0 });
      await expect(read({ context, executionScope }, { keySha256: intent.keySha256 })).rejects.toThrow("authenticated");
      await expect(read({ context, idempotencyKey: preparationKey }, { keySha256: intent.keySha256 })).rejects.toThrow("authenticated");
      await expect(read({ context: { ...context, actorId: "other@example.test" } }, { keySha256: intent.keySha256 })).rejects.toThrow("authenticated");
    }
    for (const mock of [mocks.preparationRead, mocks.registrationRead]) expect(mock).toHaveBeenCalledExactlyOnceWith({ scope }, intent.keySha256);
  });
  it("returns only safe exact evidence for all six auth/source combinations", async () => {
    for (const authType of ["none", "bearer_env", "api_key_header_env"] as const) for (const source of ["text", "url"] as const) {
      const value = nativeOpenapiImportFixture(authType, source, source === "url");
      const scopeForTarget = createExecutionScope({ ...executionScope, causationId: value.connectorId });
      const manager = { ...context, role: "admin" as const };
      mocks.prepare.mockResolvedValue({ prepared: value.ready, replayed: false });
      const prepared = await prepareNativeOpenapiImportService({ context: manager, executionScope: scopeForTarget,
        idempotencyKey: value.preparationKey }, value.prepareRequest);
      expect(prepared.receipt).toMatchObject({ action: "manage.connector", accessMode: "mutation", resourceCount: 1 });
      mocks.register.mockResolvedValue({ action: value.action, replayed: false });
      const registered = await submitNativeOpenapiImportService({ context: manager, executionScope: scopeForTarget,
        idempotencyKey: value.finalKey }, value.request);
      expect(registered.data.action.settlement?.result).toMatchObject({ operation: "import_openapi", connectorStatus: "disabled", contractCount: 2,
        credentialVersion: 0 });
      const published = JSON.stringify({ prepared, registered });
      expect(published).not.toContain("synthetic-private-query"); expect(published).not.toContain("synthetic-fragment");
      expect(published).not.toContain("synthetic-fixture-only"); expect(published).not.toContain(value.preparationKey);
    }
  });
  it("refuses a valid but different preparation or final receipt from the writer", async () => {
    const other = nativeOpenapiImportFixture("none");
    const manager = { ...context, role: "admin" as const };
    mocks.prepare.mockResolvedValue({ prepared: other.ready, replayed: false });
    await expect(prepareNativeOpenapiImportService({ context: manager, executionScope, idempotencyKey: preparationKey }, fixture.prepareRequest)).rejects.toThrow();
    mocks.register.mockResolvedValue({ action: other.action, replayed: false });
    await expect(submitNativeOpenapiImportService({ context: manager, executionScope, idempotencyKey: fixture.finalKey }, fixture.request)).rejects.toThrow();
  });
  it("preserves admitted pending and terminal branches without inventing ready evidence", async () => {
    const manager = { ...context, role: "admin" as const };
    for (const prepared of [fixture.preparing, fixture.failed, fixture.expiredAttempt, fixture.consumed, fixture.abandonedAbsent]) {
      mocks.prepare.mockResolvedValue({ prepared, replayed: true });
      const result = await prepareNativeOpenapiImportService({ context: manager, executionScope, idempotencyKey: preparationKey }, fixture.prepareRequest);
      expect(result.data.prepared).toEqual(prepared);
      expect(result.receipt).toMatchObject({ operation: "app.connectors.native.openapiImportPreparations.submit", resourceCount: 1 });
    }
    expect(mocks.register).not.toHaveBeenCalled(); expect(mocks.abandon).not.toHaveBeenCalled();
  });
});
