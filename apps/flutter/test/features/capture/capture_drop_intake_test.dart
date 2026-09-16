import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:asael/features/capture/capture.dart';
import 'package:asael/features/capture/capture_drop_intake.dart';
import 'package:asael/features/capture/capture_outbox.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('presents the macOS secure drop affordance and its capacity', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CaptureDropSurface(
            enabled: true,
            busy: false,
            remainingCapacity: 4,
            onDrop: (_) async {},
          ),
        ),
      ),
    );

    expect(find.text('Drop to encrypt and queue'), findsOneWidget);
    expect(
      find.textContaining('4 secure queue slots available'),
      findsOneWidget,
    );
    expect(find.textContaining('Folders stay on your Mac'), findsOneWidget);
  });

  group('CaptureDropIntake', () {
    test('rejects directories, unsupported types, unsafe names, empty and oversized files', () async {
      final harness = _Harness();
      final cleanup = _RecordingCleanup();
      final intake = CaptureDropIntake(
        harness.controller,
        promiseCleanup: cleanup,
        securityAccess: _RecordingSecurityAccess(),
      );
      final sources = [
        _Source(name: 'folder', entityType: CaptureDropEntityType.directory),
        _Source(name: 'archive.zip'),
        _Source(name: '../unsafe.vtt'),
        _Source(name: 'empty.vtt', bytes: Uint8List(0)),
        _Source(
          name: 'oversized.vtt',
          reportedLength: captureAttachmentMaxBytes + 1,
        ),
      ];

      final result = await intake.submit(sources);

      expect(result.queued, 0);
      expect(result.failed, 5);
      expect(result.directories, 1);
      expect(result.unsupported, 1);
      expect(result.invalidNames, 1);
      expect(result.empty, 1);
      expect(result.tooLarge, 1);
      expect(cleanup.sources, sources);
    });

    test(
      'deduplicates a drop and accepts at most remaining capacity',
      () async {
        final harness = _Harness();
        final intake = CaptureDropIntake(
          harness.controller,
          promiseCleanup: _RecordingCleanup(),
          securityAccess: _RecordingSecurityAccess(),
        );
        final sources = <CaptureDropSource>[
          _Source(name: 'same.vtt'),
          _Source(name: ' SAME.vtt '),
          for (var index = 0; index < captureBatchMaxFiles; index += 1)
            _Source(name: 'lesson-$index.vtt'),
        ];

        final result = await intake.submit(sources);
        await harness.controller.batchWork;

        expect(result.queued, captureBatchMaxFiles);
        expect(result.duplicates, 1);
        expect(result.full, 1);
        expect(result.failed, 2);
        expect(harness.outbox.enqueuedNames.toSet(), hasLength(25));
      },
    );

    test(
      'deduplicates against the outbox and honors its remaining slots',
      () async {
        const owner = CaptureOwnerBinding(
          tenantId: 'tenant-one',
          actorId: 'actor:one',
        );
        final outbox = _MemoryOutbox();
        for (var index = 0; index < captureBatchMaxFiles - 1; index += 1) {
          final name = index == 0 ? 'existing.vtt' : 'pending-$index.vtt';
          await outbox.enqueue(owner, _draft(name));
        }
        final controller = CaptureController(
          _Repository(fail: true),
          outbox,
          owner,
          batchPollInterval: Duration.zero,
          batchPollRounds: 1,
          delay: _noDelay,
        );
        await controller.initialize();
        final intake = CaptureDropIntake(
          controller,
          promiseCleanup: _RecordingCleanup(),
          securityAccess: _RecordingSecurityAccess(),
        );

        final result = await intake.submit([
          _Source(name: 'EXISTING.vtt'),
          _Source(name: 'one-slot.vtt'),
          _Source(name: 'no-slot.vtt'),
        ]);
        await controller.batchWork;

        expect(result.queued, 1);
        expect(result.duplicates, 1);
        expect(result.full, 1);
        expect(result.failed, 2);
        expect(controller.pending, hasLength(captureBatchMaxFiles));
      },
    );

    test('bounds streaming reads at 5 MB plus one byte', () async {
      final harness = _Harness();
      final source = _Source(
        name: 'deceptive.vtt',
        bytes: Uint8List(captureAttachmentMaxBytes + 1),
        reportedLength: 3,
      );
      final intake = CaptureDropIntake(
        harness.controller,
        promiseCleanup: _RecordingCleanup(),
        securityAccess: _RecordingSecurityAccess(),
      );

      final result = await intake.submit([source]);

      expect(result.queued, 0);
      expect(result.failed, 1);
      expect(result.tooLarge, 1);
      expect(source.lastReadStart, 0);
      expect(source.lastReadEnd, captureAttachmentMaxBytes + 1);
      expect(harness.outbox.enqueuedNames, isEmpty);
    });

    test(
      'fails closed when a file changes between selection and encryption',
      () async {
        final harness = _Harness();
        final source = _Source(
          name: 'changing.vtt',
          bytes: Uint8List.fromList([1, 2, 3]),
          lengthResponses: [3, 4],
        );
        final intake = CaptureDropIntake(
          harness.controller,
          promiseCleanup: _RecordingCleanup(),
          securityAccess: _RecordingSecurityAccess(),
        );

        final result = await intake.submit([source]);

        expect(result.queued, 0);
        expect(result.changed, 1);
        expect(result.failed, 1);
        expect(source.lengthCalls, greaterThanOrEqualTo(2));
        expect(harness.outbox.enqueuedNames, isEmpty);
      },
    );

    test(
      'balances security scope and cleans promise files on success',
      () async {
        final harness = _Harness();
        final access = _RecordingSecurityAccess();
        final cleanup = _RecordingCleanup();
        final source = _Source(
          name: 'secure.vtt',
          bookmark: Uint8List.fromList([1, 2, 3]),
          fromPromise: true,
        );
        final intake = CaptureDropIntake(
          harness.controller,
          promiseCleanup: cleanup,
          securityAccess: access,
        );

        final result = await intake.submit([source]);
        await harness.controller.batchWork;

        expect(result.queued, 1);
        expect(access.starts, 2);
        expect(access.stops, 2);
        expect(cleanup.sources, [source]);
      },
    );

    test(
      'releases security scope and cleans promise files when reading fails',
      () async {
        final harness = _Harness();
        final access = _RecordingSecurityAccess();
        final cleanup = _RecordingCleanup();
        final source = _Source(
          name: 'unreadable.vtt',
          bookmark: Uint8List.fromList([4, 5, 6]),
          fromPromise: true,
          readError: StateError('unavailable'),
        );
        final intake = CaptureDropIntake(
          harness.controller,
          promiseCleanup: cleanup,
          securityAccess: access,
        );

        final result = await intake.submit([source]);

        expect(result.queued, 0);
        expect(result.unreadable, 1);
        expect(access.starts, 2);
        expect(access.stops, 2);
        expect(cleanup.sources, [source]);
      },
    );

    test(
      'fails closed when macOS security-scoped access cannot start',
      () async {
        final harness = _Harness();
        final access = _RecordingSecurityAccess()..allowStart = false;
        final cleanup = _RecordingCleanup();
        final source = _Source(
          name: 'outside.vtt',
          bookmark: Uint8List.fromList([7]),
        );
        final intake = CaptureDropIntake(
          harness.controller,
          promiseCleanup: cleanup,
          securityAccess: access,
        );

        final result = await intake.submit([source]);

        expect(result.queued, 0);
        expect(result.unreadable, 1);
        expect(access.starts, 1);
        expect(access.stops, 0);
        expect(cleanup.sources, [source]);
      },
    );
  });

  group('DesktopCaptureDropPromiseCleanup', () {
    test('removes only plugin-created temporary promise copies', () async {
      final dropsRoot = Directory(
        '${Directory.systemTemp.path}${Platform.pathSeparator}Drops',
      );
      final promiseDirectory = Directory(
        '${dropsRoot.path}${Platform.pathSeparator}20990101_010203_987Z',
      );
      await promiseDirectory.create(recursive: true);
      final promise = File(
        '${promiseDirectory.path}${Platform.pathSeparator}promised.vtt',
      );
      await promise.writeAsBytes([1, 2, 3]);
      final originalDirectory = await Directory.systemTemp.createTemp(
        'asael-drop-original-',
      );
      final original = File(
        '${originalDirectory.path}${Platform.pathSeparator}original.vtt',
      );
      await original.writeAsBytes([4, 5, 6]);
      final cleanup = DesktopCaptureDropPromiseCleanup();

      try {
        expect(
          isSafeDesktopDropPromisePath(
            promise.path,
            systemTemporaryPath: Directory.systemTemp.path,
          ),
          isTrue,
        );
        expect(
          isSafeDesktopDropPromisePath(
            original.path,
            systemTemporaryPath: Directory.systemTemp.path,
          ),
          isFalse,
        );

        await cleanup.cleanup(
          _Source(
            name: 'promised.vtt',
            sourcePath: promise.path,
            fromPromise: true,
          ),
        );
        await cleanup.cleanup(
          _Source(
            name: 'original.vtt',
            sourcePath: original.path,
            fromPromise: true,
          ),
        );

        expect(await promise.exists(), isFalse);
        expect(await promiseDirectory.exists(), isFalse);
        expect(await original.exists(), isTrue);
      } finally {
        if (await promise.exists()) await promise.delete();
        if (await promiseDirectory.exists()) await promiseDirectory.delete();
        if (await original.exists()) await original.delete();
        if (await originalDirectory.exists()) await originalDirectory.delete();
      }
    });

    test('never deletes Finder originals even when they sit below Drops', () async {
      final directory = Directory(
        '${Directory.systemTemp.path}${Platform.pathSeparator}Drops${Platform.pathSeparator}20990101_010203_654Z',
      );
      await directory.create(recursive: true);
      final original = File(
        '${directory.path}${Platform.pathSeparator}finder.vtt',
      );
      await original.writeAsBytes([1]);

      try {
        await DesktopCaptureDropPromiseCleanup().cleanup(
          _Source(
            name: 'finder.vtt',
            sourcePath: original.path,
            fromPromise: false,
          ),
        );
        expect(await original.exists(), isTrue);
      } finally {
        if (await original.exists()) await original.delete();
        if (await directory.exists()) await directory.delete();
      }
    });

    test('deletes a promised symlink without following it to user data', () async {
      final targetDirectory = await Directory.systemTemp.createTemp(
        'asael-drop-link-target-',
      );
      final target = File(
        '${targetDirectory.path}${Platform.pathSeparator}target.vtt',
      );
      await target.writeAsBytes([1, 2, 3]);
      final promiseDirectory = Directory(
        '${Directory.systemTemp.path}${Platform.pathSeparator}Drops${Platform.pathSeparator}20990101_010203_321Z',
      );
      await promiseDirectory.create(recursive: true);
      final promisedLink = Link(
        '${promiseDirectory.path}${Platform.pathSeparator}linked.vtt',
      );
      await promisedLink.create(target.path);

      try {
        await DesktopCaptureDropPromiseCleanup().cleanup(
          _Source(
            name: 'linked.vtt',
            sourcePath: promisedLink.path,
            fromPromise: true,
          ),
        );
        expect(await promisedLink.exists(), isFalse);
        expect(await target.exists(), isTrue);
      } finally {
        if (await promisedLink.exists()) await promisedLink.delete();
        if (await promiseDirectory.exists()) await promiseDirectory.delete();
        if (await target.exists()) await target.delete();
        if (await targetDirectory.exists()) await targetDirectory.delete();
      }
    });
  });
}

class _Harness {
  _Harness() {
    outbox = _MemoryOutbox();
    controller = CaptureController(
      _Repository(),
      outbox,
      const CaptureOwnerBinding(tenantId: 'tenant-one', actorId: 'actor:one'),
      batchPollInterval: Duration.zero,
      batchPollRounds: 1,
      delay: _noDelay,
    );
  }

  late final _MemoryOutbox outbox;
  late final CaptureController controller;
}

Future<void> _noDelay(Duration _) async {}

class _Source implements CaptureDropSource {
  _Source({
    required this.name,
    this.sourcePath = '/tmp/asael-drop.vtt',
    this.fromPromise = false,
    this.bookmark,
    this._entityType = CaptureDropEntityType.file,
    Uint8List? bytes,
    this.reportedLength,
    this.lengthResponses = const [],
    this.readError,
  }) : bytes = bytes ?? Uint8List.fromList([1, 2, 3]);

  @override
  final String name;
  @override
  final String sourcePath;
  @override
  final bool fromPromise;
  final Uint8List? bookmark;
  final CaptureDropEntityType _entityType;
  final Uint8List bytes;
  final int? reportedLength;
  final List<int> lengthResponses;
  final Object? readError;
  int lengthCalls = 0;
  int? lastReadStart;
  int? lastReadEnd;

  @override
  Uint8List? get securityBookmark => bookmark;

  @override
  Future<CaptureDropEntityType> entityType() async => _entityType;

  @override
  Future<int> length() async {
    final index = lengthCalls++;
    if (index < lengthResponses.length) return lengthResponses[index];
    return reportedLength ?? bytes.length;
  }

  @override
  Future<DateTime> lastModified() async => DateTime.utc(2026, 9, 16, 12);

  @override
  Stream<Uint8List> openRead(int start, int end) async* {
    lastReadStart = start;
    lastReadEnd = end;
    if (readError != null) throw readError!;
    yield bytes;
  }
}

class _RecordingSecurityAccess implements CaptureDropSecurityAccess {
  int starts = 0;
  int stops = 0;
  bool allowStart = true;

  @override
  Future<bool> start(Uint8List bookmark) async {
    starts += 1;
    return allowStart;
  }

  @override
  Future<bool> stop(Uint8List bookmark) async {
    stops += 1;
    return true;
  }
}

class _RecordingCleanup implements CaptureDropPromiseCleanup {
  final List<CaptureDropSource> sources = [];

  @override
  Future<void> cleanup(CaptureDropSource source) async {
    sources.add(source);
  }
}

class _Repository implements CaptureRepository {
  _Repository({this.fail = false});

  final bool fail;

  @override
  Future<CaptureReceipt> submit(
    CaptureDraft draft, {
    required String idempotencyKey,
    required CaptureOwnerBinding owner,
  }) async {
    if (fail) throw StateError('offline');
    return CaptureReceipt(
      jobId: 'job-${draft.file!.name}',
      title: draft.title,
      tags: draft.tags,
    );
  }

  @override
  Future<CaptureJobSnapshot> readJob(
    String jobId, {
    required CaptureOwnerBinding owner,
  }) async => CaptureJobSnapshot(id: jobId, status: 'completed');
}

CaptureDraft _draft(String name) => CaptureDraft(
  content: '',
  title: name,
  file: CaptureAttachment(
    name: name,
    bytes: Uint8List.fromList([1, 2, 3]),
    contentType: 'text/vtt',
  ),
  kind: CaptureKind.file,
);

class _MemoryOutbox implements CaptureOutbox {
  _MemoryOutbox();

  final entries = <CaptureOutboxEntry>[];
  final enqueuedNames = <String>[];
  int nextId = 0;

  @override
  Future<CaptureOutboxEntry> enqueue(
    CaptureOwnerBinding owner,
    CaptureDraft draft,
  ) async {
    final suffix = nextId.toString().padLeft(4, '0');
    nextId += 1;
    final id = 'dddddddddddddddddddd$suffix';
    final entry = CaptureOutboxEntry(
      id: id,
      tenantId: owner.tenantId,
      actorId: owner.actorId,
      createdAt: DateTime.utc(2026, 9, 16),
      idempotencyKey: 'capture-offline-$id',
      draft: draft,
    );
    entries.add(entry);
    enqueuedNames.add(draft.file!.name);
    return entry;
  }

  @override
  Future<CaptureOutboxEntry?> get(
    CaptureOwnerBinding owner,
    String entryId,
  ) async => entries
      .where((entry) => entry.id == entryId && owner.owns(entry))
      .firstOrNull;

  @override
  Future<List<CaptureOutboxEntry>> list(CaptureOwnerBinding owner) async =>
      entries.where(owner.owns).toList();

  @override
  Future<void> remove(CaptureOwnerBinding owner, String entryId) async {
    entries.removeWhere((entry) => entry.id == entryId && owner.owns(entry));
  }
}
