import {
  controlProjectExecutionService,
  createProjectService,
  createWorkItemService,
  listProjectsService,
  planProjectService,
  recordProjectArtifactFeedbackService,
  showProjectService,
  updateProjectService,
  updateWorkItemService,
} from "@/lib/app-services/projects";
import {
  bindProjectBuilderRepositoryService,
  createProjectBuilderService,
  createProjectBuilderCheckpointService,
  createProjectBuilderPreviewDeploymentService,
  deliverProjectBuilderPullRequestService,
  listProjectBuilderRepositoriesService,
  listProjectBuilderTreeService,
  readProjectBuilderFileService,
  recordProjectBuilderSentinelReviewService,
  refreshProjectBuilderPreviewDeploymentService,
  restoreProjectBuilderCheckpointService,
  runProjectBuilderVerificationService,
  runProjectBuilderCommandService,
  showProjectBuilderVerificationService,
  showProjectBuilderService,
  stopProjectBuilderService,
  updateProjectBuilderFileService,
} from "@/lib/app-services/app-builder";
import {
  getWorkspaceReadinessService,
  getWorkspaceSummaryService,
} from "@/lib/app-services/workspaces";
import { showTruthfulIntegrationsService } from "@/lib/app-services/integrations";
import { showSourceCoverageService } from "@/lib/app-services/source-coverage";
import {
  generateMarketAnalysisVersionService,
  generateMarketForecastService,
  listMarketAnalysisVersionsService,
  listMarketResearchBarsService,
  listMarketForecastJournalService,
  scoreDueMarketForecastsService,
  showMarketResearchOverviewService,
  showMarketResearchBaselinesService,
  showMarketResearchFeaturesService,
} from "@/lib/app-services/market-research";
import { showMemoryIntelligenceService } from "@/lib/app-services/memory-intelligence";
import {
  deleteGovernedKnowledgeSourceService,
  ingestKnowledgeService,
  listKnowledgeService,
  previewGovernedKnowledgeSourceDeleteService,
  searchKnowledgeService,
} from "@/lib/app-services/knowledge";
import {
  correctMemoryService,
  forgetMemoryService,
  inspectMemoryService,
  listMemoryService,
  prepareMemoryExportService,
  previewMemoryForgetService,
  searchMemoryService,
  updateMemoryLifecycleService,
  writeMemoryService,
} from "@/lib/app-services/memory";
import { showReadableMemoryService } from "@/lib/app-services/readable-memory";
import {
  listSharedMemoryService,
  writeSharedMemoryService,
} from "@/lib/app-services/shared-memory";
import {
  instantiateWorkspaceTemplateService,
  listWorkspaceTemplatesService,
  publishWorkspaceTemplateService,
} from "@/lib/app-services/workspace-templates";
import {
  createMeetingService,
  listMeetingsService,
  listMeetingCommitmentsService,
  proposeMeetingCommitmentService,
  resolveMeetingCommitmentService,
  showMeetingService,
  updateMeetingService,
} from "@/lib/app-services/meetings";
import {
  createCustomerAccountService,
  listCustomerAccountsService,
  recordCustomerFactService,
  reviseCustomerAccountService,
  showCustomerAccountService,
} from "@/lib/app-services/customer-accounts";
import {
  configureSalesforceWritesService,
  executeSalesforceRecordWriteService,
} from "@/lib/app-services/salesforce-writes";
import {
  evaluateCustomerHealthService,
  showCustomerHealthService,
} from "@/lib/app-services/customer-health";
import {
  listCustomerSuccessWorkflowsService,
  recordCustomerSuccessWorkflowOutcomeService,
  startCustomerSuccessWorkflowService,
} from "@/lib/app-services/customer-success-workflows";
import {
  showCustomerSuccessIntelligenceService,
  showCustomerSuccessPortfolioService,
} from "@/lib/app-services/customer-success-intelligence";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import {
  createTodayItemService,
  generateTodayBriefService,
  showTodayBriefService,
  showTodayService,
  updateTodayItemService,
  updateTodayPreferencesService,
} from "@/lib/app-services/today";
import { showCohesiveTodayService } from "@/lib/app-services/cohesive-today";
import {
  listNotificationsService,
  readAllNotificationsService,
  updateNotificationService,
} from "@/lib/app-services/notifications";
import {
  cancelRunService,
  inspectRunActivityService,
  inspectRunTrajectoryService,
  listRunsService,
  recordRunFeedbackService,
  showRunService,
} from "@/lib/app-services/runs";
import {
  createAgentService,
  createSkillService,
  deleteAgentService,
  deleteSkillService,
  discoverAgentCardsService,
  listAgentsService,
  listSkillsService,
  previewAgentDeleteService,
  previewSkillDeleteService,
  showAgentService,
  showAgentPerformanceService,
  showAgentCouncilMapService,
  showSkillService,
  updateAgentService,
  updateSkillService,
} from "@/lib/app-services/agents";
import {
  listWorkflowExecutionsService,
  listWorkflowPlansService,
  listWorkflowsService,
  planWorkflowService,
  showWorkflowService,
  signalWorkflowService,
  startWorkflowService,
  tickWorkflowService,
} from "@/lib/app-services/workflows";
import { showWorkflowTrajectoryService } from "@/lib/app-services/workflow-inspection";
import {
  deleteConnectorService,
  listConnectorsService,
  previewConnectorDeleteService,
  refreshConnectorService,
  registerConnectorService,
  reviewConnectorService,
  showConnectorService,
  updateConnectorService,
} from "@/lib/app-services/connectors";
import {
  listApiKeysService,
  listModelsService,
  previewApiKeyRevokeService,
  previewProviderRevokeService,
  revokeApiKeyService,
  revokeProviderService,
  showSettingsService,
  updateMcpExportService,
  updateModelAssignmentService,
  updateProviderService,
  validateProviderService,
} from "@/lib/app-services/settings";
import {
  completeRecordingService,
  deleteAssetService,
  indexStoredAssetService,
  listAssetsService,
  previewAssetDeleteService,
  showAssetService,
  startRecordingService,
  updateRecordingService,
} from "@/lib/app-services/assets";
import {
  createAgentGrantService,
  evaluateAgentReleaseService,
  listAgentAdaptationsService,
  listAgentGrantsService,
  manageAgentAdaptationService,
  previewAgentGrantRevokeService,
  previewAgentRetirementService,
  refreshAgentAdaptationsService,
  retireAgentReleaseService,
  revokeAgentGrantService,
  showAgentReleaseService,
  transitionAgentReleaseService,
} from "@/lib/app-services/agent-governance";
import {
  listTrashReceiptsService,
  listTrashService,
  previewTrashPurgeService,
  previewTrashRestoreService,
  purgeTrashService,
  restoreTrashService,
  showTrashService,
} from "@/lib/app-services/trash";
import {
  createCommunicationDraftService,
  deliverCommunicationDraftService,
  listCommunicationDraftsService,
  listCommunicationPoliciesService,
  upsertCommunicationPolicyService,
} from "@/lib/app-services/communications";
import {
  listAp2MandateReviewsService,
  listAp2PaymentTransactionsService,
  prepareAp2MandateReviewService,
  showAp2PaymentTransactionService,
  showAp2ReadinessService,
} from "@/lib/app-services/payments";

export type FirstPartyAppToolDispatch =
  | { handled: false }
  | { handled: true; result: unknown };

export async function executeFirstPartyAppTool(input: {
  toolId: string;
  toolInput: Record<string, unknown>;
  context?: SecurityContext;
  executionScope?: ExecutionScope;
  idempotencyKey?: string;
}): Promise<FirstPartyAppToolDispatch> {
  if (!input.toolId.startsWith("app.")) return { handled: false };
  if (!input.context) {
    throw new Error("First-party application tools require an authenticated tenant and actor context.");
  }
  const caller = createAppServiceCaller({
    context: input.context,
    executionScope: input.executionScope,
    idempotencyKey: input.idempotencyKey,
  });
  const handlers: Record<string, () => Promise<unknown>> = {
    "app.workspaces.summary": () => getWorkspaceSummaryService(caller, input.toolInput as never),
    "app.workspaces.readiness": () => getWorkspaceReadinessService(caller, input.toolInput as never),
    "app.integrations.overview.show": () => showTruthfulIntegrationsService(caller, input.toolInput as never),
    "app.sources.coverage.show": () => showSourceCoverageService(caller, input.toolInput as never),
    "app.market_research.overview.show": () => showMarketResearchOverviewService(caller),
    "app.market_research.bars.list": () => listMarketResearchBarsService(caller, input.toolInput as never),
    "app.market_research.features.show": () => showMarketResearchFeaturesService(caller, input.toolInput as never),
    "app.market_research.analysis.list": () => listMarketAnalysisVersionsService(caller, input.toolInput as never),
    "app.market_research.analysis.generate": () => generateMarketAnalysisVersionService(caller, input.toolInput as never),
    "app.market_research.baselines.show": () => showMarketResearchBaselinesService(caller, input.toolInput as never),
    "app.market_research.journal.list": () => listMarketForecastJournalService(caller, input.toolInput as never),
    "app.market_research.journal.generate": () => generateMarketForecastService(caller, input.toolInput as never),
    "app.market_research.journal.score": () => scoreDueMarketForecastsService(caller, input.toolInput as never),
    "app.memory.intelligence.show": () => showMemoryIntelligenceService(caller, input.toolInput as never),
    "app.memory.shared.list": () => listSharedMemoryService(caller, input.toolInput as never),
    "app.memory.shared.write": () => writeSharedMemoryService(caller, input.toolInput as never),
    "app.workspace_templates.list": () => listWorkspaceTemplatesService(caller, input.toolInput as never),
    "app.workspace_templates.publish": () => publishWorkspaceTemplateService(caller, input.toolInput as never),
    "app.workspace_templates.instantiate": () => instantiateWorkspaceTemplateService(caller, input.toolInput as never),
    "app.meetings.list": () => listMeetingsService(caller, input.toolInput as never),
    "app.meetings.show": () => showMeetingService(caller, input.toolInput as never),
    "app.meetings.create": () => createMeetingService(caller, input.toolInput as never),
    "app.meetings.update": () => updateMeetingService(caller, input.toolInput as never),
    "app.meetings.commitments.list": () => listMeetingCommitmentsService(caller, input.toolInput as never),
    "app.meetings.commitments.propose": () => proposeMeetingCommitmentService(caller, input.toolInput as never),
    "app.meetings.commitments.resolve": () => resolveMeetingCommitmentService(caller, input.toolInput as never),
    "app.customer_accounts.list": () => listCustomerAccountsService(caller, input.toolInput as never),
    "app.customer_accounts.show": () => showCustomerAccountService(caller, input.toolInput as never),
    "app.customer_accounts.portfolio.show": () => showCustomerSuccessPortfolioService(caller, input.toolInput as never),
    "app.customer_accounts.intelligence.show": () => showCustomerSuccessIntelligenceService(caller, input.toolInput as never),
    "app.customer_accounts.create": () => createCustomerAccountService(caller, input.toolInput as never),
    "app.customer_accounts.revise": () => reviseCustomerAccountService(caller, input.toolInput as never),
    "app.customer_accounts.facts.record": () => recordCustomerFactService(caller, input.toolInput as never),
    "app.customer_accounts.health.show": () => showCustomerHealthService(caller, input.toolInput as never),
    "app.customer_accounts.health.evaluate": () => evaluateCustomerHealthService(caller, input.toolInput as never),
    "app.customer_accounts.workflows.list": () => listCustomerSuccessWorkflowsService(caller, input.toolInput as never),
    "app.customer_accounts.workflows.start": () => startCustomerSuccessWorkflowService(caller, input.toolInput as never),
    "app.customer_accounts.workflows.outcome.record": () => recordCustomerSuccessWorkflowOutcomeService(caller, input.toolInput as never),
    "app.customer_accounts.salesforce.writes.configure": () => configureSalesforceWritesService(caller, input.toolInput as never),
    "app.customer_accounts.salesforce.contact.create": () => executeSalesforceRecordWriteService(caller, "app.customer_accounts.salesforce.contact.create", input.toolInput),
    "app.customer_accounts.salesforce.contact.update": () => executeSalesforceRecordWriteService(caller, "app.customer_accounts.salesforce.contact.update", input.toolInput),
    "app.customer_accounts.salesforce.task.create": () => executeSalesforceRecordWriteService(caller, "app.customer_accounts.salesforce.task.create", input.toolInput),
    "app.customer_accounts.salesforce.task.update": () => executeSalesforceRecordWriteService(caller, "app.customer_accounts.salesforce.task.update", input.toolInput),
    "app.customer_accounts.salesforce.note.update": () => executeSalesforceRecordWriteService(caller, "app.customer_accounts.salesforce.note.update", input.toolInput),
    "app.customer_accounts.salesforce.case.create": () => executeSalesforceRecordWriteService(caller, "app.customer_accounts.salesforce.case.create", input.toolInput),
    "app.customer_accounts.salesforce.case.update": () => executeSalesforceRecordWriteService(caller, "app.customer_accounts.salesforce.case.update", input.toolInput),
    "app.customer_accounts.salesforce.opportunity.create": () => executeSalesforceRecordWriteService(caller, "app.customer_accounts.salesforce.opportunity.create", input.toolInput),
    "app.customer_accounts.salesforce.opportunity.update": () => executeSalesforceRecordWriteService(caller, "app.customer_accounts.salesforce.opportunity.update", input.toolInput),
    "app.customer_accounts.salesforce.account.update": () => executeSalesforceRecordWriteService(caller, "app.customer_accounts.salesforce.account.update", input.toolInput),
    "app.projects.list": () => listProjectsService(caller, input.toolInput as never),
    "app.projects.show": () => showProjectService(caller, input.toolInput as never),
    "app.projects.create": () => createProjectService(caller, input.toolInput as never),
    "app.projects.update": () => updateProjectService(caller, input.toolInput as never),
    "app.projects.plan": () => planProjectService(caller, input.toolInput as never),
    "app.projects.execution.control": () => controlProjectExecutionService(caller, input.toolInput as never),
    "app.projects.artifacts.feedback": () => recordProjectArtifactFeedbackService(caller, input.toolInput as never),
    "app.projects.builder.show": () => showProjectBuilderService(caller, input.toolInput as never),
    "app.projects.builder.create": () => createProjectBuilderService(caller, input.toolInput as never),
    "app.projects.builder.tree": () => listProjectBuilderTreeService(caller, input.toolInput as never),
    "app.projects.builder.file.read": () => readProjectBuilderFileService(caller, input.toolInput as never),
    "app.projects.builder.file.update": () => updateProjectBuilderFileService(caller, input.toolInput as never),
    "app.projects.builder.command.run": () => runProjectBuilderCommandService(caller, input.toolInput as never),
    "app.projects.builder.checkpoint.create": () => createProjectBuilderCheckpointService(caller, input.toolInput as never),
    "app.projects.builder.checkpoint.restore": () => restoreProjectBuilderCheckpointService(caller, input.toolInput as never),
    "app.projects.builder.verification.show": () => showProjectBuilderVerificationService(caller, input.toolInput as never),
    "app.projects.builder.verification.run": () => runProjectBuilderVerificationService(caller, input.toolInput as never),
    "app.projects.builder.sentinel.record": () => recordProjectBuilderSentinelReviewService(caller, input.toolInput as never),
    "app.projects.builder.repositories.list": () => listProjectBuilderRepositoriesService(caller, input.toolInput as never),
    "app.projects.builder.repository.bind": () => bindProjectBuilderRepositoryService(caller, input.toolInput as never),
    "app.projects.builder.delivery.create": () => deliverProjectBuilderPullRequestService(caller, input.toolInput as never),
    "app.projects.builder.deployment.preview": () => createProjectBuilderPreviewDeploymentService(caller, input.toolInput as never),
    "app.projects.builder.deployment.refresh": () => refreshProjectBuilderPreviewDeploymentService(caller, input.toolInput as never),
    "app.projects.builder.stop": () => stopProjectBuilderService(caller, input.toolInput as never),
    "app.work_items.create": () => createWorkItemService(caller, input.toolInput as never),
    "app.work_items.update": () => updateWorkItemService(caller, input.toolInput as never),
    "app.memory.list": () => listMemoryService(caller, input.toolInput as never),
    "app.memory.readable.show": () => showReadableMemoryService(caller, input.toolInput as never),
    "app.memory.search": () => searchMemoryService(caller, input.toolInput as never),
    "app.memory.inspect": () => inspectMemoryService(caller, input.toolInput as never),
    "app.memory.write": () => writeMemoryService(caller, input.toolInput as never),
    "app.memory.correct": () => correctMemoryService(caller, memoryCorrectionInput(input.toolInput) as never),
    "app.memory.lifecycle": () => updateMemoryLifecycleService(caller, input.toolInput as never),
    "app.memory.forget.preview": () => previewMemoryForgetService(caller, input.toolInput as never),
    "app.memory.forget": () => forgetMemoryService(caller, input.toolInput as never),
    "app.memory.export": () => Promise.resolve(prepareMemoryExportService(caller)),
    "app.knowledge.list": () => listKnowledgeService(caller, input.toolInput as never),
    "app.knowledge.search": () => searchKnowledgeService(caller, input.toolInput as never),
    "app.knowledge.ingest": () => ingestKnowledgeService(caller, input.toolInput as never),
    "app.knowledge.delete.preview": () => previewGovernedKnowledgeSourceDeleteService(caller, input.toolInput as never),
    "app.knowledge.delete": () => deleteGovernedKnowledgeSourceService(caller, input.toolInput as never),
    "app.today.show": () => showTodayService(caller, input.toolInput as never),
    "app.today.agenda.show": () => showCohesiveTodayService(caller, input.toolInput as never),
    "app.today.item.create": () => createTodayItemService(caller, input.toolInput as never),
    "app.today.item.update": () => updateTodayItemService(caller, input.toolInput as never),
    "app.today.brief.show": () => showTodayBriefService(caller, input.toolInput as never),
    "app.today.brief.generate": () => generateTodayBriefService(caller, input.toolInput as never),
    "app.today.preferences.update": () => updateTodayPreferencesService(caller, input.toolInput as never),
    "app.notifications.list": () => listNotificationsService(caller, input.toolInput as never),
    "app.notifications.update": () => updateNotificationService(caller, input.toolInput as never),
    "app.notifications.read_all": () => readAllNotificationsService(caller, input.toolInput as never),
    "app.runs.list": () => listRunsService(caller, input.toolInput as never),
    "app.runs.show": () => showRunService(caller, input.toolInput as never),
    "app.runs.activity": () => inspectRunActivityService(caller, input.toolInput as never),
    "app.runs.trajectory": () => inspectRunTrajectoryService(caller, input.toolInput as never),
    "app.runs.feedback": () => recordRunFeedbackService(caller, input.toolInput as never),
    "app.runs.cancel": () => cancelRunService(caller, input.toolInput as never),
    "app.agents.list": () => listAgentsService(caller, input.toolInput as never),
    "app.agents.show": () => showAgentService(caller, input.toolInput as never),
    "app.agents.cards": () => discoverAgentCardsService(caller, input.toolInput as never),
    "app.agents.performance": () => showAgentPerformanceService(caller, input.toolInput as never),
    "app.agents.council.show": () => showAgentCouncilMapService(caller, input.toolInput as never),
    "app.agents.create": () => createAgentService(caller, input.toolInput as never),
    "app.agents.update": () => updateAgentService(caller, input.toolInput as never),
    "app.agents.delete.preview": () => previewAgentDeleteService(caller, input.toolInput as never),
    "app.agents.delete": () => deleteAgentService(caller, input.toolInput as never),
    "app.agents.release.show": () => showAgentReleaseService(caller, input.toolInput as never),
    "app.agents.release.evaluate": () => evaluateAgentReleaseService(caller, input.toolInput as never),
    "app.agents.release.transition": () => transitionAgentReleaseService(caller, input.toolInput as never),
    "app.agents.release.retire.preview": () => previewAgentRetirementService(caller, input.toolInput as never),
    "app.agents.release.retire": () => retireAgentReleaseService(caller, input.toolInput as never),
    "app.agents.grants.list": () => listAgentGrantsService(caller, input.toolInput as never),
    "app.agents.grants.create": () => createAgentGrantService(caller, input.toolInput as never),
    "app.agents.grants.revoke.preview": () => previewAgentGrantRevokeService(caller, input.toolInput as never),
    "app.agents.grants.revoke": () => revokeAgentGrantService(caller, input.toolInput as never),
    "app.agents.adaptations.list": () => listAgentAdaptationsService(caller, input.toolInput as never),
    "app.agents.adaptations.refresh": () => refreshAgentAdaptationsService(caller, input.toolInput as never),
    "app.agents.adaptations.manage": () => manageAgentAdaptationService(caller, input.toolInput as never),
    "app.skills.list": () => listSkillsService(caller, input.toolInput as never),
    "app.skills.show": () => showSkillService(caller, input.toolInput as never),
    "app.skills.create": () => createSkillService(caller, input.toolInput as never),
    "app.skills.update": () => updateSkillService(caller, input.toolInput as never),
    "app.skills.delete.preview": () => previewSkillDeleteService(caller, input.toolInput as never),
    "app.skills.delete": () => deleteSkillService(caller, input.toolInput as never),
    "app.workflows.list": () => listWorkflowsService(caller, input.toolInput as never),
    "app.workflows.show": () => showWorkflowService(caller, input.toolInput as never),
    "app.workflows.trajectory": () => showWorkflowTrajectoryService(caller, input.toolInput as never),
    "app.workflows.plans.list": () => listWorkflowPlansService(caller, input.toolInput as never),
    "app.workflows.plan": () => planWorkflowService(caller, input.toolInput as never),
    "app.workflows.executions.list": () => listWorkflowExecutionsService(caller, input.toolInput as never),
    "app.workflows.start": () => startWorkflowService(caller, input.toolInput as never),
    "app.workflows.signal": () => signalWorkflowService(caller, input.toolInput as never),
    "app.workflows.tick": () => tickWorkflowService(caller, input.toolInput as never),
    "app.connectors.list": () => listConnectorsService(caller, input.toolInput as never),
    "app.connectors.show": () => showConnectorService(caller, input.toolInput as never),
    "app.connectors.register": () => registerConnectorService(caller, input.toolInput as never),
    "app.connectors.update": () => updateConnectorService(caller, input.toolInput as never),
    "app.connectors.refresh": () => refreshConnectorService(caller, input.toolInput as never),
    "app.connectors.review": () => reviewConnectorService(caller, input.toolInput as never),
    "app.connectors.delete.preview": () => previewConnectorDeleteService(caller, input.toolInput as never),
    "app.connectors.delete": () => deleteConnectorService(caller, input.toolInput as never),
    "app.trash.list": () => listTrashService(caller, input.toolInput as never),
    "app.trash.show": () => showTrashService(caller, input.toolInput as never),
    "app.trash.receipts.list": () => listTrashReceiptsService(caller, input.toolInput as never),
    "app.trash.restore.preview": () => previewTrashRestoreService(caller, input.toolInput as never),
    "app.trash.restore": () => restoreTrashService(caller, input.toolInput as never),
    "app.trash.purge.preview": () => previewTrashPurgeService(caller, input.toolInput as never),
    "app.trash.purge": () => purgeTrashService(caller, input.toolInput as never),
    "app.settings.show": () => showSettingsService(caller, input.toolInput as never),
    "app.settings.models.list": () => listModelsService(caller, input.toolInput as never),
    "app.settings.assignments.update": () => updateModelAssignmentService(caller, input.toolInput as never),
    "app.settings.mcp.update": () => updateMcpExportService(caller, input.toolInput as never),
    "app.settings.providers.update": () => updateProviderService(caller, input.toolInput as never),
    "app.settings.providers.validate": () => validateProviderService(caller, input.toolInput as never),
    "app.settings.providers.revoke.preview": () => previewProviderRevokeService(caller, input.toolInput as never),
    "app.settings.providers.revoke": () => revokeProviderService(caller, input.toolInput as never),
    "app.settings.api_keys.list": () => listApiKeysService(caller, input.toolInput as never),
    "app.settings.api_keys.revoke.preview": () => previewApiKeyRevokeService(caller, input.toolInput as never),
    "app.settings.api_keys.revoke": () => revokeApiKeyService(caller, input.toolInput as never),
    "app.communications.policies.list": () => listCommunicationPoliciesService(caller, input.toolInput as never),
    "app.communications.policies.upsert": () => upsertCommunicationPolicyService(caller, input.toolInput as never),
    "app.communications.drafts.list": () => listCommunicationDraftsService(caller, input.toolInput as never),
    "app.communications.drafts.create": () => createCommunicationDraftService(caller, input.toolInput as never),
    "app.communications.deliver": () => deliverCommunicationDraftService(caller, input.toolInput as never),
    "app.payments.ap2.readiness": () => showAp2ReadinessService(caller, input.toolInput as never),
    "app.payments.ap2.transactions.list": () => listAp2PaymentTransactionsService(caller, input.toolInput as never),
    "app.payments.ap2.transactions.show": () => showAp2PaymentTransactionService(caller, input.toolInput as never),
    "app.payments.ap2.mandates.list": () => listAp2MandateReviewsService(caller, input.toolInput as never),
    "app.payments.ap2.mandates.prepare": () => prepareAp2MandateReviewService(caller, input.toolInput as never),
    "app.assets.list": () => listAssetsService(caller, input.toolInput as never),
    "app.assets.show": () => showAssetService(caller, input.toolInput as never),
    "app.assets.index": () => indexStoredAssetService(caller, input.toolInput as never),
    "app.assets.recordings.start": () => startRecordingService(caller, input.toolInput as never),
    "app.assets.recordings.update": () => updateRecordingService(caller, input.toolInput as never),
    "app.assets.recordings.complete": () => completeRecordingService(caller, input.toolInput as never),
    "app.assets.delete.preview": () => previewAssetDeleteService(caller, input.toolInput as never),
    "app.assets.delete": () => deleteAssetService(caller, input.toolInput as never),
  };
  const handler = handlers[input.toolId];
  if (!handler) throw new Error(`No first-party application handler is registered for ${input.toolId}.`);
  const service = await handler() as { data?: unknown; receipt?: unknown };
  return {
    handled: true,
    result: service && typeof service === "object" && "data" in service
      ? { ...asRecord(service.data), serviceReceipt: service.receipt }
      : service,
  };
}

function memoryCorrectionInput(value: Record<string, unknown>) {
  const { id, ...correction } = value;
  return { id, correction };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}
