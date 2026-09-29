import "server-only";

import { runTableMigrations } from "@/lib/db/schema/base";
import {
  ensureAgentRunCancellationRetention,
  ensureAsaelCanonicalIdentity,
  ensureAssetObjectBackfillReceiptsV1,
  ensureDatabaseIdentity,
  ensureMcpConnectorCredentialVault,
  ensureMobileSessions,
  ensureNativeClientCompatibilityTelemetry,
  ensurePlatformSafetyControls,
  ensureSensitiveDataRetention,
  ensureSettingsControlPlane,
  ensureTenantCapabilityRollouts,
  ensureTenantOwnedOperationalSchema,
  ensureTenantScopedAssetObjectPlaneV1,
  ensureUnifiedAiUsageLedger,
  ensureUnifiedAiUsageLedgerCompatibility,
  normalizeLegacyJsonbStorage,
} from "@/lib/db/schema/platform";
import { ensureTenantIsolationPolicies } from "@/lib/db/schema/tenant-isolation";
import {
  ensureActorPrivateRunThreadLedgers,
  ensureActorPrivateToolExecutionLedgers,
  ensureActorScopedEventCorrelationIndex,
  ensureAgentRunTerminalReceiptsV1,
  ensureConversationSummaryDeletionBarrierV1,
  ensureConversationSummaryHierarchyV1,
  ensureConversationThreads,
  ensureDelegationTaskLifecycleV1,
  ensureGovernedToolEffectReceipts,
  ensureLoopV2ClarificationWait,
  ensureLoopV2InterruptionRecoveryV1,
  ensureLoopV2ModelTextEngine,
  ensureLoopV2TransitionCheckpoints,
  ensureRecurringFailureFeedbackV1,
  ensureRunCheckpointResumeClaims,
  ensureRunCheckpointStore,
  ensureToolExecutionRetentionRedactionV1,
} from "@/lib/db/schema/runs";
import {
  ensureAgentAdaptationLifecycleV1,
  ensureAgentAssignmentHistory,
  ensureAgentDefinitionPersonaV1,
  ensureAgentIdentityVersionsV1,
  ensureAgentMemoryGrantLifecycleV1,
  ensureAgentMemoryGrantsV1,
  ensureAgentOutcomeFeedback,
  ensureAgentPrivateMemoryV1,
  ensureAgentReleaseEnrollmentV1,
  ensureAgentReleaseLifecycleV1,
  ensureCustomAgentSkillReferenceIntegrity,
} from "@/lib/db/schema/agents";
import {
  ensureClaimBasedMemory,
  ensureEvidenceBasedMemoryFormation,
  ensureMemoryAccessAuthorizationDenyHook,
  ensureMemoryAccessScopeShadow,
  ensureMemoryAccessSessionContractShadow,
  ensureMemoryDeletionBarriers,
  ensureMemoryDeletionScrubLeaseContract,
  ensureMemoryGraphRebuildGenerationLeases,
  ensureMemoryGraphRebuildQueue,
  ensureMemoryLifecycleMaintenanceV1,
  ensureMemoryReconciliationInboxV1,
  ensureMemoryTierPolicyV1,
  ensurePersistedAnswerGrounding,
  reconcileLegacyMemoryGraphOwnership,
} from "@/lib/db/schema/memory";
import {
  ensureEntityBitemporalRelationsV1,
  ensureEntityEvidenceLineageBarrier,
  ensureEntityMemoryDeletionBarrier,
  ensureEntityMemoryLineageOwnerProbe,
  ensureEntityRegistryIdentityTriggerDispatch,
  ensureEntityRegistryV1,
  ensureEntityRelationProjectionV1,
  ensureGraphQueryTelemetryV1,
} from "@/lib/db/schema/entities";
import {
  ensureMemoryPurposeCatalog,
  ensureTenantActorMemoryPurposeConsents,
  ensureTenantMemoryAccessGrantsShadow,
  ensureTenantMemoryDataRightRequestsShadow,
  ensureTenantMemoryOperationPoliciesShadow,
  ensureTenantMemoryPurposeEntitlements,
} from "@/lib/db/schema/memory-purposes";
import {
  ensureMemoryInformedNoticeAnchorReviewEvidenceShadow,
  ensureMemoryInformedNoticeAuthorityBoundaryVerification,
  ensureMemoryInformedNoticeGovernanceEvidenceShadow,
  ensureMemoryInformedNoticeReceiptsAndConsentV2Shadow,
} from "@/lib/db/schema/memory-notices";
import {
  ensureCanonicalAuthUserActorIdentifiersShadow,
  ensureCanonicalAuthUserActorIdsShadow,
  ensureMembershipManagementBootstrapEvidenceShadow,
  ensureTenantActorMembershipEpochsShadow,
  ensureTenantActorMembershipManagementAuthoritiesShadow,
  ensureTenantExecutionPrincipalsShadow,
  ensureTenantWorkspaceMembershipAuthorityShadow,
} from "@/lib/db/schema/identity";
import {
  ensureCanonicalSourceConvergenceFoundation,
  ensureCanonicalSourceLineageShadow,
  ensureDriveGeneration2RolloutBoundCheckpoints,
  ensureDriveSyncV2ShadowCheckpoints,
  ensureOAuthGrants,
  ensureOAuthIncrementalSyncHealth,
} from "@/lib/db/schema/sources";
import {
  ensureAutonomousProjectExecution,
  ensureCaptureRecordingRequestReadIndex,
  ensureCaptureRecordings,
  ensureCaptureStructuredExtractionV1,
  ensureMissionKanbanTaskMetadata,
  ensureMissionKernel,
  ensurePersonalNotificationCenter,
  ensurePersonalProjects,
  ensureProactiveDailyBriefs,
  ensureProjectArtifactReflections,
  ensureProjectArtifacts,
  ensureTodayItems,
} from "@/lib/db/schema/personal";
import type { SchemaMigrationUp } from "@/lib/db/sql-types";

/**
 * TypeScript steps for the ordered migrations that have no SQL file. Every
 * other version runs the SQL file named in schema-migrations.json, so that
 * file is the only definition of the version in every environment.
 */
export const typescriptSchemaMigrations: ReadonlyMap<number, SchemaMigrationUp> = new Map<
  number,
  SchemaMigrationUp
>([
  [1, runTableMigrations],
  [2, ensureTenantOwnedOperationalSchema],
  [3, ensureTenantIsolationPolicies],
  [4, ensurePlatformSafetyControls],
  [5, ensureSensitiveDataRetention],
  [
    6,
    async (sql) => {
      await ensureTenantOwnedOperationalSchema(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    7,
    async (sql) => {
      await ensureMemoryGraphRebuildQueue(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [8, ensureAgentRunCancellationRetention],
  [
    9,
    async (sql) => {
      await ensureMemoryGraphRebuildGenerationLeases(sql);
      await reconcileLegacyMemoryGraphOwnership(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [10, ensureDatabaseIdentity],
  [11, normalizeLegacyJsonbStorage],
  [
    12,
    async (sql) => {
      await ensureConversationThreads(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [13, ensureClaimBasedMemory],
  [14, ensurePersistedAnswerGrounding],
  [
    15,
    async (sql) => {
      await ensureOAuthGrants(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [16, ensureAgentAssignmentHistory],
  [17, ensureAgentOutcomeFeedback],
  [
    18,
    async (sql) => {
      await ensureTodayItems(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    19,
    async (sql) => {
      await ensureProactiveDailyBriefs(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    20,
    async (sql) => {
      await ensurePersonalNotificationCenter(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    21,
    async (sql) => {
      await ensurePersonalProjects(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [22, ensureAutonomousProjectExecution],
  [
    23,
    async (sql) => {
      await ensureProjectArtifacts(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [24, ensureProjectArtifactReflections],
  [25, ensureOAuthIncrementalSyncHealth],
  [
    27,
    async (sql) => {
      await ensureMissionKernel(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    28,
    async (sql) => {
      await ensureCaptureRecordings(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [29, ensureMissionKanbanTaskMetadata],
  [
    30,
    async (sql) => {
      await ensureSettingsControlPlane(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [31, ensureMcpConnectorCredentialVault],
  [
    32,
    async (sql) => {
      await ensureUnifiedAiUsageLedger(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    33,
    async (sql) => {
      await ensureUnifiedAiUsageLedgerCompatibility(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    34,
    async (sql) => {
      await ensureMobileSessions(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [35, ensureAsaelCanonicalIdentity],
  [36, ensureGovernedToolEffectReceipts],
  [
    37,
    async (sql) => {
      await ensureCanonicalSourceLineageShadow(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    38,
    async (sql) => {
      await ensureDriveSyncV2ShadowCheckpoints(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    39,
    async (sql) => {
      await ensureCanonicalSourceConvergenceFoundation(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    40,
    async (sql) => {
      await ensureTenantCapabilityRollouts(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    41,
    async (sql) => {
      await ensureDriveGeneration2RolloutBoundCheckpoints(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    42,
    async (sql) => {
      await ensureMemoryDeletionBarriers(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    43,
    async (sql) => {
      await ensureMemoryAccessScopeShadow(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [44, ensureMemoryAccessSessionContractShadow],
  [45, ensureMemoryAccessAuthorizationDenyHook],
  [46, ensureCanonicalAuthUserActorIdsShadow],
  [47, ensureMemoryPurposeCatalog],
  [48, ensureTenantMemoryPurposeEntitlements],
  [49, ensureTenantActorMemoryPurposeConsents],
  [50, ensureCanonicalAuthUserActorIdentifiersShadow],
  [51, ensureCustomAgentSkillReferenceIntegrity],
  [
    52,
    async (sql) => {
      await ensureTenantIsolationPolicies(sql);
      await ensureNativeClientCompatibilityTelemetry(sql);
    },
  ],
  [53, ensureCaptureRecordingRequestReadIndex],
  [54, ensureTenantActorMembershipEpochsShadow],
  [55, ensureMemoryInformedNoticeReceiptsAndConsentV2Shadow],
  [56, ensureTenantActorMembershipManagementAuthoritiesShadow],
  [57, ensureMembershipManagementBootstrapEvidenceShadow],
  [59, ensureMemoryDeletionScrubLeaseContract],
  [60, ensureTenantExecutionPrincipalsShadow],
  [61, ensureTenantWorkspaceMembershipAuthorityShadow],
  [62, ensureTenantMemoryAccessGrantsShadow],
  [63, ensureTenantMemoryOperationPoliciesShadow],
  [64, ensureTenantMemoryDataRightRequestsShadow],
  [65, ensureMemoryInformedNoticeAuthorityBoundaryVerification],
  [66, ensureMemoryInformedNoticeGovernanceEvidenceShadow],
  [67, ensureMemoryInformedNoticeAnchorReviewEvidenceShadow],
  [68, ensureRunCheckpointStore],
  [69, ensureRunCheckpointResumeClaims],
  [81, ensureActorPrivateRunThreadLedgers],
  [82, ensureActorPrivateToolExecutionLedgers],
  [83, ensureEvidenceBasedMemoryFormation],
  [84, ensureEntityRegistryV1],
  [85, ensureLoopV2TransitionCheckpoints],
  [86, ensureEntityMemoryDeletionBarrier],
  [87, ensureEntityMemoryLineageOwnerProbe],
  [88, ensureEntityRegistryIdentityTriggerDispatch],
  [89, ensureEntityEvidenceLineageBarrier],
  [90, ensureLoopV2ClarificationWait],
  [91, ensureLoopV2ModelTextEngine],
  [92, ensureToolExecutionRetentionRedactionV1],
  [93, ensureActorScopedEventCorrelationIndex],
  [94, ensureRecurringFailureFeedbackV1],
  [95, ensureLoopV2InterruptionRecoveryV1],
  [96, ensureAgentRunTerminalReceiptsV1],
  [
    97,
    async (sql) => {
      await ensureTenantScopedAssetObjectPlaneV1(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    98,
    async (sql) => {
      await ensureAssetObjectBackfillReceiptsV1(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [99, ensureCaptureStructuredExtractionV1],
  [100, ensureMemoryTierPolicyV1],
  [101, ensureMemoryReconciliationInboxV1],
  [102, ensureConversationSummaryHierarchyV1],
  [103, ensureConversationSummaryDeletionBarrierV1],
  [
    104,
    async (sql) => {
      await ensureMemoryLifecycleMaintenanceV1(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    105,
    async (sql) => {
      await ensureEntityBitemporalRelationsV1(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    106,
    async (sql) => {
      await ensureEntityRelationProjectionV1(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    107,
    async (sql) => {
      await ensureGraphQueryTelemetryV1(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    108,
    async (sql) => {
      await ensureAgentIdentityVersionsV1(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    109,
    async (sql) => {
      await ensureAgentDefinitionPersonaV1(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [110, ensureAgentPrivateMemoryV1],
  [
    111,
    async (sql) => {
      await ensureAgentMemoryGrantsV1(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [112, ensureAgentMemoryGrantLifecycleV1],
  [
    113,
    async (sql) => {
      await ensureAgentReleaseLifecycleV1(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [114, ensureAgentReleaseEnrollmentV1],
  [
    115,
    async (sql) => {
      await ensureAgentAdaptationLifecycleV1(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
  [
    116,
    async (sql) => {
      await ensureDelegationTaskLifecycleV1(sql);
      await ensureTenantIsolationPolicies(sql);
    },
  ],
]);
