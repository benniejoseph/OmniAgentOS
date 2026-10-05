import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeAcceptanceId, connectorNativePreparationId, connectorNativeReviewSchema, sealConnectorNativePin } from "@/lib/connectors/native-control-contracts";
import { buildConnectorNativeCredentialPreparationIntent, buildConnectorNativeCredentialRotationIntent, nativeCredentialPreparationDeclaration,
  connectorNativeCredentialPrepareRequestSchema, connectorNativeCredentialPreparationSchema, connectorNativeCredentialPreparationReadSchema,
  connectorNativeCredentialPreparationAbandonRequestSchema, connectorNativeCredentialPreparationAbandonmentId,
  connectorNativeCredentialPreparationAbandonmentSchema, connectorNativeCredentialRotationRequestSchema,
  connectorNativeCredentialRotationAcceptanceSchema, connectorNativeCredentialRotationSettlementSchema, connectorNativeCredentialRotationActionSchema,
} from "@/lib/connectors/native-credential-rotation-contracts";

/** Synthetic, deterministic wire evidence; no provider or database access. */
export function nativeCredentialRotationFixture(version = 2) {
  const scope = { tenantId: "rotation-fixture", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
  const connector = { kind: "mcp", id: "rotation-fixture-mcp", name: "Fixture MCP", endpoint: "https://example.test/mcp", endpointRedacted: true,
    status: "active", authType: version ? "bearer_vault" : "none", authTokenEnv: null, authHeaderName: null,
    credentialConfigured: version > 0, credentialVersion: version, credentialOriginMatch: version > 0, defaultRiskLevel: 1,
    approvalRequired: true, contractCount: 1, discoveredAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z" };
  const contracts = [{ id: "rotation-fixture-mcp:tool", name: "fixture_read", description: "Synthetic fixture", status: "active", riskLevel: 1,
    approvalRequired: true, fingerprint: "x".repeat(43), definition: { inputSchema: { type: "object" } } }];
  const review = connectorNativeReviewSchema.parse({ connector, contracts, pin: sealConnectorNativePin({ kind: "mcp", connectorId: connector.id,
    connectorSha256: canonicalJsonSha256(connector), contractsSha256: canonicalJsonSha256(contracts), configurationSha256: canonicalJsonSha256(["synthetic configuration", version]),
    reviewFingerprint: null, credentialVersion: version }), availableActions: ["disable"], unavailableReason: null });
  const preparationKey = "fixture-preparation-key", rotationKey = "fixture-rotation-key";
  const prepareRequest = connectorNativeCredentialPrepareRequestSchema.parse({ contract: "asael-connector-prepare:1", nonce: "22222222-2222-4222-8222-222222222222",
    operation: "rotate_mcp", connectorId: connector.id, review: review.pin, declaration: nativeCredentialPreparationDeclaration(review),
    payload: { endpoint: null, specUrl: null, specText: null, bearerToken: "synthetic-fixture-only" } });
  const preparationIntent = buildConnectorNativeCredentialPreparationIntent(scope, preparationKey, prepareRequest);
  const { contract: _contract, ...safe } = preparationIntent;
  const body = { ...safe, contract: "asael-connector-preparation:1", id: connectorNativePreparationId(scope, preparationIntent.keySha256),
    intentSha256: canonicalJsonSha256(preparationIntent), configurationSha256: prepareRequest.review.configurationSha256,
    preparedAt: "2026-10-05T00:01:00.000Z", expiresAt: "2026-10-05T00:16:00.000Z" };
  const preparation = connectorNativeCredentialPreparationSchema.parse({ ...body, preparationSha256: canonicalJsonSha256(body) });
  const rotationRequest = connectorNativeCredentialRotationRequestSchema.parse({ contract: "asael-connector-prepared-action:1", kind: "mcp", connectorId: connector.id,
    action: "rotate_mcp", preparationId: preparation.id, preparationSha256: preparation.preparationSha256, review: preparation.review });
  const rotationIntent = buildConnectorNativeCredentialRotationIntent(scope, rotationKey, rotationRequest);
  const acceptanceBody = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, rotationIntent.keySha256), scope,
    keySha256: rotationIntent.keySha256, requestSha256: canonicalJsonSha256(rotationIntent), kind: "mcp", connectorId: connector.id,
    action: "rotate_mcp", reviewSha256: preparation.preparationSha256, acceptedAt: "2026-10-05T00:02:00.000Z" };
  const acceptance = connectorNativeCredentialRotationAcceptanceSchema.parse({ ...acceptanceBody, acceptanceSha256: canonicalJsonSha256(acceptanceBody) });
  const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptance.id, settledAt: "2026-10-05T00:02:00.001Z", result: {
    kind: "mcp", connectorId: connector.id, operation: "rotate_mcp", status: "complete", connectorStatus: "disabled", contractCount: 0,
    credentialVersion: version + 1, connectorSha256: canonicalJsonSha256(["synthetic saved connector", version + 1]), contractsSha256: canonicalJsonSha256([]),
    configurationSha256: canonicalJsonSha256(["synthetic saved configuration", version + 1]), trash: null, failureCode: null } };
  const settlement = connectorNativeCredentialRotationSettlementSchema.parse({ ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) });
  const rotationAction = connectorNativeCredentialRotationActionSchema.parse({ acceptance, state: "settled", settlement });
  const preparedReady = connectorNativeCredentialPreparationReadSchema.parse({ preparation, availability: "ready", consumedBy: null, consumedKeySha256: null });
  const preparedExpired = connectorNativeCredentialPreparationReadSchema.parse({ ...preparedReady, availability: "expired" });
  const preparedConsumed = connectorNativeCredentialPreparationReadSchema.parse({ preparation, availability: "consumed", consumedBy: acceptance.id, consumedKeySha256: rotationIntent.keySha256 });
  const abandonRequest = connectorNativeCredentialPreparationAbandonRequestSchema.parse({ contract: "asael-connector-credential-preparation-abandon:1", intent: preparationIntent });
  function abandoned(prepared: typeof preparation | null) {
    const abandonBody = { contract: "asael-connector-credential-preparation-abandonment:1", id: connectorNativeCredentialPreparationAbandonmentId(scope, preparationIntent.keySha256),
      scope, keySha256: preparationIntent.keySha256, intentSha256: canonicalJsonSha256(preparationIntent), preparationSha256: prepared?.preparationSha256 ?? null,
      abandonedAt: "2026-10-05T00:03:00.000Z" };
    const abandonment = connectorNativeCredentialPreparationAbandonmentSchema.parse({ ...abandonBody, abandonmentSha256: canonicalJsonSha256(abandonBody) });
    return connectorNativeCredentialPreparationReadSchema.parse({ intent: preparationIntent, preparation: prepared, availability: "abandoned", consumedBy: null, consumedKeySha256: null, abandonment });
  }
  return { scope, review, preparationKey, rotationKey, prepareRequest, preparationIntent, preparation, preparedReady, preparedExpired, preparedConsumed,
    abandonRequest, abandonedAbsent: abandoned(null), abandonedPrepared: abandoned(preparation), rotationRequest, rotationIntent, rotationAction };
}
