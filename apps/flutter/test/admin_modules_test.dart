import 'package:flutter_test/flutter_test.dart';
import 'package:omniagent/features/auth/domain/app_session.dart';
import 'package:omniagent/features/settings/admin_registry.dart';

void main() {
  test('admin registry covers every control-plane domain', () {
    expect(
      adminModules.map((item) => item.id),
      containsAll(<String>[
        'automation',
        'integrations',
        'tools',
        'quality',
        'monitoring',
        'security',
        'settings',
      ]),
    );
    expect(adminModules.every((item) => item.endpoints.isNotEmpty), isTrue);
    final paths = adminModules
        .expand((item) => item.endpoints)
        .map((item) => item.path);
    expect(paths, contains('/api/security/isolation-report'));
    expect(paths, contains('/api/observability/slo'));
    expect(paths, contains('/api/openapi-connectors'));
  });

  test('only privileged workspace roles can manage the control plane', () {
    const base = AppSession(
      userId: 'u1',
      email: 'user@test.dev',
      displayName: 'User',
      workspaceName: 'Workspace',
    );
    const owner = AppSession(
      userId: 'u2',
      email: 'owner@test.dev',
      displayName: 'Owner',
      workspaceName: 'Workspace',
      role: 'owner',
    );
    expect(base.canManage, isFalse);
    expect(owner.canManage, isTrue);
  });
}
