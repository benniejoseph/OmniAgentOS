import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeKeySha256, NativeConnectorError } from "@/lib/connectors/native-control-contracts";
import type { ConnectorNativeAuthority } from "@/lib/connectors/native-control-store";
import { connectorNativeMcpDiscoveryRequestSchema, connectorNativeMcpDiscoveryCloseRequestSchema } from "@/lib/connectors/native-mcp-discovery-contracts";
import { submitNativeMcpDiscovery, readNativeMcpDiscovery, closeNativeMcpDiscovery } from "@/lib/connectors/native-mcp-discovery-store";
import { assertNativeConnectorMcpDiscoveryResponseScope, nativeConnectorMcpDiscoveryReadInputSchema,
  nativeConnectorMcpDiscoverySubmitResponseSchema, nativeConnectorMcpDiscoveryReadResponseSchema,
  nativeConnectorMcpDiscoveryCloseResponseSchema } from "@/lib/mobile/connector-mcp-discovery-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

function authorityFor(caller: AppServiceCaller, mutation: boolean): ConnectorNativeAuthority {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context);
  if (!canonical || (mutation ? !caller.executionScope || !caller.idempotencyKey : caller.executionScope !== undefined || caller.idempotencyKey !== undefined)) {
    throw new NativeConnectorError("connector_authority", 403, "Current authenticated connector authority is required.");
  }
  return { scope: { tenantId: caller.context.tenantId, ownerActorId: caller.context.actorId, canonicalActorId: canonical.actorId },
    ...(mutation ? { executionScope: caller.executionScope } : {}) };
}
function expected(caller: AppServiceCaller, authority: ConnectorNativeAuthority) {
  return { scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role,
    executionScope: caller.executionScope, idempotencyKey: caller.idempotencyKey };
}
export async function submitNativeMcpDiscoveryService(caller: AppServiceCaller, input: z.input<typeof connectorNativeMcpDiscoveryRequestSchema>) {
  const request = connectorNativeMcpDiscoveryRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.mcpDiscoveries.submit")), authority = authorityFor(caller, true);
  const result = await submitNativeMcpDiscovery({ authority, request, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorMcpDiscoverySubmitResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorMcpDiscoveryResponseScope(response, { ...expected(caller, authority), request });
  return completed;
}
export async function readNativeMcpDiscoveryService(caller: AppServiceCaller, input: z.input<typeof nativeConnectorMcpDiscoveryReadInputSchema>) {
  const request = nativeConnectorMcpDiscoveryReadInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.mcpDiscoveries.read")), authority = authorityFor(caller, false);
  const discovery = await readNativeMcpDiscovery(authority, request.keySha256);
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, discovery }, { resourceCount: discovery ? 1 : 0 });
  const response = nativeConnectorMcpDiscoveryReadResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorMcpDiscoveryResponseScope(response, { ...expected(caller, authority), keySha256: request.keySha256 });
  return completed;
}
export async function closeNativeMcpDiscoveryService(caller: AppServiceCaller, input: z.input<typeof connectorNativeMcpDiscoveryCloseRequestSchema>,
  keyInput: z.input<typeof nativeConnectorMcpDiscoveryReadInputSchema>) {
  const request = connectorNativeMcpDiscoveryCloseRequestSchema.parse(input), { keySha256 } = nativeConnectorMcpDiscoveryReadInputSchema.parse(keyInput);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.mcpDiscoveries.close")), authority = authorityFor(caller, true);
  if (connectorNativeKeySha256(authority.scope, caller.idempotencyKey!) !== keySha256 || request.intent.keySha256 !== keySha256 ||
    canonicalJsonSha256(request.intent.scope) !== canonicalJsonSha256(authority.scope)) {
    throw new NativeConnectorError("connector_conflict", 409, "The original discovery authority and key are required.");
  }
  const result = await closeNativeMcpDiscovery({ authority, request, keySha256, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorMcpDiscoveryCloseResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorMcpDiscoveryResponseScope(response, { ...expected(caller, authority), keySha256, intent: request.intent });
  return completed;
}
