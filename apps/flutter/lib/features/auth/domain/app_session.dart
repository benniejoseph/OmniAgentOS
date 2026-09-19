import '../../../generated/native_contract.g.dart';

class AppSession {
  const AppSession({
    required this.tenantId,
    required this.actorId,
    required this.userId,
    required this.email,
    required this.displayName,
    required this.workspaceName,
    this.role = 'member',
  });

  factory AppSession.fromJson(Map<String, dynamic> json) {
    NativeContract.verifyBootstrap(json);
    final context = json['context'] is Map
        ? Map<String, dynamic>.from(json['context'] as Map)
        : const <String, dynamic>{};
    final user = json['user'] is Map
        ? Map<String, dynamic>.from(json['user'] as Map)
        : json;
    final workspaceValue = json['tenant'] ?? json['workspace'];
    final workspace = workspaceValue is Map
        ? Map<String, dynamic>.from(workspaceValue)
        : const <String, dynamic>{};
    final membership = json['membership'] is Map
        ? Map<String, dynamic>.from(json['membership'] as Map)
        : const <String, dynamic>{};
    final tenantId = (context['tenantId'] ?? workspace['id'] ?? '').toString();
    final actorId = (context['actorId'] ?? '').toString();
    if (tenantId.isEmpty || actorId.isEmpty) {
      throw const FormatException(
        'The native session is missing its tenant or actor scope.',
      );
    }
    return AppSession(
      tenantId: tenantId,
      actorId: actorId,
      userId: (user['id'] ?? user['userId'] ?? '').toString(),
      email: (user['email'] ?? '').toString(),
      displayName: (user['name'] ?? user['displayName'] ?? 'Operator')
          .toString(),
      workspaceName: (workspace['name'] ?? json['workspaceName'] ?? 'Asael')
          .toString(),
      role: (membership['role'] ?? user['role'] ?? json['role'] ?? 'member')
          .toString(),
    );
  }

  final String tenantId;
  final String actorId;
  final String userId;
  final String email;
  final String displayName;
  final String workspaceName;
  final String role;
  bool get canManage => const {
    'operator',
    'admin',
    'system',
    'owner',
  }.contains(role.toLowerCase());
}
