import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT, NativeConnectorError } from "@/lib/connectors/native-control-contracts";
import type { ConnectorNativeAuthority } from "@/lib/connectors/native-control-store";
import { connectorNativeCredentialRemovalRequestSchema } from "@/lib/connectors/native-credential-removal-contracts";
import { readNativeConnectorCredentialRemoval, submitNativeConnectorCredentialRemoval } from "@/lib/connectors/native-credential-removal-store";
import { assertNativeConnectorCredentialRemovalResponseScope, nativeConnectorCredentialRemovalReadInputSchema,
  nativeConnectorCredentialRemovalReadResponseSchema, nativeConnectorCredentialRemovalSubmitResponseSchema } from "@/lib/mobile/connector-credential-removal-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";

function authorityFor(caller: AppServiceCaller, mutation: boolean): ConnectorNativeAuthority {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context);
  if (!canonical || (mutation ? !caller.executionScope || !caller.idempotencyKey : caller.executionScope !== undefined || caller.idempotencyKey !== undefined)) {
    throw new NativeConnectorError("connector_authority", 403, "Current authenticated connector authority is required.");
  }
  return {
    scope: { tenantId: caller.context.tenantId, ownerActorId: caller.context.actorId, canonicalActorId: canonical.actorId },
    ...(mutation ? { executionScope: caller.executionScope } : {}),
  };
}

export async function submitNativeConnectorCredentialRemovalService(caller: AppServiceCaller, input: z.input<typeof connectorNativeCredentialRemovalRequestSchema>) {
  const request = connectorNativeCredentialRemovalRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.credentialRemovals.submit"));
  const authority = authorityFor(caller, true);
  const result = await submitNativeConnectorCredentialRemoval({ authority, request, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorCredentialRemovalSubmitResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorCredentialRemovalResponseScope(response, {
    scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role,
    executionScope: caller.executionScope, idempotencyKey: caller.idempotencyKey, request,
  });
  return completed;
}

export async function readNativeConnectorCredentialRemovalService(caller: AppServiceCaller, input: z.input<typeof nativeConnectorCredentialRemovalReadInputSchema>) {
  const request = nativeConnectorCredentialRemovalReadInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.credentialRemovals.read"));
  const authority = authorityFor(caller, false);
  const action = await readNativeConnectorCredentialRemoval(authority, request.keySha256);
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, action }, { resourceCount: action ? 1 : 0 });
  const response = nativeConnectorCredentialRemovalReadResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorCredentialRemovalResponseScope(response, {
    scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role, keySha256: request.keySha256,
  });
  return completed;
}
