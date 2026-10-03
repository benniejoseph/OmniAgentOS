import { describe, expect, it } from "vitest";
import { buildTrashActionPreviewV1, buildTrashEffectReceiptV1, buildTrashItemV1 } from "@/lib/trash/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  parseConnectionInventory, parseContractReviewReceipt, parseGoogleDisconnectReceipt,
  parseGoogleSyncReceipt, parseMcpReceipt, parseMcpTrashPreview, parseMcpTrashReceipt, parseOpenApiCreationReceipt,
} from "./connection-state";

const connector = { id: "mcp-a", name: "Fixture connection", endpoint: "https://example.com/mcp", status: "active", authType: "none", toolCount: 1, review: { pendingCount: 1 } };
const target = { kind: "mcp", connector, operationIds: ["mcp-tool-a"] };
const targetSha256 = canonicalJsonSha256(target);
const now = "2026-10-04T10:00:00.000Z";
const preview = buildTrashActionPreviewV1({ version: "p9.3-trash-preview:1", action: "trash", trashId: null,
  resourceType: "mcp_connector", resourceId: connector.id, lifecycleRevision: 0, targetSha256,
  effectSummary: "Move this exact connection to reversible Trash.", reversible: true, issuedAt: now, expiresAt: "2026-10-04T10:15:00.000Z" });
const trashId = "trash:11111111-1111-4111-8111-111111111111";
const trash = buildTrashItemV1({ version: "p9.3-trash-item:1", trashId, tenantId: "tenant-a", ownerActorId: "actor-a",
  resourceType: "mcp_connector", resourceId: connector.id, displayLabel: connector.name, targetSha256, snapshotSha256: "b".repeat(64),
  compensation: { kind: "exact_restore", handlerId: "connector.restore", limitation: null }, state: "retained", lifecycleRevision: 1,
  trashedAt: now, restoreUntil: "2026-11-03T10:00:00.000Z", restoredAt: null, purgedAt: null });
const effectReceipt = buildTrashEffectReceiptV1({ version: "p9.3-trash-effect-receipt:1", action: "trash", trashId,
  resourceType: "mcp_connector", resourceId: connector.id, targetSha256, previewSha256: preview.previewSha256,
  beforeState: null, afterState: "retained", beforeRevision: 0, afterRevision: 1, outcome: "applied", affectedResourceIds: [connector.id], occurredAt: now });

describe("connection resource truth", () => {
  it("keeps missing arrays and counts unavailable rather than projecting zero", () => {
    expect(parseConnectionInventory("connectors", { connectors: [], tools: [] })).toEqual({ connectors: [], tools: [] });
    expect(parseConnectionInventory("catalog", { connectors: [] })).toEqual({ connectors: [] });
    expect(() => parseConnectionInventory("connectors", { connectors: [connector] })).toThrow("incomplete");
    expect(() => parseConnectionInventory("connectors", { connectors: [{ ...connector, toolCount: undefined }], tools: [] })).toThrow();
    expect(() => parseConnectionInventory("catalog", { connections: [] })).toThrow();
    expect(() => parseConnectionInventory("oauth", { providers: [], grants: [null] })).toThrow();
  });
});

describe("personal connection receipts", () => {
  const response = { provider: "google", grant: { id: "grant-a" }, status: "partial", imported: 3, removed: 1,
    sources: [{ source: "mail", status: "healthy", imported: 3, removed: 1 }, { source: "calendar", status: "error", imported: 0, removed: 0 }] };
  it("retains a confirmed partial outcome with exact per-source counts and account binding", () => {
    expect(parseGoogleSyncReceipt(response, "grant-a")).toMatchObject({ status: "partial", imported: 3, removed: 1 });
    expect(() => parseGoogleSyncReceipt(response, "grant-b")).toThrow("unconfirmed");
    expect(() => parseGoogleSyncReceipt({ ...response, imported: 4 }, "grant-a")).toThrow();
    expect(() => parseGoogleSyncReceipt({ ...response, status: "healthy" }, "grant-a")).toThrow();
    expect(() => parseGoogleSyncReceipt({ ...response, sources: [response.sources[0], response.sources[0]] }, "grant-a")).toThrow();
  });
  it("distinguishes a revoked local grant from a failed provider token revocation", () => {
    expect(parseGoogleDisconnectReceipt({ revoked: true, provider: "google", providerRevocation: "failed", providerRevoked: false })).toEqual({ providerRevocation: "failed" });
    expect(parseGoogleDisconnectReceipt({ revoked: true, provider: "google", providerRevocation: "not_needed", providerRevoked: false })).toEqual({ providerRevocation: "not_needed" });
    expect(() => parseGoogleDisconnectReceipt({ revoked: true, provider: "google", providerRevocation: "failed", providerRevoked: true })).toThrow();
  });
});

describe("managed connector receipts", () => {
  it("requires the requested connector fields and binds discovered contract rows", () => {
    const result = { connector, tools: [{ id: "tool-a", connectorId: connector.id }] };
    expect(parseMcpReceipt(result, { id: connector.id, discovered: true, fields: { endpoint: connector.endpoint } })).toEqual(connector);
    expect(() => parseMcpReceipt(result, { id: "another-connector" })).toThrow();
    expect(() => parseMcpReceipt(result, { fields: { status: "disabled" } })).toThrow();
    expect(() => parseMcpReceipt({ ...result, tools: [{ id: "tool-a", connectorId: "other" }] }, { discovered: true })).toThrow();
    expect(() => parseMcpReceipt({ connector }, { discovered: true })).toThrow();
  });
  it("does not equate reviewed contracts with an activated connector", () => {
    const result = { promoted: 1, connectorStatus: "disabled", activationRequired: true, tools: [{ id: "tool-a", connectorId: connector.id }] };
    expect(parseContractReviewReceipt(result, "mcp", connector.id)).toEqual({ promoted: 1, activationRequired: true, status: "disabled" });
    expect(() => parseContractReviewReceipt({ ...result, activationRequired: false }, "mcp", connector.id)).toThrow();
    expect(() => parseContractReviewReceipt(result, "mcp", "different")).toThrow();
    expect(() => parseContractReviewReceipt({ ...result, promoted: 2 }, "mcp", connector.id)).toThrow();
  });
  it("preserves the accepted connector creation when a spec import fails", () => {
    const submitted = { name: "REST fixture", authType: "none", specUrl: "https://example.com/openapi.json" };
    const created = { id: "rest-a", ...submitted, status: "error" };
    expect(parseOpenApiCreationReceipt({ connector: created, operations: [], error: "Spec import unavailable" }, submitted)).toEqual({ connector: created, importFailed: true });
    expect(() => parseOpenApiCreationReceipt({ connector: { ...created, specUrl: "https://elsewhere.example/spec" }, operations: [] }, submitted)).toThrow();
    expect(() => parseOpenApiCreationReceipt({ connector: created, operations: [{ id: "operation-a", connectorId: "rest-b" }] }, submitted)).toThrow();
  });
});

describe("exact reversible connector retirement", () => {
  it("validates a real server-built preview and detects a changed target or review body", async () => {
    const result = { preview, target, targetSha256 };
    expect(await parseMcpTrashPreview(result, connector.id)).toEqual(preview);
    await expect(parseMcpTrashPreview(result, "another")).rejects.toThrow();
    await expect(parseMcpTrashPreview({ ...result, target: { ...target, operationIds: [] } }, connector.id)).rejects.toThrow();
    await expect(parseMcpTrashPreview({ ...result, preview: { ...preview, effectSummary: "Changed effect" } }, connector.id)).rejects.toThrow();
  });
  it("accepts only the exact preview, item and immutable effect receipt", async () => {
    const result = { movedToTrash: true, trash, effectReceipt };
    expect(await parseMcpTrashReceipt(result, preview)).toEqual({ trashId, restoreUntil: trash.restoreUntil, receiptSha256: effectReceipt.receiptSha256 });
    await expect(parseMcpTrashReceipt(result, { ...preview, previewSha256: "c".repeat(64) })).rejects.toThrow();
    await expect(parseMcpTrashReceipt({ ...result, trash: { ...trash, displayLabel: "Changed name" } }, preview)).rejects.toThrow();
    await expect(parseMcpTrashReceipt({ ...result, effectReceipt: { ...effectReceipt, outcome: "already_applied" } }, preview)).rejects.toThrow();
    await expect(parseMcpTrashReceipt({ ...result, movedToTrash: false }, preview)).rejects.toThrow();
  });
});
