import 'package:asael/app/router/app_router.dart';
import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/agents/specialist_api_client.dart';
import 'package:asael/features/agents/specialist_recovery_store.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/automation/automation_api_repository.dart';
import 'package:asael/features/automation/automation_models.dart';
import 'package:asael/features/automation/automation_providers.dart';
import 'package:asael/features/results/results.dart';
import 'package:asael/features/results/results_providers.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

const _runId = 'run/with%2Fencoded:Ω?part#one';
const _sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _occurrenceId =
    'workflow_schedule_occurrence_1111111111111111111111111111111111111111';

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    final previous = WidgetController.hitTestWarningShouldBeFatal;
    WidgetController.hitTestWarningShouldBeFatal = true;
    addTearDown(() => WidgetController.hitTestWarningShouldBeFatal = previous);
  });

  for (final desktop in [false, true]) {
    final presentation = desktop ? 'macOS' : 'portable';
    final variant = TargetPlatformVariant.only(
      desktop ? TargetPlatform.macOS : TargetPlatform.android,
    );

    testWidgets(
      '$presentation opens exact workflow output and returns to Automations',
      (tester) async {
        final results = _ReadOnlyResults();
        final container = await _mount(
          tester,
          desktop: desktop,
          automation: _AutomationRepository(),
          results: results,
        );
        await _selectAutomations(tester, desktop: desktop);

        final open = find.widgetWithText(TextButton, 'Open run');
        await _reveal(
          tester,
          open,
          scrollable: desktop ? null : _portableAutomationScroll(),
        );
        final semantics = tester.ensureSemantics();
        try {
          expect(
            tester.getSemantics(open),
            isSemantics(
              label: 'Open run',
              isButton: true,
              hasEnabledState: true,
              isEnabled: true,
              isFocusable: true,
              hasTapAction: true,
            ),
          );
        } finally {
          semantics.dispose();
        }
        await tester.tap(open);
        await tester.pumpAndSettle();

        expect(results.details, ['workflow:$_runId']);
        expect(find.text('Stored workflow output'), findsOneWidget);
        expect(find.text('Stored workflow evidence'), findsOneWidget);
        expect(results.effects, 0);
        expect(container.read(appRouterProvider).canPop(), isTrue);
        await tester.pageBack();
        await tester.pumpAndSettle();

        await _reveal(
          tester,
          find.text('Prepared weekly summary'),
          scrollable: desktop ? null : _portableAutomationScroll(),
        );
        expect(find.text('Recent workflow runs'), findsOneWidget);
        expect(find.text('Prepared weekly summary'), findsOneWidget);
        container.read(appRouterProvider).go('/automation?section=connections');
        await tester.pumpAndSettle();
        expect(find.text('Recent workflow runs'), findsNothing);
        expect(
          desktop
              ? find.byKey(const ValueKey('automation-connections'))
              : find.text('What Asael can use'),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      },
      variant: variant,
    );

    testWidgets(
      '$presentation opens an occurrence through existing unavailable Results',
      (tester) async {
        final results = _ReadOnlyResults(missing: true);
        final automation = _AutomationRepository(runs: const []);
        await _mount(
          tester,
          desktop: desktop,
          automation: automation,
          results: results,
        );
        await _selectAutomations(tester, desktop: desktop);
        await _openSchedule(tester, desktop: desktop);
        if (!desktop) {
          await tester.tap(find.text(_occurrenceId));
          await tester.pumpAndSettle();
        }
        final open = find.widgetWithText(TextButton, 'Open run');
        await _reveal(
          tester,
          open,
          scrollable: desktop
              ? null
              : find
                    .descendant(
                      of: find.byType(BottomSheet),
                      matching: find.byType(Scrollable),
                    )
                    .first,
        );
        await tester.tap(open);
        await tester.pumpAndSettle();

        expect(automation.scheduleLoads, ['trigger-one']);
        expect(results.details, ['workflow:$_runId']);
        expect(
          find.textContaining(
            'This exact record is unavailable or no longer visible.',
          ),
          findsOneWidget,
        );
        expect(results.effects, 0);
        await tester.pageBack();
        await tester.pumpAndSettle();
        final close = desktop ? find.text('Close') : find.byTooltip('Close');
        expect(close, findsNothing);
        expect(find.text('Recent workflow runs'), findsOneWidget);
        await _openSchedule(tester, desktop: desktop);
        expect(automation.scheduleLoads, ['trigger-one', 'trigger-one']);
        expect(tester.takeException(), isNull);
      },
      variant: variant,
    );

    testWidgets(
      '$presentation never links missing or malformed workflow identities',
      (tester) async {
        final results = _ReadOnlyResults();
        await _mount(
          tester,
          desktop: desktop,
          automation: _AutomationRepository(
            runs: [
              _run(null, 'Missing identity'),
              _run(' padded-run ', 'Padded identity'),
              _run('run\ncontrol', 'Control character identity'),
              _run(List.filled(201, 'a').join(), 'Oversized identity'),
              _run(42, 'Non-string identity'),
            ],
            occurrenceRunId: ' padded-occurrence-run ',
          ),
          results: results,
        );
        await _selectAutomations(tester, desktop: desktop);
        await _reveal(
          tester,
          find.text('Non-string identity'),
          scrollable: desktop ? null : _portableAutomationScroll(),
        );
        expect(find.text('Open run'), findsNothing);

        await _openSchedule(tester, desktop: desktop);
        if (!desktop) {
          await tester.tap(find.text(_occurrenceId));
          await tester.pumpAndSettle();
        }
        expect(find.text('Open run'), findsNothing);
        expect(results.details, isEmpty);
        expect(results.effects, 0);
        expect(tester.takeException(), isNull);
      },
      variant: variant,
    );
  }
}

Future<ProviderContainer> _mount(
  WidgetTester tester, {
  required bool desktop,
  required _AutomationRepository automation,
  required _ReadOnlyResults results,
}) async {
  tester.view.physicalSize = desktop
      ? const Size(1240, 900)
      : const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final store = SecureSessionStore(const FlutterSecureStorage());
  final api = ApiClient(Dio(), Dio(), store);
  final access = NativeWorkspaceAccess(
    api,
    NativeRequestAuthority(
      tenantId: 'tenant-one',
      actorId: 'actor:11111111-1111-4111-8111-111111111111',
      canonicalUserId: '11111111-1111-4111-8111-111111111111',
      role: 'operator',
      apiBaseUrl: api.apiBaseUrl,
      isCurrent: () => true,
    ),
    true,
  );
  final container = ProviderContainer(
    overrides: [
      sessionControllerProvider.overrideWith(_OperatorSession.new),
      appInitialLocationProvider.overrideWithValue(
        '/automation?section=skills',
      ),
      nativeWorkspaceAccessProvider.overrideWithValue(access),
      specialistRecoveryProvider.overrideWithValue(
        MemorySpecialistRecoveryStore(),
      ),
      automationRepositoryProvider.overrideWithValue(automation),
      resultsRepositoryProvider.overrideWithValue(results),
      reconnectCoordinatorProvider.overrideWithValue(
        ReconnectCoordinator(() async => const [], const Stream.empty()),
      ),
    ],
  );
  addTearDown(container.dispose);
  await container.read(sessionControllerProvider.future);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        theme: desktop ? MacosAppTheme.light() : AppTheme.light(),
        routerConfig: container.read(appRouterProvider),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

Future<void> _selectAutomations(
  WidgetTester tester, {
  required bool desktop,
}) async {
  final tab = desktop
      ? find.byKey(const ValueKey('automation-section-automations'))
      : find.text('Automations');
  await _reveal(tester, tab);
  await tester.tap(tab);
  await tester.pumpAndSettle();
}

Future<void> _openSchedule(WidgetTester tester, {required bool desktop}) async {
  final history = find.byKey(
    ValueKey(
      desktop
          ? 'automation-schedule-history-trigger-one'
          : 'portable-automation-trigger-trigger-one',
    ),
  );
  await _reveal(
    tester,
    history,
    scrollable: desktop ? null : _portableAutomationScroll(),
    delta: -120,
  );
  await tester.tap(history);
  await tester.pumpAndSettle();
}

Finder _portableAutomationScroll() => find
    .descendant(
      of: find.byKey(const ValueKey('portable-automations')),
      matching: find.byType(Scrollable),
    )
    .first;

Future<void> _reveal(
  WidgetTester tester,
  Finder target, {
  Finder? scrollable,
  double delta = 120,
}) async {
  if (scrollable == null) {
    await tester.ensureVisible(target);
  } else {
    await tester.scrollUntilVisible(target, delta, scrollable: scrollable);
  }
  // Scrollable.ensureVisible changes the offset before the next layout. Wait
  // for that layout before checking the target or deriving the tap position.
  await tester.pumpAndSettle();
  expect(target.hitTestable(), findsOneWidget);
}

class _OperatorSession extends SessionController {
  @override
  Future<AppSession?> build() async => const AppSession(
    tenantId: 'tenant-one',
    actorId: 'actor:11111111-1111-4111-8111-111111111111',
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'operator@example.test',
    displayName: 'Operator',
    workspaceName: 'Asael',
    role: 'operator',
  );
}

AutomationWorkflowRun _run(Object? id, String title) =>
    AutomationWorkflowRun.fromJson({
      'id': ?id,
      'name': title,
      'status': 'completed',
      'mode': 'workflow',
    });

class _AutomationRepository implements AutomationRepository {
  _AutomationRepository({
    List<AutomationWorkflowRun>? runs,
    this.occurrenceRunId = _runId,
  }) : runs = runs ?? [_run(_runId, 'Prepared weekly summary')];

  final List<AutomationWorkflowRun> runs;
  final Object? occurrenceRunId;
  final scheduleLoads = <String>[];

  AutomationTrigger get trigger => AutomationTrigger.fromJson({
    'id': 'trigger-one',
    'name': 'Morning briefing',
    'status': 'active',
    'source': 'schedule',
    'workflowMode': 'orchestrate',
  });

  @override
  Future<AutomationSnapshot> load() async => AutomationSnapshot(
    skills: const AutomationResource.ready([]),
    workflows: AutomationResource.ready(runs),
    triggers: AutomationResource.ready([trigger]),
  );

  @override
  Future<AutomationScheduleDetail> loadSchedule(String triggerId) async {
    scheduleLoads.add(triggerId);
    return AutomationScheduleDetail.fromResponse({
      'trigger': trigger.raw,
      'preview': {'occurrences': const []},
      'occurrences': [
        {
          'id': _occurrenceId,
          'kind': 'scheduled',
          'status': 'completed',
          'scheduledFor': '2026-09-22T03:00:00.000Z',
          'workflowRunId': occurrenceRunId,
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
        'outcomes': const [],
      },
    });
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw StateError(
    'Unexpected Automation operation: ${invocation.memberName}',
  );
}

class _ReadOnlyResults implements ResultsRepository {
  _ReadOnlyResults({this.missing = false});
  final bool missing;
  final details = <String>[];
  int effects = 0;

  @override
  Future<ResultsSnapshot> list() async =>
      const ResultsSnapshot(items: [], evaluations: [], sourceErrors: []);

  @override
  Future<ResultItem?> detail(String key) async {
    details.add(key);
    if (missing) return null;
    return ResultItem(
      key: key,
      kind: ResultKind.workflow,
      title: 'Workflow result',
      status: 'completed',
      body: 'Stored workflow output',
      meta: 'Exact workflow fixture',
      tone: ResultTone.neutral,
      evidence: const ['Stored workflow evidence'],
    );
  }

  @override
  Future<void> cancel(String runId) async {
    effects++;
    throw StateError('Unexpected effect');
  }
}
