import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { buildTrashActionPreviewV1 } from "@/lib/trash/contracts";
import { connectorNativeAcceptanceId, connectorNativeActionSchema, connectorNativeIntentSchema,
  connectorNativeReviewSchema, connectorNativeTrashTarget, sealConnectorNativePin } from "@/lib/connectors/native-control-contracts";
import { connectorNativeCredentialRemovalActionSchema, connectorNativeCredentialRemovalRequestSchema } from "@/lib/connectors/native-credential-removal-contracts";
import { buildConnectorNativeTrashIntent, canTrashNativeConnector, connectorNativeTrashAcceptanceSchema,
  connectorNativeTrashActionSchema, connectorNativeTrashCompensation, connectorNativeTrashEffectSummary,
  connectorNativeTrashPreviewSchema, connectorNativeTrashRequestSchema, connectorNativeTrashSettlementSchema } from "@/lib/connectors/native-trash-contracts";

const scope = { tenantId: "trash-contract", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
function fixture(vault = true, version = 2) {
  const connector = { kind: "mcp" as const, id: "connector-one", name: "Notes", endpoint: "https://example.test/mcp", endpointRedacted: true,
    status: "active" as const, authType: vault ? "bearer_vault" as const : "none" as const, authTokenEnv: null, authHeaderName: null,
    credentialConfigured: vault, credentialVersion: version, credentialOriginMatch: false, defaultRiskLevel: 2 as const,
    approvalRequired: true, contractCount: 0, discoveredAt: null, updatedAt: "2026-10-05T01:00:00.000Z" };
  const pin = sealConnectorNativePin({ kind: "mcp", connectorId: connector.id, connectorSha256: canonicalJsonSha256(connector),
    contractsSha256: canonicalJsonSha256([]), configurationSha256: "c".repeat(64), reviewFingerprint: null, credentialVersion: version });
  const review = connectorNativeReviewSchema.parse({ connector, contracts: [], pin, availableActions: [], unavailableReason: null });
  const preview = buildTrashActionPreviewV1({ version: "p9.3-trash-preview:1", action: "trash", trashId: null, resourceType: "mcp_connector",
    resourceId: connector.id, lifecycleRevision: 0, targetSha256: canonicalJsonSha256(connectorNativeTrashTarget(pin)),
    effectSummary: connectorNativeTrashEffectSummary(review), reversible: true,
    issuedAt: "2026-10-05T01:00:00.000Z", expiresAt: "2026-10-05T01:10:00.000Z" });
  const request = connectorNativeTrashRequestSchema.parse({ contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId: connector.id,
    action: "trash", review: pin, preview });
  const intent = buildConnectorNativeTrashIntent(scope, "trash-key", request);
  const body = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, intent.keySha256), scope,
    keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent), kind: "mcp", connectorId: connector.id,
    action: "trash", reviewSha256: pin.reviewSha256, acceptedAt: "2026-10-05T01:00:01.000Z" };
  const acceptance = connectorNativeTrashAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
  const compensation = connectorNativeTrashCompensation(review);
  const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptance.id, settledAt: "2026-10-05T01:00:01.001Z",
    result: { kind: "mcp", connectorId: connector.id, operation: "trash", status: "complete", connectorStatus: null, contractCount: null,
      credentialVersion: null, connectorSha256: null, contractsSha256: null, configurationSha256: null, failureCode: null,
      trash: { trashId: "trash:11111111-1111-4111-8111-111111111111", proofSha256: "d".repeat(64), restoreUntil: "2026-11-04T01:00:01.000Z",
        compensation: compensation.kind, limitation: compensation.limitation } } };
  const settlement = connectorNativeTrashSettlementSchema.parse({ ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) });
  return { review, preview, compensation, request, intent, acceptance, settlement, action: { acceptance, state: "settled" as const, settlement } };
}

describe("exact native MCP Trash contracts", () => {
  it("binds the preview and compensation without requiring a usable credential or incrementable version", () => {
    for (const f of [fixture(), fixture(false, 0), fixture(true, 2147483647)]) {
      expect(canTrashNativeConnector(f.review)).toBe(true);
      expect(connectorNativeTrashPreviewSchema.parse({ review: f.review, preview: f.preview, compensation: f.compensation }))
        .toEqual({ review: f.review, preview: f.preview, compensation: f.compensation });
      expect(connectorNativeTrashActionSchema.parse(f.action)).toEqual(f.action);
    }
    expect(connectorNativeTrashPreviewSchema.parse({ review: null, preview: null, compensation: null })).toEqual({ review: null, preview: null, compensation: null });
    const f = fixture();
    const unavailable = { ...f.review, pin: null, availableActions: [], unavailableReason: "scope_too_large" };
    expect(connectorNativeTrashPreviewSchema.safeParse({ review: unavailable, preview: null, compensation: null }).success).toBe(true);
    expect(connectorNativeTrashPreviewSchema.safeParse({ review: unavailable, preview: f.preview, compensation: f.compensation }).success).toBe(false);
    expect(connectorNativeTrashPreviewSchema.safeParse({ review: f.review, preview: f.preview, compensation: fixture(false).compensation }).success).toBe(false);
  });
  it("rejects even resealed wrong-target, widened and non-ten-minute previews", () => {
    const f = fixture();
    const { previewSha256: _digest, ...body } = f.preview;
    for (const patch of [{ resourceId: "other" }, { resourceType: "openapi_connector" }, { action: "purge" },
      { trashId: "trash:11111111-1111-4111-8111-111111111111" }, { lifecycleRevision: 1 }, { reversible: false },
      { targetSha256: "e".repeat(64) }, { expiresAt: "2026-10-05T01:10:00.001Z" }, { bearerToken: "never-persist" }]) {
      const changed = { ...body, ...patch };
      expect(connectorNativeTrashRequestSchema.safeParse({ ...f.request, preview: { ...changed, previewSha256: canonicalJsonSha256(changed) } }).success).toBe(false);
    }
    const changed = { ...body, effectSummary: "No contracts will change." };
    expect(connectorNativeTrashPreviewSchema.safeParse({ review: f.review, compensation: f.compensation,
      preview: { ...changed, previewSha256: canonicalJsonSha256(changed) } }).success).toBe(false);
    for (const action of ["remove_credential", "discover", "upgrade_github", "rotate_mcp", "disable"]) {
      expect(connectorNativeTrashRequestSchema.safeParse({ ...f.request, action }).success).toBe(false);
    }
  });
  it("retains expired historical intent while isolating both earlier action families", () => {
    const f = fixture();
    expect(connectorNativeTrashRequestSchema.parse(f.request)).toEqual(f.request);
    expect(connectorNativeIntentSchema.safeParse(f.intent).success).toBe(false);
    expect(connectorNativeActionSchema.safeParse(f.action).success).toBe(false);
    expect(connectorNativeCredentialRemovalRequestSchema.safeParse(f.request).success).toBe(false);
    expect(connectorNativeCredentialRemovalActionSchema.safeParse(f.action).success).toBe(false);
    expect(connectorNativeTrashActionSchema.safeParse({ acceptance: f.acceptance, state: "accepted", settlement: null }).success).toBe(true);
    expect(connectorNativeTrashActionSchema.safeParse({ ...f.action, state: "accepted" }).success).toBe(false);
    expect(connectorNativeTrashActionSchema.safeParse({ ...f.action, settlement: null }).success).toBe(false);
  });
  it("rejects fabricated live state, provider revocation and inconsistent restore evidence", () => {
    const f = fixture();
    const { settlementSha256: _digest, ...body } = f.settlement;
    for (const patch of [{ connectorStatus: "disabled" }, { contractCount: 0 }, { credentialVersion: 3 },
      { contractsSha256: canonicalJsonSha256([]) }, { trash: null }, { status: "failed", failureCode: "target_changed" },
      { providerRevoked: true }, { trash: { ...body.result.trash, compensation: "exact_restore" } },
      { trash: { ...body.result.trash, restoreUntil: body.settledAt } }, { trash: { ...body.result.trash, proofSha256: "bad" } }]) {
      const changed = { ...body, result: { ...body.result, ...patch } };
      expect(connectorNativeTrashSettlementSchema.safeParse({ ...changed, settlementSha256: canonicalJsonSha256(changed) }).success).toBe(false);
    }
    const changed = { ...body, acceptanceId: `connector-acceptance:${"e".repeat(64)}` };
    expect(connectorNativeTrashActionSchema.safeParse({ ...f.action,
      settlement: { ...changed, settlementSha256: canonicalJsonSha256(changed) } }).success).toBe(false);
  });
});
