import 'dart:io';
import 'dart:ui' as ui;

import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/self_improvement/self_improvement_controller.dart';
import 'package:asael/features/self_improvement/self_improvement_models.dart';
import 'package:asael/features/self_improvement/self_improvement_repository.dart';
import 'package:asael/features/self_improvement/self_improvement_providers.dart';
import 'package:asael/features/self_improvement/self_improvement_view.dart';
import 'package:asael/features/self_improvement/self_improvement_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'self_improvement_test_support.dart';

class _Repository implements SelfImprovementRepositoryApi {
  _Repository(this.value);
  ImprovementJson value;
  bool active = true, writable = true, failWrite = false;
  final writes = <(String, ImprovementJson)>[];
  int reads = 0;
  @override
  bool get current => active;
  @override
  bool get canManage => writable;
  @override
  Future<SelfImprovementSnapshot> load() async {
    reads++;
    return SelfImprovementSnapshot.fromJson(improvementCopy(value));
  }

  @override
  Future<SelfImprovementCycle?> loadCycle(String id) async => null;
  @override
  Future<List<SelfImprovementRepositoryOption>> loadRepositories() async => [
    SelfImprovementRepositoryOption.fromJson({
      'repositoryId': '1260961340',
      'owner': 'benniejoseph',
      'name': 'OmniAgentOS',
      'fullName': 'benniejoseph/OmniAgentOS',
      'defaultBranch': 'main',
      'htmlUrl': 'https://github.com/benniejoseph/OmniAgentOS',
    }),
  ];
  @override
  Future<List<SelfImprovementProject>> loadProjects() async => [
    SelfImprovementProject.fromJson({
      'id': 'project-one',
      'title': 'Asael engineering',
      'objective': 'Synthetic widget verification only.',
      'status': 'active',
      'tenantId': 'default',
      'actorId': improvementActor,
    }),
  ];
  @override
  Future<SelfImprovementMutationResult> mutate(
    String action,
    ImprovementJson input,
    String idempotencyKey,
  ) async {
    writes.add((action, improvementCopy(input)));
    if (failWrite) throw StateError('Synthetic response interrupted.');
    return SelfImprovementMutationResult(outcome: action);
  }
}

Future<(_Repository, SelfImprovementController)> _fixture({
  String stage = 'review_required',
  bool unknown = false,
}) async {
  final policy = await improvementPolicy();
  final cycle = await improvementCycle(policy, stage: stage);
  cycle['summary'] = 'Synthetic UI verification: preserve the selected work and review its recorded evidence.';
  cycle['phase'] = stage == 'failed' ? 'setup' : 'review';
  cycle['spendUsd'] = 0.42;
  cycle['usageState'] = unknown ? 'unknown' : 'known';
  cycle['agentRuns'] = [
    for (final (name, phase, id) in [
      ('atlas', 'inspect', '2'),
      ('forge', 'implement', '3'),
      ('sentinel', 'review', '4'),
    ])
      {
        'agentId': name,
        'phase': phase,
        'runId': '${id * 8}-${id * 4}-${id * 4}-${id * 4}-${id * 12}',
        'costCeilingUsd': 1,
        'completed': true,
      },
  ];
  final repository = _Repository(
    improvementSnapshot(improvementConfig(policy), [cycle]),
  );
  final controller = SelfImprovementController(repository);
  await controller.refresh();
  return (repository, controller);
}

Future<void> _pump(
  WidgetTester tester,
  SelfImprovementController controller, {
  Size size = const Size(1280, 960),
  bool dark = false,
  String? cycleId,
  double textScale = 1,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: dark ? MacosAppTheme.dark() : MacosAppTheme.light(),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: RepaintBoundary(
        key: const Key('synthetic-improvement-render'),
        child: SelfImprovementView(controller: controller, cycleId: cycleId),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _capture(WidgetTester tester, String name) async {
  final directory = Platform.environment['ASAEL_SELF_IMPROVEMENT_CAPTURE_DIR'];
  if (directory == null) return;
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(const Key('synthetic-improvement-render')),
  );
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 1);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(directory).create(recursive: true);
    await File('$directory/$name').writeAsBytes(data!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(() async {
    if (Platform.environment['ASAEL_SELF_IMPROVEMENT_CAPTURE_DIR'] != null) {
      // Optional local visual evidence uses the installed system typeface;
      // the normal portable tests keep Flutter's deterministic test font.
      final font = FontLoader('.AppleSystemUIFont')
        ..addFont(
          File('/System/Library/Fonts/SFNS.ttf')
              .readAsBytes()
              .then((bytes) => ByteData.sublistView(bytes)),
        );
      final icons = FontLoader('MaterialIcons')
        ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
      await font.load();
      await icons.load();
    }
  });
  testWidgets(
    'wide native view binds review to the displayed exact candidate',
    (tester) async {
      final (repository, controller) = await _fixture();
      addTearDown(controller.dispose);
      await _pump(tester, controller);
      expect(find.text('Self-improvement'), findsOneWidget);
      expect(
        find.textContaining('\$100.00 / UTC day · \$10.00 / cycle'),
        findsOneWidget,
      );
      expect(find.text('Mac publisher not connected'), findsOneWidget);
      expect(find.text('Atlas'), findsOneWidget);
      expect(find.text('Forge'), findsOneWidget);
      expect(find.text('Sentinel'), findsOneWidget);
      await _capture(tester, 'wide-light-synthetic.png');
      await tester.ensureVisible(find.text('Approve this repair'));
      await tester.tap(find.text('Approve this repair'));
      await tester.pumpAndSettle();
      expect(repository.writes, hasLength(1));
      final (action, input) = repository.writes.single;
      final cycle = controller.snapshot!.cycles.single;
      expect(action, 'review');
      expect(input['cycleId'], cycle.id);
      expect(input['expectedRevision'], cycle.revision);
      expect(input['candidateSha256'], cycle.candidate!.candidateSha256);
      expect(input['validationSha256'], cycle.validation!.validationSha256);
      expect(input['decision'], 'approve');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'interrupted write disables actions and never replays on rebuild',
    (tester) async {
      final (repository, controller) = await _fixture(stage: 'failed');
      addTearDown(controller.dispose);
      repository.failWrite = true;
      await _pump(tester, controller);
      await tester.tap(find.byKey(const Key('improvement-run')));
      await tester.pumpAndSettle();
      expect(repository.writes, hasLength(1));
      expect(
        find.textContaining('nothing will be replayed automatically'),
        findsOneWidget,
      );
      expect(
        tester
            .widget<FilledButton>(find.byKey(const Key('improvement-run')))
            .onPressed,
        isNull,
      );
      await tester.pump();
      expect(repository.writes, hasLength(1));
      await tester.tap(find.byKey(const Key('improvement-refresh')));
      await tester.pumpAndSettle();
      expect(repository.writes, hasLength(1));
      expect(
        tester
            .widget<FilledButton>(find.byKey(const Key('improvement-run')))
            .onPressed,
        isNotNull,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('refresh preserves selection after the ledger is reordered', (
    tester,
  ) async {
    final (repository, controller) = await _fixture(stage: 'failed');
    addTearDown(controller.dispose);
    final first = improvementCopy((repository.value['cycles'] as List).single);
    final second = improvementCopy(first)
      ..['id'] = 'self_cycle_${improvementHex('9')}'
      ..['summary'] = 'Second saved investigation';
    repository.value['cycles'] = [first, second];
    await controller.refresh();
    await _pump(tester, controller);
    await tester.tap(find.byKey(ValueKey('improvement-cycle-${second['id']}')));
    await tester.pumpAndSettle();
    repository.value['cycles'] = [second, first];
    await tester.tap(find.byKey(const Key('improvement-refresh')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(ValueKey('improvement-detail-${second['id']}')),
      findsOneWidget,
    );
    expect(repository.writes, isEmpty);
  });

  testWidgets(
    'unavailable notification cycle never substitutes a recent cycle',
    (tester) async {
      final (repository, controller) = await _fixture(stage: 'failed');
      addTearDown(controller.dispose);
      final missing = 'self_cycle_${improvementHex('9')}';
      await controller.refresh(cycleId: missing);
      await _pump(tester, controller, cycleId: missing);
      expect(find.text('This cycle is unavailable'), findsOneWidget);
      expect(find.byType(SelectionArea), findsNothing);
      expect(repository.writes, isEmpty);
    },
  );

  testWidgets(
    'settings preserve notifications and reject invalid cycle budgets',
    (tester) async {
      final (repository, controller) = await _fixture(stage: 'failed');
      addTearDown(controller.dispose);
      await _pump(tester, controller);
      await tester.tap(find.byKey(const Key('improvement-settings')));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextFormField>(
              find.byKey(const Key('improvement-daily-budget')),
            )
            .controller!
            .text,
        '100.0',
      );
      expect(
        tester
            .widget<TextFormField>(
              find.byKey(const Key('improvement-cycle-budget')),
            )
            .controller!
            .text,
        '10.0',
      );
      await tester.enterText(
        find.byKey(const Key('improvement-cycle-budget')),
        '101',
      );
      await tester.ensureVisible(
        find.byKey(const Key('improvement-save-settings')),
      );
      await tester.tap(find.byKey(const Key('improvement-save-settings')));
      await tester.pumpAndSettle();
      expect(repository.writes, isEmpty);
      expect(
        find.text('Use an amount above 0, within the daily limit.'),
        findsOneWidget,
      );
      await tester.ensureVisible(
        find.byKey(const Key('improvement-cycle-budget')),
      );
      await tester.enterText(
        find.byKey(const Key('improvement-cycle-budget')),
        '8',
      );
      await tester.ensureVisible(
        find.byKey(const Key('improvement-save-settings')),
      );
      await tester.tap(find.byKey(const Key('improvement-save-settings')));
      await tester.pumpAndSettle();
      expect(repository.writes.single.$1, 'configure');
      expect(repository.writes.single.$2['maxCycleBudgetUsd'], 8);
      expect(repository.writes.single.$2['notifyOutcomes'], false);
      expect(repository.writes.single.$2['expectedGeneration'], 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('narrow dark view renders unknown cost and disables approval', (
    tester,
  ) async {
    final (repository, controller) = await _fixture(unknown: true);
    addTearDown(controller.dispose);
    await _pump(
      tester,
      controller,
      size: const Size(430, 920),
      dark: true,
      textScale: 1.2,
      cycleId: improvementCycleId,
    );
    expect(find.text('Cycle history'), findsOneWidget);
    await _capture(tester, 'narrow-dark-synthetic.png');
    await tester.ensureVisible(find.text('Approve this repair'));
    expect(
      tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'Approve this repair'),
          )
          .onPressed,
      isNull,
    );
    await tester.ensureVisible(find.text('Not fully reconciled'));
    expect(find.text('Not fully reconciled'), findsOneWidget);
    expect(repository.writes, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('held candidate discard requires exact confirmation', (
    tester,
  ) async {
    final (repository, controller) = await _fixture(stage: 'ready_for_release');
    addTearDown(controller.dispose);
    final raw = (repository.value['cycles'] as List).single as ImprovementJson;
    raw['discardAvailable'] = true;
    raw['controllerHold'] = {
      'category': 'source_drift',
      'occurredAt': improvementStamp,
    };
    await controller.refresh();
    await _pump(tester, controller);
    await tester.ensureVisible(find.text('Discard candidate'));
    await tester.tap(find.text('Discard candidate'));
    await tester.pumpAndSettle();
    expect(repository.writes, isEmpty);
    await tester.ensureVisible(find.text('Confirm discard'));
    await tester.tap(find.text('Confirm discard'));
    await tester.pumpAndSettle();
    expect(repository.writes.single.$2['decision'], 'reject');
    expect(repository.writes.single.$2['cycleId'], improvementCycleId);
  });

  testWidgets('invalid deep link is rejected without a private provider', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(home: NativeSelfImprovementPage(cycleId: '../other')),
    );
    expect(find.text('This improvement link is invalid.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('native workspace preserves drafts when inactive or hidden', (
    tester,
  ) async {
    final (repository, controller) = await _fixture(stage: 'failed');
    final api = ApiClient(
      Dio(BaseOptions(baseUrl: 'https://synthetic.test')),
      Dio(),
      SecureSessionStore(const FlutterSecureStorage()),
    );
    final authority = NativeRequestAuthority(
      tenantId: 'default',
      actorId: improvementActor,
      canonicalUserId: improvementUser,
      role: 'admin',
      apiBaseUrl: api.apiBaseUrl,
      isCurrent: () => true,
    );
    final visible = ValueNotifier(true);
    addTearDown(visible.dispose);
    tester.view.physicalSize = const Size(1280, 960);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(
            NativeWorkspaceAccess(api, authority, true),
          ),
          selfImprovementControllerProvider.overrideWith((ref) => controller),
        ],
        child: MaterialApp(
          theme: MacosAppTheme.light(),
          home: ValueListenableBuilder<bool>(
            valueListenable: visible,
            builder: (context, value, child) =>
                TickerMode(enabled: value, child: child!),
            child: const NativeSelfImprovementPage(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('improvement-settings')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('improvement-cycle-budget')),
      '8',
    );
    final reads = repository.reads;
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    visible.value = false;
    await tester.pump();
    visible.value = true;
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<TextFormField>(
            find.byKey(const Key('improvement-cycle-budget')),
          )
          .controller!
          .text,
      '8',
    );
    expect(repository.reads, reads);
    expect(repository.writes, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('settings cannot save after the starting generation changes', (
    tester,
  ) async {
    final (repository, controller) = await _fixture(stage: 'failed');
    addTearDown(controller.dispose);
    await _pump(tester, controller);
    await tester.tap(find.byKey(const Key('improvement-settings')));
    await tester.pumpAndSettle();
    final configuration =
        (repository.value['configurations'] as List).single as ImprovementJson;
    configuration['generation'] = 2;
    await controller.refresh();
    await tester.pumpAndSettle();
    expect(
      find.textContaining('changed while this draft was open'),
      findsOneWidget,
    );
    await tester.ensureVisible(
      find.byKey(const Key('improvement-save-settings')),
    );
    expect(
      tester
          .widget<FilledButton>(
            find.byKey(const Key('improvement-save-settings')),
          )
          .onPressed,
      isNull,
    );
    expect(repository.writes, isEmpty);
  });
}
