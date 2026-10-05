import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeKeySha256, NativeConnectorError } from "@/lib/connectors/native-control-contracts";
import type { ConnectorNativeAuthority } from "@/lib/connectors/native-control-store";
import { connectorNativeGithubUpgradeRequestSchema, connectorNativeGithubUpgradeCloseRequestSchema } from "@/lib/connectors/native-github-upgrade-contracts";
import { submitNativeGithubUpgrade, readNativeGithubUpgrade, closeNativeGithubUpgrade,
  reviewNativeGithubUpgrade } from "@/lib/connectors/native-github-upgrade-store";
import { assertNativeConnectorGithubUpgradeResponseScope, nativeConnectorGithubUpgradeReadInputSchema,
  nativeConnectorGithubUpgradeSubmitResponseSchema, nativeConnectorGithubUpgradeReadResponseSchema,
  nativeConnectorGithubUpgradeCloseResponseSchema, nativeConnectorGithubUpgradeReviewResponseSchema,
  assertNativeConnectorGithubUpgradeReviewResponseScope } from "@/lib/mobile/connector-github-upgrade-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

function authorityFor(caller: AppServiceCaller, mutation: boolean): ConnectorNativeAuthority {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context);
  if (!canonical || (mutation ? !caller.executionScope || !caller.idempotencyKey
    : caller.executionScope !== undefined || caller.idempotencyKey !== undefined)) {
    throw new NativeConnectorError("connector_authority", 403, "Current authenticated GitHub upgrade authority is required.");
  }
  return { scope: { tenantId: caller.context.tenantId, ownerActorId: caller.context.actorId,
    canonicalActorId: canonical.actorId },
    ...(mutation ? { executionScope: caller.executionScope } : {}) };
}
function expected(caller: AppServiceCaller, authority: ConnectorNativeAuthority) {
  return { scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role,
    executionScope: caller.executionScope, idempotencyKey: caller.idempotencyKey };
}
export async function reviewNativeGithubUpgradeService(caller: AppServiceCaller, connectorId: string) {
  const authorized = authorizeAppServiceCall(caller,
    getAppServiceOperationContract("app.connectors.native.githubUpgrades.review"));
  const authority = authorityFor(caller, false);
  const upgradeReview = await reviewNativeGithubUpgrade(authority, connectorId);
  const completed = completeAppServiceCall(authorized,
    { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, upgradeReview },
    { resourceCount: upgradeReview ? 1 : 0 });
  const response = nativeConnectorGithubUpgradeReviewResponseSchema.parse({
    ...completed.data, serviceReceipt: completed.receipt,
  });
  assertNativeConnectorGithubUpgradeReviewResponseScope(response, { ...expected(caller, authority), connectorId });
  return completed;
}
export async function submitNativeGithubUpgradeService(caller: AppServiceCaller,
  input: z.input<typeof connectorNativeGithubUpgradeRequestSchema>) {
  const request = connectorNativeGithubUpgradeRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller,
    getAppServiceOperationContract("app.connectors.native.githubUpgrades.submit"));
  const authority = authorityFor(caller, true);
  const result = await submitNativeGithubUpgrade({ authority, request, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized,
    { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorGithubUpgradeSubmitResponseSchema.parse({
    ...completed.data, serviceReceipt: completed.receipt,
  });
  assertNativeConnectorGithubUpgradeResponseScope(response, { ...expected(caller, authority), request });
  return completed;
}
export async function readNativeGithubUpgradeService(caller: AppServiceCaller,
  input: z.input<typeof nativeConnectorGithubUpgradeReadInputSchema>) {
  const request = nativeConnectorGithubUpgradeReadInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller,
    getAppServiceOperationContract("app.connectors.native.githubUpgrades.read"));
  const authority = authorityFor(caller, false);
  const upgrade = await readNativeGithubUpgrade(authority, request.keySha256);
  const completed = completeAppServiceCall(authorized,
    { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, upgrade },
    { resourceCount: upgrade ? 1 : 0 });
  const response = nativeConnectorGithubUpgradeReadResponseSchema.parse({
    ...completed.data, serviceReceipt: completed.receipt,
  });
  assertNativeConnectorGithubUpgradeResponseScope(response, { ...expected(caller, authority),
    keySha256: request.keySha256 });
  return completed;
}
export async function closeNativeGithubUpgradeService(caller: AppServiceCaller,
  input: z.input<typeof connectorNativeGithubUpgradeCloseRequestSchema>,
  keyInput: z.input<typeof nativeConnectorGithubUpgradeReadInputSchema>) {
  const request = connectorNativeGithubUpgradeCloseRequestSchema.parse(input);
  const { keySha256 } = nativeConnectorGithubUpgradeReadInputSchema.parse(keyInput);
  const authorized = authorizeAppServiceCall(caller,
    getAppServiceOperationContract("app.connectors.native.githubUpgrades.close"));
  const authority = authorityFor(caller, true);
  if (connectorNativeKeySha256(authority.scope, caller.idempotencyKey!) !== keySha256 ||
    request.intent.keySha256 !== keySha256 ||
    canonicalJsonSha256(request.intent.scope) !== canonicalJsonSha256(authority.scope)) {
    throw new NativeConnectorError("connector_conflict", 409, "The original GitHub upgrade authority and key are required.");
  }
  const result = await closeNativeGithubUpgrade({
    authority, request, keySha256, idempotencyKey: caller.idempotencyKey!,
  });
  const completed = completeAppServiceCall(authorized,
    { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorGithubUpgradeCloseResponseSchema.parse({
    ...completed.data, serviceReceipt: completed.receipt,
  });
  assertNativeConnectorGithubUpgradeResponseScope(response, { ...expected(caller, authority),
    keySha256, intent: request.intent });
  return completed;
}
