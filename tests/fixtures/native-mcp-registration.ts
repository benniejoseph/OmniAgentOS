import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeAcceptanceId } from "@/lib/connectors/native-control-contracts";
import {
  buildConnectorNativeMcpRegistrationPreparationIntent, buildConnectorNativeMcpRegistrationIntent,
  connectorNativeMcpRegistrationTargetId, connectorNativeMcpRegistrationPreparationId,
  connectorNativeMcpRegistrationAbandonmentId, normalizeNativeMcpRegistrationEndpoint,
  nativeMcpRegistrationEndpointProjection, connectorNativeMcpRegistrationPrepareRequestSchema,
  connectorNativeMcpRegistrationPreparationSchema, connectorNativeMcpRegistrationPreparationReadSchema,
  connectorNativeMcpRegistrationPreparationAbandonRequestSchema, connectorNativeMcpRegistrationPreparationAbandonmentSchema,
  connectorNativeMcpRegistrationRequestSchema, connectorNativeMcpRegistrationAcceptanceSchema,
  connectorNativeMcpRegistrationSettlementSchema, connectorNativeMcpRegistrationActionSchema,
} from "@/lib/connectors/native-mcp-registration-contracts";

/** Synthetic deterministic wire evidence. No provider, credential vault or database access. */
export function nativeMcpRegistrationFixture(authType: "none" | "bearer_env" | "bearer_vault" = "none", privateEndpoint = false) {
  const scope = { tenantId: "registration-fixture", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
  const index = ["none", "bearer_env", "bearer_vault"].indexOf(authType) * 2 + (privateEndpoint ? 2 : 1);
  const nonce = `33333333-3333-4333-8333-33333333333${index}`;
  const connectorId = connectorNativeMcpRegistrationTargetId(scope, nonce);
  const endpoint = normalizeNativeMcpRegistrationEndpoint(privateEndpoint
    ? "https://EXAMPLE.test:443/api/%2f/mcp?fixture=synthetic-private-query#synthetic-fragment"
    : "https://EXAMPLE.test:443/api/%2f/mcp");
  const declaration = { name: "Fixture MCP", ...nativeMcpRegistrationEndpointProjection(endpoint), authType,
    authTokenEnv: authType === "bearer_env" ? "OMNIAGENT_CONNECTOR_FIXTURE_TOKEN" : null, authHeaderName: null,
    defaultRiskLevel: 2, approvalRequired: true, specSource: "none", specUrl: null, specUrlRedacted: false };
  const preparationKey = `fixture-registration-preparation-${index}`, registrationKey = `fixture-registration-action-${index}`;
  const prepareRequest = connectorNativeMcpRegistrationPrepareRequestSchema.parse({ contract: "asael-connector-prepare:1", nonce,
    operation: "register_mcp", connectorId, review: null, declaration,
    payload: { endpoint, specUrl: null, specText: null, bearerToken: authType === "bearer_vault" ? "synthetic-fixture-only" : null } });
  const preparationIntent = buildConnectorNativeMcpRegistrationPreparationIntent(scope, preparationKey, prepareRequest);
  const { contract: _contract, ...safe } = preparationIntent;
  const body = { ...safe, contract: "asael-connector-preparation:1", id: connectorNativeMcpRegistrationPreparationId(scope, preparationIntent.keySha256),
    intentSha256: canonicalJsonSha256(preparationIntent), configurationSha256: canonicalJsonSha256(["synthetic opaque configuration binding", index]),
    preparedAt: "2026-10-05T00:01:00.000Z", expiresAt: "2026-10-05T00:16:00.000Z" };
  const preparation = connectorNativeMcpRegistrationPreparationSchema.parse({ ...body, preparationSha256: canonicalJsonSha256(body) });
  const registrationRequest = connectorNativeMcpRegistrationRequestSchema.parse({ contract: "asael-connector-prepared-action:1", kind: "mcp", connectorId,
    action: "register_mcp", preparationId: preparation.id, preparationSha256: preparation.preparationSha256, review: null });
  const registrationIntent = buildConnectorNativeMcpRegistrationIntent(scope, registrationKey, registrationRequest);
  const acceptanceBody = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, registrationIntent.keySha256), scope,
    keySha256: registrationIntent.keySha256, requestSha256: canonicalJsonSha256(registrationIntent), kind: "mcp", connectorId,
    action: "register_mcp", reviewSha256: preparation.preparationSha256, acceptedAt: "2026-10-05T00:02:00.000Z" };
  const acceptance = connectorNativeMcpRegistrationAcceptanceSchema.parse({ ...acceptanceBody, acceptanceSha256: canonicalJsonSha256(acceptanceBody) });
  const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptance.id, settledAt: "2026-10-05T00:02:00.001Z", result: {
    kind: "mcp", connectorId, operation: "register_mcp", status: "complete", connectorStatus: "disabled", contractCount: 0,
    credentialVersion: authType === "bearer_vault" ? 1 : 0, connectorSha256: canonicalJsonSha256(["synthetic saved connector", index]),
    contractsSha256: canonicalJsonSha256([]), configurationSha256: canonicalJsonSha256(["synthetic saved configuration", index]), trash: null, failureCode: null } };
  const settlement = connectorNativeMcpRegistrationSettlementSchema.parse({ ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) });
  const registrationAction = connectorNativeMcpRegistrationActionSchema.parse({ acceptance, state: "settled", settlement });
  const preparedReady = connectorNativeMcpRegistrationPreparationReadSchema.parse({ preparation, availability: "ready", consumedBy: null, consumedKeySha256: null });
  const preparedExpired = connectorNativeMcpRegistrationPreparationReadSchema.parse({ ...preparedReady, availability: "expired" });
  const preparedConsumed = connectorNativeMcpRegistrationPreparationReadSchema.parse({ preparation, availability: "consumed", consumedBy: acceptance.id, consumedKeySha256: registrationIntent.keySha256 });
  const abandonRequest = connectorNativeMcpRegistrationPreparationAbandonRequestSchema.parse({ contract: "asael-mcp-registration-preparation-abandon:1", intent: preparationIntent });
  function abandoned(prepared: typeof preparation | null) {
    const abandonBody = { contract: "asael-mcp-registration-preparation-abandonment:1", id: connectorNativeMcpRegistrationAbandonmentId(scope, preparationIntent.keySha256),
      scope, keySha256: preparationIntent.keySha256, intentSha256: canonicalJsonSha256(preparationIntent), preparationSha256: prepared?.preparationSha256 ?? null,
      abandonedAt: "2026-10-05T00:03:00.000Z" };
    const abandonment = connectorNativeMcpRegistrationPreparationAbandonmentSchema.parse({ ...abandonBody, abandonmentSha256: canonicalJsonSha256(abandonBody) });
    return connectorNativeMcpRegistrationPreparationReadSchema.parse({ intent: preparationIntent, preparation: prepared, availability: "abandoned",
      consumedBy: null, consumedKeySha256: null, abandonment });
  }
  return { scope, nonce, connectorId, preparationKey, registrationKey, prepareRequest, preparationIntent, preparation,
    preparedReady, preparedExpired, preparedConsumed, abandonRequest, abandonedAbsent: abandoned(null), abandonedPrepared: abandoned(preparation),
    registrationRequest, registrationIntent, registrationAction };
}

/** Exact server normalization vectors consumed independently by Dart. */
export function nativeMcpRegistrationNormalizationFixtures() {
  return [
    "https://EXAMPLE.test:443/mcp",
    "http://EXAMPLE.test:80/mcp",
    "https://example.test",
    "https://example.test/a/%2f/%7e/mcp",
    "https://example.test/a/%2e/mcp",
    "https://example.test/a/%2e%2e/mcp",
    "https://example.test/a/./b/../mcp",
    "https://example.test/mcp?",
    "https://example.test/mcp#",
    "https://example.test/mcp?#",
    "https://example.test/mcp?fixture=synthetic-private-query#synthetic-fragment",
    "https://example.test/mcp?fixture=synthetic%2fquery#synthetic%2ffragment",
  ].map((input) => ({ input, normalized: normalizeNativeMcpRegistrationEndpoint(input), ...nativeMcpRegistrationEndpointProjection(input) }));
}
