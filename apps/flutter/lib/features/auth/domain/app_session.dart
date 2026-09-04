class AppSession {
  const AppSession({
    required this.userId,
    required this.email,
    required this.displayName,
    required this.workspaceName,
    this.role = 'member',
  });

  factory AppSession.fromJson(Map<String, dynamic> json) {
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
    return AppSession(
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

  final String userId;
  final String email;
  final String displayName;
  final String workspaceName;
  final String role;
  bool get canManage => const {'owner', 'admin'}.contains(role.toLowerCase());
}
