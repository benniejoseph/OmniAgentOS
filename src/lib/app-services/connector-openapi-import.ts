import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CONNECTOR_NATIVE_READ_CONTRACT, connectorNativeKeySha256, NativeConnectorError } from "@/lib/connectors/native-control-contracts";
import type { ConnectorNativeAuthority } from "@/lib/connectors/native-control-store";
import { buildConnectorNativeOpenapiImportPreparationIntent, connectorNativeOpenapiImportPrepareRequestSchema,
  connectorNativeOpenapiImportPreparationAbandonRequestSchema, connectorNativeOpenapiImportRequestSchema } from "@/lib/connectors/native-openapi-import-contracts";
import { abandonNativeOpenapiImportPreparation, prepareNativeOpenapiImport, readNativeOpenapiImportPreparation,
  readNativeOpenapiImport, submitNativeOpenapiImport } from "@/lib/connectors/native-openapi-import-store";
import { assertNativeConnectorOpenapiImportPreparationResponseScope, assertNativeConnectorOpenapiImportResponseScope,
  nativeConnectorOpenapiImportReadInputSchema, nativeConnectorOpenapiImportPreparationAbandonResponseSchema,
  nativeConnectorOpenapiImportPreparationReadResponseSchema, nativeConnectorOpenapiImportPreparationSubmitResponseSchema,
  nativeConnectorOpenapiImportReadResponseSchema, nativeConnectorOpenapiImportSubmitResponseSchema } from "@/lib/mobile/connector-openapi-import-contracts";
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
export async function prepareNativeOpenapiImportService(caller: AppServiceCaller, input: z.input<typeof connectorNativeOpenapiImportPrepareRequestSchema>) {
  const request = connectorNativeOpenapiImportPrepareRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.openapiImportPreparations.submit")), authority = authorityFor(caller, true);
  const intent = buildConnectorNativeOpenapiImportPreparationIntent(authority.scope, caller.idempotencyKey!, request);
  const result = await prepareNativeOpenapiImport({ authority, request, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorOpenapiImportPreparationSubmitResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorOpenapiImportPreparationResponseScope(response, { ...expectedAuthority(caller, authority), intent });
  return completed;
}
export async function readNativeOpenapiImportPreparationService(caller: AppServiceCaller, input: z.input<typeof nativeConnectorOpenapiImportReadInputSchema>) {
  const request = nativeConnectorOpenapiImportReadInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.openapiImportPreparations.read")), authority = authorityFor(caller, false);
  const prepared = await readNativeOpenapiImportPreparation(authority, request.keySha256);
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, prepared }, { resourceCount: prepared ? 1 : 0 });
  const response = nativeConnectorOpenapiImportPreparationReadResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorOpenapiImportPreparationResponseScope(response, { ...expectedAuthority(caller, authority), keySha256: request.keySha256 });
  return completed;
}
export async function abandonNativeOpenapiImportPreparationService(caller: AppServiceCaller,
  input: z.input<typeof connectorNativeOpenapiImportPreparationAbandonRequestSchema>, keyInput: z.input<typeof nativeConnectorOpenapiImportReadInputSchema>) {
  const request = connectorNativeOpenapiImportPreparationAbandonRequestSchema.parse(input), { keySha256 } = nativeConnectorOpenapiImportReadInputSchema.parse(keyInput);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.openapiImportPreparations.abandon")), authority = authorityFor(caller, true);
  if (connectorNativeKeySha256(authority.scope, caller.idempotencyKey!) !== keySha256 || request.intent.keySha256 !== keySha256 ||
    canonicalJsonSha256(request.intent.scope) !== canonicalJsonSha256(authority.scope)) {
    throw new NativeConnectorError("connector_conflict", 409, "The original OpenAPI import preparation authority and key are required.");
  }
  const result = await abandonNativeOpenapiImportPreparation({ authority, request, keySha256, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorOpenapiImportPreparationAbandonResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorOpenapiImportPreparationResponseScope(response, { ...expectedAuthority(caller, authority), keySha256, intent: request.intent });
  return completed;
}
export async function submitNativeOpenapiImportService(caller: AppServiceCaller, input: z.input<typeof connectorNativeOpenapiImportRequestSchema>) {
  const request = connectorNativeOpenapiImportRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.openapiImports.submit")), authority = authorityFor(caller, true);
  const result = await submitNativeOpenapiImport({ authority, request, idempotencyKey: caller.idempotencyKey! });
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, ...result }, { resourceCount: 1 });
  const response = nativeConnectorOpenapiImportSubmitResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorOpenapiImportResponseScope(response, { ...expectedAuthority(caller, authority), request });
  return completed;
}
export async function readNativeOpenapiImportService(caller: AppServiceCaller, input: z.input<typeof nativeConnectorOpenapiImportReadInputSchema>) {
  const request = nativeConnectorOpenapiImportReadInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.native.openapiImports.read")), authority = authorityFor(caller, false);
  const action = await readNativeOpenapiImport(authority, request.keySha256);
  const completed = completeAppServiceCall(authorized, { contract: CONNECTOR_NATIVE_READ_CONTRACT, scope: authority.scope, action }, { resourceCount: action ? 1 : 0 });
  const response = nativeConnectorOpenapiImportReadResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeConnectorOpenapiImportResponseScope(response, { ...expectedAuthority(caller, authority), keySha256: request.keySha256 });
  return completed;
}
