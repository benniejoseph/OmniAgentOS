import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeKeySha256, NativeConnectorError } from "@/lib/connectors/native-control-contracts";
import type { ConnectorNativeAuthority } from "@/lib/connectors/native-control-store";
import { buildConnectorNativeMcpRegistrationPreparationIntent, connectorNativeMcpRegistrationPrepareRequestSchema,
  connectorNativeMcpRegistrationPreparationAbandonRequestSchema, connectorNativeMcpRegistrationRequestSchema } from "@/lib/connectors/native-mcp-registration-contracts";
import { abandonNativeMcpRegistrationPreparation, prepareNativeMcpRegistration, readNativeMcpRegistrationPreparation,
  readNativeMcpRegistration, submitNativeMcpRegistration } from "@/lib/connectors/native-mcp-registration-store";
import { assertNativeConnectorMcpRegistrationPreparationResponseScope, assertNativeConnectorMcpRegistrationResponseScope,
  nativeConnectorMcpRegistrationReadInputSchema, nativeConnectorMcpRegistrationPreparationAbandonResponseSchema,
  nativeConnectorMcpRegistrationPreparationReadResponseSchema, nativeConnectorMcpRegistrationPreparationSubmitResponseSchema,
  nativeConnectorMcpRegistrationReadResponseSchema, nativeConnectorMcpRegistrationSubmitResponseSchema } from "@/lib/mobile/connector-mcp-registration-contracts";
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
function expectedAuthority(caller: AppServiceCaller, authority: ConnectorNativeAuthority) {
  return { scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role,
    executionScope: caller.executionScope, idempotencyKey: caller.idempotencyKey };
}
export async function prepareNativeMcpRegistrationService(caller: AppServiceCaller, input: z.input<typeof connectorNativeMcpRegistrationPrepareRequestSchema>) {
  const request = connectorNativeMcpRegistrationPrepareRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.mcpRegistrationPreparations.submit")), authority = authorityFor(caller, true);
  const intent = buildConnectorNativeMcpRegistrationPreparationIntent(authority.scope, caller.idempotencyKey!, request);
  const result = await prepareNativeMcpRegistration({ authority, request, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorMcpRegistrationPreparationSubmitResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorMcpRegistrationPreparationResponseScope(response, { ...expectedAuthority(caller, authority), intent });
  return completed;
}
export async function readNativeMcpRegistrationPreparationService(caller: AppServiceCaller, input: z.input<typeof nativeConnectorMcpRegistrationReadInputSchema>) {
  const request = nativeConnectorMcpRegistrationReadInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.mcpRegistrationPreparations.read")), authority = authorityFor(caller, false);
  const prepared = await readNativeMcpRegistrationPreparation(authority, request.keySha256);
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, prepared }, { resourceCount: prepared ? 1 : 0 });
  const response = nativeConnectorMcpRegistrationPreparationReadResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorMcpRegistrationPreparationResponseScope(response, { ...expectedAuthority(caller, authority), keySha256: request.keySha256 });
  return completed;
}
export async function abandonNativeMcpRegistrationPreparationService(caller: AppServiceCaller,
  input: z.input<typeof connectorNativeMcpRegistrationPreparationAbandonRequestSchema>, keyInput: z.input<typeof nativeConnectorMcpRegistrationReadInputSchema>) {
  const request = connectorNativeMcpRegistrationPreparationAbandonRequestSchema.parse(input), { keySha256 } = nativeConnectorMcpRegistrationReadInputSchema.parse(keyInput);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.mcpRegistrationPreparations.abandon")), authority = authorityFor(caller, true);
  if (connectorNativeKeySha256(authority.scope, caller.idempotencyKey!) !== keySha256 || request.intent.keySha256 !== keySha256 ||
    canonicalJsonSha256(request.intent.scope) !== canonicalJsonSha256(authority.scope)) {
    throw new NativeConnectorError("connector_conflict", 409, "The original MCP registration preparation authority and key are required.");
  }
  const result = await abandonNativeMcpRegistrationPreparation({ authority, request, keySha256, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorMcpRegistrationPreparationAbandonResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorMcpRegistrationPreparationResponseScope(response, { ...expectedAuthority(caller, authority), keySha256, intent: request.intent });
  return completed;
}
export async function submitNativeMcpRegistrationService(caller: AppServiceCaller, input: z.input<typeof connectorNativeMcpRegistrationRequestSchema>) {
  const request = connectorNativeMcpRegistrationRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.mcpRegistrations.submit")), authority = authorityFor(caller, true);
  const result = await submitNativeMcpRegistration({ authority, request, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorMcpRegistrationSubmitResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorMcpRegistrationResponseScope(response, { ...expectedAuthority(caller, authority), request });
  return completed;
}
export async function readNativeMcpRegistrationService(caller: AppServiceCaller, input: z.input<typeof nativeConnectorMcpRegistrationReadInputSchema>) {
  const request = nativeConnectorMcpRegistrationReadInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.mcpRegistrations.read")), authority = authorityFor(caller, false);
  const action = await readNativeMcpRegistration(authority, request.keySha256);
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, action }, { resourceCount: action ? 1 : 0 });
  const response = nativeConnectorMcpRegistrationReadResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorMcpRegistrationResponseScope(response, { ...expectedAuthority(caller, authority), keySha256: request.keySha256 });
  return completed;
}
