import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { nativeMcpRegistrationFixture } from "../../../tests/fixtures/native-mcp-registration";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), preparationRead: vi.fn(), abandon: vi.fn(), register: vi.fn(), registrationRead: vi.fn() }));
vi.mock("@/lib/connectors/native-mcp-registration-store", () => ({ prepareNativeMcpRegistration: mocks.prepare,
  readNativeMcpRegistrationPreparation: mocks.preparationRead, abandonNativeMcpRegistrationPreparation: mocks.abandon,
  submitNativeMcpRegistration: mocks.register, readNativeMcpRegistration: mocks.registrationRead }));
import { abandonNativeMcpRegistrationPreparationService, prepareNativeMcpRegistrationService,
  readNativeMcpRegistrationPreparationService, readNativeMcpRegistrationService,
  submitNativeMcpRegistrationService } from "@/lib/app-services/connector-mcp-registration";

const fixture = nativeMcpRegistrationFixture("bearer_vault", true);
const { scope, connectorId, preparationKey, preparationIntent, abandonRequest } = fixture;
const context: SecurityContext = { tenantId: scope.tenantId, actorId: scope.ownerActorId, role: "viewer", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: scope.ownerActorId, sessionId: "session-one", tenantName: "Test" } };
const cleanupScope = createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: scope.ownerActorId, executingPrincipalType: "user",
  executingPrincipalId: scope.ownerActorId, causationId: connectorId, correlationId: "registration-service", purpose: "api.connectors.native.mcp_registration_preparation.abandon" });
const executionScope = createExecutionScope({ ...cleanupScope, purpose: "api.connectors.native.action" });

describe("prepared MCP registration application boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.abandon.mockResolvedValue({ prepared: fixture.abandonedAbsent, replayed: false });
    mocks.preparationRead.mockResolvedValue(null); mocks.registrationRead.mockResolvedValue(null);
  });
  it("allows exact owner cleanup after management loss with its own mutation receipt", async () => {
    const caller = createAppServiceCaller({ context, executionScope: cleanupScope, idempotencyKey: preparationKey });
    const result = await abandonNativeMcpRegistrationPreparationService(caller, abandonRequest, { keySha256: preparationIntent.keySha256 });
    expect(mocks.abandon).toHaveBeenCalledExactlyOnceWith({ authority: { scope, executionScope: cleanupScope }, request: abandonRequest,
      idempotencyKey: preparationKey, keySha256: preparationIntent.keySha256 });
    expect(result.data).toMatchObject({ prepared: fixture.abandonedAbsent, replayed: false });
    expect(result.receipt).toMatchObject({ operation: "app.connectors.native.mcpRegistrationPreparations.abandon", action: "read", accessMode: "mutation",
      resourceType: "connector_native_preparation", idempotencyKeySha256: preparationIntent.keySha256, resourceCount: 1 });
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.register).not.toHaveBeenCalled();
  });
  it("rejects changed path, original header, intent key and owner before the staging writer", async () => {
    const caller = createAppServiceCaller({ context, executionScope: cleanupScope, idempotencyKey: preparationKey });
    await expect(abandonNativeMcpRegistrationPreparationService(caller, abandonRequest, { keySha256: "c".repeat(64) })).rejects.toThrow("original");
    await expect(abandonNativeMcpRegistrationPreparationService({ ...caller, idempotencyKey: "different-key" }, abandonRequest,
      { keySha256: preparationIntent.keySha256 })).rejects.toThrow("original");
    await expect(abandonNativeMcpRegistrationPreparationService(caller, { ...abandonRequest, intent: { ...preparationIntent, keySha256: "d".repeat(64) } },
      { keySha256: preparationIntent.keySha256 })).rejects.toThrow();
    await expect(abandonNativeMcpRegistrationPreparationService(caller,
      { ...abandonRequest, intent: { ...preparationIntent, scope: { ...scope, ownerActorId: "other@example.test" } } },
      { keySha256: preparationIntent.keySha256 })).rejects.toThrow();
    expect(mocks.abandon).not.toHaveBeenCalled();
  });
  it("requires management for both creation stages and mutation attribution for owner cleanup", async () => {
    const caller = createAppServiceCaller({ context, executionScope, idempotencyKey: preparationKey });
    await expect(prepareNativeMcpRegistrationService(caller, fixture.prepareRequest)).rejects.toThrow();
    await expect(submitNativeMcpRegistrationService(caller, fixture.registrationRequest)).rejects.toThrow();
    await expect(abandonNativeMcpRegistrationPreparationService({ context }, abandonRequest, { keySha256: preparationIntent.keySha256 })).rejects.toThrow();
    await expect(abandonNativeMcpRegistrationPreparationService({ context, executionScope: cleanupScope }, abandonRequest,
      { keySha256: preparationIntent.keySha256 })).rejects.toThrow();
    await expect(abandonNativeMcpRegistrationPreparationService({ ...caller, context: { ...context, auth: undefined } }, abandonRequest,
      { keySha256: preparationIntent.keySha256 })).rejects.toThrow("authenticated");
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.register).not.toHaveBeenCalled(); expect(mocks.abandon).not.toHaveBeenCalled();
  });
  it("keeps both exact recovery reads free of mutation scope and canonical-owner bound", async () => {
    for (const read of [readNativeMcpRegistrationPreparationService, readNativeMcpRegistrationService]) {
      const result = await read({ context }, { keySha256: preparationIntent.keySha256 });
      expect(result.receipt).toMatchObject({ action: "read", accessMode: "read", idempotencyKeySha256: null, resourceCount: 0 });
      await expect(read({ context, executionScope }, { keySha256: preparationIntent.keySha256 })).rejects.toThrow("authenticated");
      await expect(read({ context, idempotencyKey: preparationKey }, { keySha256: preparationIntent.keySha256 })).rejects.toThrow("authenticated");
      await expect(read({ context: { ...context, actorId: "other@example.test" } }, { keySha256: preparationIntent.keySha256 })).rejects.toThrow("authenticated");
    }
    for (const mock of [mocks.preparationRead, mocks.registrationRead]) expect(mock).toHaveBeenCalledExactlyOnceWith({ scope }, preparationIntent.keySha256);
  });
  it("returns only safe exact evidence for each auth mode and endpoint privacy choice", async () => {
    for (const authType of ["none", "bearer_env", "bearer_vault"] as const) for (const privateEndpoint of [false, true]) {
      const value = nativeMcpRegistrationFixture(authType, privateEndpoint);
      const scopeForTarget = createExecutionScope({ ...executionScope, causationId: value.connectorId });
      const manager = { ...context, role: "admin" as const };
      mocks.prepare.mockResolvedValue({ prepared: value.preparedReady, replayed: false });
      const prepared = await prepareNativeMcpRegistrationService({ context: manager, executionScope: scopeForTarget,
        idempotencyKey: value.preparationKey }, value.prepareRequest);
      expect(prepared.receipt).toMatchObject({ action: "manage.connector", accessMode: "mutation", resourceCount: 1 });
      mocks.register.mockResolvedValue({ action: value.registrationAction, replayed: false });
      const registered = await submitNativeMcpRegistrationService({ context: manager, executionScope: scopeForTarget,
        idempotencyKey: value.registrationKey }, value.registrationRequest);
      expect(registered.data.action.settlement?.result).toMatchObject({ operation: "register_mcp", connectorStatus: "disabled", contractCount: 0,
        credentialVersion: authType === "bearer_vault" ? 1 : 0 });
      const published = JSON.stringify({ prepared, registered });
      expect(published).not.toContain("synthetic-private-query"); expect(published).not.toContain("synthetic-fragment");
      expect(published).not.toContain("synthetic-fixture-only"); expect(published).not.toContain(value.preparationKey);
    }
  });
  it("refuses a valid but different preparation or final receipt from the writer", async () => {
    const other = nativeMcpRegistrationFixture("none");
    const manager = { ...context, role: "admin" as const };
    mocks.prepare.mockResolvedValue({ prepared: other.preparedReady, replayed: false });
    await expect(prepareNativeMcpRegistrationService({ context: manager, executionScope, idempotencyKey: preparationKey }, fixture.prepareRequest)).rejects.toThrow();
    mocks.register.mockResolvedValue({ action: other.registrationAction, replayed: false });
    await expect(submitNativeMcpRegistrationService({ context: manager, executionScope, idempotencyKey: fixture.registrationKey }, fixture.registrationRequest)).rejects.toThrow();
  });
});
