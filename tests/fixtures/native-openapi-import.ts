import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeAcceptanceId } from "@/lib/connectors/native-control-contracts";
import {
  buildConnectorNativeOpenapiImportIntent, buildConnectorNativeOpenapiImportPreparationIntent,
  connectorNativeOpenapiImportTargetId, connectorNativeOpenapiImportAttemptId,
  connectorNativeOpenapiImportPreparationId, connectorNativeOpenapiImportAbandonmentId,
  normalizeNativeOpenapiImportSourceUrl, nativeOpenapiImportSourceProjection, normalizeNativeOpenapiImportBaseUrl,
  connectorNativeOpenapiImportPrepareRequestSchema, connectorNativeOpenapiImportAttemptSchema,
  connectorNativeOpenapiImportPreparationSchema, connectorNativeOpenapiImportSummarySchema,
  connectorNativeOpenapiImportPreparationPreparingReadSchema, connectorNativeOpenapiImportPreparationReadyReadSchema,
  connectorNativeOpenapiImportPreparationExpiredReadSchema, connectorNativeOpenapiImportPreparationFailedReadSchema,
  connectorNativeOpenapiImportPreparationConsumedReadSchema, connectorNativeOpenapiImportPreparationAbandonedReadSchema,
  connectorNativeOpenapiImportPreparationAbandonRequestSchema, connectorNativeOpenapiImportPreparationAbandonmentSchema,
  connectorNativeOpenapiImportRequestSchema, connectorNativeOpenapiImportAcceptanceSchema,
  connectorNativeOpenapiImportSettlementSchema, connectorNativeOpenapiImportActionSchema,
  type ConnectorNativeOpenapiImportAttempt, type ConnectorNativeOpenapiImportPreparation,
} from "@/lib/connectors/native-openapi-import-contracts";

/** Deterministic synthetic wire vectors, without database, vault or provider access.
 * Opaque fixture bindings are stand-ins, never hashes of private source content. */
export function nativeOpenapiImportFixture(
  authType: "none" | "bearer_env" | "api_key_header_env" = "none",
  source: "url" | "text" = "text",
  privateSource = false,
) {
  const scope = { tenantId: "openapi-import-fixture", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
  const index = ["none", "bearer_env", "api_key_header_env"].indexOf(authType) * 4 + (source === "url" ? 2 : 0) + (privateSource ? 2 : 1);
  const nonce = `44444444-4444-4444-8444-4444444444${String(index).padStart(2, "0")}`;
  const connectorId = connectorNativeOpenapiImportTargetId(scope, nonce);
  const fullSource = source === "url" ? normalizeNativeOpenapiImportSourceUrl(privateSource
    ? "https://SPEC.example.test:443/openapi/%2f/doc?fixture=synthetic-private-query#synthetic-fragment"
    : "https://SPEC.example.test:443/openapi/%2f/doc") : null;
  const resolvedBase = "https://api.example.test/v1";
  const declaration = { name: "Fixture OpenAPI", endpoint: null, endpointRedacted: false, authType,
    authTokenEnv: authType === "none" ? null : "OMNIAGENT_CONNECTOR_FIXTURE_TOKEN",
    authHeaderName: authType === "api_key_header_env" ? "X-Fixture-Key" : null,
    defaultRiskLevel: 1, approvalRequired: false, specSource: source,
    ...(fullSource ? nativeOpenapiImportSourceProjection(fullSource) : { specUrl: null, specUrlRedacted: false }) };
  const specText = JSON.stringify({ openapi: "3.1.0", info: { title: "Synthetic fixture", version: "1" }, servers: [{ url: resolvedBase }], paths: {
    "/items": { get: { operationId: "list_items", responses: { "200": { description: "Fixture" } } },
      post: { operationId: "create_item", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } } } }, responses: { "200": { description: "Fixture" } } } },
  } });
  const preparationKey = `fixture-openapi-preparation-${index}`, finalKey = `fixture-openapi-action-${index}`;
  const prepareRequest = connectorNativeOpenapiImportPrepareRequestSchema.parse({ contract: "asael-openapi-import-prepare:1",
    kind: "openapi", nonce, operation: "import_openapi", connectorId, review: null, declaration,
    payload: { endpoint: null, specUrl: fullSource, specText: source === "text" ? specText : null } });
  const intent = buildConnectorNativeOpenapiImportPreparationIntent(scope, preparationKey, prepareRequest);
  const attemptBody = { contract: "asael-openapi-import-attempt:1", id: connectorNativeOpenapiImportAttemptId(scope, intent.keySha256), scope,
    keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent), startedAt: "2026-10-05T00:00:00.000Z", expiresAt: "2026-10-05T00:00:45.000Z" };
  const attempt = connectorNativeOpenapiImportAttemptSchema.parse({ ...attemptBody, attemptSha256: canonicalJsonSha256(attemptBody) });
  const summary = connectorNativeOpenapiImportSummarySchema.parse({ contract: "asael-openapi-import-summary:1", connectorId, operations: [
    { id: `openapi:${connectorId}:list_items`, operationId: "list_items", method: "GET", path: "/items", riskLevel: 1, approvalRequired: false,
      definitionSha256: canonicalJsonSha256(["synthetic opaque list definition", index]) },
    { id: `openapi:${connectorId}:create_item`, operationId: "create_item", method: "POST", path: "/items", riskLevel: 2, approvalRequired: true,
      definitionSha256: canonicalJsonSha256(["synthetic opaque create definition", index]) },
  ] });
  const { contract: _contract, ...safe } = intent;
  const proofBody = { ...safe, contract: "asael-openapi-import-preparation:1", id: connectorNativeOpenapiImportPreparationId(scope, intent.keySha256),
    intentSha256: canonicalJsonSha256(intent), resolvedDeclaration: { ...intent.declaration, endpoint: resolvedBase }, attemptSha256: attempt.attemptSha256,
    configurationSha256: canonicalJsonSha256(["synthetic opaque configuration", index]), snapshotSha256: canonicalJsonSha256(["synthetic opaque snapshot", index]),
    summarySha256: canonicalJsonSha256(summary), reviewProjectionSha256: canonicalJsonSha256(["synthetic opaque review projection", index]), contractCount: 2,
    preparedAt: "2026-10-05T00:00:10.000Z", expiresAt: "2026-10-05T00:15:10.000Z" };
  const preparation = connectorNativeOpenapiImportPreparationSchema.parse({ ...proofBody, preparationSha256: canonicalJsonSha256(proofBody) });
  const request = connectorNativeOpenapiImportRequestSchema.parse({ contract: "asael-connector-prepared-action:1", kind: "openapi", connectorId,
    action: "import_openapi", preparationId: preparation.id, preparationSha256: preparation.preparationSha256, review: null });
  const actionIntent = buildConnectorNativeOpenapiImportIntent(scope, finalKey, request);
  const acceptanceBody = { contract: "asael-connector-acceptance:1", id: connectorNativeAcceptanceId(scope, actionIntent.keySha256), scope,
    keySha256: actionIntent.keySha256, requestSha256: canonicalJsonSha256(actionIntent), kind: "openapi", connectorId, action: "import_openapi",
    reviewSha256: preparation.preparationSha256, acceptedAt: "2026-10-05T00:00:20.000Z" };
  const acceptance = connectorNativeOpenapiImportAcceptanceSchema.parse({ ...acceptanceBody, acceptanceSha256: canonicalJsonSha256(acceptanceBody) });
  const settlementBody = { contract: "asael-connector-settlement:2", acceptanceId: acceptance.id, settledAt: "2026-10-05T00:00:20.001Z", result: {
    kind: "openapi", connectorId, operation: "import_openapi", status: "complete", connectorStatus: "disabled", contractCount: 2,
    credentialVersion: 0, connectorSha256: canonicalJsonSha256(["synthetic saved connector", index]), contractsSha256: canonicalJsonSha256(["synthetic saved contracts", index]),
    configurationSha256: preparation.configurationSha256, trash: null, failureCode: null } };
  const settlement = connectorNativeOpenapiImportSettlementSchema.parse({ ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) });
  const action = connectorNativeOpenapiImportActionSchema.parse({ acceptance, state: "settled", settlement });
  const preparing = connectorNativeOpenapiImportPreparationPreparingReadSchema.parse({ availability: "preparing", intent, attempt });
  const ready = connectorNativeOpenapiImportPreparationReadyReadSchema.parse({ availability: "ready", intent, attempt, preparation, summary });
  const expired = connectorNativeOpenapiImportPreparationExpiredReadSchema.parse({ availability: "expired", intent, attempt, preparation });
  const expiredAttempt = connectorNativeOpenapiImportPreparationExpiredReadSchema.parse({ availability: "expired", intent, attempt, preparation: null });
  const failed = connectorNativeOpenapiImportPreparationFailedReadSchema.parse({ availability: "failed", intent, attempt,
    failure: { code: "unsupported_spec", failedAt: "2026-10-05T00:00:12.000Z" } });
  const consumed = connectorNativeOpenapiImportPreparationConsumedReadSchema.parse({ availability: "consumed", intent, attempt, preparation,
    consumedBy: acceptance.id, consumedKeySha256: actionIntent.keySha256 });
  const abandonRequest = connectorNativeOpenapiImportPreparationAbandonRequestSchema.parse({ contract: "asael-openapi-import-preparation-abandon:1", intent });
  function abandon(originalAttempt: ConnectorNativeOpenapiImportAttempt | null, originalProof: ConnectorNativeOpenapiImportPreparation | null) {
    const body = { contract: "asael-openapi-import-preparation-abandonment:1", id: connectorNativeOpenapiImportAbandonmentId(scope, intent.keySha256), scope,
      keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent), attemptSha256: originalAttempt?.attemptSha256 ?? null,
      preparationSha256: originalProof?.preparationSha256 ?? null, abandonedAt: "2026-10-05T00:00:25.000Z" };
    const abandonment = connectorNativeOpenapiImportPreparationAbandonmentSchema.parse({ ...body, abandonmentSha256: canonicalJsonSha256(body) });
    return connectorNativeOpenapiImportPreparationAbandonedReadSchema.parse({ availability: "abandoned", intent, attempt: originalAttempt, preparation: originalProof, abandonment });
  }
  return { scope, nonce, connectorId, preparationKey, finalKey, prepareRequest, intent, attempt, summary, preparation,
    preparing, ready, expired, expiredAttempt, failed, consumed, abandonRequest,
    abandonedAbsent: abandon(null, null), abandonedAttempt: abandon(attempt, null), abandonedPrepared: abandon(attempt, preparation),
    request, actionIntent, action };
}

export function nativeOpenapiImportNormalizationFixtures() {
  const inputs = ["https://EXAMPLE.test:443/doc", "http://EXAMPLE.test:80/doc", "https://example.test", "https://example.test/a/%2f/%7e/doc",
    "https://example.test/a/%2e/doc", "https://example.test/a/%2e%2e/doc", "https://example.test/a/./b/../doc", "https://example.test/doc?",
    "https://example.test/doc#", "https://example.test/doc?#", "https://example.test/doc?fixture=synthetic-private-query#synthetic-fragment"];
  return inputs.map((input) => { let base: string | null = null;
    try { base = normalizeNativeOpenapiImportBaseUrl(input); } catch { /* Explicit source-only URL. */ }
    return { input, source: normalizeNativeOpenapiImportSourceUrl(input), ...nativeOpenapiImportSourceProjection(input), base };
  });
}
