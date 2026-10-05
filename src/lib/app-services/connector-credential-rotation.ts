import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeKeySha256, NativeConnectorError } from "@/lib/connectors/native-control-contracts";
import type { ConnectorNativeAuthority } from "@/lib/connectors/native-control-store";
import { buildConnectorNativeCredentialPreparationIntent, connectorNativeCredentialPrepareRequestSchema,
  connectorNativeCredentialPreparationAbandonRequestSchema, connectorNativeCredentialRotationRequestSchema } from "@/lib/connectors/native-credential-rotation-contracts";
import { abandonNativeConnectorCredentialPreparation, prepareNativeConnectorCredential, readNativeConnectorCredentialPreparation,
  readNativeConnectorCredentialRotation, submitNativeConnectorCredentialRotation } from "@/lib/connectors/native-credential-rotation-store";
import { assertNativeConnectorCredentialPreparationResponseScope, assertNativeConnectorCredentialRotationResponseScope,
  nativeConnectorCredentialReadInputSchema, nativeConnectorCredentialPreparationAbandonResponseSchema,
  nativeConnectorCredentialPreparationReadResponseSchema, nativeConnectorCredentialPreparationSubmitResponseSchema,
  nativeConnectorCredentialRotationReadResponseSchema, nativeConnectorCredentialRotationSubmitResponseSchema } from "@/lib/mobile/connector-credential-rotation-contracts";
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
export async function prepareNativeConnectorCredentialService(caller: AppServiceCaller, input: z.input<typeof connectorNativeCredentialPrepareRequestSchema>) {
  const request = connectorNativeCredentialPrepareRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.credentialPreparations.submit")), authority = authorityFor(caller, true);
  const intent = buildConnectorNativeCredentialPreparationIntent(authority.scope, caller.idempotencyKey!, request);
  const result = await prepareNativeConnectorCredential({ authority, request, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorCredentialPreparationSubmitResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorCredentialPreparationResponseScope(response, { ...expectedAuthority(caller, authority), intent });
  return completed;
}
export async function readNativeConnectorCredentialPreparationService(caller: AppServiceCaller, input: z.input<typeof nativeConnectorCredentialReadInputSchema>) {
  const request = nativeConnectorCredentialReadInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.credentialPreparations.read")), authority = authorityFor(caller, false);
  const prepared = await readNativeConnectorCredentialPreparation(authority, request.keySha256);
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, prepared }, { resourceCount: prepared ? 1 : 0 });
  const response = nativeConnectorCredentialPreparationReadResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorCredentialPreparationResponseScope(response, { ...expectedAuthority(caller, authority), keySha256: request.keySha256 });
  return completed;
}
export async function abandonNativeConnectorCredentialPreparationService(caller: AppServiceCaller,
  input: z.input<typeof connectorNativeCredentialPreparationAbandonRequestSchema>, keyInput: z.input<typeof nativeConnectorCredentialReadInputSchema>) {
  const request = connectorNativeCredentialPreparationAbandonRequestSchema.parse(input), { keySha256 } = nativeConnectorCredentialReadInputSchema.parse(keyInput);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.credentialPreparations.abandon")), authority = authorityFor(caller, true);
  if (connectorNativeKeySha256(authority.scope, caller.idempotencyKey!) !== keySha256 || request.intent.keySha256 !== keySha256 ||
    canonicalJsonSha256(request.intent.scope) !== canonicalJsonSha256(authority.scope)) {
    throw new NativeConnectorError("connector_conflict", 409, "The original credential preparation authority and key are required.");
  }
  const result = await abandonNativeConnectorCredentialPreparation({ authority, request, keySha256, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorCredentialPreparationAbandonResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorCredentialPreparationResponseScope(response, { ...expectedAuthority(caller, authority), keySha256, intent: request.intent });
  return completed;
}
export async function submitNativeConnectorCredentialRotationService(caller: AppServiceCaller, input: z.input<typeof connectorNativeCredentialRotationRequestSchema>) {
  const request = connectorNativeCredentialRotationRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.credentialRotations.submit")), authority = authorityFor(caller, true);
  const result = await submitNativeConnectorCredentialRotation({ authority, request, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorCredentialRotationSubmitResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorCredentialRotationResponseScope(response, { ...expectedAuthority(caller, authority), request });
  return completed;
}
export async function readNativeConnectorCredentialRotationService(caller: AppServiceCaller, input: z.input<typeof nativeConnectorCredentialReadInputSchema>) {
  const request = nativeConnectorCredentialReadInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.credentialRotations.read")), authority = authorityFor(caller, false);
  const action = await readNativeConnectorCredentialRotation(authority, request.keySha256);
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, action }, { resourceCount: action ? 1 : 0 });
  const response = nativeConnectorCredentialRotationReadResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorCredentialRotationResponseScope(response, { ...expectedAuthority(caller, authority), keySha256: request.keySha256 });
  return completed;
}
