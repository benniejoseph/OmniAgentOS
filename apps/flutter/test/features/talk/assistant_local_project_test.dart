import 'dart:async';

import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/platform/local_computer_bridge.dart';
import 'package:asael/features/computer_use/local_computer.dart';
import 'package:asael/features/talk/assistant_local_project.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const first = 'local_workspace_11111111111111111111111111111111';
const second = 'local_workspace_22222222222222222222222222222222';
const snapshot = LocalProjectSnapshot(
  isRepository: true,
  branch: 'feature/current',
  detached: false,
  remotes: [
    LocalProjectRemote(
      name: 'origin',
      url: 'git.example.test/team/project.git',
    ),
  ],
  changes: [LocalProjectChange(path: 'lib/main.dart', status: ' M')],
  files: ['lib/main.dart'],
  truncated: false,
);

void main() {
  test('local requests use their folder; queued work keeps it after selection changes', () async {
    final repository = _Repository();
    final controller = TalkController(repository);
    addTearDown(controller.dispose);
    await controller.selectLocalProject(first);
    await controller.send(
      'Read the project',
      mode: 'coding',
      executionTarget: TalkExecutionTarget.thisMac,
    );
    expect(repository.receivedFolders, [first]);
    expect(repository.cloudSends, 0);
    controller.sending = true;
    await controller.send(
      'Then review the diff',
      mode: 'coding',
      executionTarget: TalkExecutionTarget.thisMac,
    );
    await controller.selectLocalProject(second);
    expect(controller.promptQueue.single.localWorkspaceId, first);
    expect(
      controller.promptQueue.single
          .copyWith(input: 'Corrected prompt')
          .localWorkspaceId,
      first,
    );
    expect(controller.voiceConversationContext['localWorkspaceId'], second);
    controller.sending = false;
  });

  test(
    'late folder restoration cannot replace a newly selected folder',
    () async {
      final repository = _Repository();
      final controller = TalkController(repository);
      addTearDown(controller.dispose);
      controller.applyHistoryThreadProjection(
        TalkThreadDetail(
          thread: TalkThreadSummary.fromJson({
            'id': '11111111-1111-4111-8111-111111111111',
            'title': 'Old project',
            'mode': 'coding',
          }),
          turns: const [],
        ),
      );
      expect(controller.localProjectLoading, isTrue);
      await controller.selectLocalProject(second);
      repository.saved.complete(first);
      await Future<void>.delayed(Duration.zero);
      expect(controller.localWorkspaceId, second);
      expect(controller.localProjectLoading, isFalse);
    },
  );

  test('file projections reject paths that escape the selected folder', () {
    for (final path in [
      '../private',
      '/private',
      '.git/config',
      'folder/../../private',
    ]) {
      expect(
        () => LocalProjectFile.fromArguments({
          'path': path,
          'content': 'secret',
          'truncated': false,
          'binary': false,
        }),
        throwsFormatException,
      );
    }
    expect(
      LocalProjectFile.fromArguments({
        'path': 'src/main.dart',
        'content': 'actual file',
        'truncated': false,
        'binary': false,
      }).content,
      'actual file',
    );
  });

  for (final width in [400.0, 540.0, 1100.0]) {
    testWidgets('local file and diff review is usable at $width', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 850);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final coordinator = _Coordinator();
      addTearDown(coordinator.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: MacosAppTheme.light(),
          home: Scaffold(
            body: AssistantLocalProjectPanel(
              workspace: const LocalCommandWorkspace(
                id: first,
                name: 'Example project',
                path: '/projects/example',
              ),
              coordinator: coordinator,
              embedded: width == 400,
              onClose: width == 400 ? () {} : null,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('feature/current'), findsOneWidget);
      expect(find.textContaining('git.example.test'), findsOneWidget);
      await tester.tap(find.text('lib/main.dart'));
      await tester.pumpAndSettle();
      expect(find.textContaining('+ actual change'), findsOneWidget);
      expect(coordinator.reads, ['changes:lib/main.dart']);
      if (width < 640) {
        await tester.tap(find.text('Back to files'));
        await tester.pumpAndSettle();
      }
      await tester.tap(find.widgetWithText(ChoiceChip, 'Files'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('lib/main.dart'));
      await tester.pumpAndSettle();
      expect(coordinator.reads.last, 'file:lib/main.dart');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }
}

class _Repository extends Fake
    implements TalkRepository, TalkLocalProjectRepository {
  final receivedFolders = <String>[];
  final saved = Completer<String?>();
  int cloudSends = 0;
  @override
  Future<String?> readLocalProjectBinding(String threadId) => saved.future;
  @override
  Future<void> saveLocalProjectBinding(
    String threadId,
    String workspaceId,
  ) async {}
  @override
  Stream<SseEvent> sendFromLocalProject({
    required String message,
    required String workspaceId,
    String? threadId,
    String mode = 'coding',
    String strategy = 'auto',
    String? agentId,
    List<TalkCommandContextReference> contextReferences = const [],
    TalkCommandModelSelection? modelSelection,
    TalkVoiceInput? voiceInput,
  }) {
    receivedFolders.add(workspaceId);
    return const Stream.empty();
  }

  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    String? agentId,
    TalkCommandModelSelection? modelSelection,
  }) {
    cloudSends++;
    return const Stream.empty();
  }
}

class _Coordinator extends ChangeNotifier implements LocalComputerCoordinator {
  final reads = <String>[];
  @override
  Future<LocalProjectSnapshot> inspectProject(String workspaceId) async =>
      snapshot;
  @override
  Future<LocalProjectFile> readProjectFile(
    String workspaceId,
    String path, {
    bool changes = false,
  }) async {
    reads.add('${changes ? 'changes' : 'file'}:$path');
    return LocalProjectFile(
      path: path,
      content: changes ? '+ actual change' : 'actual file',
      truncated: false,
      binary: false,
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
