import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT, NativeConnectorError } from "@/lib/connectors/native-control-contracts";
import type { ConnectorNativeAuthority } from "@/lib/connectors/native-control-store";
import { connectorNativeTrashRequestSchema } from "@/lib/connectors/native-trash-contracts";
import { previewNativeConnectorTrash, readNativeConnectorTrash, submitNativeConnectorTrash } from "@/lib/connectors/native-trash-store";
import { assertNativeConnectorTrashResponseScope, nativeConnectorTrashPreviewInputSchema, nativeConnectorTrashPreviewResponseSchema,
  nativeConnectorTrashReadInputSchema, nativeConnectorTrashReadResponseSchema, nativeConnectorTrashSubmitResponseSchema } from "@/lib/mobile/connector-trash-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";

function authorityFor(caller: AppServiceCaller, mutation: boolean): ConnectorNativeAuthority {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context);
  if (!canonical || (mutation ? !caller.executionScope || !caller.idempotencyKey : caller.executionScope !== undefined || caller.idempotencyKey !== undefined)) {
    throw new NativeConnectorError("connector_authority", 403, "Current authenticated connector authority is required.");
  }
  return { scope: { tenantId: caller.context.tenantId, ownerActorId: caller.context.actorId, canonicalActorId: canonical.actorId },
    ...(mutation ? { executionScope: caller.executionScope } : {}) };
}
export async function previewNativeConnectorTrashService(caller: AppServiceCaller, input: z.input<typeof nativeConnectorTrashPreviewInputSchema>) {
  const request = nativeConnectorTrashPreviewInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.trash.preview")), authority = authorityFor(caller, false);
  const result = await previewNativeConnectorTrash(authority, request.id);
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: result.review ? 1 : 0 });
  const response = nativeConnectorTrashPreviewResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorTrashResponseScope(response, { scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role, connectorId: request.id });
  return completed;
}
export async function submitNativeConnectorTrashService(caller: AppServiceCaller, input: z.input<typeof connectorNativeTrashRequestSchema>) {
  const request = connectorNativeTrashRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.trash.submit")), authority = authorityFor(caller, true);
  const result = await submitNativeConnectorTrash({ authority, request, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorTrashSubmitResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorTrashResponseScope(response, { scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role,
    executionScope: caller.executionScope, idempotencyKey: caller.idempotencyKey, request });
  return completed;
}
export async function readNativeConnectorTrashService(caller: AppServiceCaller, input: z.input<typeof nativeConnectorTrashReadInputSchema>) {
  const request = nativeConnectorTrashReadInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.trash.read")), authority = authorityFor(caller, false);
  const action = await readNativeConnectorTrash(authority, request.keySha256);
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, action }, { resourceCount: action ? 1 : 0 });
  const response = nativeConnectorTrashReadResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorTrashResponseScope(response, { scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role, keySha256: request.keySha256 });
  return completed;
}
