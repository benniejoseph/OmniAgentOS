import 'package:asael/features/results/results.dart';
import 'package:asael/features/results/results_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('shows created files on the adaptive Results surface', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(420, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final artifact = GeneratedArtifactSummary(
      id: 'generated_artifact_${List.filled(48, 'f').join()}',
      kind: GeneratedArtifactKind.presentation,
      title: 'Client transformation pitch',
      filename: 'Client transformation pitch.pptx',
      version: 2,
      status: GeneratedArtifactStatus.ready,
      mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      byteCount: 4096,
      createdAt: DateTime.utc(2026, 9, 19, 2),
      updatedAt: DateTime.utc(2026, 9, 19, 2, 1),
      queuedAt: DateTime.utc(2026, 9, 19, 2),
      readyAt: DateTime.utc(2026, 9, 19, 2, 1),
      failedAt: null,
    );
    final snapshot = ResultsSnapshot(
      items: const [],
      evaluations: const [],
      sourceErrors: const [],
      createdFiles: [artifact],
    );
    final controller = ResultsController(_Repository(snapshot))
      ..snapshot = snapshot;

    await tester.pumpWidget(
      MaterialApp(
        home: ResultsView(controller: controller, onOpen: (_) {}),
      ),
    );

    expect(find.byKey(const Key('created-files-section')), findsOneWidget);
    expect(find.text('Client transformation pitch'), findsOneWidget);
    expect(find.text('Private · Ready'), findsOneWidget);
    expect(find.byKey(Key('created-file-save-${artifact.id}')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

class _Repository implements ResultsRepository {
  const _Repository(this.snapshot);

  final ResultsSnapshot snapshot;

  @override
  Future<void> cancel(String runId) async {}

  @override
  Future<ResultItem?> detail(String key) async => null;

  @override
  Future<ResultsSnapshot> list() async => snapshot;
}
