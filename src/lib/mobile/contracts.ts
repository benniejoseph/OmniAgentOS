import { z } from "zod";
import { agentDailyLearningStatusV1Schema } from "@/lib/agents/learning-contracts";
import {
  promptQueueCreateRequestSchema,
  promptQueueDeleteRequestSchema,
  promptQueueDispatchRequestSchema,
  promptQueueItemV1Schema,
  promptQueueListV1Schema,
  promptQueueReorderRequestSchema,
  promptQueueUpdateRequestSchema,
} from "@/lib/command/prompt-queue-contracts";
import {
  LOCAL_COMPUTER_PROTOCOL_VERSION,
  localComputerActionSchema,
  localComputerClaimRequestSchema,
  localComputerCommandSchema,
  localComputerCommandRunnerSchema,
  localComputerCompletionRequestSchema,
  localComputerDeviceUpdateSchema,
  localComputerStopRequestSchema,
} from "@/lib/local-computer/contracts";
import { mobilePushReceiptRequestSchema } from "@/lib/mobile/push-contract";
import { pluginManifestSchema } from "@/lib/plugins/contracts";

export const NATIVE_API_CONTRACT_ID = "asael.native-api" as const;
export const NATIVE_API_CURRENT_VERSION = 27 as const;
// v26 remains the rollback bridge while v27 extends the existing governed
// local-computer courier with the command-runner status and wire schemas only.
export const NATIVE_API_PREVIOUS_VERSION = 26 as const;
export const NATIVE_API_SUPPORTED_VERSIONS = [
  NATIVE_API_CURRENT_VERSION,
  NATIVE_API_PREVIOUS_VERSION,
] as const;

const positiveDatabaseInteger = z.number().int().min(1).max(2_147_483_647);
const isoDateTime = z.string().datetime({ offset: true });
const opaqueId = z.string().trim().min(1).max(200);
const mobilePushOpaqueId = z.string().trim().min(1).max(240);
const jsonObject = z.record(z.string(), z.unknown());
const sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);
const LOCAL_COMPUTER_PREVIEW_BINDING_CONTRACT_VERSION = 12;

export const nativeAgentTaskCancelRequestSchema = z.object({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(1).max(500),
}).strict();

const nativeAgentTaskRuntimeSchema = z.object({
  providerId: opaqueId,
  modelId: opaqueId,
  modelTier: z.enum(["fast", "reasoning"]),
  reasoningProfileId: opaqueId,
  normalizedReasoningEffort: z.enum([
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
  ]),
}).strict();

const nativeAgentTaskProjectionSchema = z.object({
  executionId: z.string().trim().min(1).max(240),
  delegationId: opaqueId,
  rootExecutionId: opaqueId,
  parentExecutionId: opaqueId,
  childRunId: opaqueId,
  state: z.literal("canceled"),
  lifecycleRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  canCancel: z.literal(false),
  mode: z.enum(["isolated", "fork", "team"]),
  objective: z.string().trim().min(1).max(4_000),
  delegateAgentId: opaqueId,
  runtime: nativeAgentTaskRuntimeSchema,
  result: z.object({
    status: z.enum(["completed", "blocked"]),
    summary: z.string().max(8_000),
    artifacts: z.array(z.object({
      artifactId: opaqueId,
      kind: opaqueId,
      mediaType: z.string().trim().min(1).max(160),
      byteCount: z.number().int().min(0).max(64 * 1024 * 1024),
    }).strict()).max(20),
    acceptanceChecks: z.array(z.object({
      criterionId: opaqueId,
      passed: z.boolean(),
      note: z.string().max(2_000),
    }).strict()).max(64),
  }).strict().nullable(),
  verification: z.object({
    verdict: z.enum(["verified", "rejected"]),
    score: z.number().min(0).max(1),
    note: z.string().max(2_000),
    verifiedAt: isoDateTime,
  }).strict().nullable(),
  failureCode: opaqueId.nullable(),
  createdAt: isoDateTime,
  acceptBy: isoDateTime,
  completeBy: isoDateTime,
  updatedAt: isoDateTime,
  terminalAt: isoDateTime,
}).strict();

export const nativeAgentTaskCancelResponseSchema = z.object({
  task: nativeAgentTaskProjectionSchema,
  canceledChildRun: z.boolean(),
  canceledDeliveryCount: z.number().int().min(0).max(1),
  idempotent: z.boolean(),
  serviceReceipt: jsonObject,
}).strict();

export const nativeClientAttestationSchema = z.object({
  platform: z.enum(["android", "ios", "macos"]),
  appVersion: z.string().regex(
    /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/,
  ),
  buildNumber: positiveDatabaseInteger,
  clientContractVersion: positiveDatabaseInteger,
}).strict();

export const nativeDeviceSchema = z.object({
  id: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  name: z.string().trim().min(1).max(120),
  platform: z.enum(["android", "ios", "macos"]),
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
  platform: z.enum(["android", "ios", "macos"]),
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
  platform: z.enum(["android", "ios", "macos"]),
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
  notificationId: mobilePushOpaqueId.nullable(),
  causeKind: z.enum([
    "approval",
    "work_item",
    "meeting",
    "customer",
    "run",
    "notification",
    "canary",
  ]),
  causeId: mobilePushOpaqueId,
  deepLink: z.string().min(2).max(1_000),
}).strict();

const nativePushCauseKindSchema = z.enum([
  "approval",
  "work_item",
  "meeting",
  "customer",
  "run",
  "notification",
  "canary",
]);

const nativePushDeliveryStateSchema = z.object({
  id: opaqueId,
  notificationId: mobilePushOpaqueId.nullable(),
  causeKind: nativePushCauseKindSchema,
  causeId: mobilePushOpaqueId,
  deepLink: z.string().min(2).max(1_000),
  providerState: z.enum(["queued", "sending", "accepted", "failed"]),
  providerAcceptedAt: isoDateTime.nullable(),
  appState: z.enum(["none", "received", "opened", "action"]),
  receivedAt: isoDateTime.nullable(),
  openedAt: isoDateTime.nullable(),
  lastAction: z.object({
    action: z.enum(["open", "complete", "snooze", "dismiss"]),
    observedAt: isoDateTime,
    recordedAt: isoDateTime,
  }).strict().nullable(),
  failureCode: z.string().min(1).max(120).nullable(),
}).strict();

const nativePushReceiptSchema = z.object({
  id: opaqueId,
  kind: z.enum(["received", "opened", "action"]),
  action: z.enum(["open", "complete", "snooze", "dismiss"]).nullable(),
  observedAt: isoDateTime,
  recordedAt: isoDateTime,
  appLifecycle: z.enum(["foreground", "background", "terminated", "unknown"]),
  platform: z.enum(["android", "ios", "macos"]),
}).strict();

export const nativePushReceiptResponseSchema = z.object({
  schemaVersion: z.literal(1),
  recorded: z.literal(true),
  newlyRecorded: z.boolean(),
  receipt: nativePushReceiptSchema,
  delivery: nativePushDeliveryStateSchema,
}).strict();

export const nativePushCanaryRequestSchema = z.object({
  registrationId: opaqueId.optional(),
  timeoutSeconds: z.number().int().min(1).max(20).optional(),
}).strict();

export const nativePushCanaryResponseSchema = z.object({
  schemaVersion: z.literal(1),
  canaryId: opaqueId,
  deliveryId: opaqueId,
  outcome: z.enum(["received", "provider_failed", "timed_out"]),
  timedOut: z.boolean(),
  state: nativePushDeliveryStateSchema,
}).strict();

export const nativePluginPreviewRequestSchema = z.union([
  z.object({ manifest: pluginManifestSchema }).strict(),
  z.object({
    pluginId: z.string().trim().min(3).max(120),
    version: z.string().trim().min(5).max(80),
    manifestSha256: sha256Digest,
  }).strict(),
]);

export const nativePluginInstallRequestSchema = z.object({
  previewId: z.string().trim().min(16).max(200),
  manifestSha256: sha256Digest,
}).strict();

export const nativePluginChangeRequestSchema = z.object({
  action: z.enum(["enable", "disable"]),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const nativePluginUninstallRequestSchema = z.object({
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const nativeConversationRequestSchema = z.object({
  message: z.string().min(1).max(120_000),
  threadId: z.string().uuid().optional(),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
  strategy: z.enum(["auto", "direct", "durable"]).optional(),
  agentId: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
  computerUseTarget: z.literal("local_macos").optional(),
  requestId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();

const localComputerPermissionStateSchema = z.enum([
  "granted",
  "denied",
  "unknown",
]);

export const nativeLocalComputerDeviceResponseSchema = z.object({
  schemaVersion: z.literal(LOCAL_COMPUTER_PROTOCOL_VERSION),
  deviceId: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  enabled: z.boolean(),
  online: z.boolean(),
  helperVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  permissions: z.object({
    accessibility: localComputerPermissionStateSchema,
    screenRecording: localComputerPermissionStateSchema,
  }).strict(),
  activityState: z.enum(["idle", "active", "stopped", "error"]),
  commandRunner: localComputerCommandRunnerSchema.optional(),
  lifecycleRevision: positiveDatabaseInteger,
  lastSeenAt: isoDateTime,
  leaseExpiresAt: isoDateTime,
}).strict();

export const nativeLocalComputerDeviceReadResponseSchema =
  nativeLocalComputerDeviceResponseSchema.nullable();

export const nativeLocalComputerClaimResponseSchema = z.object({
  schemaVersion: z.literal(LOCAL_COMPUTER_PROTOCOL_VERSION),
  command: localComputerCommandSchema.nullable(),
  pollAfterMs: z.number().int().min(0).max(5_000),
}).strict();

// Contract v11 predates the run-bound preview routing fields carried by the
// current courier envelope. Keep its wire shape explicit so an installed v11
// client never receives fields rejected by its frozen strict contract.
export const nativeLocalComputerV11ClaimResponseSchema = z.object({
  schemaVersion: z.literal(LOCAL_COMPUTER_PROTOCOL_VERSION),
  command: z.object({
    schemaVersion: z.literal(LOCAL_COMPUTER_PROTOCOL_VERSION),
    id: z.string().regex(/^local_computer_command_[a-f0-9]{48}$/),
    action: localComputerActionSchema,
    input: z.record(z.string(), z.unknown()),
    claimToken: z.string().min(32).max(256),
    claimGeneration: z.number().int().positive(),
    expiresAt: isoDateTime,
  }).strict().nullable(),
  pollAfterMs: z.number().int().min(0).max(5_000),
}).strict();

export function nativeLocalComputerClaimResponseForClient(
  value: unknown,
  clientContractVersion: number,
) {
  const current = nativeLocalComputerClaimResponseSchema.parse(value);
  if (clientContractVersion >= LOCAL_COMPUTER_PREVIEW_BINDING_CONTRACT_VERSION) {
    return current;
  }
  const command = current.command
    ? omitLocalComputerPreviewBinding(current.command)
    : null;
  return nativeLocalComputerV11ClaimResponseSchema.parse({
    ...current,
    command,
  });
}

export const nativeLocalComputerCompletionResponseSchema = z.object({
  schemaVersion: z.literal(LOCAL_COMPUTER_PROTOCOL_VERSION),
  accepted: z.literal(true),
  commandId: z.string().regex(/^local_computer_command_[a-f0-9]{48}$/),
  outcome: z.enum(["succeeded", "failed", "canceled"]),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  completedAt: isoDateTime,
}).strict();

export const nativeLocalComputerStopResponseSchema = z.object({
  schemaVersion: z.literal(LOCAL_COMPUTER_PROTOCOL_VERSION),
  stopped: z.literal(true),
  reason: z.enum(["user_stop", "app_exit", "sign_out", "permission_lost"]),
  canceledCommands: z.number().int().min(0).max(10_000),
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
  queryParameters?: readonly NativeQueryParameter[];
  headerParameters?: readonly NativeHeaderParameter[];
  binaryResponse?: boolean;
}>;

export type NativeQueryParameter = Readonly<{
  name: string;
  type: "string" | "integer" | "flag";
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}>;

export type NativeHeaderParameter = Readonly<{
  name: string;
  required: true;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
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

const v7Operations = [
  ...v6Operations,
  operation("market.backtests", "GET", "/api/market-research/backtests", "Read actor-private immutable deterministic backtests.", "bearer", undefined, "JsonObject"),
  operation("market.backtests.run", "POST", "/api/market-research/backtests", "Queue one governed leakage-safe deterministic backtest.", "bearer", "JsonObject", "JsonObject"),
] as const satisfies readonly NativeOperation[];

// Contract publication must describe only authority a native bearer can
// actually exercise. These legacy v7 declarations have no enrolled route
// capability, so v8 stops advertising them without changing the frozen v7
// compatibility artifact or granting any new mutation authority.
const v8UnenrolledMutationOperationIds = new Set<string>([
  "agents.create",
  "agents.update",
  "agents.delete",
  "skills.create",
  "skills.update",
  "skills.delete",
  "memory.create",
  "memory.update",
  "memory.delete",
  "memory.graph.rebuild",
  "knowledge.source.delete",
  "missions.create",
  "missions.update",
  "admin.workflows.tick",
]);

const v8Operations: readonly NativeOperation[] = v7Operations.filter(
  (operation) => !v8UnenrolledMutationOperationIds.has(operation.id),
);

// Contract v9 adds only authenticated reads needed for durable desktop
// conversations. The existing Memory collection read gains an explicit
// thread filter; no new write or authority path is introduced.
const v9Operations: readonly NativeOperation[] = [
  ...v8Operations.map((candidate) => candidate.id === "memory.list"
    ? {
        ...candidate,
        summary: "Read actor-scoped memory, optionally limited to one exact owned thread.",
        queryParameters: [
          queryParameter("threadId", "string", { minLength: 1, maxLength: 200 }),
          queryParameter("limit", "integer", { minimum: 1, maximum: 100 }),
        ],
      }
    : candidate),
  operation(
    "threads.list",
    "GET",
    "/api/threads",
    "Read the authenticated actor's durable conversation threads.",
    "bearer",
    undefined,
    "JsonObject",
    {
      queryParameters: [
        queryParameter("limit", "integer", { minimum: 1, maximum: 100 }),
      ],
    },
  ),
  operation(
    "threads.get",
    "GET",
    "/api/threads/{id}",
    "Read one exact owned thread with bounded turns and public summaries.",
    "bearer",
    undefined,
    "JsonObject",
  ),
  operation(
    "capture.asset.get",
    "GET",
    "/api/capture/assets/{id}",
    "Read scoped asset metadata or integrity-verified content with content=1.",
    "bearer",
    undefined,
    "JsonObject",
    {
      queryParameters: [queryParameter("content", "flag")],
      binaryResponse: true,
    },
  ),
];

// Contract v10 exposes an already-authorized, run-bound Computer Use frame to
// native artifact rails. It adds no control path: interaction still occurs
// through the governed agent tool loop and the existing activity frame route.
const v10Operations: readonly NativeOperation[] = [
  ...v9Operations,
  operation(
    "evidence.run.computerFrame",
    "GET",
    "/api/runs/{id}/activity/frames/{frameId}",
    "Read one exact private Computer Use frame owned by the run actor.",
    "bearer",
    undefined,
    "JsonObject",
    { binaryResponse: true },
  ),
];

// Contract v11 adds only the device-bound courier path between the governed
// agent executor and the separately signed helper on the authenticated Mac.
// The native client may advertise readiness, claim an exact queued command,
// return its bounded receipt, or stop the local executor. Agent actions still
// originate in the governed tool loop; these routes grant no general-purpose
// shell, filesystem, Apple Events, or network authority.
const v11Operations: readonly NativeOperation[] = [
  ...v10Operations,
  operation(
    "localComputer.device",
    "GET",
    "/api/mobile/computer-use/device",
    "Read this authenticated Mac installation's local Computer Use readiness.",
    "bearer",
    undefined,
    "NativeLocalComputerDeviceReadResponse",
  ),
  operation(
    "localComputer.device.update",
    "PUT",
    "/api/mobile/computer-use/device",
    "Publish this authenticated Mac helper's short-lived readiness lease.",
    "bearer",
    "NativeLocalComputerDeviceUpdateRequest",
    "NativeLocalComputerDeviceResponse",
  ),
  operation(
    "localComputer.command.claim",
    "POST",
    "/api/mobile/computer-use/commands/claim",
    "Claim one exact governed local Computer Use command for this Mac installation.",
    "bearer",
    "NativeLocalComputerClaimRequest",
    "NativeLocalComputerClaimResponse",
  ),
  operation(
    "localComputer.command.complete",
    "POST",
    "/api/mobile/computer-use/commands/{id}/complete",
    "Return the bounded idempotent completion receipt for one claimed local command.",
    "bearer",
    "NativeLocalComputerCompletionRequest",
    "NativeLocalComputerCompletionResponse",
  ),
  operation(
    "localComputer.stop",
    "POST",
    "/api/mobile/computer-use/stop",
    "Disable this Mac installation and cancel its queued or claimed local commands.",
    "bearer",
    "NativeLocalComputerStopRequest",
    "NativeLocalComputerStopResponse",
  ),
];

// Contract v12 keeps the governed courier operations and adds exact run and
// execution binding plus an explicit presentation intent to claimed commands.
// Those fields are used only to route a short-lived screenshot to the matching
// conversation; they do not add computer-control authority.
const v12Operations: readonly NativeOperation[] = [
  ...v11Operations,
];

// Contract v13 adds the governed, approval-gated local browser navigation
// action to the strict command enum. The route set itself is unchanged.
const v13Operations: readonly NativeOperation[] = [
  ...v12Operations,
];

// Contract v14 removes the retired remote Computer Use frame projection from
// the source-current native surface. Frozen v10-v13 documents retain the route
// only as historical compatibility evidence; new clients receive screenshots
// exclusively through the private, short-lived This Mac preview channel.
const v14Operations: readonly NativeOperation[] = v13Operations.filter(
  (operation) => operation.id !== "evidence.run.computerFrame",
);

// Contract v15 adds first-class app receipt evidence and the live push canary.
// Frozen v14 remains byte-for-byte unchanged after its Computer Use cutover.
const v15Operations: readonly NativeOperation[] = [
  ...v14Operations,
  operation(
    "push.delivery.receipts",
    "POST",
    "/api/mobile/push/deliveries/{id}/receipts",
    "Record one idempotent app-observed received, opened, or action receipt.",
    "bearer",
    "NativePushReceiptRequest",
    "NativePushReceiptResponse",
  ),
  operation(
    "push.canary.targets",
    "GET",
    "/api/mobile/push/canary",
    "List this actor's eligible push registrations for a live receipt canary.",
    "bearer",
    undefined,
    "JsonObject",
  ),
  operation(
    "push.canary.run",
    "POST",
    "/api/mobile/push/canary",
    "Send a live provider-to-app push canary and wait for its app receipt.",
    "bearer",
    "NativePushCanaryRequest",
    "NativePushCanaryResponse",
  ),
];

// Contract v16 exposes the actor-scoped declarative Plugin inventory to native
// clients. This is a read-only catalog projection; installation and lifecycle
// mutations remain on the governed web control plane.
const v16Operations: readonly NativeOperation[] = [
  ...v15Operations,
  operation(
    "plugins.list",
    "GET",
    "/api/plugins",
    "Read the actor-scoped declarative Plugin catalog and installation state.",
    "bearer",
    undefined,
    "JsonObject",
  ),
];

// Contract v17 gives the native Automation Studio the same truthful read
// inventory and digest-bound declarative Plugin lifecycle as the web control
// plane. Plugin mutations require the ordinary role check, an explicit native
// capability enrollment, and a required Idempotency-Key. They do not create
// credentials, review MCP contracts, or grant tool execution authority.
const pluginMutationHeaders = [
  {
    name: "Idempotency-Key",
    required: true,
    minLength: 1,
    maxLength: 512,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$",
  },
] as const satisfies readonly NativeHeaderParameter[];

const agentTaskCancelHeaders = [
  {
    name: "Idempotency-Key",
    required: true,
    minLength: 1,
    maxLength: 512,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$",
  },
] as const satisfies readonly NativeHeaderParameter[];

const v17Operations: readonly NativeOperation[] = [
  ...v16Operations,
  operation(
    "integrations.overview",
    "GET",
    "/api/integrations/overview",
    "Read the truthful nested account, API, and MCP connection overview.",
    "bearer",
    undefined,
    "JsonObject",
    {
      queryParameters: [
        queryParameter("workspaceId", "string", { minLength: 1, maxLength: 240 }),
      ],
    },
  ),
  operation(
    "plugins.preview",
    "POST",
    "/api/plugins/preview",
    "Create an expiring exact-digest review of one declarative Plugin manifest.",
    "bearer",
    "NativePluginPreviewRequest",
    "JsonObject",
    { headerParameters: pluginMutationHeaders },
  ),
  operation(
    "plugins.install",
    "POST",
    "/api/plugins/install",
    "Install the exact manifest bound to an unexpired actor-private Plugin preview.",
    "bearer",
    "NativePluginInstallRequest",
    "JsonObject",
    { headerParameters: pluginMutationHeaders },
  ),
  operation(
    "plugins.change",
    "PATCH",
    "/api/plugins/{id}",
    "Enable or disable one exact revision of an actor-owned Plugin installation.",
    "bearer",
    "NativePluginChangeRequest",
    "JsonObject",
    { headerParameters: pluginMutationHeaders },
  ),
  operation(
    "plugins.uninstall",
    "DELETE",
    "/api/plugins/{id}",
    "Uninstall one exact revision of an actor-owned Plugin installation.",
    "bearer",
    "NativePluginUninstallRequest",
    "JsonObject",
    { headerParameters: pluginMutationHeaders },
  ),
];

// Contract v18 exposes actor-scoped generated-file inventory and the
// integrity-verified bytes for one exact version. Creation still flows through
// the governed agent loop; these reads grant no new mutation authority.
const v18Operations: readonly NativeOperation[] = [
  ...v17Operations,
  operation(
    "artifacts.list",
    "GET",
    "/api/artifacts",
    "List actor-owned generated files across governed runs.",
    "bearer",
    undefined,
    "JsonObject",
    {
      queryParameters: [
        queryParameter("kind", "string", { minLength: 1, maxLength: 32 }),
        queryParameter("limit", "integer", { minimum: 1, maximum: 100 }),
      ],
    },
  ),
  operation(
    "artifacts.content",
    "GET",
    "/api/artifacts/{id}/content",
    "Download one exact actor-owned generated artifact version.",
    "bearer",
    undefined,
    "JsonObject",
    {
      queryParameters: [
        queryParameter("version", "integer", {
          minimum: 1,
          maximum: 2_147_483_647,
        }),
      ],
      binaryResponse: true,
    },
  ),
];

// Contract v19 enrolls the two existing Agent definition mutations needed by
// the macOS roster and the exact owner-scoped Moltbook connection console.
// It does not enroll Agent deletion, skill mutation, or any generic external
// HTTP authority.
const v19Operations: readonly NativeOperation[] = [
  ...v18Operations,
  operation(
    "agents.create",
    "POST",
    "/api/agents",
    "Create one governed actor-owned Agent definition.",
    "bearer",
    "JsonObject",
    "JsonObject",
  ),
  operation(
    "agents.update",
    "PATCH",
    "/api/agents/{id}",
    "Update one governed actor-owned Agent definition.",
    "bearer",
    "JsonObject",
    "JsonObject",
  ),
  operation(
    "moltbook.connection.show",
    "GET",
    "/api/agents/{id}/moltbook",
    "Read one exact Agent's private Moltbook connection and sanitized activity ledger.",
    "bearer",
    undefined,
    "JsonObject",
    {
      queryParameters: [
        queryParameter("cursor", "string", { minLength: 1, maxLength: 512 }),
        queryParameter("limit", "integer", { minimum: 1, maximum: 100 }),
      ],
    },
  ),
  operation(
    "moltbook.connection.manage",
    "POST",
    "/api/agents/{id}/moltbook",
    "Register, observe, pause, or resume one exact Agent's Moltbook connection.",
    "bearer",
    "JsonObject",
    "JsonObject",
  ),
];

// Contract v20 preserves the v19 operation surface while extending the strict
// conversation envelope with an optional exact Agent identity. Selection does
// not broaden authority: /api/agent still resolves the actor-owned Agent and
// pins its definition, principal, grants, and policy before execution.
const v20Operations: readonly NativeOperation[] = [...v19Operations];

// Contract v21 publishes the canonical, actor-scoped Council read projection
// used by the macOS Agent Control Center. It adds no mutation or delegation
// authority; child control remains exclusively inside governed workflows.
const v21Operations: readonly NativeOperation[] = [
  ...v20Operations,
  operation(
    "agents.council",
    "GET",
    "/api/agents/council",
    "Read recent canonical delegation work, verification, and evidence summaries.",
    "bearer",
    undefined,
    "JsonObject",
    {
      queryParameters: [
        queryParameter("limit", "integer", { minimum: 1, maximum: 100 }),
      ],
    },
  ),
];

// Contract v22 keeps the canonical Council read and enrolls only exact child
// cancellation. The operation is revision-fenced, requires stable
// idempotency, and returns the bounded public execution projection; it grants
// no delegation, execution, or broader Agent mutation authority.
const v22Operations: readonly NativeOperation[] = [
  ...v21Operations,
  operation(
    "agents.tasks.cancel",
    "POST",
    "/api/agents/tasks/{id}/cancel",
    "Cancel one exact active V2 child execution at its expected lifecycle revision.",
    "bearer",
    "NativeAgentTaskCancelRequest",
    "NativeAgentTaskCancelResponse",
    { headerParameters: agentTaskCancelHeaders },
  ),
];

// Contract v23 keeps v22 byte-frozen while extending only the enrolled push
// cause vocabulary with the generic, server-derived Inbox notification target.
// It adds no route or action authority.
const v23Operations: readonly NativeOperation[] = [...v22Operations];

// Contract v24 adds the actor-private persistent prompt queue shared by web,
// macOS, and Android. Queue mutations are revision-fenced, and dispatch still
// enters the ordinary governed conversation operation with no carried
// authority, approval, budget, or tool-policy grant.
const v24Operations: readonly NativeOperation[] = [
  ...v23Operations,
  operation(
    "promptQueue.list",
    "GET",
    "/api/command/prompt-queue",
    "Read the actor-private server-authoritative prompt queue.",
    "bearer",
    undefined,
    "NativePromptQueueList",
  ),
  operation(
    "promptQueue.create",
    "POST",
    "/api/command/prompt-queue",
    "Add one exact Agent, model, target, and prompt intent to the queue.",
    "bearer",
    "NativePromptQueueCreateRequest",
    "NativePromptQueueCreateResponse",
  ),
  operation(
    "promptQueue.update",
    "PATCH",
    "/api/command/prompt-queue/{id}",
    "Edit, pause, or resume one exact prompt queue revision.",
    "bearer",
    "NativePromptQueueUpdateRequest",
    "NativePromptQueueItemResponse",
  ),
  operation(
    "promptQueue.delete",
    "DELETE",
    "/api/command/prompt-queue/{id}",
    "Remove one exact prompt queue revision without granting execution authority.",
    "bearer",
    "NativePromptQueueDeleteRequest",
    "NativePromptQueueDeleteResponse",
  ),
  operation(
    "promptQueue.reorder",
    "POST",
    "/api/command/prompt-queue/reorder",
    "Atomically reorder the complete queued and paused prompt set.",
    "bearer",
    "NativePromptQueueReorderRequest",
    "NativePromptQueueReorderResponse",
  ),
  {
    ...operation(
      "promptQueue.dispatch",
      "POST",
      "/api/command/prompt-queue/{id}/dispatch",
      "Run one exact queue revision through the governed Agent service.",
      "bearer",
      "NativePromptQueueDispatchRequest",
      "NativeConversationEvent",
    ),
    mediaType: "text/event-stream" as const,
  },
];

// Contract v25 adds the actor-private management projections used to inspect
// released Agent definitions, correction-backed adaptations, immutable child
// execution grants, scheduled PolicyLease outcomes, and notification delivery
// decisions. The only new mutations are the existing governed release and
// adaptation lifecycle transitions. Retirement and signed-grant editing are
// deliberately absent from the native product surface.
const v25Operations: readonly NativeOperation[] = [
  ...v24Operations,
  operation(
    "agents.release.show",
    "GET",
    "/api/agents/{id}/release",
    "Read one actor-owned Agent release channel with exact version IDs, digests, and evaluations.",
    "bearer",
    undefined,
    "JsonObject",
  ),
  operation(
    "agents.release.manage",
    "POST",
    "/api/agents/{id}/release",
    "Evaluate, promote, or roll back one exact Agent definition through the governed release lifecycle.",
    "bearer",
    "JsonObject",
    "JsonObject",
  ),
  operation(
    "agents.adaptations.list",
    "GET",
    "/api/agents/{id}/adaptations",
    "Read correction-backed, non-authority adaptations for one actor-owned Agent.",
    "bearer",
    undefined,
    "JsonObject",
  ),
  operation(
    "agents.adaptations.manage",
    "POST",
    "/api/agents/{id}/adaptations",
    "Refresh, evaluate, activate, or roll back one exact non-authority Agent adaptation.",
    "bearer",
    "JsonObject",
    "JsonObject",
  ),
  operation(
    "agents.tasks.show",
    "GET",
    "/api/agents/tasks/{id}",
    "Inspect one actor-owned child task and its immutable native-read, Skill, Plugin, and MCP grant pins.",
    "bearer",
    undefined,
    "JsonObject",
  ),
  operation(
    "automation.schedule.show",
    "GET",
    "/api/triggers/{id}",
    "Read one actor-owned schedule with occurrence receipts and content-free PolicyLease outcomes.",
    "bearer",
    undefined,
    "JsonObject",
  ),
  operation(
    "notifications.dispositions.list",
    "GET",
    "/api/notifications/dispositions",
    "Read content-free send, defer, digest, and suppress decisions for the authenticated actor.",
    "bearer",
    undefined,
    "JsonObject",
    {
      queryParameters: [
        queryParameter("limit", "integer", { minimum: 1, maximum: 200 }),
        queryParameter("before", "string", { minLength: 20, maxLength: 40 }),
      ],
    },
  ),
];

// Contract v26 adds one read-only, content-free Daily learning projection for
// the exact current Agent definition. It carries counts and lifecycle state
// only and grants no behavior, model, tool, context, budget, or mutation
// authority.
const v26Operations: readonly NativeOperation[] = [
  ...v25Operations,
  operation(
    "agents.learning.show",
    "GET",
    "/api/agents/{id}/learning",
    "Read one Agent's content-free Daily learning evidence status for its exact current definition.",
    "bearer",
    undefined,
    "NativeAgentDailyLearningResponse",
  ),
];

// Contract v27 changes only strict schemas carried by the existing local
// computer courier. No endpoint or capability surface is added.
const v27Operations: readonly NativeOperation[] = [...v26Operations];

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
  NativePushReceiptRequest: mobilePushReceiptRequestSchema,
  NativePushReceiptResponse: nativePushReceiptResponseSchema,
  NativePushCanaryRequest: nativePushCanaryRequestSchema,
  NativePushCanaryResponse: nativePushCanaryResponseSchema,
  NativePluginPreviewRequest: nativePluginPreviewRequestSchema,
  NativePluginInstallRequest: nativePluginInstallRequestSchema,
  NativePluginChangeRequest: nativePluginChangeRequestSchema,
  NativePluginUninstallRequest: nativePluginUninstallRequestSchema,
  NativeAgentTaskCancelRequest: nativeAgentTaskCancelRequestSchema,
  NativeAgentTaskCancelResponse: nativeAgentTaskCancelResponseSchema,
  NativeAgentDailyLearningResponse: z.object({
    learning: agentDailyLearningStatusV1Schema,
    serviceReceipt: jsonObject,
  }).strict(),
  NativePromptQueueList: promptQueueListV1Schema,
  NativePromptQueueCreateRequest: promptQueueCreateRequestSchema,
  NativePromptQueueCreateResponse: z.object({
    item: promptQueueItemV1Schema,
    created: z.boolean(),
  }).strict(),
  NativePromptQueueUpdateRequest: promptQueueUpdateRequestSchema,
  NativePromptQueueItemResponse: z.object({
    item: promptQueueItemV1Schema,
  }).strict(),
  NativePromptQueueDeleteRequest: promptQueueDeleteRequestSchema,
  NativePromptQueueDeleteResponse: z.object({
    deleted: z.literal(true),
    id: z.string().uuid(),
  }).strict(),
  NativePromptQueueReorderRequest: promptQueueReorderRequestSchema,
  NativePromptQueueReorderResponse: z.object({
    items: z.array(promptQueueItemV1Schema).max(40),
  }).strict(),
  NativePromptQueueDispatchRequest: promptQueueDispatchRequestSchema,
  NativeConversationRequest: nativeConversationRequestSchema,
  NativeConversationEvent: nativeConversationEventSchema,
  NativeLocalComputerDeviceUpdateRequest: localComputerDeviceUpdateSchema,
  NativeLocalComputerDeviceResponse: nativeLocalComputerDeviceResponseSchema,
  NativeLocalComputerDeviceReadResponse: nativeLocalComputerDeviceReadResponseSchema,
  NativeLocalComputerClaimRequest: localComputerClaimRequestSchema,
  NativeLocalComputerClaimResponse: nativeLocalComputerClaimResponseSchema,
  NativeLocalComputerCompletionRequest: localComputerCompletionRequestSchema,
  NativeLocalComputerCompletionResponse: nativeLocalComputerCompletionResponseSchema,
  NativeLocalComputerStopRequest: localComputerStopRequestSchema,
  NativeLocalComputerStopResponse: nativeLocalComputerStopResponseSchema,
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
  if (version === 7) return v7Operations;
  if (version === 8) return v8Operations;
  if (version === 9) return v9Operations;
  if (version === 10) return v10Operations;
  if (version === 11) return v11Operations;
  if (version === 12) return v12Operations;
  if (version === 13) return v13Operations;
  if (version === 14) return v14Operations;
  if (version === 15) return v15Operations;
  if (version === 16) return v16Operations;
  if (version === 17) return v17Operations;
  if (version === 18) return v18Operations;
  if (version === 19) return v19Operations;
  if (version === 20) return v20Operations;
  if (version === 21) return v21Operations;
  if (version === 22) return v22Operations;
  if (version === 23) return v23Operations;
  if (version === 24) return v24Operations;
  if (version === 25) return v25Operations;
  if (version === 26) return v26Operations;
  if (version === 27) return v27Operations;
  return undefined;
}

export function nativeContractDiscovery() {
  return {
    schemaVersion: 1 as const,
    contractId: NATIVE_API_CONTRACT_ID,
    currentVersion: NATIVE_API_CURRENT_VERSION,
    previousVersion: NATIVE_API_PREVIOUS_VERSION,
    supportedVersions: [...NATIVE_API_SUPPORTED_VERSIONS] as [27, 26],
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

function omitLocalComputerPreviewBinding(
  command: z.infer<typeof localComputerCommandSchema>,
) {
  const {
    runId: _runId,
    executionId: _executionId,
    presentScreenshot: _presentScreenshot,
    ...legacyCommand
  } = command;
  return legacyCommand;
}

function operation(
  id: string,
  method: NativeOperation["method"],
  path: string,
  summary: string,
  auth: NativeOperation["auth"],
  requestSchema: string | undefined,
  responseSchema: string,
  options: Pick<NativeOperation, "queryParameters" | "headerParameters" | "binaryResponse"> = {},
): NativeOperation {
  return {
    id,
    method,
    path,
    summary,
    auth,
    requestSchema,
    responseSchema,
    ...options,
  };
}

function queryParameter(
  name: string,
  type: NativeQueryParameter["type"],
  constraints: Omit<NativeQueryParameter, "name" | "type"> = {},
): NativeQueryParameter {
  return { name, type, ...constraints };
}
