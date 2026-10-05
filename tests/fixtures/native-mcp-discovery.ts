import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { sealConnectorNativePin } from "@/lib/connectors/native-control-contracts";
import * as C from "@/lib/connectors/native-mcp-discovery-contracts";

/** Public deterministic synthetic evidence; no provider or database access. */
export function nativeMcpDiscoveryFixture(authType: "none" | "bearer_env" | "bearer_vault" = "none", toolCount = 2) {
  const scope = { tenantId: "discovery-fixture", ownerActorId: "owner@example.test", canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
  const connectorId = `fixture-discovery-${authType}`, key = `fixture-discovery-key-${authType}-${toolCount}`;
  const credentialVersion = authType === "bearer_vault" ? 7 : 0;
  const originalPin = sealConnectorNativePin({ kind: "mcp", connectorId, connectorSha256: canonicalJsonSha256(["synthetic original connector", authType]),
    contractsSha256: canonicalJsonSha256([]), configurationSha256: canonicalJsonSha256(["synthetic original configuration", authType]),
    reviewFingerprint: null, credentialVersion });
  const request = C.connectorNativeMcpDiscoveryRequestSchema.parse({ contract: "asael-connector-lifecycle-action:1", kind: "mcp", connectorId,
    action: "discover", review: originalPin, preview: null });
  const intent = C.buildConnectorNativeMcpDiscoveryIntent(scope, key, request);
  const attemptBody = { contract: "asael-mcp-discovery-attempt:1", id: C.connectorNativeMcpDiscoveryAttemptId(scope, intent.keySha256),
    scope, keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent), kind: "mcp", connectorId,
    reviewSha256: request.review.reviewSha256, startedAt: "2026-10-05T10:00:00.000Z", expiresAt: "2026-10-05T10:00:45.000Z" };
  const attempt = C.connectorNativeMcpDiscoveryAttemptSchema.parse({ ...attemptBody, attemptSha256: canonicalJsonSha256(attemptBody) });
  const pending = C.connectorNativeMcpDiscoveryReadSchema.parse({ state: "pending", intent, attempt });
  const expired = C.connectorNativeMcpDiscoveryReadSchema.parse({ state: "expired", intent, attempt });
  const resultingPin = sealConnectorNativePin({ kind: "mcp", connectorId, connectorSha256: canonicalJsonSha256(["synthetic discovered connector", authType, toolCount]),
    contractsSha256: canonicalJsonSha256(Array.from({ length: toolCount }, (_, index) => ({ fixtureTool: index }))),
    configurationSha256: canonicalJsonSha256(["synthetic discovered configuration", authType, toolCount]),
    reviewFingerprint: toolCount ? "A".repeat(43) : null, credentialVersion });
  const settlementBody = { contract: "asael-mcp-discovery-settlement:1", attemptId: attempt.id, attemptSha256: attempt.attemptSha256,
    settledAt: "2026-10-05T10:00:01.000Z", result: { status: "complete", kind: "mcp", connectorId, connectorStatus: "disabled",
      contractCount: toolCount, pendingCount: toolCount, credentialVersion, review: resultingPin } };
  const settlement = C.connectorNativeMcpDiscoverySettlementSchema.parse({ ...settlementBody, settlementSha256: canonicalJsonSha256(settlementBody) });
  const settled = C.connectorNativeMcpDiscoveryReadSchema.parse({ state: "settled", intent, attempt, settlement });
  const failed = C.connectorNativeMcpDiscoveryFailureCodeSchema.options.map((failureCode) => {
    const body = { contract: "asael-mcp-discovery-settlement:1", attemptId: attempt.id, attemptSha256: attempt.attemptSha256,
      settledAt: failureCode === "deadline_exceeded" ? attempt.expiresAt : "2026-10-05T10:00:01.000Z",
      result: { status: "failed", kind: "mcp", connectorId, failureCode } };
    return C.connectorNativeMcpDiscoveryReadSchema.parse({ state: "settled", intent, attempt,
      settlement: { ...body, settlementSha256: canonicalJsonSha256(body) } });
  });
  const closeRequest = C.connectorNativeMcpDiscoveryCloseRequestSchema.parse({ contract: "asael-mcp-discovery-close:1", intent });
  function closed(admitted: typeof attempt | null) {
    const body = { contract: "asael-mcp-discovery-closure:1", scope, keySha256: intent.keySha256, intentSha256: canonicalJsonSha256(intent),
      attemptId: admitted?.id ?? null, attemptSha256: admitted?.attemptSha256 ?? null, closedAt: "2026-10-05T10:00:02.000Z" };
    return C.connectorNativeMcpDiscoveryCloseReadSchema.parse({ state: "closed", intent, attempt: admitted,
      closure: { ...body, closureSha256: canonicalJsonSha256(body) } });
  }
  return { scope, key, connectorId, authType, request, intent, attempt, pending, expired, settled, failed, closeRequest,
    closedAttempt: closed(attempt), closedAbsent: closed(null), closeSettled: C.connectorNativeMcpDiscoveryCloseReadSchema.parse(settled) };
}
