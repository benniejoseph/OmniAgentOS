import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/automation/automation_api_repository.dart';
import 'package:asael/features/automation/automation_controller.dart';
import 'package:asael/features/automation/automation_models.dart';
import 'package:asael/features/automation/automation_providers.dart';
import 'package:asael/features/automation/automation_studio_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _occurrenceId =
    'workflow_schedule_occurrence_1111111111111111111111111111111111111111';
const _leaseId =
    'policy_lease_222222222222222222222222222222222222222222222222';
const _consumptionReceiptId =
    'policy_lease_receipt_333333333333333333333333333333333333333333333333';

void main() {
  testWidgets('portable Studio opens exact PolicyLease history', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final repository = _PortableRepository();
    final controller = AutomationController(
      repository,
      canManage: true,
      mutationsAvailable: true,
    );
    await controller.refresh();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionControllerProvider.overrideWith(_OperatorSession.new),
          automationControllerProvider.overrideWith((ref) => controller),
        ],
        child: const MaterialApp(
          home: AutomationStudioView(initialSection: 'automations'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Morning briefing'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey('portable-automation-trigger-trigger-one')),
    );
    await tester.pumpAndSettle();

    expect(repository.scheduleLoads, ['trigger-one']);
    expect(
      find.text('Occurrences, receipts, and PolicyLease outcomes'),
      findsOneWidget,
    );
    expect(find.text('PolicyLease outcomes'), findsOneWidget);
    expect(
      find.text(
        'Content-free evidence only. A history record never grants authority.',
      ),
      findsOneWidget,
    );
    expect(find.text(_leaseId), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('portable Studio keeps source failures honest', (tester) async {
    final controller = AutomationController(
      _PortableRepository(toolsUnavailable: true),
      canManage: true,
      mutationsAvailable: true,
    );
    await controller.refresh();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionControllerProvider.overrideWith(_OperatorSession.new),
          automationControllerProvider.overrideWith((ref) => controller),
        ],
        child: const MaterialApp(
          home: AutomationStudioView(initialSection: 'tools'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Tools'), findsWidgets);
    expect(find.text('Tool inventory unavailable.'), findsOneWidget);
    expect(find.text('Unavailable'), findsOneWidget);
  });
}

class _OperatorSession extends SessionController {
  @override
  Future<AppSession?> build() async => const AppSession(
    tenantId: 'tenant-one',
    actorId: 'actor-one',
    userId: 'user-one',
    email: 'operator@example.test',
    displayName: 'Operator',
    workspaceName: 'Asael',
    role: 'operator',
  );
}

class _PortableRepository implements AutomationRepository {
  _PortableRepository({this.toolsUnavailable = false});

  final bool toolsUnavailable;
  final scheduleLoads = <String>[];

  @override
  Future<AutomationSnapshot> load() async => AutomationSnapshot(
    skills: const AutomationResource.ready([]),
    connections: AutomationResource.ready(
      AutomationConnectionInventory.fromResponse({
        'overview': {
          'state': 'ready',
          'generatedAt': '2026-09-22T10:00:00.000Z',
          'installed': const [],
          'suggestions': const [],
        },
      }),
    ),
    mcp: const AutomationResource.ready([]),
    tools: toolsUnavailable
        ? const AutomationResource.failed('Tool inventory unavailable.')
        : const AutomationResource.ready([]),
    workflows: const AutomationResource.ready([]),
    triggers: AutomationResource.ready([
      AutomationTrigger.fromJson({
        'id': 'trigger-one',
        'name': 'Morning briefing',
        'status': 'active',
        'source': 'schedule',
        'workflowMode': 'orchestrate',
      }),
    ]),
    plugins: const AutomationResource.ready(
      AutomationPluginCatalog(
        plugins: [],
        installations: [],
        storage: 'canonical_database',
        raw: {},
      ),
    ),
  );

  @override
  Future<AutomationScheduleDetail> loadSchedule(String triggerId) async {
    scheduleLoads.add(triggerId);
    return AutomationScheduleDetail.fromResponse({
      'trigger': {
        'id': triggerId,
        'name': 'Morning briefing',
        'status': 'active',
        'source': 'schedule',
        'workflowMode': 'orchestrate',
      },
      'preview': {'occurrences': const []},
      'occurrences': [
        {
          'id': _occurrenceId,
          'kind': 'scheduled',
          'status': 'completed',
          'scheduledFor': '2026-09-22T03:00:00.000Z',
          'workflowRunId': 'workflow-one',
          'attemptCount': 1,
          'authoritySha256': _sha,
          'updatedAt': '2026-09-22T03:05:00.000Z',
        },
      ],
      'receipts': const [],
      'policyLeases': {
        'version': 'scheduled-policy-lease-outcomes:1',
        'available': true,
        'contentIncluded': false,
        'outcomes': [
          {
            'leaseId': _leaseId,
            'leaseSha256': _sha,
            'occurrenceId': _occurrenceId,
            'executionId': 'execution-one',
            'toolId': 'calendar.events.create',
            'status': 'consumed',
            'bindingIndex': 0,
            'bindingSha256': _sha,
            'toolContractSha256': _sha,
            'policySha256': _sha,
            'influenceManifestSha256': _sha,
            'issuedAt': '2026-09-22T03:00:00.000Z',
            'expiresAt': '2026-09-22T03:15:00.000Z',
            'consumedAt': '2026-09-22T03:01:00.000Z',
            'consumptionReceiptId': _consumptionReceiptId,
            'consumptionReceiptSha256': _sha,
            'contentIncluded': false,
            'leaseGrantsAuthority': false,
          },
        ],
      },
    });
  }

  @override
  Future<AutomationResource<AutomationPluginCatalog>> loadPlugins() async =>
      const AutomationResource.ready(
        AutomationPluginCatalog(
          plugins: [],
          installations: [],
          storage: 'canonical_database',
          raw: {},
        ),
      );

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
