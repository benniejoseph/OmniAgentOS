import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/customers/macos_customer_detail_view.dart';
import 'package:asael/features/meetings/macos_meeting_detail_view.dart';
import 'package:asael/features/meetings/meetings.dart' hide Json;
import 'package:asael/features/projects/macos_project_detail_view.dart';
import 'package:asael/features/projects/projects.dart';
import 'package:asael/features/results/macos_result_detail_view.dart';
import 'package:asael/features/results/results.dart' hide Json;
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets('project workspace preserves mutations and artifact evidence', (
    tester,
  ) async {
    final repository = _ProjectRepository();
    await _pumpMac(
      tester,
      MacosProjectDetailView(
        id: 'project-1',
        repository: repository,
        api: _FixtureApi(const {}),
        focusWorkItemId: 'task-1',
      ),
    );

    expect(find.text('Build the native Asael workspace'), findsOneWidget);
    expect(find.text('Review the Mac interaction model'), findsOneWidget);
    expect(find.text('2 of 3 tasks completed'), findsOneWidget);

    await tester.tap(find.byKey(const Key('macos-project-toggle-complete')));
    await tester.pumpAndSettle();
    expect(repository.lastProjectChanges, {'status': 'completed'});

    await tester.tap(find.text('Artifacts'));
    await tester.pumpAndSettle();
    expect(find.text('Native workspace review'), findsWidgets);
    expect(
      find.textContaining('The desktop navigation now follows'),
      findsOneWidget,
    );
    expect(find.text('evidence:macos-shell'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'meeting workspace keeps decisions, consent, and evidence visible',
    (tester) async {
      await _pumpMac(
        tester,
        MacosMeetingDetailView(
          id: 'meeting-1',
          repository: _MeetingRepository(),
        ),
      );

      expect(find.text('Mac release review'), findsWidgets);
      expect(
        find.text('Ship the signed candidate after targeted validation.'),
        findsOneWidget,
      );
      expect(find.text('Bennie'), findsOneWidget);
      expect(find.text('Release checklist'), findsOneWidget);
      expect(find.text('Participants & consent'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('result workspace copies output and cancels through repository', (
    tester,
  ) async {
    final repository = _ResultRepository();
    await _pumpMac(
      tester,
      MacosResultDetailView(keyValue: 'agent:run-1', repository: repository),
    );

    expect(find.text('Research XAUUSD'), findsWidgets);
    expect(find.textContaining('Evidence-backed market brief'), findsOneWidget);
    expect(find.text('https://example.test/source'), findsOneWidget);

    await tester.tap(find.byKey(const Key('macos-result-cancel')));
    await tester.pumpAndSettle();
    expect(find.text('Cancel this agent run?'), findsOneWidget);
    await tester.tap(find.byKey(const Key('macos-result-cancel-confirm')));
    await tester.pumpAndSettle();
    expect(repository.canceledRun, 'run-1');
    expect(tester.takeException(), isNull);
  });

  testWidgets('Customer 360 workspace searches and inspects governed facts', (
    tester,
  ) async {
    await _pumpMac(
      tester,
      MacosCustomerDetailView(
        id: 'account-1',
        api: _FixtureApi(_customerProjection),
      ),
    );

    expect(find.text('Acme Private Office'), findsWidgets);
    expect(find.text('Renewal Status'), findsWidgets);
    expect(find.text('Workspace Region'), findsOneWidget);

    await tester.enterText(
      find.byKey(const Key('macos-customer-fact-search')),
      'renewal',
    );
    await tester.pump();
    expect(find.text('Renewal Status'), findsWidgets);
    expect(find.text('Workspace Region'), findsNothing);
    expect(find.text('salesforce · opportunity-7'), findsWidgets);
    expect(tester.takeException(), isNull);
  });
}

Future<void> _pumpMac(WidgetTester tester, Widget home) async {
  tester.view.physicalSize = const Size(1500, 920);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(theme: MacosAppTheme.light(), home: home),
  );
  await tester.pumpAndSettle();
}

class _FixtureApi extends ApiClient {
  _FixtureApi(this.response)
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  final Map<String, dynamic> response;

  @override
  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, dynamic>? query,
  }) async => response;
}

class _ProjectRepository implements ProjectsRepository {
  final project = Project(
    id: 'project-1',
    title: 'Mac application redesign',
    objective: 'Build the native Asael workspace',
    status: 'active',
    autonomyMode: 'supervised',
    executionStatus: 'idle',
    taskBudget: 8,
    tasksDispatched: 3,
    maxParallelTasks: 2,
    requireApproval: true,
    tasks: const [
      ProjectTask(
        id: 'task-1',
        title: 'Review the Mac interaction model',
        detail: 'Validate pointer, keyboard, and window behavior.',
        status: 'doing',
        priority: 'high',
        agentId: 'atlas',
        origin: 'plan',
        position: 0,
        dependsOn: [],
        dispatchAttempt: 1,
      ),
      ProjectTask(
        id: 'task-2',
        title: 'Implement workspace shell',
        detail: '',
        status: 'done',
        priority: 'high',
        agentId: 'builder',
        origin: 'plan',
        position: 1,
        dependsOn: [],
        dispatchAttempt: 1,
      ),
      ProjectTask(
        id: 'task-3',
        title: 'Validate native chrome',
        detail: '',
        status: 'done',
        priority: 'medium',
        agentId: 'sentinel',
        origin: 'plan',
        position: 2,
        dependsOn: [],
        dispatchAttempt: 1,
      ),
    ],
    artifacts: [
      ProjectArtifact(
        id: 'artifact-1',
        taskId: 'task-2',
        workflowRunId: 'workflow-1',
        agentId: 'builder',
        status: 'verified',
        title: 'Native workspace review',
        content:
            'The desktop navigation now follows macOS workspace conventions.',
        evidenceRefs: const ['evidence:macos-shell'],
        createdAt: DateTime.utc(2026, 9, 17),
      ),
    ],
    updatedAt: DateTime.utc(2026, 9, 17),
  );

  Json? lastProjectChanges;

  @override
  Future<Project> detail(String id) async => project;

  @override
  Future<Project> update(String id, Json changes) async {
    lastProjectChanges = changes;
    return project;
  }

  @override
  Future<List<Project>> list() async => [project];

  @override
  Future<Project> create({
    required String title,
    required String objective,
    DateTime? targetDate,
  }) async => project;

  @override
  Future<ProjectPlan> plan(String id, {String? context}) async =>
      const ProjectPlan('', []);

  @override
  Future<ProjectTask> createTask(
    String id, {
    required String title,
    String detail = '',
    String priority = 'medium',
    String agentId = 'atlas',
  }) async => project.tasks.first;

  @override
  Future<ProjectTask> updateTask(
    String id,
    String taskId,
    Json changes,
  ) async => project.tasks.first;

  @override
  Future<Project> execute(
    String id,
    String action, {
    ExecutionConfig? config,
    String? taskId,
  }) async => project;

  @override
  Future<ProjectArtifact> reflect(
    String id,
    String artifactId, {
    required String verdict,
    required String lesson,
  }) async => project.artifacts.first;
}

class _MeetingRepository implements MeetingsRepository {
  final meeting = Meeting(
    id: 'meeting-1',
    title: 'Mac release review',
    summary: 'Review the signed application candidate and deployment evidence.',
    status: 'scheduled',
    startAt: DateTime.utc(2026, 9, 17, 10),
    endAt: DateTime.utc(2026, 9, 17, 11),
    timezone: 'Asia/Kolkata',
    location: 'Asael Studio',
    accessClass: 'owner_private',
    revision: 4,
    participants: const [
      MeetingParticipant(
        id: 'person-1',
        name: 'Bennie',
        role: 'owner',
        response: 'accepted',
        attendeeConsent: 'granted',
        recordingConsent: 'granted',
      ),
    ],
    decisions: const [
      MeetingNote(
        id: 'decision-1',
        label: 'Ship the signed candidate after targeted validation.',
      ),
    ],
    commitments: const [],
    followUps: const [],
    evidence: const [
      MeetingEvidence(
        id: 'evidence-1',
        label: 'Release checklist',
        kind: 'source_revision',
        role: 'reference',
      ),
    ],
  );

  @override
  Future<Meeting> detail(String id) async => meeting;

  @override
  Future<List<Meeting>> list() async => [meeting];
}

class _ResultRepository implements ResultsRepository {
  ResultItem item = ResultItem.agent({
    'id': 'run-1',
    'prompt': 'Research XAUUSD',
    'status': 'running',
    'response': 'Evidence-backed market brief is still being assembled.',
    'startedAt': '2026-09-17T04:00:00.000Z',
    'grounding': {
      'status': 'verified',
      'citations': [
        {'url': 'https://example.test/source'},
      ],
    },
  });
  String? canceledRun;

  @override
  Future<ResultItem?> detail(String key) async => item;

  @override
  Future<void> cancel(String runId) async {
    canceledRun = runId;
    item = ResultItem.agent({
      'id': runId,
      'prompt': 'Research XAUUSD',
      'status': 'canceled',
      'response': 'The run was canceled.',
    });
  }

  @override
  Future<ResultsSnapshot> list() async => ResultsSnapshot(
    items: [item],
    evaluations: const [],
    sourceErrors: const [],
  );
}

const _customerProjection = <String, dynamic>{
  'account': {
    'account': {
      'accountId': 'account-1',
      'name': 'Acme Private Office',
      'lifecycle': 'active',
      'revision': 7,
    },
    'facts': [
      {
        'fact': {
          'factKey': 'renewal.status',
          'value': {'status': 'on_track'},
          'source': {'sourceKind': 'salesforce', 'sourceId': 'opportunity-7'},
          'confidenceBasisPoints': 9400,
        },
        'freshness': {'status': 'fresh'},
      },
      {
        'fact': {
          'factKey': 'workspace.region',
          'value': {'value': 'Mumbai'},
          'source': {'sourceKind': 'drive', 'sourceId': 'account-brief'},
          'confidenceBasisPoints': 8100,
        },
        'freshness': {'status': 'stale'},
      },
    ],
  },
};
