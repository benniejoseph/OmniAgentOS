import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/automation/automation_api_repository.dart';
import 'package:asael/features/automation/automation_controller.dart';
import 'package:asael/features/automation/automation_models.dart';
import 'package:asael/features/automation/automation_providers.dart';
import 'package:asael/features/automation/macos_automation_studio_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _scheduleShaA =
    '1111111111111111111111111111111111111111111111111111111111111111';
const _scheduleShaB =
    '2222222222222222222222222222222222222222222222222222222222222222';
const _scheduleShaC =
    '3333333333333333333333333333333333333333333333333333333333333333';
const _scheduleShaD =
    '4444444444444444444444444444444444444444444444444444444444444444';
const _scheduleShaE =
    '5555555555555555555555555555555555555555555555555555555555555555';
const _scheduleShaF =
    '6666666666666666666666666666666666666666666666666666666666666666';
const _scheduleShaG =
    '7777777777777777777777777777777777777777777777777777777777777777';
const _scheduleShaH =
    '8888888888888888888888888888888888888888888888888888888888888888';
const _occurrenceId =
    'workflow_schedule_occurrence_1111111111111111111111111111111111111111';
const _receiptId =
    'workflow_schedule_receipt_2222222222222222222222222222222222222222';
const _leaseId =
    'policy_lease_333333333333333333333333333333333333333333333333';
const _consumptionReceiptId =
    'policy_lease_receipt_444444444444444444444444444444444444444444444444';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'native operator sees one semantic six-section Automation Studio',
    (tester) async {
      tester.view.physicalSize = const Size(1240, 820);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final controller = AutomationController(
        _Repository(_snapshot()),
        canManage: true,
        mutationsAvailable: true,
        now: () => DateTime.utc(2026, 9, 19, 8),
      );
      await controller.refresh();

      await tester.pumpWidget(_app(controller: controller));
      await tester.pumpAndSettle();

      expect(find.text('How a capability becomes useful'), findsOneWidget);
      expect(find.text('Access'), findsOneWidget);
      expect(find.text('Actions'), findsOneWidget);
      expect(find.text('Guidance'), findsOneWidget);
      expect(find.text('Repeat'), findsOneWidget);
      expect(find.text('Bundles'), findsOneWidget);
      for (final section in AutomationStudioSection.values) {
        expect(
          find.byKey(ValueKey('automation-section-${section.id}')),
          findsOneWidget,
        );
      }

      await tester.tap(
        find.byKey(const ValueKey('automation-section-connections')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Google Workspace'), findsOneWidget);
      expect(find.text('Research MCP'), findsOneWidget);
      expect(find.text('Connect Codex or Claude to Asael'), findsOneWidget);

      await tester.tap(
        find.byKey(const ValueKey('automation-section-plugins')),
      );
      await tester.pumpAndSettle();
      expect(find.text('GitHub Project Kit'), findsWidgets);
      expect(
        find.text('Installation is a review, not an authority shortcut.'),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('automation-plugin-manifest')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('Studio remains usable at the compact auxiliary-window width', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(680, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final snapshot = _snapshot().copyWith(
      tools: const AutomationResource.failed('Tools: temporarily unavailable.'),
    );
    final controller = AutomationController(
      _Repository(snapshot),
      canManage: true,
      mutationsAvailable: true,
    );
    await controller.refresh();

    await tester.pumpWidget(_app(controller: controller));
    await tester.pumpAndSettle();
    final advanced = find.byKey(const ValueKey('automation-section-advanced'));
    await tester.ensureVisible(advanced);
    await tester.tap(advanced);
    await tester.pumpAndSettle();

    expect(find.text('Source integrity'), findsOneWidget);
    expect(find.text('Unavailable'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Studio states why an ordinary member cannot administer it', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionControllerProvider.overrideWith(_MemberSessionController.new),
        ],
        child: const MaterialApp(home: MacosAutomationStudioView()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Operator access required'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('partial connections remain explicit and MCP is not duplicated', (
    tester,
  ) async {
    final snapshot = _snapshot().copyWith(
      connections: AutomationResource.ready(
        AutomationConnectionInventory.fromResponse({
          'overview': {
            'state': 'partial',
            'generatedAt': '2026-09-19T08:00:00.000Z',
            'installed': [
              {
                'id': 'google',
                'name': 'Google Workspace',
                'kind': 'google_service',
                'adapter': 'oauth',
                'state': 'connected',
                'connected': true,
                'manageable': true,
                'permissions': {'mode': 'read_write'},
                'sync': {'status': 'current'},
              },
              {
                'id': 'mcp-one',
                'name': 'Research MCP',
                'kind': 'mcp',
                'adapter': 'mcp',
                'state': 'connected',
                'connected': true,
                'manageable': true,
                'permissions': {'mode': 'tool_contracts'},
                'sync': {'status': 'current'},
              },
            ],
            'suggestions': [],
          },
        }),
      ),
    );
    final controller = AutomationController(
      _Repository(snapshot),
      canManage: true,
      mutationsAvailable: true,
    );
    await controller.refresh();

    await tester.pumpWidget(_app(controller: controller));
    await tester.pumpAndSettle();
    expect(find.text('1 source needs attention'), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey('automation-section-connections')),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('missing accounts are unknown'), findsOneWidget);
    expect(find.text('Research MCP'), findsOneWidget);
    expect(find.text('Google Workspace'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('schedule history exposes exact macOS execution evidence', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1240, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = AutomationController(
      _Repository(_snapshot(), schedule: _scheduleDetail()),
      canManage: true,
      mutationsAvailable: true,
    );
    await controller.refresh();
    await tester.pumpWidget(_app(controller: controller));
    await tester.pumpAndSettle();

    await tester.tap(
      find.byKey(const ValueKey('automation-section-automations')),
    );
    await tester.pumpAndSettle();
    final history = find.byKey(
      const ValueKey('automation-schedule-history-trigger-one'),
    );
    await tester.ensureVisible(history);
    await tester.tap(history);
    await tester.pumpAndSettle();

    expect(find.textContaining('Exact content-free evidence'), findsOneWidget);
    expect(find.text('Workflow run workflow-run-one'), findsOneWidget);
    expect(find.text('Authority $_scheduleShaA'), findsOneWidget);

    await tester.tap(find.text('Receipts'));
    await tester.pumpAndSettle();
    expect(
      find.text('Receipt $_scheduleShaB\nState $_scheduleShaC'),
      findsOneWidget,
    );

    await tester.tap(find.text('PolicyLease'));
    await tester.pumpAndSettle();
    expect(find.textContaining('execution execution-one'), findsOneWidget);
    expect(find.textContaining('Binding $_scheduleShaE'), findsOneWidget);
    expect(
      find.textContaining('Consumption receipt $_scheduleShaH'),
      findsOneWidget,
    );
    expect(find.textContaining('does not grant authority'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

Widget _app({required AutomationController controller}) => ProviderScope(
  overrides: [
    sessionControllerProvider.overrideWith(_OwnerSessionController.new),
    automationControllerProvider.overrideWith((ref) => controller),
  ],
  child: MaterialApp(
    theme: MacosAppTheme.light(),
    home: const MacosAutomationStudioView(),
  ),
);

class _OwnerSessionController extends SessionController {
  @override
  Future<AppSession?> build() async => const AppSession(
    tenantId: 'tenant-test',
    actorId: 'actor:operator',
    userId: 'user-operator',
    email: 'operator@example.com',
    displayName: 'Operator',
    workspaceName: 'Asael',
    role: 'operator',
  );
}

class _MemberSessionController extends SessionController {
  @override
  Future<AppSession?> build() async => const AppSession(
    tenantId: 'tenant-test',
    actorId: 'actor:member',
    userId: 'user-member',
    email: 'member@example.com',
    displayName: 'Member',
    workspaceName: 'Asael',
  );
}

AutomationSnapshot _snapshot() => AutomationSnapshot(
  skills: AutomationResource.ready([
    AutomationSkill.fromJson({
      'id': 'skill-one',
      'name': 'Research brief',
      'description': 'Build an evidence-bound research brief.',
      'category': 'research',
      'status': 'active',
      'builtIn': true,
      'toolIds': ['web.search'],
      'knowledgeTags': ['research'],
    }),
  ]),
  connections: AutomationResource.ready(
    AutomationConnectionInventory.fromResponse({
      'overview': {
        'state': 'ready',
        'generatedAt': '2026-09-19T08:00:00.000Z',
        'installed': [
          {
            'id': 'google',
            'name': 'Google Workspace',
            'kind': 'google_service',
            'adapter': 'oauth',
            'state': 'connected',
            'connected': true,
            'manageable': true,
            'permissions': {'mode': 'read_write'},
            'sync': {'status': 'current'},
            'nextAction': 'No action required.',
          },
        ],
        'suggestions': [],
      },
    }),
  ),
  mcp: AutomationResource.ready([
    AutomationMcpServer.fromJson({
      'id': 'mcp-one',
      'name': 'Research MCP',
      'status': 'active',
      'authType': 'service_key',
      'toolCount': 4,
      'defaultRiskLevel': 1,
      'approvalRequired': true,
    }),
  ]),
  tools: AutomationResource.ready([
    AutomationTool.fromJson({
      'id': 'web.search',
      'name': 'Search the web',
      'description': 'Read current public sources.',
      'status': 'active',
      'riskLevel': 0,
      'approvalRequired': false,
    }),
  ]),
  workflows: AutomationResource.ready([
    AutomationWorkflowRun.fromJson({
      'id': 'run-one',
      'input': {'goal': 'Prepare the daily research brief'},
      'canonicalStatus': 'running',
      'mode': 'workflow',
      'updatedAt': '2026-09-19T08:00:00.000Z',
    }),
  ]),
  triggers: AutomationResource.ready([
    AutomationTrigger.fromJson({
      'id': 'trigger-one',
      'name': 'Daily briefing',
      'status': 'active',
      'source': 'schedule',
      'workflowMode': 'orchestrate',
    }),
  ]),
  plugins: AutomationResource.ready(
    AutomationPluginCatalog.fromResponse({
      'storage': 'postgres',
      'plugins': [
        {
          'pluginId': 'asael.github-project-kit',
          'version': '1.0.0',
          'name': 'GitHub Project Kit',
          'description': 'Project research and delivery instructions.',
          'publisher': {'name': 'Asael'},
          'manifestSha256': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'installed': true,
          'status': 'enabled',
          'installationId': 'install-one',
          'revision': 1,
          'componentCounts': {
            'skills': 2,
            'mcpTemplates': 1,
            'workflowTemplates': 1,
          },
        },
      ],
      'installations': [],
    }),
  ),
);

class _Repository implements AutomationRepository {
  const _Repository(this.snapshot, {this.schedule});

  final AutomationSnapshot snapshot;
  final AutomationScheduleDetail? schedule;

  @override
  Future<AutomationSnapshot> load() async => snapshot;

  @override
  Future<AutomationScheduleDetail> loadSchedule(String triggerId) async =>
      schedule ?? (throw UnimplementedError());

  @override
  Future<AutomationResource<AutomationPluginCatalog>> loadPlugins() async =>
      snapshot.plugins;

  @override
  Future<AutomationPluginMutation> installPlugin(
    AutomationPluginPreview preview, {
    required String idempotencyKey,
  }) => throw UnimplementedError();

  @override
  Future<AutomationPluginPreview> previewCatalogPlugin(
    AutomationPlugin plugin, {
    required String idempotencyKey,
  }) => throw UnimplementedError();

  @override
  Future<AutomationPluginPreview> previewManifest(
    AutomationJson manifest, {
    required String idempotencyKey,
  }) => throw UnimplementedError();

  @override
  Future<AutomationPluginMutation> setPluginEnabled(
    AutomationPlugin plugin, {
    required bool enabled,
    required String idempotencyKey,
  }) => throw UnimplementedError();

  @override
  Future<AutomationPluginMutation> uninstallPlugin(
    AutomationPlugin plugin, {
    required String idempotencyKey,
  }) => throw UnimplementedError();
}

AutomationScheduleDetail _scheduleDetail() => AutomationScheduleDetail(
  trigger: AutomationTrigger.fromJson({
    'id': 'trigger-one',
    'name': 'Daily briefing',
    'status': 'active',
    'source': 'schedule',
    'workflowMode': 'orchestrate',
  }),
  previewTimes: [DateTime.utc(2026, 9, 23, 8)],
  occurrences: [
    AutomationScheduleOccurrence(
      id: _occurrenceId,
      kind: 'scheduled',
      status: 'completed',
      scheduledFor: DateTime.utc(2026, 9, 22, 8),
      workflowRunId: 'workflow-run-one',
      failureCode: null,
      attemptCount: 1,
      authoritySha256: _scheduleShaA,
      updatedAt: DateTime.utc(2026, 9, 22, 8, 1),
    ),
  ],
  receipts: [
    AutomationScheduleReceipt(
      id: _receiptId,
      occurrenceId: _occurrenceId,
      status: 'completed',
      receiptSha256: _scheduleShaB,
      stateSha256: _scheduleShaC,
      recordedAt: DateTime.utc(2026, 9, 22, 8, 1),
    ),
  ],
  policyLeasesAvailable: true,
  policyLeases: [
    AutomationPolicyLeaseOutcome(
      leaseId: _leaseId,
      leaseSha256: _scheduleShaD,
      occurrenceId: _occurrenceId,
      executionId: 'execution-one',
      toolId: 'google.gmail.send',
      status: 'consumed',
      bindingIndex: 0,
      bindingSha256: _scheduleShaE,
      toolContractSha256: _scheduleShaF,
      policySha256: _scheduleShaG,
      influenceManifestSha256: _scheduleShaA,
      issuedAt: DateTime.utc(2026, 9, 22, 8),
      expiresAt: DateTime.utc(2026, 9, 22, 8, 5),
      consumedAt: DateTime.utc(2026, 9, 22, 8, 1),
      consumptionReceiptId: _consumptionReceiptId,
      consumptionReceiptSha256: _scheduleShaH,
    ),
  ],
);
