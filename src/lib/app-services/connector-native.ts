import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeRequestSchema, NativeConnectorError } from "@/lib/connectors/native-control-contracts";
import { listNativeConnectors, readNativeConnectorAction, reviewNativeConnector, submitNativeConnectorAction, type ConnectorNativeAuthority } from "@/lib/connectors/native-control-store";
import { assertNativeConnectorResponseScope, nativeConnectorActionResponseSchema, nativeConnectorListResponseSchema,
  nativeConnectorReadInputSchema, nativeConnectorReadResponseSchema, nativeConnectorReviewInputSchema, nativeConnectorReviewResponseSchema } from "@/lib/mobile/connector-native-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";

function authorityFor(caller: AppServiceCaller, mutation: boolean): ConnectorNativeAuthority {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context);
  if (!canonical || (mutation ? !caller.executionScope || !caller.idempotencyKey : caller.executionScope !== undefined || caller.idempotencyKey !== undefined)) {
    throw new NativeConnectorError("connector_authority", 403, "Current authenticated connector authority is required.");
  }
  return { scope: { tenantId: caller.context.tenantId, ownerActorId: caller.context.actorId, canonicalActorId: canonical.actorId },
    ...(mutation ? { executionScope: caller.executionScope } : {}) };
}
export async function listNativeConnectorsService(caller: AppServiceCaller) {
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.list")), authority = authorityFor(caller, false);
  const result = await listNativeConnectors(authority);
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: result.connectors.length });
  const response = nativeConnectorListResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorResponseScope(response, { scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role });
  return completed;
}
export async function reviewNativeConnectorService(caller: AppServiceCaller, input: z.input<typeof nativeConnectorReviewInputSchema>) {
  const request = nativeConnectorReviewInputSchema.parse(input), authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.review")), authority = authorityFor(caller, false);
  const found = await reviewNativeConnector(authority, request.kind, request.id), review = found && { ...found, availableActions: canPerform(caller.context.role, "manage.connector") ? found.availableActions : [] };
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, review }, { resourceCount: review ? 1 : 0 });
  const response = nativeConnectorReviewResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorResponseScope(response, { scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role });
  if (response.review && (response.review.connector.kind !== request.kind || response.review.connector.id !== request.id)) throw new Error("Connector review target differs.");
  return completed;
}
export async function readNativeConnectorActionService(caller: AppServiceCaller, input: z.input<typeof nativeConnectorReadInputSchema>) {
  const request = nativeConnectorReadInputSchema.parse(input), authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.show")), authority = authorityFor(caller, false);
  const action = await readNativeConnectorAction(authority, request.keySha256);
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, action }, { resourceCount: action ? 1 : 0 });
  const response = nativeConnectorReadResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorResponseScope(response, { scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role, keySha256: request.keySha256 });
  return completed;
}
export async function submitNativeConnectorActionService(caller: AppServiceCaller, input: z.input<typeof connectorNativeRequestSchema>) {
  const request = connectorNativeRequestSchema.parse(input), authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.act")), authority = authorityFor(caller, true);
  const result = await submitNativeConnectorAction({ authority, request, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorActionResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorResponseScope(response, { scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role,
    executionScope: caller.executionScope, idempotencyKey: caller.idempotencyKey, request });
  return completed;
}
