import { z } from "zod";
import { contentSearchResponseSchema } from "@/lib/content-search/contracts";
import { COMPANION_PREFERENCES_CONTRACT, companionChangeSchema, companionPreferencesSchema, companionThreadIdSchema } from "@/lib/companion/contracts";
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
import { commandModelSelectionRequestSchema } from "@/lib/models/command-selection";
import { commandContextReferencesSchema } from "@/lib/command/composer-context-contract";
import { REALTIME_PROVIDER_ERROR_CODE_PATTERN } from "@/lib/voice/realtime-error";
import { COMMAND_REASONING_LEVELS } from "@/lib/models/reasoning-effort";
import {
  LOCAL_COMPUTER_PROTOCOL_VERSION,
  LOCAL_COMPUTER_TASK_AUTHORITY_CONTRACT_VERSION,
  localComputerActionSchema,
  localComputerClaimRequestSchema,
  localComputerCommandSchema,
  localComputerCommandRunnerSchema,
  localComputerCompletionRequestSchema,
  localComputerDeviceUpdateSchema,
  localComputerStopRequestSchema,
} from "@/lib/local-computer/contracts";
import { mobilePushReceiptRequestSchema } from "@/lib/mobile/push-contract";
import { nativeResponsibilityContractSchemas } from "@/lib/mobile/responsibility-contracts";
import { nativeMeetingContractSchemas } from "@/lib/mobile/meeting-contracts";
import { nativeCustomerContractSchemas } from "@/lib/mobile/customer-contracts";
import { nativeCustomerDetailContractSchemas } from "@/lib/mobile/customer-detail-contracts";
import { nativeCustomerMutationContractSchemas } from "@/lib/mobile/customer-mutation-contracts";
import { nativeCustomerHealthMutationSchemas } from "@/lib/mobile/customer-health-mutation-contracts";
import { nativeCustomerWorkflowMutationSchemas } from "@/lib/mobile/customer-workflow-mutation-contracts";
import { nativeAgentSkillMutationSchemas } from "@/lib/mobile/agent-skill-mutation-contracts";
import { nativeMeetingRecordingSchemas } from "@/lib/mobile/meeting-recording-contracts";
import { nativeCustomerFactMutationSchemas } from "@/lib/mobile/customer-fact-mutation-contracts";
import { nativeSalesforceActionSchemas } from "@/lib/mobile/salesforce-native-contracts";
import { nativeKnowledgeCognificationSchemas } from "@/lib/mobile/knowledge-cognification-contracts";
import { nativeKnowledgeSourceDeletionSchemas } from "@/lib/mobile/knowledge-source-deletion-contracts";
import { nativeMemoryGraphReadSchemas } from "@/lib/mobile/memory-graph-read-contracts";
import { nativeMemoryMaintenanceSchemas, nativeMemoryGraphRebuildSchemas } from "@/lib/mobile/memory-deterministic-contracts";
import { nativeKnowledgeCognitionBuildSchemas } from "@/lib/mobile/knowledge-cognition-build-contracts";
import { entityRelationTypeIdSchema } from "@/lib/entities/ontology";
import { relationEpistemicKindSchema } from "@/lib/entities/temporal-claims";
import { nativeLibraryContractSchemas, nativeLibraryListQueryMetadata } from "@/lib/mobile/library-contracts";
import { nativeLibraryHistoryContractSchemas } from "@/lib/mobile/library-history-contracts";
import { entityOptionsContractSchemas, entityOptionsQueryMetadata } from "@/lib/entities/options-contracts";
import { nativeMarketReadContractSchemas } from "@/lib/mobile/market-contracts";
import { nativeMemoryMutationSchemas } from "@/lib/mobile/memory-mutation-contracts";
import { nativeMemoryReconciliationSchemas } from "@/lib/mobile/memory-reconciliation-contracts";
import { nativeMemoryPromotionSchemas } from "@/lib/mobile/memory-promotion-contracts";
import { nativePersonalContextConsentSchemas } from "@/lib/mobile/personal-context-consent-contracts";
import { nativeMeetingCalendarSchemas } from "@/lib/mobile/meeting-calendar-contracts";
import { nativeGooglePersonalSchemas } from "@/lib/mobile/google-personal-native-contracts";
import { nativeConnectorSchemas } from "@/lib/mobile/connector-native-contracts";
import { nativeConnectorCredentialRemovalSchemas } from "@/lib/mobile/connector-credential-removal-contracts";
import { nativeConnectorTrashSchemas } from "@/lib/mobile/connector-trash-contracts";
import { nativeConnectorCredentialRotationSchemas } from "@/lib/mobile/connector-credential-rotation-contracts";
import { nativeConnectorMcpRegistrationSchemas } from "@/lib/mobile/connector-mcp-registration-contracts";
import { nativeConnectorOpenapiImportSchemas } from "@/lib/mobile/connector-openapi-import-contracts";

import { pluginManifestSchema } from "@/lib/plugins/contracts";
import {
  MODEL_ASSIGNMENT_SCOPES,
  MODEL_PROVIDERS,
} from "@/lib/settings/types";
import { voiceCommandInputSchema } from "@/lib/voice/command-input";

export const NATIVE_API_CONTRACT_ID = "asael.native-api" as const;
export const NATIVE_API_CURRENT_VERSION = 45 as const;
// v43/v44 remain byte-frozen. v45 adds only bounded new OpenAPI import,
// exact preparation/action recovery and terminal staging abandonment.
export const NATIVE_API_PREVIOUS_VERSION = 44 as const;
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
const nativeVoiceLanguageSchema = z.string().trim().toLowerCase().regex(/^[a-z]{2}$/);
const nativeVoiceAudioRetentionSchema = z.literal("not_stored_by_asael");
const nativeVoiceTranscriptRetentionSchema = z.literal("command_draft_until_sent");
const nativeVoiceProfileVersionSchema = z.literal("asael-voice:1");
const nativeVoiceOpaqueTokenSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);

export const nativeRealtimeVoiceSessionStartRequestSchema = z.object({
  sessionId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  mode: z.enum(["orchestrate", "research", "execute", "learn"])
    .default("orchestrate"),
  language: nativeVoiceLanguageSchema.optional(),
  providerConsent: z.literal(true),
  audioRetention: nativeVoiceAudioRetentionSchema,
  reconnectAttempt: z.number().int().min(0).max(3).default(0),
}).strict().superRefine((value, context) => {
  if (value.reconnectAttempt > 0 && (!value.sessionId || !value.conversationId)) {
    context.addIssue({
      code: "custom",
      message: "Reconnects require the existing session and conversation.",
      path: ["sessionId"],
    });
  }
});

export const nativeRealtimeVoiceSessionStartResponseSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
  conversationId: z.string().uuid(),
  clientSecret: z.string().min(4).max(4_096).regex(/^ek_[A-Za-z0-9._:-]+$/),
  clientSecretExpiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  transportUrl: z.literal("https://api.openai.com/v1/realtime/calls"),
  provider: z.literal("openai"),
  model: z.string().trim().min(1).max(240),
  language: z.union([z.literal("auto"), nativeVoiceLanguageSchema]),
  turnDetection: z.literal("server_vad"),
  audioRetention: nativeVoiceAudioRetentionSchema,
  transcriptRetention: nativeVoiceTranscriptRetentionSchema,
  reconnectAttempt: z.number().int().min(0).max(3),
}).strict();

export const nativeRealtimeVoiceSessionFinishRequestSchema = z.object({
  sessionId: z.string().uuid(),
  conversationId: z.string().uuid(),
  outcome: z.enum(["sent", "canceled", "failed"]),
  durationMilliseconds: z.number().int().min(0).max(10 * 60 * 1_000),
  turnCount: z.number().int().min(0).max(1_000),
  reconnectCount: z.number().int().min(0).max(3),
  transcriptCharacters: z.number().int().min(0).max(100_000),
  confidenceBand: z.enum(["high", "low", "unavailable", "edited"]),
  confidenceMean: z.number().min(0).max(1).optional(),
  confidenceMinimum: z.number().min(0).max(1).optional(),
  confidenceSampleCount: z.number().int().min(0).max(10_000),
  reviewRequired: z.boolean(),
  reviewAttested: z.boolean(),
  providerErrorCode: z.string().regex(REALTIME_PROVIDER_ERROR_CODE_PATTERN).optional(),
}).strict().superRefine((value, context) => {
  if (value.outcome === "sent" && !value.reviewAttested) {
    context.addIssue({
      code: "custom",
      message: "Sent voice commands require a review attestation.",
      path: ["reviewAttested"],
    });
  }
  if (
    value.confidenceBand === "high" &&
    (value.confidenceMean === undefined ||
      value.confidenceMinimum === undefined ||
      value.confidenceSampleCount < 1)
  ) {
    context.addIssue({
      code: "custom",
      message: "High-confidence completion metadata is incomplete.",
      path: ["confidenceBand"],
    });
  }
});

export const nativeRealtimeVoiceSessionFinishResponseSchema = z.object({
  recorded: z.literal(true),
}).strict();

export const nativeSpeechStreamRequestSchema = z.object({
  text: z.string().trim().min(1).max(4_000),
  agentId: nativeVoiceOpaqueTokenSchema.optional(),
  threadId: z.string().uuid().optional(),
  runId: nativeVoiceOpaqueTokenSchema.optional(),
  voiceProfileVersion: nativeVoiceProfileVersionSchema,
  audioRetention: nativeVoiceAudioRetentionSchema,
}).strict();

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
  modelSelection: commandModelSelectionRequestSchema.optional(),
  /** v34: existing server-resolved source references; never inline source content. */
  contextReferences: commandContextReferencesSchema.optional(),
  projectId: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
  requestId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  /** v30: the reviewed realtime voice declaration for this command. */
  voiceInput: voiceCommandInputSchema.optional(),
}).strict().refine(
  (value) => !value.voiceInput || value.threadId === value.voiceInput.conversationId,
  {
    message: "The voice review must be bound to its conversation.",
    path: ["voiceInput", "conversationId"],
  },
);

const nativeModelCatalogEntrySchema = z.object({
  id: opaqueId,
  tenantId: opaqueId,
  actorId: z.string().trim().min(1).max(320),
  provider: z.enum(MODEL_PROVIDERS),
  modelId: z.string().trim().min(1).max(240),
  displayName: z.string().trim().min(1).max(240),
  capabilities: z.array(z.string().trim().min(1).max(120)).max(64),
  lifecycle: z.enum(["available", "deprecated", "retiring", "unknown"]),
  lifecycleReason: z.string().trim().min(1).max(1_000).optional(),
  lifecycleCheckedAt: isoDateTime.optional(),
  discoveredAt: isoDateTime,
  updatedAt: isoDateTime,
  displayModelId: z.string().trim().min(1).max(240),
  selectable: z.boolean(),
}).strict();

const nativeCommandReasoningOptionSchema = z.object({
  id: z.enum(COMMAND_REASONING_LEVELS),
  label: z.enum(["Low", "Medium", "High", "Extra high", "Ultra"]),
  nativeEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]),
}).strict();

const nativeCommandModelChoiceSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  assignmentId: z.string().trim().min(1).max(240),
  assignmentRevision: positiveDatabaseInteger,
  assignmentConfigurationSha256: sha256Digest,
  route: z.enum(["primary", "fallback"]),
  provider: z.enum(["openai", "google", "anthropic", "aws_bedrock"]),
  modelId: z.string().trim().min(1).max(240),
  displayName: z.string().trim().min(1).max(240),
  displayModelId: z.string().trim().min(1).max(240),
  reasoningOptions: z.array(nativeCommandReasoningOptionSchema).max(5),
}).strict();

export const nativeCommandModelCatalogResponseSchema = z.object({
  models: z.array(nativeModelCatalogEntrySchema).max(1_000),
  command: z.object({
    schemaVersion: z.literal(1),
    scope: z.enum(MODEL_ASSIGNMENT_SCOPES),
    defaultChoiceId: z.string().regex(/^[a-f0-9]{24}$/).nullable(),
    choices: z.array(nativeCommandModelChoiceSchema).max(2),
    message: z.string().trim().min(1).max(1_000),
  }).strict(),
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
  if (
    current.command?.authority !== undefined &&
    clientContractVersion < LOCAL_COMPUTER_TASK_AUTHORITY_CONTRACT_VERSION
  ) {
    // Removing the marker would send the action without the target check it
    // depends on, so an older client never receives it.
    throw new Error(
      "A task-authorized local computer command requires a newer native client.",
    );
  }
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
  z.object({
    type: z.literal("model"),
    model: z.string().trim().min(1).max(240),
    provider: z.enum(["openai", "google", "anthropic", "aws_bedrock", "local"])
      .describe("The provider that completed this model attempt."),
    tier: z.enum(["fast", "reasoning"]),
    inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    totalTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
      .describe("The provider-reported total token count for this attempt."),
    latencyMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
      .describe("End-to-end model attempt latency in milliseconds."),
    reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"])
      .optional()
      .describe("The effective provider-native reasoning effort after server validation."),
    commandSelectionSha256: sha256Digest.optional()
      .describe("The digest of the exact server-revalidated Command model selection."),
  }).passthrough(),
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
  responseSchema?: string;
  mediaType?: "application/json" | "text/event-stream" | "multipart/form-data";
  responseMediaType?: "application/json" | "text/event-stream" | "audio/pcm";
  responseHeaders?: readonly NativeResponseHeader[];
  successStatuses?: readonly (200 | 201 | 202)[];
  errorStatuses?: readonly (400 | 401 | 403 | 404 | 409 | 413 | 415 | 428 | 500 | 503)[];
  errorResponseSchema?: string;
  pathParameters?: readonly NativePathParameter[];
  queryParameters?: readonly NativeQueryParameter[];
  queryPolicy?: "exact";
  requestBodyMaxBytes?: number;
  headerParameters?: readonly NativeHeaderParameter[];
  binaryResponse?: boolean;
}>;

export type NativeResponseHeader = Readonly<{
  name: string;
  description: string;
  constValue?: string;
  pattern?: string;
}>;

export type NativeQueryParameter = Readonly<{
  name: string;
  type: "string" | "integer" | "flag";
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  enumValues?: readonly string[];
  defaultValue?: string | number;
  description?: string;
}>;

export type NativePathParameter = Readonly<{
  name: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
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
// capability, so v8 stops advertising them without granting any new mutation
// authority.
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
// the source-current native surface. New clients receive screenshots
// exclusively through the private, short-lived This Mac preview channel.
const v14Operations: readonly NativeOperation[] = v13Operations.filter(
  (operation) => operation.id !== "evidence.run.computerFrame",
);

// Contract v15 adds first-class app receipt evidence and the live push canary.
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

// Contract v23 extends only the enrolled push cause vocabulary with the
// generic, server-derived Inbox notification target.
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

// Contract v28 publishes the strict, revision-bound Command model selection
// and the read-only catalog required to construct it. The catalog grants no
// model authority: /api/agent still revalidates the exact assignment revision,
// configuration digest, provider, model, and supported reasoning effort.
const v28Operations: readonly NativeOperation[] = [
  ...v27Operations,
  operation(
    "settings.models.commandCatalog",
    "GET",
    "/api/settings/models",
    "Read the bounded Command model catalog for one exact Settings assignment scope.",
    "bearer",
    undefined,
    "NativeCommandModelCatalogResponse",
    {
      queryParameters: [
        queryParameter("commandScope", "string", {
          required: true,
          minLength: 1,
          maxLength: 80,
          enumValues: MODEL_ASSIGNMENT_SCOPES,
        }),
      ],
    },
  ),
];

// Contract v29 exposes the existing authenticated realtime transcription and
// versioned speech services to native clients. Audio remains ephemeral, voice
// completion receipts remain content-free, and command execution continues
// through the existing governed conversation and visible approval boundaries.
const v29Operations: readonly NativeOperation[] = [
  ...v28Operations,
  operation(
    "voice.realtime.session.start",
    "POST",
    "/api/voice/realtime/session",
    "Create or reconnect one actor-owned ephemeral realtime transcription session.",
    "bearer",
    "NativeRealtimeVoiceSessionStartRequest",
    "NativeRealtimeVoiceSessionStartResponse",
  ),
  operation(
    "voice.realtime.session.finish",
    "PATCH",
    "/api/voice/realtime/session",
    "Record bounded content-free review and confidence metadata for one voice session.",
    "bearer",
    "NativeRealtimeVoiceSessionFinishRequest",
    "NativeRealtimeVoiceSessionFinishResponse",
  ),
  operation(
    "voice.speech.stream",
    "POST",
    "/api/media/speech",
    "Stream an actor-scoped Agent reply under the pinned Asael voice profile without retaining audio.",
    "bearer",
    "NativeSpeechStreamRequest",
    undefined,
    {
      responseMediaType: "audio/pcm",
      responseHeaders: [
        {
          name: "x-asael-audio-retention",
          description: "Asael does not retain generated speech audio.",
          constValue: "not_stored_by_asael",
        },
        {
          name: "x-asael-audio-encoding",
          description: "PCM sample encoding.",
          constValue: "pcm_s16le",
        },
        {
          name: "x-asael-audio-sample-rate",
          description: "PCM sample rate in hertz.",
          constValue: "24000",
        },
        {
          name: "x-asael-voice-profile",
          description: "Pinned Asael voice profile version.",
          constValue: "asael-voice:1",
        },
        {
          name: "x-asael-voice-profile-sha256",
          description: "Digest of the exact resolved Agent voice profile.",
          pattern: "^[a-f0-9]{64}$",
        },
      ],
    },
  ),
];

// Contract v30 changes only the strict local computer command carried by the
// existing courier: a command that runs on This Mac task authority alone says
// so, and the helper checks its real target. No endpoint or capability
// surface is added.
const v30Operations: readonly NativeOperation[] = [...v29Operations];

const companionOwnerHeaders = [{
  name: "x-asael-companion-owner-sha256", required: true,
  minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$",
}] as const satisfies readonly NativeHeaderParameter[];

const v31Operations: readonly NativeOperation[] = [
  ...v30Operations,
  operation("companion.preferences.get", "GET", "/api/companion/preferences",
    "Read presentation preferences for the authenticated owner bound by the request digest.",
    "bearer", undefined, "NativeCompanionPreferencesResponse", { headerParameters: companionOwnerHeaders }),
  operation("companion.preferences.update", "PATCH", "/api/companion/preferences",
    "Save or reset the exact owner's presentation preferences with a revision and replayable receipt; grants no execution authority.",
    "bearer", "NativeCompanionPreferencesRequest", "NativeCompanionPreferencesResponse",
    { headerParameters: [...companionOwnerHeaders, ...pluginMutationHeaders] }),
];

const responsibilityReadOptions = {
  queryPolicy: "exact",
  errorResponseSchema: "NativeResponsibilityErrorResponse",
  errorStatuses: [400, 401, 403, 409, 503],
  responseHeaders: [{ name: "cache-control", description: "Private owner-scoped response; never stored.", constValue: "private, no-store" }],
} as const satisfies Partial<NativeOperation>;
const responsibilityDetailOptions = {
  ...responsibilityReadOptions,
  pathParameters: [{ name: "id", minLength: 79, maxLength: 79, pattern: "^responsibility:[a-f0-9]{64}$" }],
  errorStatuses: [400, 401, 403, 404, 409, 503],
} as const satisfies Partial<NativeOperation>;
const responsibilityMutationOptions = {
  ...responsibilityDetailOptions,
  headerParameters: pluginMutationHeaders,
  errorStatuses: [400, 401, 403, 404, 409, 413, 415, 503],
} as const satisfies Partial<NativeOperation>;

// These are the existing exact-owner web routes. A draft review grants no
// execution or delivery authority; both admissions remain explicit controls.
const v32Operations: readonly NativeOperation[] = [
  ...v31Operations,
  operation("responsibilities.list", "GET", "/api/responsibilities",
    "Read a bounded recent list of the authenticated owner's Responsibility drafts.", "bearer", undefined, "NativeResponsibilityListResponse",
    { ...responsibilityReadOptions, queryParameters: [queryParameter("limit", "integer", { minimum: 1, maximum: 100, defaultValue: 40,
      description: "Canonical decimal integer from 1 through 100; duplicate and unknown query parameters are rejected." })] }),
  operation("responsibilities.create", "POST", "/api/responsibilities",
    "Create an inactive owner-bound draft with a durable replay receipt; does not activate checks or notifications.",
    "bearer", "NativeResponsibilityCreateRequest", "NativeResponsibilityMutationResponse",
    { ...responsibilityReadOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 32_768,
      successStatuses: [201, 200], errorStatuses: [400, 401, 403, 409, 413, 415, 503] }),
  operation("responsibilities.get", "GET", "/api/responsibilities/{id}",
    "Read an exact owned draft, optionally checking its non-activating review pins.", "bearer", undefined, "NativeResponsibilityReadResponse",
    { ...responsibilityDetailOptions, queryParameters: [queryParameter("view", "string", { enumValues: ["review"] })] }),
  operation("responsibilities.change", "PATCH", "/api/responsibilities/{id}",
    "Update or review the exact draft revision and digests without activating execution or delivery.",
    "bearer", "NativeResponsibilityChangeRequest", "NativeResponsibilityMutationResponse",
    { ...responsibilityMutationOptions, requestBodyMaxBytes: 32_768 }),
  operation("responsibilities.references", "GET", "/api/responsibilities/references",
    "Read bounded authorized source, Work, procedure and Agent options; unavailable groups stay explicit and no authority is provisioned.",
    "bearer", undefined, "NativeResponsibilityReferencesResponse", responsibilityReadOptions),
  operation("responsibilities.lifecycle.get", "GET", "/api/responsibilities/{id}/lifecycle",
    "Read the finite Meeting pilot's current lifecycle and bounded history, optionally previewing exact activation pins without activating.",
    "bearer", undefined, "NativeResponsibilityLifecycleReadResponse",
    { ...responsibilityDetailOptions, queryParameters: [queryParameter("view", "string", { enumValues: ["activation"] })] }),
  operation("responsibilities.lifecycle.change", "POST", "/api/responsibilities/{id}/lifecycle",
    "Explicitly activate, pause, resume or end the reviewed read-only Meeting pilot using exact revision, generation and replay identity.",
    "bearer", "NativeResponsibilityLifecycleRequest", "NativeResponsibilityLifecycleMutationResponse",
    { ...responsibilityMutationOptions, requestBodyMaxBytes: 4096 }),
  operation("responsibilities.observations.list", "GET", "/api/responsibilities/{id}/observations",
    "Read bounded authoritative observation receipts and the accepted baseline; clients cannot submit evidence or advance it.",
    "bearer", undefined, "NativeResponsibilityObservationsResponse",
    { ...responsibilityDetailOptions, queryParameters: [queryParameter("limit", "integer", { minimum: 1, maximum: 100, defaultValue: 25,
      description: "Canonical decimal integer from 1 through 100; duplicate and unknown query parameters are rejected." })] }),
  operation("responsibilities.notifications.get", "GET", "/api/responsibilities/{id}/notifications",
    "Read the separate inbox admission and bounded candidate/delivery history, optionally previewing a non-activating enable request.",
    "bearer", undefined, "NativeResponsibilityNotificationsReadResponse",
    { ...responsibilityDetailOptions, queryParameters: [queryParameter("view", "string", { enumValues: ["enable"] })] }),
  operation("responsibilities.notifications.change", "POST", "/api/responsibilities/{id}/notifications",
    "Explicitly enable a reviewed finite owner-inbox admission or permanently stop it; never sends push, email or browser notifications.",
    "bearer", "NativeResponsibilityNotificationControlRequest", "NativeResponsibilityNotificationsMutationResponse",
    { ...responsibilityMutationOptions, requestBodyMaxBytes: 4096 }),
];

const meetingReadOptions = {
  errorResponseSchema: "NativeMeetingErrorResponse",
  errorStatuses: [400, 401, 403, 404, 409, 503],
  responseHeaders: [{ name: "cache-control", description: "Private scoped response; never stored.", constValue: "private, no-store" }],
} as const satisfies Partial<NativeOperation>;
const meetingDetailOptions = {
  ...meetingReadOptions,
  pathParameters: [{ name: "id", minLength: 44, maxLength: 44,
    pattern: "^meeting:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }],
} as const satisfies Partial<NativeOperation>;
const meetingMutationOptions = {
  ...meetingDetailOptions,
  headerParameters: pluginMutationHeaders,
  errorStatuses: [400, 401, 403, 404, 409, 413, 415, 503],
} as const satisfies Partial<NativeOperation>;
const meetingWorkspaceQuery = [queryParameter("workspaceId", "string", { minLength: 1, maxLength: 240 })];

// The existing Meeting routes remain authoritative. The published read queries
// describe supported fields; these legacy routes do not reject unknown or
// repeated fields. Recording completion and Calendar sync remain unenrolled.
const v33Operations: readonly NativeOperation[] = [
  ...v32Operations.filter(({ id }) => id !== "meetings.list" && id !== "meetings.get"),
  operation("meetings.list", "GET", "/api/meetings",
    "Read up to 200 authorized Meeting revisions in the selected workspace.", "bearer", undefined, "NativeMeetingListResponse",
    { ...meetingReadOptions, queryParameters: [...meetingWorkspaceQuery,
      queryParameter("status", "string", { enumValues: ["scheduled", "in_progress", "completed", "cancelled"] }),
      queryParameter("limit", "integer", { minimum: 1, maximum: 200, defaultValue: 100 })] }),
  operation("meetings.get", "GET", "/api/meetings/{id}",
    "Read one authorized Meeting revision with exact source availability and consent evidence.", "bearer", undefined, "NativeMeetingReadResponse",
    { ...meetingDetailOptions, queryParameters: meetingWorkspaceQuery }),
  operation("meetings.create", "POST", "/api/meetings",
    "Create a scoped Meeting with a stable replay identity; grants no recording or external delivery authority.",
    "bearer", "NativeMeetingCreateRequest", "NativeMeetingCreateResponse",
    { ...meetingReadOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 250_000,
      successStatuses: [201], errorStatuses: [400, 401, 403, 404, 409, 413, 415, 503] }),
  operation("meetings.update", "PATCH", "/api/meetings/{id}",
    "Revise the exact scoped Meeting with its expected revision and replay identity.",
    "bearer", "NativeMeetingUpdateRequest", "NativeMeetingUpdateResponse",
    { ...meetingMutationOptions, requestBodyMaxBytes: 250_000 }),
  operation("meetings.commitments.list", "GET", "/api/meetings/{id}/commitments",
    "Read bounded exact proposals, accepted decisions and immutable partial progress without retry authority.",
    "bearer", undefined, "NativeMeetingCommitmentsResponse",
    { ...meetingDetailOptions, queryParameters: meetingWorkspaceQuery }),
  operation("meetings.commitments.propose", "POST", "/api/meetings/{id}/commitments",
    "Propose one exact media action for explicit owner review without creating Work or sending a message.",
    "bearer", "NativeMeetingCommitmentProposeRequest", "NativeMeetingCommitmentProposeResponse",
    { ...meetingMutationOptions, requestBodyMaxBytes: 50_000, successStatuses: [201] }),
  operation("meetings.commitments.resolve", "PATCH", "/api/meetings/{id}/commitments",
    "Admit one exact reviewed decision; partial progress remains inspectable and cannot authorize automatic retry.",
    "bearer", "NativeMeetingCommitmentResolveRequest", "NativeMeetingCommitmentResolveResponse",
    { ...meetingMutationOptions, requestBodyMaxBytes: 100_000 }),
];

const privateReadOptions = {
  errorStatuses: [400, 401, 403, 404, 409, 503],
  responseHeaders: [{ name: "cache-control", description: "Private scoped response; never stored.", constValue: "private, no-store" }],
} as const satisfies Partial<NativeOperation>;
const customerWorkspaceQuery = [queryParameter("workspaceId", "string", { minLength: 1, maxLength: 240 })];
const customerDetailOptions = {
  ...privateReadOptions,
  pathParameters: [{ name: "id", minLength: 81, maxLength: 81, pattern: "^customer-account:[a-f0-9]{64}$" }],
} as const satisfies Partial<NativeOperation>;
const marketInstrumentQuery = queryParameter("instrumentId", "string", { required: true, minLength: 3, maxLength: 120 });
const marketIntervalQuery = queryParameter("interval", "string", { required: true, enumValues: ["5min", "15min", "1h"] });
const libraryPath = { name: "id", minLength: 1, maxLength: 320,
  pattern: "^library:(capture_asset|capture_recording|capture_transcript|project_artifact|source_item):.+$" } as const;
const historyHeadQuery = queryParameter("currentVersionId", "string", { minLength: 1, maxLength: 320 });
const memoryMutationOptions = {
  ...privateReadOptions, headerParameters: pluginMutationHeaders,
  errorStatuses: [400, 401, 403, 404, 409, 413, 415, 503],
  errorResponseSchema: "NativeMemoryMutationError",
  pathParameters: [{ name: "id", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$" }],
} as const satisfies Partial<NativeOperation>;
const typedMarketReadSchemas: Readonly<Record<string, string>> = {
  "market.overview": "NativeMarketOverviewResponse", "market.features": "NativeMarketFeaturesResponse",
  "market.events": "NativeMarketEventsResponse", "market.replays": "NativeMarketReplaysResponse",
  "market.baselines": "NativeMarketBaselinesResponse", "market.backtests": "NativeMarketBacktestsResponse",
  "market.journal": "NativeMarketJournalResponse",
};
const typedMarketQueries: Readonly<Record<string, readonly NativeQueryParameter[]>> = {
  "market.features": [queryParameter("snapshotId", "string", { required: true, minLength: 64, maxLength: 64 })],
  "market.events": [queryParameter("limit", "integer", { minimum: 1, maximum: 500, defaultValue: 100 })],
  "market.replays": [marketInstrumentQuery, queryParameter("limit", "integer", { minimum: 1, maximum: 500, defaultValue: 100 })],
  "market.baselines": [marketInstrumentQuery, queryParameter("minimumSampleSize", "integer", { minimum: 5, maximum: 100, defaultValue: 20 })],
  "market.backtests": [marketInstrumentQuery, queryParameter("limit", "integer", { minimum: 1, maximum: 100, defaultValue: 20 })],
  "market.journal": [marketInstrumentQuery, queryParameter("limit", "integer", { minimum: 1, maximum: 100, defaultValue: 40 })],
};
const v34Operations: readonly NativeOperation[] = [
  ...v33Operations.filter(({ id }) => !["customers.list", "customers.get", "customers.portfolio", "market.analysis"].includes(id))
    .map((candidate) => typedMarketReadSchemas[candidate.id] ? {
      ...candidate, ...privateReadOptions, responseSchema: typedMarketReadSchemas[candidate.id],
      ...(typedMarketQueries[candidate.id] ? { queryParameters: typedMarketQueries[candidate.id] } : {}),
    } : candidate),
  operation("customers.list", "GET", "/api/customer-accounts", "Read a bounded authorized Account portfolio.", "bearer", undefined, "NativeCustomerListResponse",
    { ...privateReadOptions, queryParameters: [...customerWorkspaceQuery, queryParameter("lifecycle", "string", { enumValues: ["prospect", "onboarding", "active", "at_risk", "churned", "archived"] }), queryParameter("limit", "integer", { minimum: 1, maximum: 200, defaultValue: 100 })] }),
  operation("customers.get", "GET", "/api/customer-accounts/{id}", "Read exact account facts, conflicts and source evidence with bounded fact coverage.", "bearer", undefined, "NativeCustomerReadResponse",
    { ...customerDetailOptions, queryParameters: customerWorkspaceQuery }),
  operation("customers.portfolio", "GET", "/api/customer-accounts/portfolio", "Read health and risk intelligence for the bounded authorized portfolio.", "bearer", undefined, "NativeCustomerPortfolioResponse",
    { ...privateReadOptions, queryParameters: [...customerWorkspaceQuery, queryParameter("limit", "integer", { minimum: 1, maximum: 200, defaultValue: 100 })] }),
  operation("customers.health", "GET", "/api/customer-accounts/{id}/health", "Read bounded health history and its evidence.", "bearer", undefined, "NativeCustomerHealthResponse",
    { ...customerDetailOptions, queryParameters: [...customerWorkspaceQuery, queryParameter("historyLimit", "integer", { minimum: 1, maximum: 100, defaultValue: 20 })] }),
  operation("customers.intelligence", "GET", "/api/customer-accounts/{id}/intelligence", "Read bounded Account intelligence and timeline evidence.", "bearer", undefined, "NativeCustomerIntelligenceResponse",
    { ...customerDetailOptions, queryParameters: [...customerWorkspaceQuery, queryParameter("historyLimit", "integer", { minimum: 1, maximum: 250, defaultValue: 100 }), queryParameter("timelineLimit", "integer", { minimum: 1, maximum: 250, defaultValue: 100 })] }),
  operation("customers.workflows", "GET", "/api/customer-accounts/{id}/workflows", "Read bounded exact Account workflow history.", "bearer", undefined, "NativeCustomerWorkflowsResponse",
    { ...customerDetailOptions, queryParameters: [...customerWorkspaceQuery, queryParameter("limit", "integer", { minimum: 1, maximum: 100, defaultValue: 50 })] }),
  operation("customers.salesforce.status", "GET", "/api/customer-accounts/salesforce", "Read CRM connection and reviewed write status; grants no OAuth or provider write authority.", "bearer", undefined, "NativeCustomerSalesforceStatusResponse",
    { ...privateReadOptions, queryParameters: customerWorkspaceQuery }),
  operation("customers.create", "POST", "/api/customer-accounts", "Create one exact Account intent with durable acceptance and no external CRM write.", "bearer", "NativeCustomerCreateRequest", "NativeCustomerCreateResponse",
    { ...privateReadOptions, errorStatuses: [400, 401, 403, 404, 409, 413, 415, 503], headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 250_000, successStatuses: [201] }),
  operation("customers.update", "PATCH", "/api/customer-accounts/{id}", "Revise the exact Account intent and replay its original immutable acceptance.", "bearer", "NativeCustomerReviseRequest", "NativeCustomerReviseResponse",
    { ...customerDetailOptions, errorStatuses: [400, 401, 403, 404, 409, 413, 415, 503], headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 250_000 }),
  operation("library.list", "GET", "/api/library", "Read a bounded authorized page of current Library sources.", "bearer", undefined, "NativeLibraryListResponse",
    { ...privateReadOptions, queryParameters: nativeLibraryListQueryMetadata }),
  operation("library.get", "GET", "/api/library/{id}", "Resolve the exact current Library source and available citations.", "bearer", undefined, "NativeLibraryReadResponse",
    { ...privateReadOptions, pathParameters: [libraryPath] }),
  operation("library.versions.list", "GET", "/api/library/{id}/versions", "Read retained version metadata with current access and an exact current-head continuation pin.", "bearer", undefined, "NativeLibraryHistoryListResponse",
    { ...privateReadOptions, pathParameters: [libraryPath], queryPolicy: "exact", queryParameters: [queryParameter("limit", "integer", { minimum: 1, maximum: 100, defaultValue: 40 }), queryParameter("before", "string", { minLength: 1, maxLength: 320 }), historyHeadQuery] }),
  operation("library.versions.get", "GET", "/api/library/{id}/versions/{versionId}", "Read exact historical metadata; historical bytes confer no new attachment authority.", "bearer", undefined, "NativeLibraryHistoryReadResponse",
    { ...privateReadOptions, pathParameters: [libraryPath, { name: "versionId", minLength: 1, maxLength: 320 }], queryPolicy: "exact", queryParameters: [historyHeadQuery] }),
  operation("entities.options", "GET", "/api/entities/options", "Read bounded current actor-private entity choices with exact IDs and labels.", "bearer", undefined, "NativeEntityOptionsResponse",
    { ...privateReadOptions, queryPolicy: "exact", queryParameters: entityOptionsQueryMetadata }),
  operation("market.snapshots.list", "GET", "/api/market-research/snapshots", "Read bounded stored snapshot metadata without fetching provider data.", "bearer", undefined, "NativeMarketSnapshotsResponse",
    { ...privateReadOptions, queryParameters: [marketInstrumentQuery, marketIntervalQuery, queryParameter("limit", "integer", { minimum: 1, maximum: 40, defaultValue: 20 })] }),
  operation("market.snapshots.get", "GET", "/api/market-research/snapshots/{id}", "Read one exact authorized stored market snapshot.", "bearer", undefined, "NativeMarketStoredSnapshotResponse",
    { ...privateReadOptions, pathParameters: [{ name: "id", minLength: 64, maxLength: 64, pattern: "^market_snapshot_[a-f0-9]{48}$" }] }),
  operation("market.analysis.metadata", "GET", "/api/market-research/analysis", "Read saved analysis identities and evidence without arbitrary chart plug-in state.", "bearer", undefined, "NativeMarketAnalysisMetadataResponse",
    { ...privateReadOptions, queryParameters: [marketInstrumentQuery, marketIntervalQuery, queryParameter("view", "string", { required: true, enumValues: ["metadata"] }), queryParameter("limit", "integer", { minimum: 1, maximum: 40, defaultValue: 10 })] }),
  operation("market.jobs.get", "GET", "/api/market-research/jobs/{id}", "Read one authorized Market operation with bounded progress, results and error text.", "bearer", undefined, "NativeMarketJobResponse",
    { ...privateReadOptions, pathParameters: [{ name: "id", minLength: 36, maxLength: 36 }] }),
  operation("market.calendar", "GET", "/api/market-research/calendar", "Explicitly refresh the official provider calendar; never an automatic stored-data read.", "bearer", undefined, "NativeMarketCalendarResponse",
    { ...privateReadOptions, queryParameters: [queryParameter("days", "integer", { minimum: 1, maximum: 31, defaultValue: 14 })] }),
  operation("memory.create", "POST", "/api/memory", "Create one private Memory; an uncertain response does not authorize automatic replay.", "bearer", "NativeMemoryCreateRequest", "NativeMemoryCreateResponse",
    { ...memoryMutationOptions, errorStatuses: [...memoryMutationOptions.errorStatuses, 500], pathParameters: [], successStatuses: [201] }),
  operation("memory.update", "PATCH", "/api/memory/{id}", "Correct an exact private Memory while preserving lineage; an uncertain response remains held.", "bearer", "NativeMemoryCorrectionRequest", "NativeMemoryCorrectionResponse", memoryMutationOptions),
  operation("memory.delete", "DELETE", "/api/memory/{id}", "Forget the exact reviewed Memory lineage and reconcile its immutable deletion receipt.", "bearer", undefined, "NativeMemoryForgetResponse",
    { ...memoryMutationOptions, errorStatuses: [400, 401, 403, 404, 409, 428, 503], headerParameters: [...pluginMutationHeaders,
      { name: "x-asael-deletion-preview", required: true, minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }] }),
  operation("memory.lifecycle.get", "GET", "/api/memory/{id}/lifecycle", "Read the exact current private lifecycle and opaque revision token.", "bearer", undefined, "NativeMemoryLifecycleReadResponse",
    { ...privateReadOptions, errorResponseSchema: "NativeMemoryMutationError", pathParameters: memoryMutationOptions.pathParameters, queryPolicy: "exact" }),
  operation("memory.lifecycle.change", "PATCH", "/api/memory/{id}/lifecycle", "Pin, unpin, archive or restore one exact reviewed lifecycle intent with durable acceptance.", "bearer", "NativeMemoryLifecycleRequest", "NativeMemoryLifecycleChangeResponse", memoryMutationOptions),
];

const memoryReconciliationReadOptions = {
  ...privateReadOptions,
  queryPolicy: "exact",
  errorResponseSchema: "NativeMemoryReconciliationError",
  errorStatuses: [400, 401, 403, 404, 409, 503],
} as const satisfies Partial<NativeOperation>;
const v35Operations: readonly NativeOperation[] = [
  ...v34Operations,
  operation("memory.reconciliation.list", "GET", "/api/memory/reconciliation", "Read bounded currently authorized private Memory reviews without granting correction authority.", "bearer", undefined, "NativeMemoryReconciliationListResponse", {
    ...memoryReconciliationReadOptions,
    queryParameters: [
      queryParameter("contract", "string", { required: true, enumValues: ["asael-memory-reconciliation-read:1"] }),
      queryParameter("status", "string", { enumValues: ["pending", "resolved", "all"], defaultValue: "pending" }),
      queryParameter("limit", "integer", { minimum: 1, maximum: 100, defaultValue: 50 }),
    ],
  }),
  operation("memory.reconciliation.read", "GET", "/api/memory/reconciliation/{id}", "Read one exact authorized review and matching acceptance without repeating a decision or projection.", "bearer", undefined, "NativeMemoryReconciliationReadResponse", {
    ...memoryReconciliationReadOptions,
    pathParameters: [{ name: "id", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$" }],
    queryParameters: [queryParameter("acceptanceKeySha256", "string", { minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })],
  }),
  operation("memory.reconciliation.resolve", "PATCH", "/api/memory/reconciliation", "Resolve one revision-bound private Memory review with atomic decision acceptance and separately reported projection outcomes.", "bearer", "NativeMemoryReconciliationDecisionRequest", "NativeMemoryReconciliationDecisionResponse", {
    ...memoryReconciliationReadOptions,
    headerParameters: pluginMutationHeaders,
    requestBodyMaxBytes: 4096,
    errorStatuses: [400, 401, 403, 404, 409, 413, 415, 503],
  }),
];

const personalContextConsentOptions = {
  ...privateReadOptions, queryPolicy: "exact", errorResponseSchema: "NativePersonalContextConsentError",
  errorStatuses: [400, 401, 403, 404, 409, 503],
} as const satisfies Partial<NativeOperation>;
const meetingCalendarOptions = {
  ...privateReadOptions, queryPolicy: "exact", errorResponseSchema: "NativeMeetingCalendarError",
  errorStatuses: [400, 401, 403, 404, 409, 503],
} as const satisfies Partial<NativeOperation>;
const v36Operations: readonly NativeOperation[] = [
  ...v35Operations,
  operation("memory.personal-context-consent.get", "GET", "/api/memory/personal-context-consent", "Read the current owner's exact personal recall consent generation and complete notice.", "bearer", undefined, "NativePersonalContextConsentResponse", {
    ...personalContextConsentOptions,
    queryParameters: [queryParameter("contract", "string", { required: true, enumValues: ["asael-personal-context-consent-read:1"] })],
  }),
  operation("memory.personal-context-consent.decide", "PATCH", "/api/memory/personal-context-consent", "Accept one exact generation-bound personal recall decision with durable recovery.", "bearer", "NativePersonalContextConsentDecisionRequest", "NativePersonalContextConsentDecisionResponse", {
    ...personalContextConsentOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 4096,
    errorStatuses: [400, 401, 403, 409, 413, 415, 503],
  }),
  operation("memory.personal-context-consent.decision.get", "GET", "/api/memory/personal-context-consent/decisions/{id}", "Recover one exact keyed personal recall acceptance and current state without repeating a decision.", "bearer", undefined, "NativePersonalContextConsentDecisionReadResponse", {
    ...personalContextConsentOptions, pathParameters: [{ name: "id", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }],
  }),
  operation("meetings.calendar.get", "GET", "/api/meetings/calendar", "Read the current private Google calendar connection and any unsettled sync acceptance.", "bearer", undefined, "NativeMeetingCalendarStatusResponse", meetingCalendarOptions),
  operation("meetings.calendar.sync", "POST", "/api/meetings/calendar/sync", "Accept calendar-only sync for one exact owner connection and authorization generation.", "bearer", "NativeMeetingCalendarSyncRequest", "NativeMeetingCalendarSyncResponse", {
    ...meetingCalendarOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 4096,
    errorStatuses: [400, 401, 403, 404, 409, 413, 415, 503],
  }),
  operation("meetings.calendar.sync.get", "GET", "/api/meetings/calendar/sync/{id}", "Read one exact private calendar sync acceptance without repeating provider work.", "bearer", undefined, "NativeMeetingCalendarSyncReadResponse", {
    ...meetingCalendarOptions,
    pathParameters: [{ name: "id", minLength: 86, maxLength: 86, pattern: "^meeting-calendar-sync:[a-f0-9]{64}$" }],
    queryParameters: [queryParameter("acceptanceKeySha256", "string", { required: true, minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })],
  }),
];

const customerHealthEvaluationOptions = {
  ...customerDetailOptions, queryPolicy: "exact",
  errorResponseSchema: "NativeCustomerHealthEvaluationError",
} as const satisfies Partial<NativeOperation>;
const v37Operations: readonly NativeOperation[] = [
  ...v36Operations,
  operation("customers.health.evaluate", "POST", "/api/customer-accounts/{id}/health", "Evaluate the exact reviewed Account with current authorized facts and deterministic policy, retaining immutable acceptance.", "bearer", "NativeCustomerHealthEvaluateRequest", "NativeCustomerHealthEvaluateResponse", {
    ...customerHealthEvaluationOptions, headerParameters: pluginMutationHeaders,
    requestBodyMaxBytes: 4096, successStatuses: [200, 201],
    errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("customers.health.evaluations.get", "GET", "/api/customer-accounts/{id}/health/evaluations/{evaluationId}", "Read one exact authorized health evaluation receipt without repeating the evaluation.", "bearer", undefined, "NativeCustomerHealthEvaluationReadResponse", {
    ...customerHealthEvaluationOptions, errorStatuses: [400, 401, 403, 404, 409, 500, 503],
    pathParameters: [...customerDetailOptions.pathParameters,
      { name: "evaluationId", minLength: 91, maxLength: 91, pattern: "^customer-health-evaluation:[a-f0-9]{64}$" }],
    queryParameters: [queryParameter("workspaceId", "string", { required: true, minLength: 1, maxLength: 240 })],
  }),
];

const memoryPromotionOptions = {
  ...privateReadOptions, queryPolicy: "exact",
  errorResponseSchema: "NativeMemoryPromotionError",
  errorStatuses: [400, 401, 403, 404, 409, 500, 503],
} as const satisfies Partial<NativeOperation>;
const customerWorkflowOptions = {
  ...customerDetailOptions, queryPolicy: "exact",
  errorResponseSchema: "NativeCustomerWorkflowError",
  errorStatuses: [400, 401, 403, 404, 409, 500, 503],
} as const satisfies Partial<NativeOperation>;
const customerWorkflowRunParameters = [
  ...customerDetailOptions.pathParameters,
  { name: "runId", minLength: 85, maxLength: 85, pattern: "^customer-success-run:[a-f0-9]{64}$" },
] as const;
const agentSkillNativeOptions = {
  ...privateReadOptions, queryPolicy: "exact",
  errorResponseSchema: "NativeAgentSkillError",
  errorStatuses: [400, 401, 403, 404, 409, 500, 503],
} as const satisfies Partial<NativeOperation>;
const agentSkillNativeDetailOptions = {
  ...agentSkillNativeOptions,
  pathParameters: [{ name: "id", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$" }],
} as const satisfies Partial<NativeOperation>;
const agentSkillNativeWriteOptions = {
  ...agentSkillNativeOptions, headerParameters: pluginMutationHeaders,
  errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
} as const satisfies Partial<NativeOperation>;
const agentSkillNativeRecoveryOptions = {
  ...agentSkillNativeOptions,
  pathParameters: [{ name: "keySha256", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }],
} as const satisfies Partial<NativeOperation>;
const meetingRecordingOptions = {
  ...privateReadOptions, queryPolicy: "exact", errorResponseSchema: "NativeMeetingRecordingError",
  errorStatuses: [400, 401, 403, 404, 409, 500, 503],
  pathParameters: [{ name: "id", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$" }],
} as const satisfies Partial<NativeOperation>;
const meetingRecordingQuery = [
  queryParameter("workspaceId", "string", { required: true, minLength: 11, maxLength: 240, pattern: "^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$" }),
  queryParameter("meetingId", "string", { required: true, minLength: 44, maxLength: 44, pattern: "^meeting:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
];
const customerFactOptions = {
  ...customerDetailOptions, queryPolicy: "exact", errorResponseSchema: "NativeCustomerFactMutationError",
  errorStatuses: [400, 401, 403, 404, 409, 500, 503],
} as const satisfies Partial<NativeOperation>;
const salesforceActionOptions = {
  ...privateReadOptions, queryPolicy: "exact", errorResponseSchema: "NativeSalesforceActionError",
  errorStatuses: [400, 401, 403, 404, 409, 500, 503],
} as const satisfies Partial<NativeOperation>;
const salesforceActionQuery = [
  queryParameter("workspaceId", "string", { required: true, minLength: 11, maxLength: 240, pattern: "^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$" }),
];
const knowledgeCognitionOptions = {
  ...privateReadOptions, queryPolicy: "exact", errorResponseSchema: "NativeKnowledgeCognitionError",
  errorStatuses: [400, 401, 403, 404, 409, 500, 503],
} as const satisfies Partial<NativeOperation>;
const knowledgeCognitionDetailOptions = {
  ...knowledgeCognitionOptions,
  pathParameters: [{ name: "id", minLength: 64, maxLength: 64, pattern: "^cognition_batch_[a-f0-9]{48}$" }],
} as const satisfies Partial<NativeOperation>;
const knowledgeSourceDeletionOptions = {
  ...privateReadOptions, queryPolicy: "exact", errorResponseSchema: "NativeKnowledgeSourceDeletionError",
  errorStatuses: [400, 401, 403, 404, 409, 500, 503],
  pathParameters: [{ name: "sourceKind", minLength: 4, maxLength: 8, pattern: "^(google|mail|calendar|drive)$" }],
} as const satisfies Partial<NativeOperation>;
const memoryGraphReadOptions = {
  ...privateReadOptions, queryPolicy: "exact", errorResponseSchema: "NativeMemoryGraphReadError",
  errorStatuses: [400, 401, 403, 404, 503],
} as const satisfies Partial<NativeOperation>;
const memoryGraphDetailOptions = {
  ...memoryGraphReadOptions,
  pathParameters: [{ name: "id", minLength: 1, maxLength: 240, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$" }],
} as const satisfies Partial<NativeOperation>;
const memoryMaintenanceOptions = {
  ...privateReadOptions, queryPolicy: "exact", errorResponseSchema: "NativeMemoryMaintenanceError",
  errorStatuses: [400, 401, 403, 404, 409, 500, 503],
} as const satisfies Partial<NativeOperation>;
const memoryGraphRebuildOptions = {
  ...memoryMaintenanceOptions, errorResponseSchema: "NativeMemoryGraphRebuildError",
} as const satisfies Partial<NativeOperation>;
const knowledgeCognitionBuildOptions = {
  ...privateReadOptions, queryPolicy: "exact", errorResponseSchema: "NativeKnowledgeCognitionBuildError",
  errorStatuses: [400, 401, 403, 404, 409, 500, 503],
  pathParameters: [{ name: "documentId", minLength: 1, maxLength: 320, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$" }],
} as const satisfies Partial<NativeOperation>;
const v38Operations: readonly NativeOperation[] = [
  ...v37Operations,
  operation("agents.delete.review", "GET", "/api/agents/{id}/deletion-review", "Review the exact owned custom Agent and its deletion consequences.", "bearer", undefined, "NativeAgentSkillReviewResponse", agentSkillNativeDetailOptions),
  operation("agents.delete", "DELETE", "/api/agents/{id}", "Move the exact reviewed custom Agent to Trash with atomic deletion acceptance.", "bearer", "NativeAgentSkillDeleteRequest", "NativeAgentSkillMutationResponse", {
    ...agentSkillNativeDetailOptions, ...agentSkillNativeWriteOptions, requestBodyMaxBytes: 16384,
  }),
  operation("agents.mutations.get", "GET", "/api/agents/mutations/{keySha256}", "Read the exact owned Agent deletion acceptance without repeating deletion.", "bearer", undefined, "NativeAgentSkillReadResponse", agentSkillNativeRecoveryOptions),
  operation("skills.mutation.review", "GET", "/api/skills/{id}/mutation-review", "Review an exact owned Skill and all affected Agent definitions before changing it.", "bearer", undefined, "NativeAgentSkillReviewResponse", {
    ...agentSkillNativeDetailOptions, queryParameters: [queryParameter("operation", "string", { required: true, enumValues: ["update", "delete"] })],
  }),
  operation("skills.create", "POST", "/api/skills", "Create an owned custom Skill with durable atomic acceptance.", "bearer", "NativeAgentSkillCreateRequest", "NativeAgentSkillMutationResponse", {
    ...agentSkillNativeWriteOptions, requestBodyMaxBytes: 65536, successStatuses: [200, 201],
  }),
  operation("skills.update", "PATCH", "/api/skills/{id}", "Update an exact reviewed owned Skill and bind the affected Agent set.", "bearer", "NativeAgentSkillUpdateRequest", "NativeAgentSkillMutationResponse", {
    ...agentSkillNativeDetailOptions, ...agentSkillNativeWriteOptions, requestBodyMaxBytes: 65536,
  }),
  operation("skills.delete", "DELETE", "/api/skills/{id}", "Move an exact reviewed owned Skill to Trash with atomic acceptance and assignment evidence.", "bearer", "NativeAgentSkillDeleteRequest", "NativeAgentSkillMutationResponse", {
    ...agentSkillNativeDetailOptions, ...agentSkillNativeWriteOptions, requestBodyMaxBytes: 16384,
  }),
  operation("skills.mutations.get", "GET", "/api/skills/mutations/{keySha256}", "Read one exact owned Skill mutation acceptance without repeating the change.", "bearer", undefined, "NativeAgentSkillReadResponse", agentSkillNativeRecoveryOptions),
  operation("memory.promotions.list", "GET", "/api/memory/promotions", "Read a bounded list of currently authorized private Memory promotion reviews.", "bearer", undefined, "NativeMemoryPromotionListResponse", {
    ...memoryPromotionOptions,
    queryParameters: [
      queryParameter("status", "string", { enumValues: ["pending", "resolved", "all"], defaultValue: "pending" }),
      queryParameter("limit", "integer", { minimum: 1, maximum: 50, defaultValue: 25 }),
    ],
  }),
  operation("memory.promotions.read", "GET", "/api/memory/promotions/{reviewId}", "Read one exact private promotion review and matching acceptance without repeating a decision or projection.", "bearer", undefined, "NativeMemoryPromotionReadResponse", {
    ...memoryPromotionOptions,
    pathParameters: [{ name: "reviewId", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$" }],
    queryParameters: [queryParameter("acceptanceKeySha256", "string", { minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })],
  }),
  operation("memory.promotions.decide", "PATCH", "/api/memory/promotions", "Promote or dismiss the exact reviewed private Memory source set with atomic acceptance and separately reported projections.", "bearer", "NativeMemoryPromotionDecisionRequest", "NativeMemoryPromotionDecisionResponse", {
    ...memoryPromotionOptions, headerParameters: pluginMutationHeaders,
    requestBodyMaxBytes: 4096, errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("customers.workflows.start", "POST", "/api/customer-accounts/{id}/workflows", "Create the exact reviewed workflow project and task plan atomically, without executing it.", "bearer", "NativeCustomerWorkflowStartRequest", "NativeCustomerWorkflowMutationResponse", {
    ...customerWorkflowOptions, headerParameters: pluginMutationHeaders,
    requestBodyMaxBytes: 32768, successStatuses: [200, 201],
    errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("customers.workflows.outcome", "PATCH", "/api/customer-accounts/{id}/workflows", "Record a reviewed outcome against exact Account, run, definition and artifact evidence pins.", "bearer", "NativeCustomerWorkflowOutcomeRequest", "NativeCustomerWorkflowMutationResponse", {
    ...customerWorkflowOptions, headerParameters: pluginMutationHeaders,
    requestBodyMaxBytes: 131072, errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("customers.workflows.get", "GET", "/api/customer-accounts/{id}/workflows/{runId}", "Read one exact currently authorized workflow run, pinned definition and available project progress.", "bearer", undefined, "NativeCustomerWorkflowRunReadResponse", {
    ...customerWorkflowOptions, pathParameters: customerWorkflowRunParameters,
    queryParameters: [queryParameter("workspaceId", "string", { required: true, minLength: 1, maxLength: 240 })],
  }),
  operation("customers.workflows.mutations.get", "GET", "/api/customer-accounts/{id}/workflows/{runId}/mutations/{keySha256}", "Recover an exact workflow acceptance without creating or executing a plan or repeating an outcome.", "bearer", undefined, "NativeCustomerWorkflowAcceptanceReadResponse", {
    ...customerWorkflowOptions, pathParameters: [...customerWorkflowRunParameters,
      { name: "keySha256", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }],
    queryParameters: [queryParameter("workspaceId", "string", { required: true, minLength: 1, maxLength: 240 })],
  }),
  operation("meetings.recordings.review", "GET", "/api/capture/recordings/{id}/processing-review", "Review an exact owned linked recording, current Meeting consent and reusable transcript checkpoints.", "bearer", undefined, "NativeMeetingRecordingReviewResponse", {
    ...meetingRecordingOptions, queryParameters: meetingRecordingQuery,
  }),
  operation("meetings.recordings.process", "POST", "/api/capture/recordings/{id}/complete", "Admit the exact reviewed linked recording for processing with atomic queue acceptance and no automatic retry of uncertain provider work.", "bearer", "NativeMeetingRecordingProcessRequest", "NativeMeetingRecordingProcessResponse", {
    ...meetingRecordingOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 32768,
    successStatuses: [200, 202], errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("meetings.recordings.processing.get", "GET", "/api/capture/recordings/{id}/processing/{keySha256}", "Observe exact processing acceptance and separate current media and Knowledge status without queueing or retrying work.", "bearer", undefined, "NativeMeetingRecordingReadResponse", {
    ...meetingRecordingOptions, pathParameters: [...meetingRecordingOptions.pathParameters,
      { name: "keySha256", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }], queryParameters: meetingRecordingQuery,
  }),
  operation("customers.facts.record", "POST", "/api/customer-accounts/{id}/facts", "Create, revise or retract an exact reviewed manual Account fact with explicit operator-assertion provenance and immutable acceptance.", "bearer", "NativeCustomerFactMutationRequest", "NativeCustomerFactMutationResponse", {
    ...customerFactOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 65536, successStatuses: [200, 201],
    errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("customers.facts.acceptance.get", "GET", "/api/customer-accounts/{id}/facts/acceptances/{keySha256}", "Read an exact currently authorized manual fact acceptance without recording another revision.", "bearer", undefined, "NativeCustomerFactAcceptanceReadResponse", {
    ...customerFactOptions, pathParameters: [...customerDetailOptions.pathParameters,
      { name: "keySha256", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }],
    queryParameters: [queryParameter("workspaceId", "string", { required: true, minLength: 1, maxLength: 240 })],
  }),
  operation("customers.salesforce.actions.review", "GET", "/api/customer-accounts/salesforce/actions", "Review the exact current owned Salesforce connection and available sync, reconciliation and disconnect actions.", "bearer", undefined, "NativeSalesforceActionReviewResponse", {
    ...salesforceActionOptions, queryParameters: salesforceActionQuery,
  }),
  operation("customers.salesforce.actions.submit", "POST", "/api/customer-accounts/salesforce/actions", "Admit a reviewed Salesforce action once, preserving immutable acceptance and separately reporting provider settlement.", "bearer", "NativeSalesforceActionRequest", "NativeSalesforceActionSubmitResponse", {
    ...salesforceActionOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 16384,
    successStatuses: [200, 201], errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("customers.salesforce.actions.get", "GET", "/api/customer-accounts/salesforce/actions/{keySha256}", "Observe the exact Salesforce acceptance and settlement without repeating provider work.", "bearer", undefined, "NativeSalesforceActionReadResponse", {
    ...salesforceActionOptions, queryParameters: salesforceActionQuery,
    pathParameters: [{ name: "keySha256", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }],
  }),
  operation("knowledge.cognification.list", "GET", "/api/knowledge/cognification/reviews", "Read a bounded list of currently authorized private source-map reviews.", "bearer", undefined, "NativeKnowledgeCognitionListResponse", {
    ...knowledgeCognitionOptions, queryParameters: [
      queryParameter("status", "string", { enumValues: ["pending_review", "confirmed", "dismissed"], defaultValue: "pending_review" }),
      queryParameter("limit", "integer", { minimum: 1, maximum: 50, defaultValue: 25 }),
    ],
  }),
  operation("knowledge.cognification.read", "GET", "/api/knowledge/cognification/reviews/{id}", "Read an exact currently owned source map and its current source eligibility.", "bearer", undefined, "NativeKnowledgeCognitionReadResponse", knowledgeCognitionDetailOptions),
  operation("knowledge.cognification.decide", "PATCH", "/api/knowledge/cognification/reviews/{id}", "Confirm or dismiss the exact reviewed source-map candidate and source revision with atomic acceptance.", "bearer", "NativeKnowledgeCognitionDecisionRequest", "NativeKnowledgeCognitionDecisionResponse", {
    ...knowledgeCognitionDetailOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 16384,
    errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("knowledge.cognification.decisions.get", "GET", "/api/knowledge/cognification/reviews/{id}/decisions/{keySha256}", "Recover an exact source-map decision without repeating Memory writes or downstream projections.", "bearer", undefined, "NativeKnowledgeCognitionAcceptanceResponse", {
    ...knowledgeCognitionDetailOptions, pathParameters: [...knowledgeCognitionDetailOptions.pathParameters,
      { name: "keySha256", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }],
  }),
  operation("knowledge.sources.deletion.review", "GET", "/api/knowledge/sources/{sourceKind}/deletion-review", "Review the complete supported owner-private local source deletion manifest and explicit scope limits.", "bearer", undefined, "NativeKnowledgeSourceDeletionReviewResponse", knowledgeSourceDeletionOptions),
  operation("knowledge.sources.delete", "DELETE", "/api/knowledge/sources/{sourceKind}", "Delete the exact reviewed private local source lineage with atomic minimal acceptance and no provider deletion.", "bearer", "NativeKnowledgeSourceDeletionRequest", "NativeKnowledgeSourceDeletionResponse", {
    ...knowledgeSourceDeletionOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 8192,
    errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("knowledge.sources.deletions.get", "GET", "/api/knowledge/sources/{sourceKind}/deletions/{keySha256}", "Read exact local deletion acceptance without repeating deletion or reconstructing a receipt from absent data.", "bearer", undefined, "NativeKnowledgeSourceDeletionReadResponse", {
    ...knowledgeSourceDeletionOptions, pathParameters: [...knowledgeSourceDeletionOptions.pathParameters,
      { name: "keySha256", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }],
  }),
  operation("memory.graph.universe", "GET", "/api/memory/graph/views/universe", "Read a bounded private graph sample with explicit coverage and no tenant-wide build history.", "bearer", undefined, "NativeMemoryGraphUniverseResponse", {
    ...memoryGraphReadOptions, queryParameters: [queryParameter("limit", "integer", { minimum: 1, maximum: 500, defaultValue: 200 })],
  }),
  operation("memory.graph.node", "GET", "/api/memory/graph/views/nodes/{id}", "Inspect one exact currently authorized private graph point.", "bearer", undefined, "NativeMemoryGraphNodeResponse", memoryGraphDetailOptions),
  operation("memory.graph.entity", "GET", "/api/memory/graph/views/entities/{id}", "Inspect one exact active private entity independently of sample limits.", "bearer", undefined, "NativeMemoryGraphEntityResponse", memoryGraphDetailOptions),
  operation("memory.graph.temporalRelations", "GET", "/api/memory/graph/views/relations", "Read bounded current or historical private relation claims with explicit temporal filters.", "bearer", undefined, "NativeMemoryGraphTemporalResponse", {
    ...memoryGraphReadOptions, queryParameters: [
      queryParameter("entityId", "string", { minLength: 1, maxLength: 240, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$" }),
      queryParameter("relationTypeId", "string", { enumValues: entityRelationTypeIdSchema.options }),
      queryParameter("epistemicKind", "string", { enumValues: relationEpistemicKindSchema.options }),
      queryParameter("validAt", "string", { minLength: 20, maxLength: 100, description: "ISO 8601 date-time with an explicit timezone offset." }),
      queryParameter("recordedAt", "string", { minLength: 20, maxLength: 100, description: "ISO 8601 date-time with an explicit timezone offset." }),
      queryParameter("history", "string", { enumValues: ["true", "false"], defaultValue: "false" }), queryParameter("limit", "integer", { minimum: 1, maximum: 200, defaultValue: 50 }),
    ],
  }),
  operation("memory.graph.relationshipPaths", "GET", "/api/memory/graph/views/paths", "Read bounded private relationship paths backed by currently authorized evidence.", "bearer", undefined, "NativeMemoryGraphPathsResponse", {
    ...memoryGraphReadOptions, queryParameters: [queryParameter("q", "string", { required: true, minLength: 1, maxLength: 4000 }),
      queryParameter("maxHops", "integer", { minimum: 1, maximum: 3, defaultValue: 2 }), queryParameter("limit", "integer", { minimum: 1, maximum: 24, defaultValue: 12 })],
  }),
  operation("memory.maintenance.review", "GET", "/api/memory/maintenance/review", "Review the complete supported private maintenance inventory under its existing purpose permissions.", "bearer", undefined, "NativeMemoryMaintenanceReviewResponse", memoryMaintenanceOptions),
  operation("memory.maintenance.run", "POST", "/api/memory/maintenance", "Apply the exact reviewed eligible private maintenance plan and atomically record its acceptance.", "bearer", "NativeMemoryMaintenanceRequest", "NativeMemoryMaintenanceResponse", {
    ...memoryMaintenanceOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 8192, successStatuses: [200, 201],
    errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("memory.maintenance.runs.get", "GET", "/api/memory/maintenance/runs/{keySha256}", "Read the original private maintenance acceptance without applying maintenance again.", "bearer", undefined, "NativeMemoryMaintenanceReadResponse", {
    ...memoryMaintenanceOptions, pathParameters: [{ name: "keySha256", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }],
  }),
  operation("memory.graph.rebuild.review", "GET", "/api/memory/graph/rebuild-review", "Review the complete supported private graph source inventory and exact rebuild policy.", "bearer", undefined, "NativeMemoryGraphRebuildReviewResponse", memoryGraphRebuildOptions),
  operation("memory.graph.rebuild", "POST", "/api/memory/graph", "Rebuild only the exact reviewed owner-private graph with atomic build acceptance.", "bearer", "NativeMemoryGraphRebuildRequest", "NativeMemoryGraphRebuildResponse", {
    ...memoryGraphRebuildOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 8192, successStatuses: [200, 201],
    errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("memory.graph.rebuilds.get", "GET", "/api/memory/graph/rebuilds/{keySha256}", "Read the exact owner-private graph rebuild acceptance independently of tenant build history.", "bearer", undefined, "NativeMemoryGraphRebuildReadResponse", {
    ...memoryGraphRebuildOptions, pathParameters: [{ name: "keySha256", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }],
  }),
  operation("knowledge.cognification.build.review", "GET", "/api/knowledge/cognification/documents/{documentId}/build-review", "Review one currently owned document and its bounded paid source-map build plan.", "bearer", undefined, "NativeKnowledgeCognitionBuildReviewResponse", knowledgeCognitionBuildOptions),
  operation("knowledge.cognification.build", "POST", "/api/knowledge/cognification/documents/{documentId}/build", "Accept the exact reviewed document build once and enqueue its bounded source-map work.", "bearer", "NativeKnowledgeCognitionBuildRequest", "NativeKnowledgeCognitionBuildResponse", {
    ...knowledgeCognitionBuildOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 16384, successStatuses: [202],
    errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("knowledge.cognification.builds.get", "GET", "/api/knowledge/cognification/documents/{documentId}/builds/{keySha256}", "Read an exact accepted document build and its current processing state without resubmission.", "bearer", undefined, "NativeKnowledgeCognitionBuildReadResponse", {
    ...knowledgeCognitionBuildOptions, pathParameters: [...knowledgeCognitionBuildOptions.pathParameters,
      { name: "keySha256", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }],
  }),
];

// Search follows the same current actor and canonical-owner checks as web.
// Detail wrappers intentionally leave domain payload validation to their existing
// native parsers; publishing metadata grants no authority to open a result.
const v39Operations: readonly NativeOperation[] = [
  ...v38Operations,
  operation("content.search", "GET", "/api/content-search", "Search the current account's readable conversation titles, Work, private Memory and Library with independent provider availability.", "bearer", undefined, "NativeContentSearchResponse", {
    ...privateReadOptions, queryPolicy: "exact", queryParameters: [
      queryParameter("q", "string", { required: true, minLength: 2, maxLength: 240, description: "A trimmed query containing at least one Unicode letter or number." }),
      queryParameter("limit", "integer", { minimum: 1, maximum: 20, defaultValue: 8 }),
      queryParameter("provider", "string", { enumValues: ["conversations", "work", "memory", "library"] }),
      queryParameter("cursor", "string", { maxLength: 1800, description: "Opaque continuation bound to the exact query, provider and authenticated owner." }),
    ],
  }),
  operation("content.search.work.get", "GET", "/api/content-search/work/{id}", "Revalidate a current mapped Work search result and place its exact selected task first in the bounded project detail.", "bearer", undefined, "NativeContentSearchWorkResponse", {
    ...privateReadOptions, pathParameters: [{ name: "id", minLength: 1, maxLength: 200 }],
    queryParameters: [queryParameter("task", "string", { minLength: 1, maxLength: 200 })],
  }),
  operation("content.search.memory.get", "GET", "/api/content-search/memory/{id}", "Revalidate one currently active private Memory search result under the existing purpose and owner rules.", "bearer", undefined, "NativeContentSearchMemoryResponse", {
    ...privateReadOptions, pathParameters: [{ name: "id", minLength: 1, maxLength: 200 }],
  }),
];

const googlePersonalActionOptions = {
  ...privateReadOptions, queryPolicy: "exact", errorResponseSchema: "NativeGooglePersonalError",
  errorStatuses: [400, 401, 403, 404, 409, 500, 503],
} as const satisfies Partial<NativeOperation>;
const connectorNativeOptions = {
  ...privateReadOptions, queryPolicy: "exact", errorResponseSchema: "NativeConnectorError",
  errorStatuses: [400, 401, 403, 404, 409, 500, 503],
} as const satisfies Partial<NativeOperation>;
const nativeActionRecoveryPath = [
  { name: "keySha256", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" },
];
const v40Operations: readonly NativeOperation[] = [
  ...v39Operations,
  operation("google.personal.actions.review", "GET", "/api/oauth/google/actions", "Review the exact personal Google account and permitted sources before syncing or disconnecting it.", "bearer", undefined, "NativeGooglePersonalReviewResponse", googlePersonalActionOptions),
  operation("google.personal.actions.submit", "POST", "/api/oauth/google/actions", "Accept the exact reviewed personal Google sync or disconnect once and report its settlement.", "bearer", "NativeGooglePersonalRequest", "NativeGooglePersonalSubmitResponse", {
    ...googlePersonalActionOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 16384,
    successStatuses: [200, 201], errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("google.personal.actions.read", "GET", "/api/oauth/google/actions/{keySha256}", "Read an exact personal Google action acceptance and settlement without repeating provider work.", "bearer", undefined, "NativeGooglePersonalReadResponse", {
    ...googlePersonalActionOptions, pathParameters: nativeActionRecoveryPath,
  }),
  operation("connectors.native.list", "GET", "/api/connectors/native", "List currently authorized MCP and OpenAPI connectors with explicit coverage.", "bearer", undefined, "NativeConnectorListResponse", connectorNativeOptions),
  operation("connectors.native.review", "GET", "/api/connectors/native/{kind}/{id}/review", "Review the exact current connector configuration and complete discovered contract inventory.", "bearer", undefined, "NativeConnectorReviewResponse", {
    ...connectorNativeOptions, pathParameters: [
      { name: "kind", minLength: 3, maxLength: 7, pattern: "^(mcp|openapi)$" },
      { name: "id", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,199}$" },
    ],
  }),
  operation("connectors.native.act", "POST", "/api/connectors/native/actions", "Apply an exact reviewed connector action once and atomically record its acceptance.", "bearer", "NativeConnectorActionRequest", "NativeConnectorActionResponse", {
    ...connectorNativeOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 8192,
    successStatuses: [200, 201], errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("connectors.native.actions.get", "GET", "/api/connectors/native/actions/{keySha256}", "Read an exact connector action acceptance without applying the action again.", "bearer", undefined, "NativeConnectorReadResponse", {
    ...connectorNativeOptions, pathParameters: nativeActionRecoveryPath,
  }),
];

const v41Operations: readonly NativeOperation[] = [
  ...v40Operations,
  operation("connectors.native.credentialRemovals.submit", "POST", "/api/connectors/native/credential-removals", "Remove an exact reviewed saved MCP credential once, disable its connector and clear discovered contracts without revoking the provider token.", "bearer", "NativeConnectorCredentialRemovalRequest", "NativeConnectorCredentialRemovalSubmitResponse", {
    ...connectorNativeOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 8192,
    successStatuses: [200, 201], errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("connectors.native.credentialRemovals.read", "GET", "/api/connectors/native/credential-removals/{keySha256}", "Read an exact MCP credential removal acceptance and settlement without repeating the removal.", "bearer", undefined, "NativeConnectorCredentialRemovalReadResponse", {
    ...connectorNativeOptions, pathParameters: nativeActionRecoveryPath,
  }),
];

const v42Operations: readonly NativeOperation[] = [
  ...v41Operations,
  operation("connectors.native.trash.preview", "GET", "/api/connectors/native/mcp/{id}/trash-preview", "Review an exact supported MCP connector and its bounded ten-minute Trash preview and compensation plan.", "bearer", undefined, "NativeConnectorTrashPreviewResponse", {
    ...connectorNativeOptions, pathParameters: [{ name: "id", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,199}$" }],
  }),
  operation("connectors.native.trash.submit", "POST", "/api/connectors/native/trash-actions", "Move one exactly reviewed MCP connector to Trash once and atomically record its immutable acceptance and settlement.", "bearer", "NativeConnectorTrashRequest", "NativeConnectorTrashSubmitResponse", {
    ...connectorNativeOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 8192,
    successStatuses: [200, 201], errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("connectors.native.trash.read", "GET", "/api/connectors/native/trash-actions/{keySha256}", "Read the original exact MCP Trash action acceptance and settlement without repeating deletion or requiring the live connector.", "bearer", undefined, "NativeConnectorTrashReadResponse", {
    ...connectorNativeOptions, pathParameters: nativeActionRecoveryPath,
  }),
];

const v43Operations: readonly NativeOperation[] = [
  ...v42Operations,
  operation("connectors.native.credentialPreparations.submit", "POST", "/api/connectors/native/credential-preparations", "Prepare one write-only bearer credential for an unchanged reviewed MCP connector without changing its live credential.", "bearer", "NativeConnectorCredentialPrepareRequest", "NativeConnectorCredentialPreparationSubmitResponse", {
    ...connectorNativeOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 65_536,
    successStatuses: [200, 201], errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("connectors.native.credentialPreparations.read", "GET", "/api/connectors/native/credential-preparations/{keySha256}", "Read the original owner's exact safe preparation proof or terminal abandonment without exposing or resending its credential.", "bearer", undefined, "NativeConnectorCredentialPreparationReadResponse", {
    ...connectorNativeOptions, pathParameters: nativeActionRecoveryPath,
  }),
  operation("connectors.native.credentialPreparations.abandon", "POST", "/api/connectors/native/credential-preparations/{keySha256}/abandon", "Permanently abandon only the original owner's exact staging intent, including a tombstone that fences a delayed preparation.", "bearer", "NativeConnectorCredentialPreparationAbandonRequest", "NativeConnectorCredentialPreparationAbandonResponse", {
    ...connectorNativeOptions, pathParameters: nativeActionRecoveryPath, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 16_384,
    successStatuses: [200, 201], errorStatuses: [400, 401, 403, 409, 413, 415, 500, 503],
  }),
  operation("connectors.native.credentialRotations.submit", "POST", "/api/connectors/native/credential-rotations", "Consume one exact prepared MCP bearer credential once, disable its connector and clear its discovered contracts without provider calls.", "bearer", "NativeConnectorCredentialRotationRequest", "NativeConnectorCredentialRotationSubmitResponse", {
    ...connectorNativeOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 8192,
    successStatuses: [200, 201], errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("connectors.native.credentialRotations.read", "GET", "/api/connectors/native/credential-rotations/{keySha256}", "Read the original exact MCP credential rotation receipt without repeating preparation or credential effects.", "bearer", undefined, "NativeConnectorCredentialRotationReadResponse", {
    ...connectorNativeOptions, pathParameters: nativeActionRecoveryPath,
  }),
];

const v44Operations: readonly NativeOperation[] = [
  ...v43Operations,
  operation("connectors.native.mcpRegistrationPreparations.submit", "POST", "/api/connectors/native/mcp-registration-preparations", "Prepare an exact new MCP declaration and transient endpoint/credential without creating a connector or contacting a provider.", "bearer", "NativeConnectorMcpRegistrationPrepareRequest", "NativeConnectorMcpRegistrationPreparationSubmitResponse", {
    ...connectorNativeOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 65_536,
    successStatuses: [200, 201], errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("connectors.native.mcpRegistrationPreparations.read", "GET", "/api/connectors/native/mcp-registration-preparations/{keySha256}", "Read the original owner's exact safe registration proof or terminal abandonment without exposing or resending private input.", "bearer", undefined, "NativeConnectorMcpRegistrationPreparationReadResponse", {
    ...connectorNativeOptions, pathParameters: nativeActionRecoveryPath,
  }),
  operation("connectors.native.mcpRegistrationPreparations.abandon", "POST", "/api/connectors/native/mcp-registration-preparations/{keySha256}/abandon", "Permanently abandon the original owner's exact registration preparation, including an absent-key tombstone that fences delayed preparation.", "bearer", "NativeConnectorMcpRegistrationPreparationAbandonRequest", "NativeConnectorMcpRegistrationPreparationAbandonResponse", {
    ...connectorNativeOptions, pathParameters: nativeActionRecoveryPath, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 16_384,
    successStatuses: [200, 201], errorStatuses: [400, 401, 403, 409, 413, 415, 500, 503],
  }),
  operation("connectors.native.mcpRegistrations.submit", "POST", "/api/connectors/native/mcp-registrations", "Consume one exact prepared MCP declaration to create its reserved connector disabled with zero tools and no discovery or provider calls.", "bearer", "NativeConnectorMcpRegistrationRequest", "NativeConnectorMcpRegistrationSubmitResponse", {
    ...connectorNativeOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 8192,
    successStatuses: [200, 201], errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("connectors.native.mcpRegistrations.read", "GET", "/api/connectors/native/mcp-registrations/{keySha256}", "Read the original exact MCP registration receipt without repeating preparation or creation.", "bearer", undefined, "NativeConnectorMcpRegistrationReadResponse", {
    ...connectorNativeOptions, pathParameters: nativeActionRecoveryPath,
  }),
];

const v45Operations: readonly NativeOperation[] = [
  ...v44Operations,
  operation("connectors.native.openapiImportPreparations.submit", "POST", "/api/connectors/native/openapi-import-preparations", "Reserve one exact OpenAPI import attempt, fetch a public spec once or parse transient text, and return safe preparation evidence without creating a connector or executing API operations.", "bearer", "NativeConnectorOpenapiImportPrepareRequest", "NativeConnectorOpenapiImportPreparationSubmitResponse", {
    ...connectorNativeOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 4_100_000,
    successStatuses: [200, 201, 202], errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("connectors.native.openapiImportPreparations.read", "GET", "/api/connectors/native/openapi-import-preparations/{keySha256}", "Read the original owner's exact OpenAPI attempt, complete ready summary or terminal preparation evidence without fetching or retrying private input.", "bearer", undefined, "NativeConnectorOpenapiImportPreparationReadResponse", {
    ...connectorNativeOptions, pathParameters: nativeActionRecoveryPath,
  }),
  operation("connectors.native.openapiImportPreparations.abandon", "POST", "/api/connectors/native/openapi-import-preparations/{keySha256}/abandon", "Permanently abandon the original owner's exact OpenAPI import preparation, including an absent-key tombstone that fences delayed preparation.", "bearer", "NativeConnectorOpenapiImportPreparationAbandonRequest", "NativeConnectorOpenapiImportPreparationAbandonResponse", {
    ...connectorNativeOptions, pathParameters: nativeActionRecoveryPath, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 16_384,
    successStatuses: [200, 201], errorStatuses: [400, 401, 403, 409, 413, 415, 500, 503],
  }),
  operation("connectors.native.openapiImports.submit", "POST", "/api/connectors/native/openapi-imports", "Consume one exact captured OpenAPI snapshot to create its reserved connector disabled with every imported operation pending review, without refetching or executing an API operation.", "bearer", "NativeConnectorOpenapiImportRequest", "NativeConnectorOpenapiImportSubmitResponse", {
    ...connectorNativeOptions, headerParameters: pluginMutationHeaders, requestBodyMaxBytes: 8192,
    successStatuses: [200, 201], errorStatuses: [400, 401, 403, 404, 409, 413, 415, 500, 503],
  }),
  operation("connectors.native.openapiImports.read", "GET", "/api/connectors/native/openapi-imports/{keySha256}", "Read the original exact OpenAPI import receipt without repeating preparation or creation.", "bearer", undefined, "NativeConnectorOpenapiImportReadResponse", {
    ...connectorNativeOptions, pathParameters: nativeActionRecoveryPath,
  }),
];

const nativeCompanionPreferencesResponseSchema = z.object({
  schemaVersion: z.literal(1), contract: z.literal(COMPANION_PREFERENCES_CONTRACT),
  snapshot: z.object({
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), persisted: z.boolean(),
    updatedAt: isoDateTime.nullable(), preferences: companionPreferencesSchema,
  }).strict(),
  home: z.object({
    state: z.enum(["not_set", "available", "unavailable", "unconfirmed"]),
    preferredThreadId: companionThreadIdSchema.nullable(), href: z.string().min(1).max(4096).nullable(),
    fallbackHref: z.literal("/app/command"),
  }).strict(),
  destination: z.object({ href: z.string().min(1).max(4096), state: z.enum(["configured", "fallback"]) }).strict(),
  mutation: z.object({
    outcome: z.enum(["saved", "replayed"]), receiptId: z.string().regex(/^companion:[a-f0-9]{64}$/),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), savedAt: isoDateTime,
    preferences: companionPreferencesSchema,
  }).strict().optional(),
}).strict();

export const nativeContractSchemas = Object.freeze({
  ...nativeGooglePersonalSchemas,
  ...nativeConnectorSchemas,
  ...nativeConnectorCredentialRemovalSchemas,
  ...nativeConnectorTrashSchemas,
  ...nativeConnectorCredentialRotationSchemas,
  ...nativeConnectorMcpRegistrationSchemas,
  ...nativeConnectorOpenapiImportSchemas,
  ...nativeResponsibilityContractSchemas,
  ...nativeMeetingContractSchemas,
  ...nativeCustomerContractSchemas,
  ...nativeCustomerDetailContractSchemas,
  ...nativeCustomerMutationContractSchemas,
  ...nativeCustomerHealthMutationSchemas,
  ...nativeCustomerWorkflowMutationSchemas,
  ...nativeAgentSkillMutationSchemas,
  ...nativeMeetingRecordingSchemas,
  ...nativeCustomerFactMutationSchemas,
  ...nativeSalesforceActionSchemas,
  ...nativeKnowledgeCognificationSchemas,
  ...nativeKnowledgeSourceDeletionSchemas,
  ...nativeMemoryGraphReadSchemas,
  ...nativeMemoryMaintenanceSchemas,
  ...nativeMemoryGraphRebuildSchemas,
  ...nativeKnowledgeCognitionBuildSchemas,
  ...nativeLibraryContractSchemas,
  ...nativeLibraryHistoryContractSchemas,
  ...entityOptionsContractSchemas,
  ...nativeMarketReadContractSchemas,
  ...nativeMemoryMutationSchemas,
  ...nativeMemoryReconciliationSchemas,
  ...nativeMemoryPromotionSchemas,
  ...nativePersonalContextConsentSchemas,
  ...nativeMeetingCalendarSchemas,
  NativeCompanionPreferencesRequest: companionChangeSchema,
  NativeCompanionPreferencesResponse: nativeCompanionPreferencesResponseSchema,
  NativeContentSearchResponse: contentSearchResponseSchema,
  NativeContentSearchWorkResponse: z.object({ project: jsonObject }).strict(),
  NativeContentSearchMemoryResponse: z.object({ memory: jsonObject }).strict(),
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
  NativeCommandModelCatalogResponse: nativeCommandModelCatalogResponseSchema,
  NativeRealtimeVoiceSessionStartRequest: nativeRealtimeVoiceSessionStartRequestSchema,
  NativeRealtimeVoiceSessionStartResponse: nativeRealtimeVoiceSessionStartResponseSchema,
  NativeRealtimeVoiceSessionFinishRequest: nativeRealtimeVoiceSessionFinishRequestSchema,
  NativeRealtimeVoiceSessionFinishResponse: nativeRealtimeVoiceSessionFinishResponseSchema,
  NativeSpeechStreamRequest: nativeSpeechStreamRequestSchema,
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
  if (version === 28) return v28Operations;
  if (version === 29) return v29Operations;
  if (version === 30) return v30Operations;
  if (version === 31) return v31Operations;
  if (version === 32) return v32Operations;
  if (version === 33) return v33Operations;
  if (version === 34) return v34Operations;
  if (version === 35) return v35Operations;
  if (version === 36) return v36Operations;
  if (version === 37) return v37Operations;
  if (version === 38) return v38Operations;
  if (version === 39) return v39Operations;
  if (version === 40) return v40Operations;
  if (version === 41) return v41Operations;
  if (version === 42) return v42Operations;
  if (version === 43) return v43Operations;
  if (version === 44) return v44Operations;
  if (version === 45) return v45Operations;
  return undefined;
}

export function nativeContractDiscovery() {
  return {
    schemaVersion: 1 as const,
    contractId: NATIVE_API_CONTRACT_ID,
    currentVersion: NATIVE_API_CURRENT_VERSION,
    previousVersion: NATIVE_API_PREVIOUS_VERSION,
    supportedVersions: [...NATIVE_API_SUPPORTED_VERSIONS] as [
      typeof NATIVE_API_CURRENT_VERSION, typeof NATIVE_API_PREVIOUS_VERSION,
    ],
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
  responseSchema: string | undefined,
  options: Pick<NativeOperation,
    | "queryParameters"
    | "headerParameters"
    | "binaryResponse"
    | "responseMediaType"
    | "responseHeaders"
    | "successStatuses"
    | "errorStatuses"
    | "errorResponseSchema"
    | "pathParameters"
    | "queryPolicy"
    | "requestBodyMaxBytes"
  > = {},
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
