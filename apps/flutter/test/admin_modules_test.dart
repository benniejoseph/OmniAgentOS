import 'package:flutter_test/flutter_test.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/settings/admin_registry.dart';

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

  test('automation administration uses the user-facing capability model', () {
    final modules = {for (final module in adminModules) module.id: module};

    expect(modules['automation']?.label, 'Automations');
    expect(
      modules['automation']?.endpoints.map((item) => item.label),
      containsAll(<String>[
        'Runs',
        'Schedules and triggers',
        'Advanced operations',
      ]),
    );

    expect(modules['integrations']?.label, 'Connections');
    expect(
      modules['integrations']?.endpoints.map((item) => item.label),
      containsAll(<String>[
        'Accounts and personal sources',
        'External MCP servers',
        'REST APIs',
      ]),
    );

    expect(modules['tools']?.label, 'Capabilities');
    expect(modules['tools']?.endpoints.first.label, 'Skills');
    expect(
      modules['tools']?.endpoints.map((item) => item.label),
      containsAll(<String>['Plugins', 'Advanced tool audit']),
    );
  });

  test('only privileged workspace roles can manage the control plane', () {
    const base = AppSession(
      tenantId: 'tenant-1',
      actorId: 'actor:one',
      userId: 'u1',
      email: 'user@test.dev',
      displayName: 'User',
      workspaceName: 'Workspace',
    );
    const owner = AppSession(
      tenantId: 'tenant-1',
      actorId: 'actor:owner',
      userId: 'u2',
      email: 'owner@test.dev',
      displayName: 'Owner',
      workspaceName: 'Workspace',
      role: 'owner',
    );
    const operator = AppSession(
      tenantId: 'tenant-1',
      actorId: 'actor:operator',
      userId: 'u3',
      email: 'operator@test.dev',
      displayName: 'Operator',
      workspaceName: 'Workspace',
      role: 'operator',
    );
    expect(base.canManage, isFalse);
    expect(owner.canManage, isTrue);
    expect(operator.canManage, isTrue);
  });
}
