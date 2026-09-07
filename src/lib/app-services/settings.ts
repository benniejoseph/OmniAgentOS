import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { validateAndRefreshProvider } from "@/lib/settings/provider-catalog";
import { listServiceApiKeysForRequest, revokeServiceApiKey } from "@/lib/settings/service-api-keys";
import { getSettingsSnapshot } from "@/lib/settings/snapshot";
import {
  getProviderConnection,
  listModelCatalogForRequest,
  revokeProviderConnection,
  saveMcpExportConfiguration,
  saveModelAssignment,
  updateProviderConnection,
} from "@/lib/settings/store";
import { MODEL_ASSIGNMENT_SCOPES, MODEL_PROVIDERS, SERVICE_API_SCOPES } from "@/lib/settings/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const emptySchema = z.object({}).strict();
const idSchema = z.object({ id: z.string().trim().min(1).max(200) }).strict();
const deleteSchema = idSchema.extend({ expectedTargetSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const assignmentSchema = z.object({
  scope: z.enum(MODEL_ASSIGNMENT_SCOPES), provider: z.enum(MODEL_PROVIDERS), modelId: z.string().trim().min(1).max(240),
  fallbackProvider: z.enum(MODEL_PROVIDERS).optional(), fallbackModelId: z.string().trim().min(1).max(240).optional(),
  crossProviderFallbackConsent: z.literal(true).optional(),
}).strict();
const mcpSchema = z.object({
  enabled: z.boolean(), serverName: z.string().trim().min(1).max(120),
  allowedScopes: z.array(z.enum(SERVICE_API_SCOPES)).max(SERVICE_API_SCOPES.length), exposeResources: z.boolean().default(false),
}).strict();
const providerUpdateSchema = z.object({
  id: z.string().trim().min(1).max(200), label: z.string().trim().min(1).max(120).optional(), enabled: z.boolean().optional(),
}).strict().refine(({ id: _id, ...change }) => Object.keys(change).length > 0, { message: "A provider change is required." });

export async function showSettingsService(caller: AppServiceCaller, input: z.input<typeof emptySchema>) {
  emptySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.settings.show"));
  const requestActorBinding = canonicalRequestActorBindingFromSecurityContext(
    caller.context,
  );
  const snapshot = await runWithDatabaseActorScope(
    caller.context.tenantId,
    requestActorBinding?.readableOwnerActorIds || [caller.context.actorId],
    () => getSettingsSnapshot({
      ...exactOwner(caller),
      requestActorBinding,
      providerOwnerScope: "readable",
      modelAssignmentOwnerScope: "readable",
      mcpOwnerScope: "readable",
    }),
  );
  return completeAppServiceCall(authorized, snapshot);
}

export async function listModelsService(caller: AppServiceCaller, input: z.input<typeof emptySchema>) {
  emptySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.settings.models.list"));
  const models = await listModelCatalogForRequest(readOwner(caller));
  return completeAppServiceCall(authorized, { models }, { resourceCount: models.length });
}

export async function updateModelAssignmentService(caller: AppServiceCaller, input: z.input<typeof assignmentSchema>) {
  const value = assignmentSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.settings.assignments.update"));
  const assignment = await saveModelAssignment({ ...exactOwner(caller), ...value });
  return completeAppServiceCall(authorized, { assignment });
}

export async function updateMcpExportService(caller: AppServiceCaller, input: z.input<typeof mcpSchema>) {
  const value = mcpSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.settings.mcp.update"));
  const mcp = await saveMcpExportConfiguration({ ...exactOwner(caller), ...value });
  return completeAppServiceCall(authorized, { mcp });
}

export async function updateProviderService(caller: AppServiceCaller, input: z.input<typeof providerUpdateSchema>) {
  const value = providerUpdateSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.settings.providers.update"));
  const { id, ...change } = value;
  const connection = await updateProviderConnection({ ...exactOwner(caller), connectionId: id, ...change });
  return completeAppServiceCall(authorized, { connection });
}

export async function validateProviderService(caller: AppServiceCaller, input: z.input<typeof idSchema>) {
  const value = idSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.settings.providers.validate"));
  const result = await validateAndRefreshProvider({ ...exactOwner(caller), connectionId: value.id });
  return completeAppServiceCall(authorized, result);
}

export async function previewProviderRevokeService(caller: AppServiceCaller, input: z.input<typeof idSchema>) {
  const value = idSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.settings.providers.revoke.preview"));
  const connection = await getProviderConnection({ ...exactOwner(caller), connectionId: value.id });
  const target = connection?.source === "tenant_vault" ? {
    id: connection.id, provider: connection.provider, label: connection.label, status: connection.status,
    configuredFields: [...connection.configuredFields].sort(), credentialVersion: connection.credentialVersion,
  } : null;
  return completeAppServiceCall(authorized, { target, targetSha256: canonicalJsonSha256(target), irreversible: true as const }, { resourceCount: target ? 1 : 0 });
}

export async function revokeProviderService(caller: AppServiceCaller, input: z.input<typeof deleteSchema>) {
  const value = deleteSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.settings.providers.revoke"));
  const preview = await previewProviderRevokeService(caller, { id: value.id });
  if (!preview.data.target || preview.data.targetSha256 !== value.expectedTargetSha256) throw new Error("Provider revocation target changed after preview; review the exact target again.");
  const connection = await revokeProviderConnection({ ...exactOwner(caller), connectionId: value.id });
  return completeAppServiceCall(authorized, { connection, targetSha256: preview.data.targetSha256 });
}

export async function listApiKeysService(caller: AppServiceCaller, input: z.input<typeof emptySchema>) {
  emptySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.settings.api_keys.list"));
  const apiKeys = await listServiceApiKeysForRequest(readOwner(caller));
  return completeAppServiceCall(authorized, { apiKeys }, { resourceCount: apiKeys.length });
}

export async function previewApiKeyRevokeService(caller: AppServiceCaller, input: z.input<typeof idSchema>) {
  const value = idSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.settings.api_keys.revoke.preview"));
  const key = (await listServiceApiKeysForRequest(readOwner(caller))).find((candidate) => candidate.id === value.id && candidate.manageable);
  const target = key ? {
    id: key.id, name: key.name, tokenPrefix: key.tokenPrefix, tokenLastFour: key.tokenLastFour,
    scopes: [...key.scopes].sort(), status: key.status, expiresAt: key.expiresAt,
  } : null;
  return completeAppServiceCall(authorized, { target, targetSha256: canonicalJsonSha256(target), irreversible: true as const }, { resourceCount: target ? 1 : 0 });
}

export async function revokeApiKeyService(caller: AppServiceCaller, input: z.input<typeof deleteSchema>) {
  const value = deleteSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.settings.api_keys.revoke"));
  const preview = await previewApiKeyRevokeService(caller, { id: value.id });
  if (!preview.data.target || preview.data.targetSha256 !== value.expectedTargetSha256) throw new Error("API-key revocation target changed after preview; review the exact target again.");
  const apiKey = await revokeServiceApiKey({ ...exactOwner(caller), keyId: value.id });
  return completeAppServiceCall(authorized, { apiKey, targetSha256: preview.data.targetSha256 });
}

function exactOwner(caller: AppServiceCaller) { return { tenantId: caller.context.tenantId, actorId: caller.context.actorId }; }
function readOwner(caller: AppServiceCaller) { return { ...exactOwner(caller), requestActorBinding: canonicalRequestActorBindingFromSecurityContext(caller.context) }; }
