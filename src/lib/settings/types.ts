export const MODEL_PROVIDERS = [
  "openai",
  "google",
  "anthropic",
  "aws_bedrock",
] as const;

export type SettingsModelProvider = (typeof MODEL_PROVIDERS)[number];

export const MODEL_ASSIGNMENT_SCOPES = [
  "main_agent",
  "orchestrator",
  "workflow",
  "council",
  "memory",
  "embeddings",
  "vision",
  "audio",
] as const;

export type ModelAssignmentScope = (typeof MODEL_ASSIGNMENT_SCOPES)[number];

export const SERVICE_API_SCOPES = [
  "mcp:discover",
  "mcp:tools:list",
  "mcp:tools:execute",
  "missions:read",
  "missions:write",
  "memory:read",
  "memory:write",
  "runs:read",
  "settings:read",
] as const;

export type ServiceApiScope = (typeof SERVICE_API_SCOPES)[number];

export type ProviderConnectionStatus =
  | "needs_validation"
  | "validating"
  | "connected"
  | "error"
  | "disabled"
  | "revoked";

export type ProviderRuntimeReadiness =
  | "active_environment_fallback"
  | "active_tenant_runtime"
  | "configuration_only";

export type RedactedProviderConnection = {
  id: string;
  tenantId: string;
  actorId: string;
  provider: SettingsModelProvider;
  label: string;
  source: "tenant_vault" | "deployment_environment";
  status: ProviderConnectionStatus;
  enabled: boolean;
  credentialVersion?: number;
  credentialFingerprint?: string;
  configuredFields: string[];
  lastValidatedAt?: string;
  validationCode?: string;
  catalogRefreshedAt?: string;
  runtimeReadiness: ProviderRuntimeReadiness;
  runtimeNote: string;
  createdAt?: string;
  updatedAt?: string;
  rotatedAt?: string;
};

export type ModelLifecycleState =
  | "available"
  | "deprecated"
  | "retiring"
  | "unknown";

export type ModelCatalogEntry = {
  id: string;
  tenantId: string;
  actorId: string;
  provider: SettingsModelProvider;
  modelId: string;
  displayName: string;
  capabilities: string[];
  lifecycle: ModelLifecycleState;
  lifecycleReason?: string;
  lifecycleCheckedAt?: string;
  discoveredAt: string;
  updatedAt: string;
};

export type RequestModelCatalogEntry = ModelCatalogEntry & {
  displayModelId: string;
  selectable: boolean;
};

export type ModelAssignment = {
  id: string;
  tenantId: string;
  actorId: string;
  scope: ModelAssignmentScope;
  provider: SettingsModelProvider;
  modelId: string;
  fallbackProvider?: SettingsModelProvider;
  fallbackModelId?: string;
  allowCrossProviderFallback: boolean;
  runtimeReadiness: "active" | "configuration_only";
  runtimeNote: string;
  createdAt: string;
  updatedAt: string;
};

export type RedactedServiceApiKey = {
  id: string;
  tenantId: string;
  actorId: string;
  name: string;
  tokenPrefix: string;
  tokenLastFour: string;
  scopes: ServiceApiScope[];
  status: "active" | "revoked" | "expired";
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
};

export type RequestServiceApiKey = RedactedServiceApiKey & {
  manageable: boolean;
};

export type ServiceApiKeyPrincipal = {
  keyId: string;
  tenantId: string;
  actorId: string;
  name: string;
  scopes: ServiceApiScope[];
};

export type McpExportConfiguration = {
  tenantId: string;
  actorId: string;
  enabled: boolean;
  serverName: string;
  allowedScopes: ServiceApiScope[];
  defaultApprovalMode: "governed";
  exposeResources: boolean;
  endpointPath: "/api/mcp";
  readiness: "ready" | "disabled";
  createdAt: string;
  updatedAt: string;
};

export type SettingsSnapshot = {
  platform: {
    authEnforced: boolean;
    bootstrapConfigured: boolean;
    databaseConfigured: boolean;
    storageBackend: "postgres" | "ephemeral" | "file";
    releaseRevision?: string;
  };
  vault: {
    configured: boolean;
    activeKeyId?: string;
    message: string;
  };
  providers: RedactedProviderConnection[];
  models: RequestModelCatalogEntry[];
  assignments: ModelAssignment[];
  apiKeys: RequestServiceApiKey[];
  mcp: McpExportConfiguration;
  runtime: {
    tenantAssignmentsConsumed: boolean;
    activeScopes: ModelAssignmentScope[];
    configurationOnlyScopes: ModelAssignmentScope[];
    message: string;
  };
};
