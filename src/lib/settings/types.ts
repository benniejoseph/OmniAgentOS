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
  "planner",
  "verifier",
  "council",
  "market_research",
  "code_builder",
  "memory",
  "embeddings",
  "vision",
  "audio",
  "audio_diarization",
  "web_search",
  "image_generation",
  "video_generation",
  "computer_use",
  "speech_synthesis",
  "realtime_transcription",
] as const;

export type ModelAssignmentScope = (typeof MODEL_ASSIGNMENT_SCOPES)[number];

export const SPECIALIZED_MODEL_ASSIGNMENT_SCOPES = [
  "embeddings",
  "vision",
  "audio",
  "audio_diarization",
  "web_search",
  "image_generation",
  "video_generation",
  "computer_use",
  "speech_synthesis",
  "realtime_transcription",
] as const satisfies readonly ModelAssignmentScope[];

export const SERVICE_API_SCOPES = [
  "mcp:discover",
  "mcp:tools:list",
  "mcp:tools:execute",
  "a2a:discover",
  "a2a:tasks:read",
  "a2a:tasks:write",
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

export type RequestProviderConnection = RedactedProviderConnection & {
  manageable: boolean;
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
  contractVersion: "p11.8-model-assignment:1" | "legacy";
  revision: number;
  configurationSha256?: string;
  validatedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type RequestModelAssignment = ModelAssignment & {
  displayModelId: string;
  displayFallbackModelId?: string;
  manageable: boolean;
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

export type RequestMcpExportConfiguration = McpExportConfiguration & {
  manageable: boolean;
};

export type SettingsSnapshot = {
  requestReadContracts?: {
    providerConnections: "exact_v1" | "readable_v1";
    modelAssignments: "exact_v1" | "readable_v1";
    mcpExportConfiguration: "exact_v1" | "readable_v1";
  };
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
  providers: RequestProviderConnection[];
  models: RequestModelCatalogEntry[];
  assignments: RequestModelAssignment[];
  apiKeys: RequestServiceApiKey[];
  mcp: RequestMcpExportConfiguration;
  runtime: {
    contractVersion: "p11.8-functional-model-routing:1";
    tenantAssignmentsConsumed: boolean;
    activeScopes: ModelAssignmentScope[];
    configurationOnlyScopes: ModelAssignmentScope[];
    receipts: ModelAssignmentRuntimeReceipt[];
    message: string;
  };
};

export type ModelAssignmentRuntimeReceipt = {
  scope: ModelAssignmentScope;
  assignmentId: string;
  assignmentRevision: number;
  assignmentConfigurationSha256: string;
  state: "succeeded" | "failed";
  provider: string;
  model: string;
  fallbackUsed: boolean;
  credentialSource: "tenant_vault";
  recordedAt: string;
};
