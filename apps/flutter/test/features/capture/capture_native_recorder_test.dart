import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:asael/features/capture/capture_models.dart';
import 'package:asael/features/capture/capture_recording.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'cancel during encoder negotiation prevents every native start',
    () async {
      final backend = _Backend(), files = _Files(), held = Completer<bool>();
      backend.encoder = () => held.future;
      final recorder = NativeCaptureRecorder(
        backendFactory: () => backend,
        files: files,
      );
      final start = recorder.start();
      await Future<void>.delayed(Duration.zero);
      final cancel = recorder.cancel();
      held.complete(true);
      await Future.wait([start, cancel]);
      expect(backend.starts, isEmpty);
      expect(files.created, isEmpty);
      expect(backend.active, isFalse);
      await recorder.dispose();
    },
  );
  test('cancel during temporary directory creation cleans the captured directory and cannot start late', () async {
    final backend = _Backend(), files = _Files(), held = Completer<String>();
    files.nextDirectory = () => held.future;
    final recorder = NativeCaptureRecorder(
      backendFactory: () => backend,
      files: files,
    );
    final start = recorder.start();
    await Future<void>.delayed(Duration.zero);
    final cancel = recorder.cancel();
    held.complete('/synthetic/old-directory');
    await Future.wait([start, cancel]);
    expect(backend.starts, isEmpty);
    expect(files.deleted, ['/synthetic/old-directory']);
    files.nextDirectory = null;
    await recorder.start();
    expect(backend.starts.single, endsWith('/directory-1/audio-note.wav'));
    expect(files.deleted, isNot(contains('/synthetic/directory-1')));
    await recorder.dispose();
  });
  test('a native start already in progress is canceled before cancellation completes', () async {
    final backend = _Backend(), files = _Files(), held = Completer<void>();
    backend.beforeStart = () => held.future;
    final recorder = NativeCaptureRecorder(
      backendFactory: () => backend,
      files: files,
    );
    final start = recorder.start();
    await Future<void>.delayed(Duration.zero);
    final cancel = recorder.cancel();
    held.complete();
    await Future.wait([start, cancel]);
    expect(backend.active, isFalse);
    expect(files.deleted, contains(files.created.single));
    await recorder.dispose();
  });
  test('stop and cancel exceptions independently clean the owned plaintext directory', () async {
    final backend = _Backend(), files = _Files();
    final recorder = NativeCaptureRecorder(
      backendFactory: () => backend,
      files: files,
    );
    await recorder.start();
    backend.stopFails = true;
    await expectLater(recorder.stop(), throwsStateError);
    expect(files.deleted, contains(files.created.first));
    await recorder.start();
    backend.cancelFails = true;
    await expectLater(recorder.cancel(), throwsStateError);
    expect(files.deleted, contains(files.created.last));
    backend.cancelFails = false;
    await recorder.dispose();
  });
  test(
    'dispose continues all cleanup after native cancel and dispose failures',
    () async {
      final backend = _Backend(), files = _Files();
      final recorder = NativeCaptureRecorder(
        backendFactory: () => backend,
        files: files,
      );
      await recorder.start();
      backend.cancelFails = backend.disposeFails = true;
      await expectLater(recorder.dispose(), throwsStateError);
      expect(backend.disposals, 1);
      expect(files.deleted, contains(files.created.single));
      expect(files.cleanupRetries, greaterThanOrEqualTo(2));
    },
  );
  test('failed plaintext deletion remains tracked across recorder disposal and is retried', () async {
    final root = await Directory.systemTemp.createTemp(
      'capture-cleanup-regression-',
    );
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    var refuseDeletion = true;
    final files = NativeCaptureRecordingFiles(
      temporaryDirectory: () async => root,
      deleteDirectory: (directory) async {
        if (refuseDeletion) {
          throw const FileSystemException('Synthetic deletion failure');
        }
        if (await directory.exists()) await directory.delete(recursive: true);
      },
    );
    final backend = _Backend();
    final recorder = NativeCaptureRecorder(
      backendFactory: () => backend,
      files: files,
    );
    await recorder.start();
    final audio = File(backend.starts.single);
    await audio.writeAsBytes([1, 2, 3]);
    backend.cancelFails = backend.disposeFails = true;
    await expectLater(recorder.dispose(), throwsStateError);
    expect(files.pendingCleanup, {audio.parent.path});
    expect(await audio.exists(), isTrue);
    refuseDeletion = false;
    await files.retryCleanup();
    expect(files.pendingCleanup, isEmpty);
    expect(await audio.exists(), isFalse);
  });
  test('failed cleanup after stop cannot expose an attachment with abandoned plaintext', () async {
    final backend = _Backend(), files = _Files();
    final recorder = NativeCaptureRecorder(
      backendFactory: () => backend,
      files: files,
    );
    await recorder.start();
    files.deleteFails = true;
    await expectLater(recorder.stop(), throwsStateError);
    expect(files.returned!.bytes, everyElement(0));
    files.deleteFails = false;
    await recorder.dispose();
  });
}

class _Backend implements CaptureRecorderBackend {
  final states = StreamController<bool>.broadcast();
  Future<bool> Function() encoder = () async => true;
  Future<void> Function()? beforeStart;
  final starts = <String>[];
  bool active = false,
      stopFails = false,
      cancelFails = false,
      disposeFails = false;
  int disposals = 0;
  @override
  Future<bool> hasPermission() async => true;
  @override
  Future<bool> supportsWav() => encoder();
  @override
  Stream<bool> get recordingChanges => states.stream;
  @override
  Future<bool> isRecording() async => active;
  @override
  Future<void> start(String path) async {
    starts.add(path);
    await beforeStart?.call();
    active = true;
    states.add(true);
  }

  @override
  Future<String?> stop() async {
    if (stopFails) throw StateError('Synthetic stop failure');
    active = false;
    return starts.last;
  }

  @override
  Future<void> cancel() async {
    if (cancelFails) throw StateError('Synthetic cancel failure');
    active = false;
  }

  @override
  Future<void> dispose() async {
    disposals++;
    await states.close();
    if (disposeFails) throw StateError('Synthetic dispose failure');
  }
}

class _Files implements CaptureRecordingFiles {
  Future<String> Function()? nextDirectory;
  final created = <String>[], deleted = <String>[];
  CaptureAttachment? returned;
  bool deleteFails = false;
  int cleanupRetries = 0;
  @override
  Future<String> createDirectory() async {
    final directory =
        await nextDirectory?.call() ?? '/synthetic/directory-${created.length}';
    created.add(directory);
    return directory;
  }

  @override
  Future<CaptureAttachment> readOriginal(String directory, String path) async {
    expect(path, '$directory/audio-note.wav');
    return returned = CaptureAttachment(
      name: 'audio-note.wav',
      bytes: Uint8List.fromList([1, 2, 3]),
      contentType: 'audio/wav',
    );
  }

  @override
  Future<void> deleteDirectory(String directory) async {
    if (deleteFails) throw StateError('Synthetic delete failure');
    deleted.add(directory);
  }

  @override
  Future<void> retryCleanup() async {
    cleanupRetries++;
  }
}
