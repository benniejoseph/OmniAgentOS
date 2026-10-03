import {
  MODEL_ASSIGNMENT_SCOPES, MODEL_PROVIDERS, SERVICE_API_SCOPES,
  type McpExportConfiguration, type SettingsSnapshot,
} from "@/lib/settings/types";

export const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const member = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === "string" && values.includes(value as T);
export const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
export const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const date = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const optionalText = (value: unknown) => value === undefined || typeof value === "string";
const optionalDate = (value: unknown) => value === undefined || date(value);
const scopes = (value: unknown) => Array.isArray(value) && value.every((item) => member(item, SERVICE_API_SCOPES)) && new Set(value).size === value.length;
const owner = (value: Record<string, unknown>) => text(value.tenantId) && text(value.actorId);
const unique = (values: Record<string, unknown>[]) => new Set(values.map((value) => value.id)).size === values.length;
const rows = (value: unknown, validate: (item: unknown) => boolean): value is Record<string, unknown>[] => Array.isArray(value) && value.length <= 10_000 && value.every((item) => object(item) && validate(item)) && unique(value);

export function providerRecord(value: unknown): value is Record<string, unknown> {
  return object(value) && text(value.id) && owner(value) && member(value.provider, MODEL_PROVIDERS) && text(value.label) &&
    member(value.source, ["tenant_vault", "deployment_environment"]) && member(value.status, ["needs_validation", "validating", "connected", "error", "disabled", "revoked"]) &&
    typeof value.enabled === "boolean" && strings(value.configuredFields) && member(value.runtimeReadiness, ["active_environment_fallback", "active_tenant_runtime", "configuration_only"]) &&
    typeof value.runtimeNote === "string" && (value.credentialVersion === undefined || integer(value.credentialVersion)) &&
    [value.credentialFingerprint, value.validationCode].every(optionalText) && [value.createdAt, value.updatedAt, value.rotatedAt, value.lastValidatedAt, value.catalogRefreshedAt].every(optionalDate);
}
export function assignmentRecord(value: unknown): value is Record<string, unknown> {
  return object(value) && text(value.id) && owner(value) && member(value.scope, MODEL_ASSIGNMENT_SCOPES) && member(value.provider, MODEL_PROVIDERS) && text(value.modelId) &&
    (value.fallbackProvider === undefined || member(value.fallbackProvider, MODEL_PROVIDERS)) && optionalText(value.fallbackModelId) &&
    Boolean(value.fallbackProvider) === Boolean(value.fallbackModelId) && typeof value.allowCrossProviderFallback === "boolean" &&
    member(value.runtimeReadiness, ["active", "configuration_only"]) && typeof value.runtimeNote === "string" && member(value.contractVersion, ["legacy", "p11.8-model-assignment:1"]) &&
    integer(value.revision) && (value.configurationSha256 === undefined || digest(value.configurationSha256)) && date(value.createdAt) && date(value.updatedAt) && optionalDate(value.validatedAt);
}
export function apiKeyRecord(value: unknown): value is Record<string, unknown> {
  return object(value) && text(value.id) && owner(value) && text(value.name) && text(value.tokenPrefix) && text(value.tokenLastFour) && scopes(value.scopes) &&
    member(value.status, ["active", "revoked", "expired"]) && date(value.createdAt) && date(value.updatedAt) && [value.expiresAt, value.lastUsedAt, value.revokedAt].every(optionalDate);
}
export function mcpRecord(value: unknown): value is Record<string, unknown> {
  return object(value) && owner(value) && typeof value.enabled === "boolean" && text(value.serverName) && scopes(value.allowedScopes) &&
    value.defaultApprovalMode === "governed" && typeof value.exposeResources === "boolean" && value.endpointPath === "/api/mcp" &&
    value.readiness === (value.enabled ? "ready" : "disabled") && date(value.createdAt) && date(value.updatedAt);
}
export function settingsSnapshot(value: unknown, scope?: { tenantId?: string; actorId?: string }): SettingsSnapshot {
  const invalid = () => { throw new Error("Settings returned incomplete or inconsistent metadata. Last-loaded settings remain unchanged."); };
  if (!object(value) || !object(value.platform) || !object(value.vault) || !object(value.runtime)) return invalid();
  const { platform, vault, runtime } = value;
  if (![platform.authEnforced, platform.bootstrapConfigured, platform.databaseConfigured].every((item) => typeof item === "boolean") ||
    !member(platform.storageBackend, ["postgres", "ephemeral", "file"]) || !optionalText(platform.releaseRevision) || typeof vault.configured !== "boolean" ||
    !optionalText(vault.activeKeyId) || typeof vault.message !== "string") return invalid();
  if (!rows(value.providers, (item) => providerRecord(item) && typeof item.manageable === "boolean") ||
    !rows(value.assignments, (item) => assignmentRecord(item) && typeof item.manageable === "boolean" && text(item.displayModelId) && optionalText(item.displayFallbackModelId)) ||
    !rows(value.apiKeys, (item) => apiKeyRecord(item) && typeof item.manageable === "boolean") ||
    !mcpRecord(value.mcp) || typeof value.mcp.manageable !== "boolean" ||
    !rows(value.models, (item) => object(item) && text(item.id) && owner(item) && member(item.provider, MODEL_PROVIDERS) && text(item.modelId) && text(item.displayModelId) &&
      text(item.displayName) && strings(item.capabilities) && member(item.lifecycle, ["available", "deprecated", "retiring", "unknown"]) && typeof item.selectable === "boolean" &&
      optionalText(item.lifecycleReason) && optionalDate(item.lifecycleCheckedAt) && date(item.discoveredAt) && date(item.updatedAt))) return invalid();
  if (runtime.contractVersion !== "p11.8-functional-model-routing:1" || typeof runtime.tenantAssignmentsConsumed !== "boolean" || typeof runtime.message !== "string" ||
    ![runtime.activeScopes, runtime.configurationOnlyScopes].every((list) => Array.isArray(list) && list.every((scope) => member(scope, MODEL_ASSIGNMENT_SCOPES))) ||
    !Array.isArray(runtime.receipts) || !runtime.receipts.every((item) => object(item) && member(item.scope, MODEL_ASSIGNMENT_SCOPES) && text(item.assignmentId) &&
      integer(item.assignmentRevision) && digest(item.assignmentConfigurationSha256) && member(item.state, ["succeeded", "failed"]) && text(item.provider) && text(item.model) &&
      typeof item.fallbackUsed === "boolean" && item.credentialSource === "tenant_vault" && date(item.recordedAt))) return invalid();
  if (value.requestReadContracts !== undefined && (!object(value.requestReadContracts) ||
    !["providerConnections", "modelAssignments", "mcpExportConfiguration"].every((key) => member((value.requestReadContracts as Record<string, unknown>)[key], ["exact_v1", "readable_v1"])))) return invalid();
  const records = [...value.providers, ...value.assignments, ...value.models, ...value.apiKeys, value.mcp];
  if (scope?.tenantId && records.some((record) => record.tenantId !== scope.tenantId)) return invalid();
  if (scope?.actorId && records.some((record) => record.manageable === true && record.actorId !== scope.actorId)) return invalid();
  return value as unknown as SettingsSnapshot;
}

export function settingsError(value: unknown, fallback: string) {
  return object(value) && text(value.message) ? value.message : object(value) && text(value.error) ? value.error : object(value) && object(value.error) && text(value.error.message) ? value.error.message : fallback;
}
export function sameSet(left: unknown, right: unknown) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value) => right.includes(value));
}
export function settingsVersion(value: unknown) { return JSON.stringify(value ?? null); }
export type BoundSettingsDraft<T> = { observed: string; basis: string; original: T; draft: T };
export function reconcileSettingsDraft<T>(state: BoundSettingsDraft<T>, source: string, seed: T): BoundSettingsDraft<T> {
  if (state.observed === source) return state;
  return settingsVersion(state.original) === settingsVersion(state.draft)
    ? { observed: source, basis: source, original: seed, draft: seed }
    : { ...state, observed: source };
}

export type SettingsMutation = {
  label: string; path: string; method: "POST" | "PUT" | "PATCH" | "DELETE"; body?: Record<string, unknown>;
  kind: "provider.create" | "provider.rotate" | "provider.validate" | "provider.update" | "provider.revoke" | "assignment" | "key.create" | "key.revoke" | "mcp";
  id?: string; provider?: string; credentialVersion?: number;
};
export function settingsMutationReplayable(kind: SettingsMutation["kind"]) {
  return ["provider.validate", "provider.update", "provider.revoke", "key.revoke", "mcp"].includes(kind);
}
export function validateSettingsMutation(value: unknown, request: SettingsMutation, scope: { tenantId?: string; actorId?: string }): Record<string, unknown> {
  const fail = () => { throw new Error("The action response did not match the reviewed identity and settings. Its outcome is unconfirmed; refresh before continuing."); };
  if (!object(value)) return fail();
  const owned = (record: Record<string, unknown>) => record.tenantId === scope.tenantId && record.actorId === scope.actorId;
  const body = request.body ?? {};
  if (request.kind.startsWith("provider.")) {
    const record = value.connection;
    if (!providerRecord(record) || !owned(record) || record.source !== "tenant_vault" || (request.id && record.id !== request.id) || record.provider !== request.provider) return fail();
    if (request.kind === "provider.create" && record.label !== body.label) return fail();
    if ((request.kind === "provider.rotate" || request.kind === "provider.create") && (!integer(record.credentialVersion) || record.credentialVersion < 1)) return fail();
    if ((request.kind === "provider.rotate" || request.kind === "provider.create" && request.id) && request.credentialVersion !== undefined && Number(record.credentialVersion) <= request.credentialVersion) return fail();
    if (request.kind === "provider.update" && record.enabled !== body.enabled) return fail();
    if (request.kind === "provider.revoke" && (record.status !== "revoked" || record.enabled !== false || !digest(value.targetSha256))) return fail();
  } else if (request.kind === "assignment") {
    const record = value.assignment;
    if (!assignmentRecord(record) || !owned(record) || !["scope", "provider", "modelId", "fallbackProvider", "fallbackModelId"].every((key) => record[key] === body[key]) ||
      record.allowCrossProviderFallback !== Boolean(body.crossProviderFallbackConsent) || record.contractVersion !== "p11.8-model-assignment:1" || !digest(record.configurationSha256)) return fail();
  } else if (request.kind === "mcp") {
    const record = value.mcp;
    if (!mcpRecord(record) || !owned(record) || !["enabled", "serverName", "exposeResources"].every((key) => record[key] === body[key]) || !sameSet(record.allowedScopes, body.allowedScopes)) return fail();
  } else if (request.kind === "key.create") {
    const record = value.record;
    if (!apiKeyRecord(record) || !owned(record) || record.name !== body.name || record.status !== "active" || !sameSet(record.scopes, body.scopes) ||
      (record.expiresAt ? Date.parse(String(record.expiresAt)) : undefined) !== (body.expiresAt ? Date.parse(String(body.expiresAt)) : undefined) ||
      !text(value.token) || !value.token.startsWith("asael_sk_") || !value.token.includes(`.${record.id}.`) || !value.token.endsWith(String(record.tokenLastFour))) return fail();
  } else if (!apiKeyRecord(value.apiKey) || !owned(value.apiKey) || value.apiKey.id !== request.id || value.apiKey.status !== "revoked" || !digest(value.targetSha256)) return fail();
  return value;
}
/** Deliberately whitelist display metadata; never retain the response's token or credential-shaped extras. */
export function confirmedSettingsMetadata(value: Record<string, unknown>) {
  const record = [value.connection, value.assignment, value.apiKey, value.record, value.mcp].find(object);
  if (!record) return [];
  const keys = ["id", "tenantId", "actorId", "provider", "label", "name", "status", "enabled", "credentialVersion", "credentialFingerprint", "validationCode", "runtimeReadiness", "runtimeNote", "scope", "revision", "configurationSha256", "modelId", "fallbackProvider", "fallbackModelId", "allowCrossProviderFallback", "tokenPrefix", "tokenLastFour", "scopes", "expiresAt", "serverName", "allowedScopes", "defaultApprovalMode", "exposeResources", "readiness", "updatedAt"];
  return keys.filter((key) => record[key] !== undefined).map((key) => ({ label: key, value: Array.isArray(record[key]) ? record[key].join(" · ") : String(record[key]) }));
}

export type McpConfigurationGate = { loading: boolean; snapshotFresh: boolean; requestReadContract?: "exact_v1" | "readable_v1"; manageable?: boolean; permissionBlocked?: string };
export type SettingsLoadResult = "success" | "failure" | "superseded";
export const settingsLoadNeedsVerificationWarning = (result: SettingsLoadResult) => result === "failure";
export const settingsRequestResultIsCurrent = (requestGeneration: number, currentGeneration: number) => requestGeneration === currentGeneration;
export const settingsLoadMayClearLoading = (input: { controllerCurrent: boolean; requestGeneration?: number; currentRequestGeneration: number }) => input.controllerCurrent && (input.requestGeneration === undefined || input.requestGeneration === input.currentRequestGeneration);
export function mcpConfigurationActionBlocked(gate: McpConfigurationGate) {
  if (gate.loading || !gate.snapshotFresh) return "MCP policy is not current. Wait for settings to finish refreshing.";
  if (gate.requestReadContract !== "readable_v1") return "MCP policy ownership metadata could not be verified. Refresh after the current release is active.";
  if (gate.manageable !== true) return "This retained MCP policy is read only.";
  return gate.permissionBlocked;
}
export const mcpConfigurationIsEditable = (gate: McpConfigurationGate) => mcpConfigurationActionBlocked(gate) === undefined;
export function mcpContinuityMetadata(config: Pick<McpExportConfiguration, "enabled" | "readiness" | "serverName" | "allowedScopes" | "exposeResources">) {
  return [
    { label: "Status", value: config.enabled ? "Enabled" : "Disabled" }, { label: "Readiness", value: config.readiness === "ready" ? "Ready" : "Disabled" },
    { label: "Server name", value: config.serverName }, { label: "Maximum scopes", value: config.allowedScopes.join(" · ") || "No client scopes recorded" },
    { label: "Resources", value: config.exposeResources ? "Exposed" : "Not exposed" },
  ];
}

/** Instance-local gate. Uncertain fingerprints are never evicted to admit a new effect. */
export function createAdvancedSettingsGate() {
  let epoch = 0;
  let mounted = true;
  let available = true;
  let active: object | undefined;
  const reads = new Map<string, AbortController>();
  const retries = new Map<string, { key: string; replayable: boolean }>();
  return {
    live: () => mounted && available,
    pending: () => Boolean(active),
    mount() { mounted = true; },
    availability(next: boolean) { if (available && !next) { epoch++; for (const read of reads.values()) read.abort(); reads.clear(); } available = next; },
    dispose() { mounted = false; epoch++; for (const read of reads.values()) read.abort(); reads.clear(); active = undefined; retries.clear(); },
    read(name: string) {
      reads.get(name)?.abort();
      const controller = new AbortController(); const version = epoch;
      reads.set(name, controller);
      return { signal: controller.signal, owned: () => mounted && reads.get(name) === controller, current: () => mounted && available && !active && !controller.signal.aborted && epoch === version && reads.get(name) === controller };
    },
    begin() {
      if (!mounted || !available) throw new Error("Current session permissions must be verified before continuing.");
      if (active) throw new Error("Another settings action is still pending. Wait for its result.");
      epoch++; for (const read of reads.values()) read.abort();
      const ticket = {}; const version = epoch; active = ticket;
      return { current: () => mounted && available && active === ticket && version === epoch, release: () => { if (active === ticket) active = undefined; } };
    },
    retry(fingerprint: string, replayable: boolean, makeKey: () => string) {
      const previous = retries.get(fingerprint);
      if (previous) {
        if (!previous.replayable) throw new Error("The previous outcome is unconfirmed and this endpoint has no replay contract. Recheck the current records before making another change; do not assume the previous request failed.");
        return previous.key;
      }
      if (retries.size >= 30) throw new Error("Too many settings actions have unconfirmed outcomes. Resolve the existing actions before starting a different change.");
      const key = makeKey(); retries.set(fingerprint, { key, replayable }); return key;
    },
    confirmed(fingerprint: string) { retries.delete(fingerprint); },
  };
}
