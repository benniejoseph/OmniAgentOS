import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { nativeMcpDiscoveryFixture } from "../../../tests/fixtures/native-mcp-discovery";
const mocks = vi.hoisted(() => ({ submit: vi.fn(), read: vi.fn(), close: vi.fn() }));
vi.mock("@/lib/connectors/native-mcp-discovery-store", () => ({ submitNativeMcpDiscovery: mocks.submit,
  readNativeMcpDiscovery: mocks.read, closeNativeMcpDiscovery: mocks.close }));
import { submitNativeMcpDiscoveryService, readNativeMcpDiscoveryService, closeNativeMcpDiscoveryService } from "./connector-mcp-discovery";
const f = nativeMcpDiscoveryFixture(), { scope } = f;
const context: SecurityContext = { tenantId: scope.tenantId, actorId: scope.ownerActorId, role: "viewer", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: scope.ownerActorId, sessionId: "session-one", tenantName: "Test" } };
const executionScope = createExecutionScope({ tenantId: scope.tenantId, initiatingActorId: scope.ownerActorId, executingPrincipalType: "user",
  executingPrincipalId: scope.ownerActorId, causationId: f.connectorId, correlationId: "discovery-service", purpose: "api.connectors.native.mcp_discovery" });
const cleanupScope = createExecutionScope({ ...executionScope, purpose: "api.connectors.native.mcp_discovery_close" });
const key = { keySha256: f.intent.keySha256 };
describe("native MCP discovery application boundary", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.read.mockResolvedValue(null); mocks.close.mockResolvedValue({ discovery: f.closedAbsent, replayed: false }); });
  it("keeps owner cleanup available after management loss with a distinct read-authority mutation receipt", async () => {
    const result = await closeNativeMcpDiscoveryService({ context, executionScope: cleanupScope, idempotencyKey: f.key }, f.closeRequest, key);
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith({ authority: { scope, executionScope: cleanupScope }, request: f.closeRequest,
      idempotencyKey: f.key, keySha256: key.keySha256 });
    expect(result.receipt).toMatchObject({ operation: "app.connectors.native.mcpDiscoveries.close", action: "read", accessMode: "mutation",
      resourceType: "connector_native_discovery", idempotencyKeySha256: key.keySha256, resourceCount: 1 });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("rejects changed path, raw key or original owner before the closure writer", async () => {
    const caller = { context, executionScope: cleanupScope, idempotencyKey: f.key };
    await expect(closeNativeMcpDiscoveryService(caller, f.closeRequest, { keySha256: "c".repeat(64) })).rejects.toThrow("original");
    await expect(closeNativeMcpDiscoveryService({ ...caller, idempotencyKey: "different-key" }, f.closeRequest, key)).rejects.toThrow("original");
    await expect(closeNativeMcpDiscoveryService(caller, { ...f.closeRequest, intent: { ...f.intent, scope: { ...scope, ownerActorId: "other@example.test" } } }, key)).rejects.toThrow();
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it("requires management for discovery and exact authenticated mutation attribution for cleanup", async () => {
    await expect(submitNativeMcpDiscoveryService({ context, executionScope, idempotencyKey: f.key }, f.request)).rejects.toThrow();
    for (const caller of [{ context }, { context, executionScope: cleanupScope }, { context: { ...context, auth: undefined }, executionScope: cleanupScope, idempotencyKey: f.key }]) {
      await expect(closeNativeMcpDiscoveryService(caller, f.closeRequest, key)).rejects.toThrow();
    }
    expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled();
  });
  it("keeps exact recovery free of mutation scope and canonical-owner bound", async () => {
    const result = await readNativeMcpDiscoveryService({ context }, key);
    expect(result.receipt).toMatchObject({ action: "read", accessMode: "read", idempotencyKeySha256: null, resourceCount: 0 });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ scope }, key.keySha256);
    for (const caller of [{ context, executionScope }, { context, idempotencyKey: f.key }, { context: { ...context, actorId: "other@example.test" } }]) {
      await expect(readNativeMcpDiscoveryService(caller, key)).rejects.toThrow("authenticated");
    }
  });
  it("preserves all admitted and terminal states, including settled-wins-close", async () => {
    const manager = { ...context, role: "admin" as const };
    for (const discovery of [f.pending, f.expired, f.settled, ...f.failed, f.closedAbsent, f.closedAttempt]) {
      mocks.submit.mockResolvedValue({ discovery, replayed: true });
      const result = await submitNativeMcpDiscoveryService({ context: manager, executionScope, idempotencyKey: f.key }, f.request);
      expect(result.data.discovery).toEqual(discovery); expect(result.receipt.resourceCount).toBe(1);
    }
    mocks.close.mockResolvedValue({ discovery: f.settled, replayed: true });
    expect((await closeNativeMcpDiscoveryService({ context, executionScope: cleanupScope, idempotencyKey: f.key }, f.closeRequest, key)).data.discovery).toEqual(f.settled);
  });
  it("refuses a valid writer response from another original discovery", async () => {
    const other = nativeMcpDiscoveryFixture("bearer_vault");
    mocks.submit.mockResolvedValue({ discovery: other.settled, replayed: false });
    await expect(submitNativeMcpDiscoveryService({ context: { ...context, role: "admin" }, executionScope, idempotencyKey: f.key }, f.request)).rejects.toThrow();
    mocks.read.mockResolvedValue(other.pending);
    await expect(readNativeMcpDiscoveryService({ context }, key)).rejects.toThrow();
    mocks.close.mockResolvedValue({ discovery: other.closedAbsent, replayed: false });
    await expect(closeNativeMcpDiscoveryService({ context, executionScope: cleanupScope, idempotencyKey: f.key }, f.closeRequest, key)).rejects.toThrow();
  });
});
