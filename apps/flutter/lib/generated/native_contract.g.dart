// GENERATED FILE. DO NOT EDIT.
// Run npm run generate:native-contracts from the repository root.

abstract final class NativeContract {
  static const id = 'asael.native-api';
  static const currentVersion = 5;
  static const previousVersion = 4;
  static const supportedVersions = <int>[5, 4];
  static const discoveryPath = '/api/mobile/contracts';

  static bool supports(int version) => supportedVersions.contains(version);

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
  static const agentsCreate = '/api/agents';
  static String agentsUpdate(String id) => '/api/agents/${Uri.encodeComponent(id)}';
  static String agentsDelete(String id) => '/api/agents/${Uri.encodeComponent(id)}';
  static const agentsPerformance = '/api/agents/performance';
  static const skillsList = '/api/skills';
  static const skillsCreate = '/api/skills';
  static String skillsUpdate(String id) => '/api/skills/${Uri.encodeComponent(id)}';
  static String skillsDelete(String id) => '/api/skills/${Uri.encodeComponent(id)}';
  static const memoryList = '/api/memory';
  static const memoryCreate = '/api/memory';
  static String memoryUpdate(String id) => '/api/memory/${Uri.encodeComponent(id)}';
  static String memoryDelete(String id) => '/api/memory/${Uri.encodeComponent(id)}';
  static const memoryGraphGet = '/api/memory/graph';
  static const memoryGraphRebuild = '/api/memory/graph';
  static const knowledgeList = '/api/knowledge';
  static const knowledgeSourceDelete = '/api/knowledge';
  static const missionsList = '/api/missions';
  static const missionsCreate = '/api/missions';
  static String missionsGet(String id) => '/api/missions/${Uri.encodeComponent(id)}';
  static String missionsUpdate(String id) => '/api/missions/${Uri.encodeComponent(id)}';
  static String missionsEvents(String id) => '/api/missions/${Uri.encodeComponent(id)}/events';
  static String workspacesPlan(String id) => '/api/projects/${Uri.encodeComponent(id)}/plan';
  static String workspacesTasksCreate(String id) => '/api/projects/${Uri.encodeComponent(id)}/tasks';
  static String workspacesTasksUpdate(String id, String taskId) => '/api/projects/${Uri.encodeComponent(id)}/tasks/${Uri.encodeComponent(taskId)}';
  static String workspacesExecute(String id) => '/api/projects/${Uri.encodeComponent(id)}/execution';
  static String workspacesArtifactsFeedback(String id, String artifactId) => '/api/projects/${Uri.encodeComponent(id)}/artifacts/${Uri.encodeComponent(artifactId)}/feedback';
  static const adminWorkflows = '/api/workflows';
  static const adminTriggers = '/api/triggers';
  static const adminOperations = '/api/operations';
  static const adminWorkflowsTick = '/api/workflows/tick';
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
