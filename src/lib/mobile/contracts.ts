import { z } from "zod";

export const NATIVE_API_CONTRACT_ID = "asael.native-api" as const;
export const NATIVE_API_CURRENT_VERSION = 6 as const;
export const NATIVE_API_PREVIOUS_VERSION = 5 as const;
export const NATIVE_API_SUPPORTED_VERSIONS = [
  NATIVE_API_CURRENT_VERSION,
  NATIVE_API_PREVIOUS_VERSION,
] as const;

const positiveDatabaseInteger = z.number().int().min(1).max(2_147_483_647);
const isoDateTime = z.string().datetime({ offset: true });
const opaqueId = z.string().trim().min(1).max(200);
const jsonObject = z.record(z.string(), z.unknown());

export const nativeClientAttestationSchema = z.object({
  platform: z.enum(["android", "ios"]),
  appVersion: z.string().regex(
    /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/,
  ),
  buildNumber: positiveDatabaseInteger,
  clientContractVersion: positiveDatabaseInteger,
}).strict();

export const nativeDeviceSchema = z.object({
  id: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  name: z.string().trim().min(1).max(120),
  platform: z.enum(["android", "ios"]),
  appVersion: z.string().min(1).max(40).optional(),
  buildNumber: positiveDatabaseInteger.optional(),
  clientContractVersion: positiveDatabaseInteger.optional(),
}).strict().superRefine((device, context) => {
  const hasBuild = device.buildNumber !== undefined;
  const hasContract = device.clientContractVersion !== undefined;
  if (!hasBuild && !hasContract) return;
  const attestation = nativeClientAttestationSchema.safeParse({
    platform: device.platform,
    appVersion: device.appVersion,
    buildNumber: device.buildNumber,
    clientContractVersion: device.clientContractVersion,
  });
  if (!hasBuild || !hasContract || !attestation.success) {
    context.addIssue({
      code: "custom",
      message: "Native client attestation must include a stable version, build, and contract.",
    });
  }
});

export const nativeLoginRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1_024),
  device: nativeDeviceSchema,
}).strict();

export const nativeRefreshRequestSchema = z.object({
  refreshToken: z.string().min(32).max(256),
  deviceId: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  client: nativeClientAttestationSchema.optional(),
}).strict();

export const nativeTokenPairSchema = z.object({
  tokenType: z.literal("Bearer"),
  accessToken: z.string().min(32).max(256),
  refreshToken: z.string().min(32).max(256),
  accessExpiresAt: isoDateTime,
  refreshExpiresAt: isoDateTime,
}).strict();

export const nativeCompatibilitySchema = z.object({
  schemaVersion: z.literal(1),
  platform: z.enum(["android", "ios"]),
  appVersion: z.string().nullable(),
  buildNumber: positiveDatabaseInteger.nullable(),
  clientContractVersion: z.number().int().min(0),
  minimumVersion: z.string().nullable(),
  requiredContractVersion: positiveDatabaseInteger,
  supportedContractVersions: z.tuple([
    z.literal(NATIVE_API_CURRENT_VERSION),
    z.literal(NATIVE_API_PREVIOUS_VERSION),
  ]),
  status: z.enum(["compatible", "upgrade_required", "unknown"]),
  agentCatalogEnrollment: z.object({
    state: z.literal("held"),
    clientReady: z.boolean(),
  }).strict(),
}).strict();

const securityContextSchema = z.object({
  tenantId: opaqueId,
  actorId: z.string().min(1).max(320),
  role: z.enum(["viewer", "operator", "admin", "system"]),
  source: z.literal("mobile"),
  auth: z.object({
    userId: opaqueId,
    email: z.string().email().max(320),
    sessionId: opaqueId,
    tenantName: z.string().min(1).max(200),
  }).strict(),
}).strict();

const authUserSchema = z.object({
  id: opaqueId,
  email: z.string().email().max(320),
  name: z.string().optional(),
  status: z.enum(["active", "disabled"]),
  lastLoginAt: isoDateTime.optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
}).strict();

const authTenantSchema = z.object({
  id: opaqueId,
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(200),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
}).strict();

const authMembershipSchema = z.object({
  id: opaqueId,
  tenantId: opaqueId,
  userId: opaqueId,
  role: z.enum(["viewer", "operator", "admin", "system"]),
  status: z.enum(["active", "disabled"]),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
}).strict();

const publicDeviceSchema = nativeDeviceSchema;

const nativePublicIdentitySchema = z.object({
  context: securityContextSchema,
  user: authUserSchema,
  tenant: authTenantSchema,
  membership: authMembershipSchema,
  device: publicDeviceSchema,
}).strict();

export const nativeLoginResponseSchema = nativePublicIdentitySchema.extend({
  authenticated: z.literal(true),
  tokens: nativeTokenPairSchema,
  client: nativeCompatibilitySchema,
});

export const nativeRefreshResponseSchema = z.object({
  tokens: nativeTokenPairSchema,
  client: nativeCompatibilitySchema,
}).strict();

export const nativeLogoutResponseSchema = z.object({
  authenticated: z.literal(false),
}).strict();

export const nativeBootstrapResponseSchema = nativePublicIdentitySchema.extend({
  authenticated: z.literal(true),
  permissions: z.array(z.string().min(1)).max(500),
  api: z.object({
    version: z.literal(1),
    basePath: z.literal("/api"),
    mobileBasePath: z.literal("/api/mobile"),
    nativeContract: z.object({
      id: z.literal(NATIVE_API_CONTRACT_ID),
      currentVersion: z.literal(NATIVE_API_CURRENT_VERSION),
      previousVersion: z.literal(NATIVE_API_PREVIOUS_VERSION),
      supportedVersions: z.tuple([
        z.literal(NATIVE_API_CURRENT_VERSION),
        z.literal(NATIVE_API_PREVIOUS_VERSION),
      ]),
      discoveryPath: z.literal("/api/mobile/contracts"),
    }).strict(),
  }).strict(),
  client: nativeCompatibilitySchema,
  nativeClientPolicy: jsonObject,
});

export const nativeErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(1_000),
  }).strict(),
}).strict();

export const nativeDeviceSessionSchema = z.object({
  id: opaqueId,
  current: z.boolean(),
  state: z.enum(["active", "expired", "revoked", "wipe_pending", "wiped"]),
  device: nativeDeviceSchema,
  createdAt: isoDateTime,
  lastSeenAt: isoDateTime,
  refreshExpiresAt: isoDateTime,
  revokedAt: isoDateTime.nullable(),
  revocationReason: z.enum([
    "logout", "refresh_reuse", "password_changed", "membership_changed",
    "user_revoked", "remote_wipe", "replaced", "legacy_revoked",
  ]).nullable(),
  wipe: z.object({
    requestedAt: isoDateTime,
    acknowledgedAt: isoDateTime.nullable(),
    localErasure: z.enum(["pending_device_acknowledgement", "acknowledged"]),
  }).strict().nullable(),
}).strict();

export const nativeDeviceListResponseSchema = z.object({
  schemaVersion: z.literal(1),
  devices: z.array(nativeDeviceSessionSchema).max(50),
}).strict();

export const nativeDeviceLifecycleRequestSchema = z.object({
  action: z.enum(["revoke", "remote_wipe"]),
}).strict();

export const nativeWipeChallengeResponseSchema = z.object({
  schemaVersion: z.literal(1),
  wipeRequired: z.literal(true),
  deviceId: z.string().min(8).max(200),
  requestedAt: isoDateTime,
  acknowledgementToken: z.string().min(32).max(256),
}).strict();

export const nativeWipeAcknowledgementRequestSchema = z.object({
  acknowledgementToken: z.string().min(32).max(256),
  deviceId: z.string().min(8).max(200),
}).strict();

export const nativeWipeAcknowledgementResponseSchema = z.object({
  acknowledged: z.literal(true),
}).strict();

export const nativePushRegistrationRequestSchema = z.object({
  provider: z.enum(["apns", "fcm"]),
  environment: z.enum(["sandbox", "production"]),
  token: z.string().trim().min(20).max(4_096),
  previewPolicy: z.enum(["hidden", "generic", "title"]),
}).strict();

const nativePushRegistrationSchema = z.object({
  id: opaqueId,
  deviceId: opaqueId,
  platform: z.enum(["android", "ios"]),
  provider: z.enum(["apns", "fcm"]),
  environment: z.enum(["sandbox", "production"]),
  previewPolicy: z.enum(["hidden", "generic", "title"]),
  state: z.enum(["active", "revoked"]),
  lifecycleRevision: positiveDatabaseInteger,
  lastRegisteredAt: isoDateTime,
  lastDeliveredAt: isoDateTime.nullable(),
  revokedAt: isoDateTime.nullable(),
}).strict();

export const nativePushRegistrationResponseSchema = z.object({
  schemaVersion: z.literal(1),
  registration: nativePushRegistrationSchema,
  changed: z.boolean(),
  providers: z.object({
    apns: z.enum(["configured", "configuration_required"]),
    fcm: z.enum(["configured", "configuration_required"]),
  }).strict(),
}).strict();

export const nativePushRegistrationListResponseSchema = z.object({
  schemaVersion: z.literal(1),
  registrations: z.array(nativePushRegistrationSchema).max(10),
  providers: z.object({
    apns: z.enum(["configured", "configuration_required"]),
    fcm: z.enum(["configured", "configuration_required"]),
  }).strict(),
}).strict();

export const nativePushAcknowledgementResponseSchema = z.object({
  schemaVersion: z.literal(1),
  acknowledged: z.literal(true),
  newlyAcknowledged: z.boolean(),
  notificationId: opaqueId.nullable(),
  causeKind: z.enum(["approval", "work_item", "meeting", "customer", "run"]),
  causeId: opaqueId,
  deepLink: z.string().min(2).max(1_000),
}).strict();

export const nativeConversationRequestSchema = z.object({
  message: z.string().min(1).max(120_000),
  threadId: z.string().uuid().optional(),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
  strategy: z.enum(["auto", "direct", "durable"]).optional(),
  requestId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();

const agentEventSchemas = [
  z.object({ type: z.literal("run"), runId: opaqueId, threadId: opaqueId.optional(), missionId: opaqueId.optional() }).passthrough(),
  z.object({ type: z.literal("delegated"), threadId: opaqueId, workflowId: opaqueId, missionId: opaqueId.optional(), acknowledgement: z.string(), reason: z.string() }).passthrough(),
  z.object({ type: z.literal("clarification"), threadId: opaqueId, runId: opaqueId.optional(), message: z.string(), reasonCode: z.enum(["ambiguous_destructive_target", "ambiguous_known_procedure", "ambiguous_read_target"]) }).passthrough(),
  z.object({ type: z.literal("status"), label: z.string(), detail: z.string().optional() }).passthrough(),
  z.object({ type: z.literal("harness"), version: z.union([z.literal(1), z.literal(2)]), mode: z.enum(["orchestrate", "research", "execute", "learn"]) }).passthrough(),
  z.object({ type: z.literal("delta"), text: z.string() }).passthrough(),
  z.object({ type: z.literal("memory"), title: z.string(), count: z.number().int().min(0).optional() }).passthrough(),
  z.object({ type: z.literal("model"), model: z.string(), tier: z.enum(["fast", "reasoning"]), inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) }).passthrough(),
  z.object({ type: z.literal("council_member"), agentId: z.enum(["atlas", "scout", "forge", "sentinel", "mnemosyne"]), agentName: z.string(), role: z.string(), status: z.enum(["thinking", "completed", "failed"]) }).passthrough(),
  z.object({ type: z.literal("council_verdict"), status: z.enum(["passed", "revised", "failed"]), score: z.number(), assessment: z.string(), requiredChanges: z.array(z.string()) }).passthrough(),
  z.object({ type: z.literal("tool"), toolId: z.string(), toolName: z.string(), status: z.enum(["running", "executed", "dry_run", "approval_required", "blocked", "failed"]) }).passthrough(),
  z.object({ type: z.literal("waiting_approval"), executionId: opaqueId, toolId: z.string(), message: z.string() }).passthrough(),
  z.object({ type: z.literal("budget_exhausted"), dimension: z.string(), limit: z.number(), attempted: z.number(), requiresAuthorization: z.literal(true), message: z.string() }).passthrough(),
  z.object({ type: z.literal("done"), response: z.string(), grounding: jsonObject.optional() }).passthrough(),
  z.object({ type: z.literal("canceled"), message: z.string() }).passthrough(),
  z.object({ type: z.literal("error"), message: z.string() }).passthrough(),
] as const;

export const nativeConversationEventSchema = z.discriminatedUnion(
  "type",
  agentEventSchemas,
);

export type NativeOperation = Readonly<{
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  auth: "public" | "bearer";
  requestSchema?: string;
  responseSchema: string;
  mediaType?: "application/json" | "text/event-stream" | "multipart/form-data";
}>;

const v1Operations = [
  operation("auth.login", "POST", "/api/mobile/auth/login", "Create a device-bound native session.", "public", "NativeLoginRequest", "NativeLoginResponse"),
  operation("auth.refresh", "POST", "/api/mobile/auth/refresh", "Rotate a device-bound refresh credential.", "public", "NativeRefreshRequest", "NativeRefreshResponse"),
  operation("auth.logout", "POST", "/api/mobile/auth/logout", "Revoke the current native session.", "bearer", undefined, "NativeLogoutResponse"),
  operation("bootstrap.get", "GET", "/api/mobile/bootstrap", "Read the current scoped identity and compatibility policy.", "bearer", undefined, "NativeBootstrapResponse"),
  operation("adoption.get", "GET", "/api/mobile/adoption", "Read tenant-aggregate native adoption evidence.", "bearer", undefined, "JsonObject"),
] as const satisfies readonly NativeOperation[];

const v2Operations = [
  ...v1Operations,
  operation("contracts.get", "GET", "/api/mobile/contracts", "Discover immutable native contract documents.", "public", undefined, "NativeContractDiscovery"),
  operation("devices.list", "GET", "/api/mobile/devices", "List the authenticated user's tenant-bound device sessions.", "bearer", undefined, "NativeDeviceListResponse"),
  operation("devices.change", "POST", "/api/mobile/devices/{id}", "Revoke or request remote wipe for one owned device session.", "bearer", "NativeDeviceLifecycleRequest", "NativeDeviceSession"),
  operation("wipe.challenge", "GET", "/api/mobile/wipe", "Resolve a remote-wipe request using the revoked device access credential.", "bearer", undefined, "NativeWipeChallengeResponse"),
  operation("wipe.acknowledge", "POST", "/api/mobile/wipe", "Acknowledge local erasure with a single-use wipe challenge.", "public", "NativeWipeAcknowledgementRequest", "NativeWipeAcknowledgementResponse"),
  operation("today.get", "GET", "/api/today", "Read the authoritative Today projection.", "bearer", undefined, "JsonObject"),
  operation("today.create", "POST", "/api/today", "Create a governed Today item.", "bearer", "JsonObject", "JsonObject"),
  operation("today.update", "PATCH", "/api/today/{id}", "Update one authoritative Today item.", "bearer", "JsonObject", "JsonObject"),
  operation("today.brief", "POST", "/api/today/brief", "Generate or read the daily brief.", "bearer", "JsonObject", "JsonObject"),
  { ...operation("conversation.send", "POST", "/api/agent", "Run the authoritative governed conversation service.", "bearer", "NativeConversationRequest", "NativeConversationEvent"), mediaType: "text/event-stream" as const },
  operation("approvals.list", "GET", "/api/approvals", "Read the governed approval queue.", "bearer", undefined, "JsonObject"),
  operation("approvals.decide", "POST", "/api/approvals/{id}", "Apply one governed approval decision.", "bearer", "JsonObject", "JsonObject"),
  operation("workspaces.list", "GET", "/api/projects", "Read canonical Workspace projections.", "bearer", undefined, "JsonObject"),
  operation("workspaces.get", "GET", "/api/projects/{id}", "Read one canonical Workspace projection.", "bearer", undefined, "JsonObject"),
  operation("workspaces.create", "POST", "/api/projects", "Create a canonical Workspace.", "bearer", "JsonObject", "JsonObject"),
  operation("workspaces.update", "PATCH", "/api/projects/{id}", "Update one canonical Workspace.", "bearer", "JsonObject", "JsonObject"),
  { ...operation("capture.create", "POST", "/api/capture", "Submit content to the authoritative Capture service.", "bearer", "JsonObject", "JsonObject"), mediaType: "multipart/form-data" as const },
  operation("meetings.list", "GET", "/api/meetings", "Read actor-visible meeting projections.", "bearer", undefined, "JsonObject"),
  operation("meetings.get", "GET", "/api/meetings/{id}", "Read one actor-visible meeting projection.", "bearer", undefined, "JsonObject"),
  operation("notifications.list", "GET", "/api/notifications", "Read actor-visible notifications.", "bearer", undefined, "JsonObject"),
  operation("notifications.acknowledge", "PATCH", "/api/notifications/{id}", "Acknowledge one actor-visible notification.", "bearer", "JsonObject", "JsonObject"),
  operation("evidence.run", "GET", "/api/runs/{id}", "Read one actor-visible run and its evidence.", "bearer", undefined, "JsonObject"),
  operation("evidence.run.cancel", "DELETE", "/api/runs/{id}", "Cancel one actor-visible run through its authoritative service.", "bearer", undefined, "JsonObject"),
  operation("evidence.workflow", "GET", "/api/workflows/{id}", "Read one actor-visible workflow and its evidence.", "bearer", undefined, "JsonObject"),
  operation("workspace.summary", "GET", "/api/workspace-summary", "Read the authoritative cross-domain Workspace summary.", "bearer", undefined, "JsonObject"),
  operation("evaluations.list", "GET", "/api/evaluations", "Read actor-visible evaluation evidence.", "bearer", undefined, "JsonObject"),
  operation("agents.list", "GET", "/api/agents", "Read the authoritative Agent catalog.", "bearer", undefined, "JsonObject"),
  operation("agents.create", "POST", "/api/agents", "Create one governed Agent definition.", "bearer", "JsonObject", "JsonObject"),
  operation("agents.update", "PATCH", "/api/agents/{id}", "Update one governed Agent definition.", "bearer", "JsonObject", "JsonObject"),
  operation("agents.delete", "DELETE", "/api/agents/{id}", "Move one Agent definition through its governed deletion flow.", "bearer", undefined, "JsonObject"),
  operation("agents.performance", "GET", "/api/agents/performance", "Read Agent performance evidence.", "bearer", undefined, "JsonObject"),
  operation("skills.list", "GET", "/api/skills", "Read actor-visible skills.", "bearer", undefined, "JsonObject"),
  operation("skills.create", "POST", "/api/skills", "Create one governed skill.", "bearer", "JsonObject", "JsonObject"),
  operation("skills.update", "PATCH", "/api/skills/{id}", "Update one governed skill.", "bearer", "JsonObject", "JsonObject"),
  operation("skills.delete", "DELETE", "/api/skills/{id}", "Move one skill through its governed deletion flow.", "bearer", undefined, "JsonObject"),
  operation("memory.list", "GET", "/api/memory", "Read actor-scoped memory.", "bearer", undefined, "JsonObject"),
  operation("memory.create", "POST", "/api/memory", "Create actor-scoped memory through the authoritative service.", "bearer", "JsonObject", "JsonObject"),
  operation("memory.update", "PATCH", "/api/memory/{id}", "Correct one actor-scoped memory record.", "bearer", "JsonObject", "JsonObject"),
  operation("memory.delete", "DELETE", "/api/memory/{id}", "Forget one actor-scoped memory record.", "bearer", undefined, "JsonObject"),
  operation("memory.graph.get", "GET", "/api/memory/graph", "Read the actor-scoped memory graph.", "bearer", undefined, "JsonObject"),
  operation("memory.graph.rebuild", "POST", "/api/memory/graph", "Rebuild the actor-scoped memory graph.", "bearer", "JsonObject", "JsonObject"),
  operation("knowledge.list", "GET", "/api/knowledge", "Read actor-visible indexed knowledge.", "bearer", undefined, "JsonObject"),
  operation("knowledge.source.delete", "DELETE", "/api/knowledge", "Delete one actor-scoped connected source.", "bearer", undefined, "JsonObject"),
  operation("missions.list", "GET", "/api/missions", "Read actor-visible durable missions.", "bearer", undefined, "JsonObject"),
  operation("missions.create", "POST", "/api/missions", "Create one durable mission.", "bearer", "JsonObject", "JsonObject"),
  operation("missions.get", "GET", "/api/missions/{id}", "Read one actor-visible durable mission.", "bearer", undefined, "JsonObject"),
  operation("missions.update", "PATCH", "/api/missions/{id}", "Transition one durable mission.", "bearer", "JsonObject", "JsonObject"),
  operation("missions.events", "GET", "/api/missions/{id}/events", "Read versioned mission events.", "bearer", undefined, "JsonObject"),
  operation("workspaces.plan", "POST", "/api/projects/{id}/plan", "Plan one canonical Workspace.", "bearer", "JsonObject", "JsonObject"),
  operation("workspaces.tasks.create", "POST", "/api/projects/{id}/tasks", "Create one canonical Workspace task.", "bearer", "JsonObject", "JsonObject"),
  operation("workspaces.tasks.update", "PATCH", "/api/projects/{id}/tasks/{taskId}", "Update one canonical Workspace task.", "bearer", "JsonObject", "JsonObject"),
  operation("workspaces.execute", "POST", "/api/projects/{id}/execution", "Execute one canonical Workspace command.", "bearer", "JsonObject", "JsonObject"),
  operation("workspaces.artifacts.feedback", "POST", "/api/projects/{id}/artifacts/{artifactId}/feedback", "Attach reviewed feedback to one Workspace artifact.", "bearer", "JsonObject", "JsonObject"),
  operation("admin.workflows", "GET", "/api/workflows", "Read workflow administration state.", "bearer", undefined, "JsonObject"),
  operation("admin.triggers", "GET", "/api/triggers", "Read workflow triggers.", "bearer", undefined, "JsonObject"),
  operation("admin.operations", "GET", "/api/operations", "Read background operation state.", "bearer", undefined, "JsonObject"),
  operation("admin.workflows.tick", "POST", "/api/workflows/tick", "Process due workflows through the governed executor.", "bearer", "JsonObject", "JsonObject"),
  operation("admin.connection.catalog", "GET", "/api/connection-catalog", "Read the connection catalog.", "bearer", undefined, "JsonObject"),
  operation("admin.connectors", "GET", "/api/connectors", "Read installed connectors.", "bearer", undefined, "JsonObject"),
  operation("admin.oauth", "GET", "/api/oauth", "Read OAuth connection state.", "bearer", undefined, "JsonObject"),
  operation("admin.openapi.connectors", "GET", "/api/openapi-connectors", "Read installed OpenAPI connectors.", "bearer", undefined, "JsonObject"),
  operation("admin.health", "GET", "/api/health", "Read public service health.", "public", undefined, "JsonObject"),
  operation("admin.observability", "GET", "/api/observability", "Read observability state.", "bearer", undefined, "JsonObject"),
  operation("admin.slo", "GET", "/api/observability/slo", "Read the SLO policy.", "bearer", undefined, "JsonObject"),
  operation("admin.incidents", "GET", "/api/incidents", "Read incidents.", "bearer", undefined, "JsonObject"),
  operation("admin.alerts", "GET", "/api/alerts", "Read alerts.", "bearer", undefined, "JsonObject"),
  operation("admin.release.evidence", "GET", "/api/release/evidence", "Read production release evidence.", "bearer", undefined, "JsonObject"),
  operation("admin.security.audits", "GET", "/api/security/audits", "Read security audit evidence.", "bearer", undefined, "JsonObject"),
  operation("admin.security.isolation", "GET", "/api/security/isolation-report", "Read tenant-isolation evidence.", "bearer", undefined, "JsonObject"),
  operation("admin.security.retention", "GET", "/api/security/retention", "Read retention state.", "bearer", undefined, "JsonObject"),
  operation("admin.security.context", "GET", "/api/security/context", "Read the current security context.", "bearer", undefined, "JsonObject"),
  operation("admin.workspace.readiness", "GET", "/api/workspace-readiness", "Read Workspace readiness.", "bearer", undefined, "JsonObject"),
  operation("admin.auth.controlPlane", "GET", "/api/auth/control-plane", "Read authorized control-plane identity state.", "bearer", undefined, "JsonObject"),
  operation("admin.system.migrations", "GET", "/api/system/migrations", "Read schema migration state.", "bearer", undefined, "JsonObject"),
  operation("admin.data.export", "GET", "/api/data/export", "Read portable-data export state.", "bearer", undefined, "JsonObject"),
  operation("admin.tools", "GET", "/api/tools", "Read the governed tool registry.", "bearer", undefined, "JsonObject"),
  operation("admin.capabilities", "GET", "/api/capabilities", "Read capabilities.", "bearer", undefined, "JsonObject"),
  operation("admin.trust", "GET", "/api/trust", "Read trust policy and evidence.", "bearer", undefined, "JsonObject"),
] as const satisfies readonly NativeOperation[];

const v3Operations = [
  ...v2Operations,
  { ...operation("capture.transcribe", "POST", "/api/capture/transcribe", "Transcribe a reviewed native voice draft.", "bearer", "JsonObject", "JsonObject"), mediaType: "multipart/form-data" as const },
  operation("notifications.readAll", "PATCH", "/api/notifications", "Mark all actor-visible notifications read.", "bearer", "JsonObject", "JsonObject"),
] as const satisfies readonly NativeOperation[];

const v4Operations = [
  ...v3Operations,
  operation("push.registrations.list", "GET", "/api/mobile/push/registrations", "Read push registrations for the current installation.", "bearer", undefined, "NativePushRegistrationListResponse"),
  operation("push.registrations.upsert", "POST", "/api/mobile/push/registrations", "Register or rotate an encrypted APNs/FCM device token.", "bearer", "NativePushRegistrationRequest", "NativePushRegistrationResponse"),
  operation("push.registrations.revoke", "DELETE", "/api/mobile/push/registrations/{id}", "Revoke one current-installation push registration.", "bearer", undefined, "JsonObject"),
  operation("push.deliveries.acknowledge", "POST", "/api/mobile/push/deliveries/{id}/acknowledge", "Acknowledge one actor-owned causal push delivery exactly once.", "bearer", "JsonObject", "NativePushAcknowledgementResponse"),
  operation("customers.get", "GET", "/api/customer-accounts/{id}", "Read one actor-visible Customer 360 projection.", "bearer", undefined, "JsonObject"),
] as const satisfies readonly NativeOperation[];

const v5Operations = [
  ...v4Operations,
  operation("memory.intelligence.get", "GET", "/api/memory/intelligence", "Read the categorized memory and knowledge index with steward health.", "bearer", undefined, "JsonObject"),
  operation("memory.get", "GET", "/api/memory/{id}", "Inspect one explicitly selected actor-scoped memory or its deletion preview.", "bearer", undefined, "JsonObject"),
] as const satisfies readonly NativeOperation[];

const v6Operations = [
  ...v5Operations,
  operation("customers.list", "GET", "/api/customer-accounts", "Read the actor-visible Customer 360 portfolio.", "bearer", undefined, "JsonObject"),
  operation("customers.portfolio", "GET", "/api/customer-accounts/portfolio", "Read actor-visible customer health and risk intelligence.", "bearer", undefined, "JsonObject"),
  operation("market.overview", "GET", "/api/market-research", "Read the market-research instrument and provider projection.", "bearer", undefined, "JsonObject"),
  operation("market.bars", "GET", "/api/market-research/bars", "Read one immutable actor-owned market snapshot.", "bearer", undefined, "JsonObject"),
  operation("market.events", "GET", "/api/market-research/events", "Read official macro event history.", "bearer", undefined, "JsonObject"),
  operation("market.events.backfill", "POST", "/api/market-research/events", "Queue governed official-event backfill.", "bearer", "JsonObject", "JsonObject"),
  operation("market.replays", "GET", "/api/market-research/replays", "Read exact event-window replays.", "bearer", undefined, "JsonObject"),
  operation("market.replays.backfill", "POST", "/api/market-research/replays", "Queue governed market replay backfill.", "bearer", "JsonObject", "JsonObject"),
  operation("market.baselines", "GET", "/api/market-research/baselines", "Read comparable-event descriptive baselines.", "bearer", undefined, "JsonObject"),
  operation("market.features", "GET", "/api/market-research/features", "Read deterministic ICT and Quarterly technical candidates.", "bearer", undefined, "JsonObject"),
  operation("market.analysis", "GET", "/api/market-research/analysis", "Read private immutable chart-analysis versions.", "bearer", undefined, "JsonObject"),
  operation("market.journal", "GET", "/api/market-research/journal", "Read the actor-private forward-shadow journal.", "bearer", undefined, "JsonObject"),
  operation("market.journal.generate", "POST", "/api/market-research/journal/generate", "Generate one governed uncalibrated market scenario.", "bearer", "JsonObject", "JsonObject"),
  operation("market.journal.score", "POST", "/api/market-research/journal/score", "Score due market scenarios against immutable outcomes.", "bearer", "JsonObject", "JsonObject"),
  operation("operations.job", "GET", "/api/operations/jobs/{id}", "Read one actor-visible background operation.", "bearer", undefined, "JsonObject"),
  operation("payments.readiness", "GET", "/api/payments/ap2/readiness", "Read the exact AP2 readiness boundary.", "bearer", undefined, "JsonObject"),
  operation("payments.reviews", "GET", "/api/payments/ap2/reviews", "Read exact actor-private mandate reviews.", "bearer", undefined, "JsonObject"),
  operation("payments.authenticators", "GET", "/api/payments/ap2/authenticators", "Read registered hardware-backed payment signers.", "bearer", undefined, "JsonObject"),
  operation("payments.transactions", "GET", "/api/payments/ap2/transactions", "Read evidence-derived payment lifecycle projections.", "bearer", undefined, "JsonObject"),
  operation("settings.get", "GET", "/api/settings", "Read the actor-authorized provider and model-routing control plane.", "bearer", undefined, "JsonObject"),
  operation("settings.assignments.update", "PUT", "/api/settings/assignments", "Update one actor-owned model assignment.", "bearer", "JsonObject", "JsonObject"),
  operation("workspaces.builder.get", "GET", "/api/projects/{id}/builder", "Read the project-scoped App Builder session.", "bearer", undefined, "JsonObject"),
  operation("workspaces.builder.update", "POST", "/api/projects/{id}/builder", "Run a governed App Builder operation.", "bearer", "JsonObject", "JsonObject"),
] as const satisfies readonly NativeOperation[];

export const nativeContractSchemas = Object.freeze({
  JsonObject: jsonObject,
  NativeClientAttestation: nativeClientAttestationSchema,
  NativeDevice: nativeDeviceSchema,
  NativeLoginRequest: nativeLoginRequestSchema,
  NativeRefreshRequest: nativeRefreshRequestSchema,
  NativeTokenPair: nativeTokenPairSchema,
  NativeCompatibility: nativeCompatibilitySchema,
  NativeLoginResponse: nativeLoginResponseSchema,
  NativeRefreshResponse: nativeRefreshResponseSchema,
  NativeLogoutResponse: nativeLogoutResponseSchema,
  NativeBootstrapResponse: nativeBootstrapResponseSchema,
  NativeErrorResponse: nativeErrorResponseSchema,
  NativeDeviceSession: nativeDeviceSessionSchema,
  NativeDeviceListResponse: nativeDeviceListResponseSchema,
  NativeDeviceLifecycleRequest: nativeDeviceLifecycleRequestSchema,
  NativeWipeChallengeResponse: nativeWipeChallengeResponseSchema,
  NativeWipeAcknowledgementRequest: nativeWipeAcknowledgementRequestSchema,
  NativeWipeAcknowledgementResponse: nativeWipeAcknowledgementResponseSchema,
  NativePushRegistrationRequest: nativePushRegistrationRequestSchema,
  NativePushRegistrationResponse: nativePushRegistrationResponseSchema,
  NativePushRegistrationListResponse: nativePushRegistrationListResponseSchema,
  NativePushAcknowledgementResponse: nativePushAcknowledgementResponseSchema,
  NativeConversationRequest: nativeConversationRequestSchema,
  NativeConversationEvent: nativeConversationEventSchema,
  NativeContractDiscovery: z.object({
    schemaVersion: z.literal(1),
    contractId: z.literal(NATIVE_API_CONTRACT_ID),
    currentVersion: z.literal(NATIVE_API_CURRENT_VERSION),
    previousVersion: z.literal(NATIVE_API_PREVIOUS_VERSION),
    supportedVersions: z.tuple([
      z.literal(NATIVE_API_CURRENT_VERSION),
      z.literal(NATIVE_API_PREVIOUS_VERSION),
    ]),
    versions: z.array(z.object({
      version: z.number().int().positive(),
      state: z.enum(["current", "previous"]),
      manifest: z.string(),
      openapi: z.string(),
      events: z.string(),
      fixtures: z.string(),
    }).strict()).length(2),
  }).strict(),
});

export function nativeOperationsForVersion(version: number): readonly NativeOperation[] | undefined {
  if (version === 1) return v1Operations;
  if (version === 2) return v2Operations;
  if (version === 3) return v3Operations;
  if (version === 4) return v4Operations;
  if (version === 5) return v5Operations;
  if (version === 6) return v6Operations;
  return undefined;
}

export function nativeContractDiscovery() {
  return {
    schemaVersion: 1 as const,
    contractId: NATIVE_API_CONTRACT_ID,
    currentVersion: NATIVE_API_CURRENT_VERSION,
    previousVersion: NATIVE_API_PREVIOUS_VERSION,
    supportedVersions: [...NATIVE_API_SUPPORTED_VERSIONS] as [6, 5],
    versions: NATIVE_API_SUPPORTED_VERSIONS.map((version) => ({
      version,
      state: version === NATIVE_API_CURRENT_VERSION ? "current" as const : "previous" as const,
      manifest: `/native-contracts/v${version}/manifest.json`,
      openapi: `/native-contracts/v${version}/openapi.json`,
      events: `/native-contracts/v${version}/events.schema.json`,
      fixtures: `/native-contracts/v${version}/fixtures.json`,
    })),
  };
}

function operation(
  id: string,
  method: NativeOperation["method"],
  path: string,
  summary: string,
  auth: NativeOperation["auth"],
  requestSchema: string | undefined,
  responseSchema: string,
): NativeOperation {
  return { id, method, path, summary, auth, requestSchema, responseSchema };
}
