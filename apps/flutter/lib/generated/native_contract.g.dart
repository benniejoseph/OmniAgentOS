// GENERATED FILE. DO NOT EDIT.
// Run npm run generate:native-contracts from the repository root.

abstract final class NativeContract {
  static const id = 'asael.native-api';
  static const currentVersion = 26;
  static const previousVersion = 25;
  static const supportedVersions = <int>[26, 25];
  static const discoveryPath = '/api/mobile/contracts';
  static const operationIds = <String>{
    'auth.login',
    'auth.refresh',
    'auth.logout',
    'bootstrap.get',
    'adoption.get',
    'contracts.get',
    'devices.list',
    'devices.change',
    'wipe.challenge',
    'wipe.acknowledge',
    'today.get',
    'today.create',
    'today.update',
    'today.brief',
    'conversation.send',
    'approvals.list',
    'approvals.decide',
    'workspaces.list',
    'workspaces.get',
    'workspaces.create',
    'workspaces.update',
    'capture.create',
    'meetings.list',
    'meetings.get',
    'notifications.list',
    'notifications.acknowledge',
    'evidence.run',
    'evidence.run.cancel',
    'evidence.workflow',
    'workspace.summary',
    'evaluations.list',
    'agents.list',
    'agents.performance',
    'skills.list',
    'memory.list',
    'memory.graph.get',
    'knowledge.list',
    'missions.list',
    'missions.get',
    'missions.events',
    'workspaces.plan',
    'workspaces.tasks.create',
    'workspaces.tasks.update',
    'workspaces.execute',
    'workspaces.artifacts.feedback',
    'admin.workflows',
    'admin.triggers',
    'admin.operations',
    'admin.connection.catalog',
    'admin.connectors',
    'admin.oauth',
    'admin.openapi.connectors',
    'admin.health',
    'admin.observability',
    'admin.slo',
    'admin.incidents',
    'admin.alerts',
    'admin.release.evidence',
    'admin.security.audits',
    'admin.security.isolation',
    'admin.security.retention',
    'admin.security.context',
    'admin.workspace.readiness',
    'admin.auth.controlPlane',
    'admin.system.migrations',
    'admin.data.export',
    'admin.tools',
    'admin.capabilities',
    'admin.trust',
    'capture.transcribe',
    'notifications.readAll',
    'push.registrations.list',
    'push.registrations.upsert',
    'push.registrations.revoke',
    'push.deliveries.acknowledge',
    'customers.get',
    'memory.intelligence.get',
    'memory.get',
    'customers.list',
    'customers.portfolio',
    'market.overview',
    'market.bars',
    'market.events',
    'market.events.backfill',
    'market.replays',
    'market.replays.backfill',
    'market.baselines',
    'market.features',
    'market.analysis',
    'market.journal',
    'market.journal.generate',
    'market.journal.score',
    'operations.job',
    'payments.readiness',
    'payments.reviews',
    'payments.authenticators',
    'payments.transactions',
    'settings.get',
    'settings.assignments.update',
    'workspaces.builder.get',
    'workspaces.builder.update',
    'market.backtests',
    'market.backtests.run',
    'threads.list',
    'threads.get',
    'capture.asset.get',
    'localComputer.device',
    'localComputer.device.update',
    'localComputer.command.claim',
    'localComputer.command.complete',
    'localComputer.stop',
    'push.delivery.receipts',
    'push.canary.targets',
    'push.canary.run',
    'plugins.list',
    'integrations.overview',
    'plugins.preview',
    'plugins.install',
    'plugins.change',
    'plugins.uninstall',
    'artifacts.list',
    'artifacts.content',
    'agents.create',
    'agents.update',
    'moltbook.connection.show',
    'moltbook.connection.manage',
    'agents.council',
    'agents.tasks.cancel',
    'promptQueue.list',
    'promptQueue.create',
    'promptQueue.update',
    'promptQueue.delete',
    'promptQueue.reorder',
    'promptQueue.dispatch',
    'agents.release.show',
    'agents.release.manage',
    'agents.adaptations.list',
    'agents.adaptations.manage',
    'agents.tasks.show',
    'automation.schedule.show',
    'notifications.dispositions.list',
    'agents.learning.show',
  };

  static bool supports(int version) => supportedVersions.contains(version);
  static bool supportsOperation(String operationId) => operationIds.contains(operationId);

  static void verifyBootstrap(Map<String, dynamic> response) {
    final api = response['api'];
    if (api is! Map || api['nativeContract'] == null) {
      // The immediately previous server did not advertise discovery metadata.
      return;
    }
    final contract = api['nativeContract'];
    if (contract is! Map || contract['id'] != id) {
      throw const FormatException('The service returned a different native contract.');
    }
    final versions = contract['supportedVersions'];
    if (versions is! List || !versions.contains(currentVersion)) {
      throw const FormatException('This native client contract is not supported by the service.');
    }
  }
}

abstract final class NativePaths {
  static const authLogin = '/api/mobile/auth/login';
  static const authRefresh = '/api/mobile/auth/refresh';
  static const authLogout = '/api/mobile/auth/logout';
  static const bootstrapGet = '/api/mobile/bootstrap';
  static const adoptionGet = '/api/mobile/adoption';
  static const contractsGet = '/api/mobile/contracts';
  static const devicesList = '/api/mobile/devices';
  static String devicesChange(String id) => '/api/mobile/devices/${Uri.encodeComponent(id)}';
  static const wipeChallenge = '/api/mobile/wipe';
  static const wipeAcknowledge = '/api/mobile/wipe';
  static const todayGet = '/api/today';
  static const todayCreate = '/api/today';
  static String todayUpdate(String id) => '/api/today/${Uri.encodeComponent(id)}';
  static const todayBrief = '/api/today/brief';
  static const conversationSend = '/api/agent';
  static const approvalsList = '/api/approvals';
  static String approvalsDecide(String id) => '/api/approvals/${Uri.encodeComponent(id)}';
  static const workspacesList = '/api/projects';
  static String workspacesGet(String id) => '/api/projects/${Uri.encodeComponent(id)}';
  static const workspacesCreate = '/api/projects';
  static String workspacesUpdate(String id) => '/api/projects/${Uri.encodeComponent(id)}';
  static const captureCreate = '/api/capture';
  static const meetingsList = '/api/meetings';
  static String meetingsGet(String id) => '/api/meetings/${Uri.encodeComponent(id)}';
  static const notificationsList = '/api/notifications';
  static String notificationsAcknowledge(String id) => '/api/notifications/${Uri.encodeComponent(id)}';
  static String evidenceRun(String id) => '/api/runs/${Uri.encodeComponent(id)}';
  static String evidenceRunCancel(String id) => '/api/runs/${Uri.encodeComponent(id)}';
  static String evidenceWorkflow(String id) => '/api/workflows/${Uri.encodeComponent(id)}';
  static const workspaceSummary = '/api/workspace-summary';
  static const evaluationsList = '/api/evaluations';
  static const agentsList = '/api/agents';
  static const agentsPerformance = '/api/agents/performance';
  static const skillsList = '/api/skills';
  static String memoryList({String? threadId, int? limit}) {
    final path = '/api/memory';
    final query = <String, String>{
      'threadId': ?threadId,
      if (limit != null) 'limit': limit.toString(),
    };
    if (query.isEmpty) return path;
    final encoded = query.entries
        .map((entry) => '${Uri.encodeQueryComponent(entry.key)}=${Uri.encodeQueryComponent(entry.value)}')
        .join('&');
    return '$path?$encoded';
  }
  static const memoryGraphGet = '/api/memory/graph';
  static const knowledgeList = '/api/knowledge';
  static const missionsList = '/api/missions';
  static String missionsGet(String id) => '/api/missions/${Uri.encodeComponent(id)}';
  static String missionsEvents(String id) => '/api/missions/${Uri.encodeComponent(id)}/events';
  static String workspacesPlan(String id) => '/api/projects/${Uri.encodeComponent(id)}/plan';
  static String workspacesTasksCreate(String id) => '/api/projects/${Uri.encodeComponent(id)}/tasks';
  static String workspacesTasksUpdate(String id, String taskId) => '/api/projects/${Uri.encodeComponent(id)}/tasks/${Uri.encodeComponent(taskId)}';
  static String workspacesExecute(String id) => '/api/projects/${Uri.encodeComponent(id)}/execution';
  static String workspacesArtifactsFeedback(String id, String artifactId) => '/api/projects/${Uri.encodeComponent(id)}/artifacts/${Uri.encodeComponent(artifactId)}/feedback';
  static const adminWorkflows = '/api/workflows';
  static const adminTriggers = '/api/triggers';
  static const adminOperations = '/api/operations';
  static const adminConnectionCatalog = '/api/connection-catalog';
  static const adminConnectors = '/api/connectors';
  static const adminOauth = '/api/oauth';
  static const adminOpenapiConnectors = '/api/openapi-connectors';
  static const adminHealth = '/api/health';
  static const adminObservability = '/api/observability';
  static const adminSlo = '/api/observability/slo';
  static const adminIncidents = '/api/incidents';
  static const adminAlerts = '/api/alerts';
  static const adminReleaseEvidence = '/api/release/evidence';
  static const adminSecurityAudits = '/api/security/audits';
  static const adminSecurityIsolation = '/api/security/isolation-report';
  static const adminSecurityRetention = '/api/security/retention';
  static const adminSecurityContext = '/api/security/context';
  static const adminWorkspaceReadiness = '/api/workspace-readiness';
  static const adminAuthControlPlane = '/api/auth/control-plane';
  static const adminSystemMigrations = '/api/system/migrations';
  static const adminDataExport = '/api/data/export';
  static const adminTools = '/api/tools';
  static const adminCapabilities = '/api/capabilities';
  static const adminTrust = '/api/trust';
  static const captureTranscribe = '/api/capture/transcribe';
  static const notificationsReadAll = '/api/notifications';
  static const pushRegistrationsList = '/api/mobile/push/registrations';
  static const pushRegistrationsUpsert = '/api/mobile/push/registrations';
  static String pushRegistrationsRevoke(String id) => '/api/mobile/push/registrations/${Uri.encodeComponent(id)}';
  static String pushDeliveriesAcknowledge(String id) => '/api/mobile/push/deliveries/${Uri.encodeComponent(id)}/acknowledge';
  static String customersGet(String id) => '/api/customer-accounts/${Uri.encodeComponent(id)}';
  static const memoryIntelligenceGet = '/api/memory/intelligence';
  static String memoryGet(String id) => '/api/memory/${Uri.encodeComponent(id)}';
  static const customersList = '/api/customer-accounts';
  static const customersPortfolio = '/api/customer-accounts/portfolio';
  static const marketOverview = '/api/market-research';
  static const marketBars = '/api/market-research/bars';
  static const marketEvents = '/api/market-research/events';
  static const marketEventsBackfill = '/api/market-research/events';
  static const marketReplays = '/api/market-research/replays';
  static const marketReplaysBackfill = '/api/market-research/replays';
  static const marketBaselines = '/api/market-research/baselines';
  static const marketFeatures = '/api/market-research/features';
  static const marketAnalysis = '/api/market-research/analysis';
  static const marketJournal = '/api/market-research/journal';
  static const marketJournalGenerate = '/api/market-research/journal/generate';
  static const marketJournalScore = '/api/market-research/journal/score';
  static String operationsJob(String id) => '/api/operations/jobs/${Uri.encodeComponent(id)}';
  static const paymentsReadiness = '/api/payments/ap2/readiness';
  static const paymentsReviews = '/api/payments/ap2/reviews';
  static const paymentsAuthenticators = '/api/payments/ap2/authenticators';
  static const paymentsTransactions = '/api/payments/ap2/transactions';
  static const settingsGet = '/api/settings';
  static const settingsAssignmentsUpdate = '/api/settings/assignments';
  static String workspacesBuilderGet(String id) => '/api/projects/${Uri.encodeComponent(id)}/builder';
  static String workspacesBuilderUpdate(String id) => '/api/projects/${Uri.encodeComponent(id)}/builder';
  static const marketBacktests = '/api/market-research/backtests';
  static const marketBacktestsRun = '/api/market-research/backtests';
  static String threadsList({int? limit}) {
    final path = '/api/threads';
    final query = <String, String>{
      if (limit != null) 'limit': limit.toString(),
    };
    if (query.isEmpty) return path;
    final encoded = query.entries
        .map((entry) => '${Uri.encodeQueryComponent(entry.key)}=${Uri.encodeQueryComponent(entry.value)}')
        .join('&');
    return '$path?$encoded';
  }
  static String threadsGet(String id) => '/api/threads/${Uri.encodeComponent(id)}';
  static String captureAssetGet(String id, {bool content = false}) {
    final path = '/api/capture/assets/${Uri.encodeComponent(id)}';
    final query = <String, String>{
      if (content) 'content': '1',
    };
    if (query.isEmpty) return path;
    final encoded = query.entries
        .map((entry) => '${Uri.encodeQueryComponent(entry.key)}=${Uri.encodeQueryComponent(entry.value)}')
        .join('&');
    return '$path?$encoded';
  }
  static const localComputerDevice = '/api/mobile/computer-use/device';
  static const localComputerDeviceUpdate = '/api/mobile/computer-use/device';
  static const localComputerCommandClaim = '/api/mobile/computer-use/commands/claim';
  static String localComputerCommandComplete(String id) => '/api/mobile/computer-use/commands/${Uri.encodeComponent(id)}/complete';
  static const localComputerStop = '/api/mobile/computer-use/stop';
  static String pushDeliveryReceipts(String id) => '/api/mobile/push/deliveries/${Uri.encodeComponent(id)}/receipts';
  static const pushCanaryTargets = '/api/mobile/push/canary';
  static const pushCanaryRun = '/api/mobile/push/canary';
  static const pluginsList = '/api/plugins';
  static String integrationsOverview({String? workspaceId}) {
    final path = '/api/integrations/overview';
    final query = <String, String>{
      'workspaceId': ?workspaceId,
    };
    if (query.isEmpty) return path;
    final encoded = query.entries
        .map((entry) => '${Uri.encodeQueryComponent(entry.key)}=${Uri.encodeQueryComponent(entry.value)}')
        .join('&');
    return '$path?$encoded';
  }
  static const pluginsPreview = '/api/plugins/preview';
  static const pluginsInstall = '/api/plugins/install';
  static String pluginsChange(String id) => '/api/plugins/${Uri.encodeComponent(id)}';
  static String pluginsUninstall(String id) => '/api/plugins/${Uri.encodeComponent(id)}';
  static String artifactsList({String? kind, int? limit}) {
    final path = '/api/artifacts';
    final query = <String, String>{
      'kind': ?kind,
      if (limit != null) 'limit': limit.toString(),
    };
    if (query.isEmpty) return path;
    final encoded = query.entries
        .map((entry) => '${Uri.encodeQueryComponent(entry.key)}=${Uri.encodeQueryComponent(entry.value)}')
        .join('&');
    return '$path?$encoded';
  }
  static String artifactsContent(String id, {int? version}) {
    final path = '/api/artifacts/${Uri.encodeComponent(id)}/content';
    final query = <String, String>{
      if (version != null) 'version': version.toString(),
    };
    if (query.isEmpty) return path;
    final encoded = query.entries
        .map((entry) => '${Uri.encodeQueryComponent(entry.key)}=${Uri.encodeQueryComponent(entry.value)}')
        .join('&');
    return '$path?$encoded';
  }
  static const agentsCreate = '/api/agents';
  static String agentsUpdate(String id) => '/api/agents/${Uri.encodeComponent(id)}';
  static String moltbookConnectionShow(String id, {String? cursor, int? limit}) {
    final path = '/api/agents/${Uri.encodeComponent(id)}/moltbook';
    final query = <String, String>{
      'cursor': ?cursor,
      if (limit != null) 'limit': limit.toString(),
    };
    if (query.isEmpty) return path;
    final encoded = query.entries
        .map((entry) => '${Uri.encodeQueryComponent(entry.key)}=${Uri.encodeQueryComponent(entry.value)}')
        .join('&');
    return '$path?$encoded';
  }
  static String moltbookConnectionManage(String id) => '/api/agents/${Uri.encodeComponent(id)}/moltbook';
  static String agentsCouncil({int? limit}) {
    final path = '/api/agents/council';
    final query = <String, String>{
      if (limit != null) 'limit': limit.toString(),
    };
    if (query.isEmpty) return path;
    final encoded = query.entries
        .map((entry) => '${Uri.encodeQueryComponent(entry.key)}=${Uri.encodeQueryComponent(entry.value)}')
        .join('&');
    return '$path?$encoded';
  }
  static String agentsTasksCancel(String id) => '/api/agents/tasks/${Uri.encodeComponent(id)}/cancel';
  static const promptQueueList = '/api/command/prompt-queue';
  static const promptQueueCreate = '/api/command/prompt-queue';
  static String promptQueueUpdate(String id) => '/api/command/prompt-queue/${Uri.encodeComponent(id)}';
  static String promptQueueDelete(String id) => '/api/command/prompt-queue/${Uri.encodeComponent(id)}';
  static const promptQueueReorder = '/api/command/prompt-queue/reorder';
  static String promptQueueDispatch(String id) => '/api/command/prompt-queue/${Uri.encodeComponent(id)}/dispatch';
  static String agentsReleaseShow(String id) => '/api/agents/${Uri.encodeComponent(id)}/release';
  static String agentsReleaseManage(String id) => '/api/agents/${Uri.encodeComponent(id)}/release';
  static String agentsAdaptationsList(String id) => '/api/agents/${Uri.encodeComponent(id)}/adaptations';
  static String agentsAdaptationsManage(String id) => '/api/agents/${Uri.encodeComponent(id)}/adaptations';
  static String agentsTasksShow(String id) => '/api/agents/tasks/${Uri.encodeComponent(id)}';
  static String automationScheduleShow(String id) => '/api/triggers/${Uri.encodeComponent(id)}';
  static String notificationsDispositionsList({int? limit, String? before}) {
    final path = '/api/notifications/dispositions';
    final query = <String, String>{
      if (limit != null) 'limit': limit.toString(),
      'before': ?before,
    };
    if (query.isEmpty) return path;
    final encoded = query.entries
        .map((entry) => '${Uri.encodeQueryComponent(entry.key)}=${Uri.encodeQueryComponent(entry.value)}')
        .join('&');
    return '$path?$encoded';
  }
  static String agentsLearningShow(String id) => '/api/agents/${Uri.encodeComponent(id)}/learning';
}

abstract final class NativeConversationEvents {
  static const supportedTypes = <String>{
    'run',
    'delegated',
    'clarification',
    'status',
    'harness',
    'delta',
    'memory',
    'model',
    'council_member',
    'council_verdict',
    'tool',
    'waiting_approval',
    'budget_exhausted',
    'done',
    'canceled',
    'error',
  };

  static Map<String, dynamic> parse(String eventName, Object? value) {
    if (value is! Map) {
      throw const FormatException('Native event payload must be an object.');
    }
    final event = Map<String, dynamic>.from(value);
    final type = event['type'];
    if (type is! String || type != eventName || !supportedTypes.contains(type)) {
      throw const FormatException('Native event discriminant is invalid.');
    }
    return event;
  }
}
