import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeAcceptanceId, connectorNativeActionSchema, connectorNativeIntentSchema, sealConnectorNativePin } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeCredentialRemovalIntent, connectorNativeCredentialRemovalAcceptanceSchema,
  connectorNativeCredentialRemovalActionSchema, connectorNativeCredentialRemovalRequestSchema,
  connectorNativeCredentialRemovalSettlementSchema } from "@/lib/connectors/native-credential-removal-contracts";

const scope = { tenantId: "removal-contract", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
function request(version = 2) {
  return { contract: "asael-connector-lifecycle-action:1" as const, kind: "mcp" as const, connectorId: "connector-one",
    action: "remove_credential" as const, preview: null,
    review: sealConnectorNativePin({ kind: "mcp", connectorId: "connector-one", connectorSha256: "a".repeat(64),
      contractsSha256: "b".repeat(64), configurationSha256: "c".repeat(64), reviewFingerprint: null, credentialVersion: version }) };
}
function fixture() {
  const intent = buildConnectorNativeCredentialRemovalIntent(scope, "removal-key", request());
  const body = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, intent.keySha256), scope,
    keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent), kind: "mcp", connectorId: "connector-one", action: "remove_credential",
    reviewSha256: intent.request.review.reviewSha256, acceptedAt: "2026-10-05T01:00:00.000Z" };
  const acceptance = connectorNativeCredentialRemovalAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
  const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptance.id, settledAt: "2026-10-05T01:00:00.001Z",
    result: { kind: "mcp", connectorId: "connector-one", operation: "remove_credential", status: "complete", connectorStatus: "disabled",
      contractCount: 0, credentialVersion: 3, connectorSha256: "d".repeat(64), contractsSha256: canonicalJsonSha256([]),
      configurationSha256: "e".repeat(64), trash: null, failureCode: null } };
  const settlement = connectorNativeCredentialRemovalSettlementSchema.parse({ ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) });
  return { intent, acceptance, settlement, action: { acceptance, state: "settled" as const, settlement } };
}

describe("removal-only native connector contract", () => {
  it("retains the lifecycle wire shape while excluding every other dormant action and raw credentials", () => {
    expect(connectorNativeCredentialRemovalRequestSchema.parse(request())).toEqual(request());
    for (const action of ["discover", "upgrade_github", "trash", "rotate_mcp", "disable"]) {
      expect(connectorNativeCredentialRemovalRequestSchema.safeParse({ ...request(), action }).success).toBe(false);
    }
    for (const patch of [{ kind: "openapi" }, { preview: {} }, { bearerToken: "never-persist" }, { connectorId: "other" }]) {
      expect(connectorNativeCredentialRemovalRequestSchema.safeParse({ ...request(), ...patch }).success).toBe(false);
    }
    expect(connectorNativeCredentialRemovalRequestSchema.safeParse(request(0)).success).toBe(false);
    expect(connectorNativeCredentialRemovalRequestSchema.safeParse(request(2147483647)).success).toBe(false);
    expect(connectorNativeCredentialRemovalRequestSchema.safeParse(request(2147483646)).success).toBe(true);
  });
  it("binds the whole exact request and isolates removal from v40 state receipt parsers", () => {
    const f = fixture();
    expect(connectorNativeCredentialRemovalActionSchema.parse(f.action)).toEqual(f.action);
    expect(connectorNativeCredentialRemovalActionSchema.safeParse({ acceptance: f.acceptance, state: "accepted", settlement: null }).success).toBe(true);
    expect(connectorNativeIntentSchema.safeParse(f.intent).success).toBe(false);
    expect(connectorNativeActionSchema.safeParse(f.action).success).toBe(false);
    expect(canonicalJsonSha256(buildConnectorNativeCredentialRemovalIntent(scope, "removal-key", request(3)))).not.toBe(f.acceptance.requestSha256);
    expect(connectorNativeCredentialRemovalActionSchema.safeParse({ ...f.action, state: "accepted" }).success).toBe(false);
    expect(connectorNativeCredentialRemovalActionSchema.safeParse({ ...f.action, settlement: null }).success).toBe(false);
    expect(connectorNativeCredentialRemovalActionSchema.safeParse({ ...f.action, acceptance: { ...f.acceptance, acceptanceSha256: "f".repeat(64) } }).success).toBe(false);
  });
  it("rejects even resealed settlements claiming provider revocation, a surviving tool, enabled state or failed effects", () => {
    const f = fixture();
    for (const patch of [{ operation: "rotate_mcp" }, { status: "failed", failureCode: "target_changed" },
      { connectorStatus: "active" }, { contractCount: 1 }, { contractsSha256: "f".repeat(64) },
      { credentialVersion: 1 }, { credentialVersion: 2147483648 }, { providerRevoked: true }]) {
      const { settlementSha256: _digest, ...body } = f.settlement;
      const changed = { ...body, result: { ...body.result, ...patch } };
      expect(connectorNativeCredentialRemovalSettlementSchema.safeParse({ ...changed, settlementSha256: canonicalJsonSha256(changed) }).success).toBe(false);
    }
    const { settlementSha256: _digest, ...body } = f.settlement;
    for (const patch of [{ acceptanceId: `connector-acceptance:${"f".repeat(64)}` }, { settledAt: "2026-10-05T00:59:59.999Z" }]) {
      const changed = { ...body, ...patch };
      expect(connectorNativeCredentialRemovalActionSchema.safeParse({ ...f.action,
        settlement: { ...changed, settlementSha256: canonicalJsonSha256(changed) } }).success).toBe(false);
    }
  });
});
