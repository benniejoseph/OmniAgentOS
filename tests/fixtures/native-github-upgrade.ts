import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { sealConnectorNativePin } from "@/lib/connectors/native-control-contracts";
import { OFFICIAL_GITHUB_MCP_ALL_ENDPOINT } from "@/lib/connectors/mcp-trust";
import * as C from "@/lib/connectors/native-github-upgrade-contracts";

/** Public deterministic synthetic evidence; no provider or database access. */
export function nativeGithubUpgradeFixture(authType: "none" | "bearer_env" | "bearer_vault" = "bearer_vault",
  toolCount = 2) {
  const scope = { tenantId: "github-upgrade-fixture", ownerActorId: "owner@example.test",
    canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
  const connectorId = `fixture-github-${authType}`, key = `fixture-github-key-${authType}-${toolCount}`;
  const credentialVersion = authType === "bearer_vault" ? 7 : 0;
  const originalPin = sealConnectorNativePin({ kind: "mcp", connectorId,
    connectorSha256: canonicalJsonSha256(["synthetic original connector", authType]),
    contractsSha256: canonicalJsonSha256([]),
    configurationSha256: canonicalJsonSha256(["synthetic original configuration", authType]),
    reviewFingerprint: null, credentialVersion });
  const request = C.connectorNativeGithubUpgradeRequestSchema.parse({
    contract: "asael-connector-lifecycle-action:1", kind: "mcp",
    connectorId, action: "upgrade_github", review: originalPin, preview: null,
  });
  const intent = C.buildConnectorNativeGithubUpgradeIntent(scope, key, request);
  const attemptBody = { contract: "asael-github-upgrade-attempt:1",
    id: C.connectorNativeGithubUpgradeAttemptId(scope, intent.keySha256),
    scope, keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent),
    connectorId, reviewSha256: request.review.reviewSha256,
    targetEndpoint: OFFICIAL_GITHUB_MCP_ALL_ENDPOINT,
    startedAt: "2026-10-05T10:00:00.000Z", expiresAt: "2026-10-05T10:00:45.000Z" };
  const attempt = C.connectorNativeGithubUpgradeAttemptSchema.parse({
    ...attemptBody, attemptSha256: canonicalJsonSha256(attemptBody),
  });
  const pending = C.connectorNativeGithubUpgradeReadSchema.parse({ state: "pending", intent, attempt });
  const expired = C.connectorNativeGithubUpgradeReadSchema.parse({ state: "expired", intent, attempt });
  const resultingPin = sealConnectorNativePin({ kind: "mcp", connectorId,
    connectorSha256: canonicalJsonSha256(["synthetic upgraded connector", authType, toolCount]),
    contractsSha256: canonicalJsonSha256(Array.from({ length: toolCount }, (_, index) => ({ fixtureTool: index }))),
    configurationSha256: canonicalJsonSha256(["synthetic upgraded configuration", authType, toolCount]),
    reviewFingerprint: "A".repeat(43), credentialVersion });
  const settlementBody = { contract: "asael-github-upgrade-settlement:1", attemptId: attempt.id,
    attemptSha256: attempt.attemptSha256, settledAt: "2026-10-05T10:00:01.000Z",
    result: { status: "complete", kind: "mcp", connectorId, connectorStatus: "disabled",
      endpoint: OFFICIAL_GITHUB_MCP_ALL_ENDPOINT, defaultRiskLevel: 2, approvalRequired: false,
      contractCount: toolCount, pendingCount: toolCount, credentialVersion, review: resultingPin } };
  const settlement = C.connectorNativeGithubUpgradeSettlementSchema.parse({
    ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody),
  });
  const settled = C.connectorNativeGithubUpgradeReadSchema.parse({ state: "settled", intent, attempt, settlement });
  const failed = C.connectorNativeGithubUpgradeFailureCodeSchema.options.map((failureCode) => {
    const body = { contract: "asael-github-upgrade-settlement:1", attemptId: attempt.id,
      attemptSha256: attempt.attemptSha256,
      settledAt: failureCode === "deadline_exceeded" ? attempt.expiresAt : "2026-10-05T10:00:01.000Z",
      result: { status: "failed", kind: "mcp", connectorId, failureCode } };
    return C.connectorNativeGithubUpgradeReadSchema.parse({ state: "settled", intent, attempt,
      settlement: { ...body, settlementSha256: canonicalJsonSha256(body) } });
  });
  const closeRequest = C.connectorNativeGithubUpgradeCloseRequestSchema.parse({
    contract: "asael-github-upgrade-close:1", intent,
  });
  function closed(admitted: typeof attempt | null) {
    const body = { contract: "asael-github-upgrade-closure:1", scope, keySha256: intent.keySha256,
      intentSha256: canonicalJsonSha256(intent), attemptId: admitted?.id ?? null,
      attemptSha256: admitted?.attemptSha256 ?? null, closedAt: "2026-10-05T10:00:02.000Z" };
    return C.connectorNativeGithubUpgradeCloseReadSchema.parse({ state: "closed", intent, attempt: admitted,
      closure: { ...body, closureSha256: canonicalJsonSha256(body) } });
  }
  return { scope, key, connectorId, authType, request, intent, attempt, pending, expired, settled,
    failed, closeRequest, closedAttempt: closed(attempt), closedAbsent: closed(null),
    closeSettled: C.connectorNativeGithubUpgradeCloseReadSchema.parse(settled) };
}
