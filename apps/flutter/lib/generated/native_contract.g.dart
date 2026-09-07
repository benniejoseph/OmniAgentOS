// GENERATED FILE. DO NOT EDIT.
// Run npm run generate:native-contracts from the repository root.

abstract final class NativeContract {
  static const id = 'asael.native-api';
  static const currentVersion = 2;
  static const previousVersion = 1;
  static const supportedVersions = <int>[2, 1];
  static const discoveryPath = '/api/mobile/contracts';

  static bool supports(int version) => supportedVersions.contains(version);
}

abstract final class NativePaths {
  static const authLogin = '/api/mobile/auth/login';
  static const authRefresh = '/api/mobile/auth/refresh';
  static const authLogout = '/api/mobile/auth/logout';
  static const bootstrapGet = '/api/mobile/bootstrap';
  static const adoptionGet = '/api/mobile/adoption';
  static const contractsGet = '/api/mobile/contracts';
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
  static String evidenceWorkflow(String id) => '/api/workflows/${Uri.encodeComponent(id)}';
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
