import 'dart:async';
import 'dart:io';

import 'package:asael/features/results/created_file_export.dart';
import 'package:asael/features/results/created_files_section.dart';
import 'package:asael/features/results/result_contracts.dart';
import 'package:asael/features/results/results.dart';
import 'package:asael/features/results/results_repository_contracts.dart';
import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _Adapter implements CreatedFileExportAdapter {
  _Adapter({this.available = true});
  @override
  final bool available;
  final destination = Completer<String?>();
  Completer<void>? beforeWrite;
  int selections = 0;
  final writes = <({String destination, List<int> bytes})>[];
  @override
  Future<String?> selectDestination({required String filename}) {
    selections++;
    return destination.future;
  }

  @override
  Future<void> writeBytes(
    String destination,
    Uint8List bytes, {
    required bool Function() isCurrent,
  }) async {
    if (beforeWrite != null) {
      await beforeWrite!.future;
    }
    if (!isCurrent()) {
      throw const CreatedFileExportScopeChanged();
    }
    writes.add((destination: destination, bytes: List.of(bytes)));
  }
}

class _Selector extends FileSelectorPlatform {
  final destination = Completer<FileSaveLocation?>();
  SaveDialogOptions? options;
  List<XTypeGroup>? types;
  @override
  Future<FileSaveLocation?> getSaveLocation({
    List<XTypeGroup>? acceptedTypeGroups,
    SaveDialogOptions options = const SaveDialogOptions(),
  }) {
    this.options = options;
    types = acceptedTypeGroups;
    return destination.future;
  }
}

GeneratedArtifactSummary _artifact() {
  final timestamp = DateTime.utc(2026, 10, 4);
  return GeneratedArtifactSummary(
    id: 'generated_artifact_${List.filled(48, 'a').join()}',
    kind: GeneratedArtifactKind.pdf,
    title: 'Private exact document',
    filename: 'exact.pdf',
    version: 3,
    status: GeneratedArtifactStatus.ready,
    mediaType: 'application/pdf',
    byteCount: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
    queuedAt: timestamp,
    readyAt: timestamp,
    failedAt: null,
  );
}

class _Repository
    implements
        ResultsRepository,
        ScopedResultsRepository,
        GeneratedArtifactResultsRepository {
  _Repository(this.artifact);
  final GeneratedArtifactSummary artifact;
  @override
  final access = ResultsAccess(
    deployment: 'https://synthetic.invalid',
    tenantId: 'tenant',
    actorId: 'actor',
    role: 'operator',
  );
  int downloads = 0;
  @override
  Future<ResultsSnapshot> list() async => ResultsSnapshot(
    items: const [],
    evaluations: const [],
    sourceErrors: const [],
    createdFiles: [artifact],
  );
  @override
  Future<ResultItem?> detail(String key) async => null;
  @override
  Future<void> cancel(String runId) async =>
      throw StateError('Not part of file export');
  @override
  Future<Uint8List> downloadGeneratedArtifact(
    GeneratedArtifactSummary value,
  ) async {
    expect(value.id, artifact.id);
    expect(value.version, 3);
    downloads++;
    return Uint8List.fromList([1, 2, 3]);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a held destination dialog receives no bytes and scope replacement prevents any download or write', () async {
    final adapter = _Adapter();
    var current = true, downloads = 0;
    final pending = ScopedCreatedFileExporter(adapter: adapter).save(
      filename: 'exact.pdf',
      isCurrent: () => current,
      loadBytes: () async {
        downloads++;
        return Uint8List.fromList([1, 2, 3]);
      },
    );
    expect(adapter.selections, 1);
    expect(downloads, 0);
    expect(adapter.writes, isEmpty);
    current = false;
    adapter.destination.complete('/synthetic/exact.pdf');
    expect(await pending, CreatedFileExportOutcome.scopeChanged);
    expect(downloads, 0);
    expect(adapter.writes, isEmpty);
  });

  test(
    'canceling a destination dialog does not download or create an empty file',
    () async {
      final adapter = _Adapter();
      var downloads = 0;
      final pending = ScopedCreatedFileExporter(adapter: adapter).save(
        filename: 'exact.pdf',
        isCurrent: () => true,
        loadBytes: () async {
          downloads++;
          return Uint8List.fromList([1, 2, 3]);
        },
      );
      adapter.destination.complete(null);
      expect(await pending, CreatedFileExportOutcome.canceled);
      expect(downloads, 0);
      expect(adapter.writes, isEmpty);
    },
  );

  test(
    'scope change while exact bytes load discards them before the writer',
    () async {
      final adapter = _Adapter(), held = Completer<Uint8List>();
      var current = true;
      adapter.destination.complete('/synthetic/exact.pdf');
      final pending = ScopedCreatedFileExporter(adapter: adapter).save(
        filename: 'exact.pdf',
        isCurrent: () => current,
        loadBytes: () => held.future,
      );
      await Future<void>.delayed(Duration.zero);
      current = false;
      held.complete(Uint8List.fromList([1, 2, 3]));
      expect(await pending, CreatedFileExportOutcome.scopeChanged);
      expect(adapter.writes, isEmpty);
    },
  );

  test('an adapter checks authority again after its own asynchronous write preparation', () async {
    final adapter = _Adapter();
    adapter.beforeWrite = Completer<void>();
    var current = true;
    adapter.destination.complete('/synthetic/exact.pdf');
    final pending = ScopedCreatedFileExporter(adapter: adapter).save(
      filename: 'exact.pdf',
      isCurrent: () => current,
      loadBytes: () async => Uint8List.fromList([1, 2, 3]),
    );
    await Future<void>.delayed(Duration.zero);
    current = false;
    adapter.beforeWrite!.complete();
    expect(await pending, CreatedFileExportOutcome.scopeChanged);
    expect(adapter.writes, isEmpty);
  });

  test(
    'unavailable platforms never open a dialog or load private bytes',
    () async {
      final adapter = _Adapter(available: false);
      var downloads = 0;
      final outcome = await ScopedCreatedFileExporter(adapter: adapter).save(
        filename: 'exact.pdf',
        isCurrent: () => true,
        loadBytes: () async {
          downloads++;
          return Uint8List.fromList([1]);
        },
      );
      expect(outcome, CreatedFileExportOutcome.unavailable);
      expect(adapter.selections, 0);
      expect(downloads, 0);
      expect(adapter.writes, isEmpty);
    },
  );

  test('a current exact export selects first and writes only the returned bytes to that destination', () async {
    final adapter = _Adapter();
    var downloads = 0;
    final pending = ScopedCreatedFileExporter(adapter: adapter).save(
      filename: 'exact.pdf',
      isCurrent: () => true,
      loadBytes: () async {
        downloads++;
        return Uint8List.fromList([1, 2, 3]);
      },
    );
    expect(downloads, 0);
    adapter.destination.complete('/synthetic/chosen.pdf');
    expect(await pending, CreatedFileExportOutcome.saved);
    expect(downloads, 1);
    expect(adapter.writes.single.destination, '/synthetic/chosen.pdf');
    expect(adapter.writes.single.bytes, [1, 2, 3]);
  });

  test('desktop adapter uses the public destination-only API and a final write authority check', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    final previous = FileSelectorPlatform.instance, selector = _Selector();
    FileSelectorPlatform.instance = selector;
    addTearDown(() => FileSelectorPlatform.instance = previous);
    const adapter = DesktopCreatedFileExportAdapter();
    final directory = await Directory.systemTemp.createTemp(
      'asael-scoped-export-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final file = File('${directory.path}/chosen.pdf');
    final selected = adapter.selectDestination(filename: 'exact.pdf');
    expect(selector.options!.suggestedName, 'exact.pdf');
    expect(selector.types!.single.extensions, ['pdf']);
    expect(await file.exists(), isFalse);
    selector.destination.complete(FileSaveLocation(file.path));
    expect(await selected, file.path);
    await expectLater(
      adapter.writeBytes(
        file.path,
        Uint8List.fromList([1, 2, 3]),
        isCurrent: () => false,
      ),
      throwsA(isA<CreatedFileExportScopeChanged>()),
    );
    expect(await file.exists(), isFalse);
    await adapter.writeBytes(
      file.path,
      Uint8List.fromList([1, 2, 3]),
      isCurrent: () => true,
    );
    expect(await file.readAsBytes(), [1, 2, 3]);
  });

  test('mobile platforms do not use the eager byte-export fallback', () {
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    for (final platform in [
      TargetPlatform.android,
      TargetPlatform.iOS,
      TargetPlatform.fuchsia,
    ]) {
      debugDefaultTargetPlatformOverride = platform;
      expect(const DesktopCreatedFileExportAdapter().available, isFalse);
    }
  });

  testWidgets(
    'closing Results access during an open save dialog exports no private bytes',
    (tester) async {
      final artifact = _artifact(), adapter = _Adapter();
      final repository = _Repository(artifact),
          exporter = ScopedCreatedFileExporter(adapter: adapter);
      final controller = ResultsController(repository);
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: controller,
              builder: (context, _) => CreatedFilesSection(
                controller: controller,
                files: controller.snapshot?.createdFiles ?? const [],
                exporter: exporter,
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(Key('created-file-save-${artifact.id}')));
      await tester.pump();
      expect(adapter.selections, 1);
      expect(repository.downloads, 0);
      repository.access.close();
      await tester.pump();
      expect(find.text('Private exact document'), findsNothing);
      adapter.destination.complete('/synthetic/exact.pdf');
      await tester.pumpAndSettle();
      expect(repository.downloads, 0);
      expect(adapter.writes, isEmpty);
      expect(
        find.text(
          'Results access or the file version changed. Refresh and choose a save location again.',
        ),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      repository.access.dispose();
    },
  );

  testWidgets(
    'a platform without delayed export shows the limitation and no active save control',
    (tester) async {
      final artifact = _artifact(), repository = _Repository(_artifact());
      final controller = ResultsController(repository);
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: CreatedFilesSection(
              controller: controller,
              files: [artifact],
              exporter: ScopedCreatedFileExporter(
                adapter: _Adapter(available: false),
              ),
            ),
          ),
        ),
      );
      expect(
        find.textContaining(
          'Saving private files is unavailable on this platform.',
        ),
        findsOneWidget,
      );
      expect(
        tester
            .widget<OutlinedButton>(
              find.byKey(Key('created-file-save-${artifact.id}')),
            )
            .onPressed,
        isNull,
      );
      expect(repository.downloads, 0);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      repository.access.dispose();
    },
  );
}
