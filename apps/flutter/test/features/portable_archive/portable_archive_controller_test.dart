import 'dart:async';
import 'dart:io';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/results/created_file_export.dart';
import 'package:asael/features/settings/portable_archive_contracts.dart';
import 'package:asael/features/settings/portable_archive_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'portable_archive_test_support.dart';

void main() {
  test('explicit activation coalesces, chooses before GET, verifies before write, and saves exact bytes', () async {
    final repo = PortableArchiveTestRepository(),
        verifier = PortableArchiveTestVerifier(),
        adapter = PortableArchiveTestAdapter();
    final c = PortableArchiveController(
      repo,
      exporter: ScopedCreatedFileExporter(adapter: adapter),
      verifier: verifier,
      now: () => DateTime.utc(2026, 10, 5),
    );
    addTearDown(c.dispose);
    expect(repo.requests, isEmpty);
    expect(verifier.calls, isEmpty);
    final pending = c.verifyAndSave(), repeated = c.verifyAndSave();
    expect(identical(pending, repeated), isTrue);
    await portableArchiveFlush();
    expect(adapter.filenames, ['asael-2026-10-05-v2.json']);
    expect(repo.requests, isEmpty);
    expect(c.phase, PortableArchivePhase.choosingDestination);
    adapter.destinations.single.complete('/chosen/archive.json');
    await portableArchiveFlush();
    expect(repo.requests, hasLength(1));
    expect(c.phase, PortableArchivePhase.downloading);
    repo.requests.single.result.complete(portableArchiveResponse());
    await portableArchiveFlush();
    expect(verifier.calls, hasLength(1));
    expect(adapter.writeCalls, 0);
    expect(c.phase, PortableArchivePhase.verifying);
    final call = verifier.calls.single;
    expect(call.tenantId, portableArchiveTenant);
    expect(call.actorId, portableArchiveActor);
    expect(call.expectedHash, portableArchiveTestHash('a'));
    expect(call.bytes, portableArchiveTestBytes);
    verifier.calls.single.result.complete(portableArchiveReceipt());
    await pending;
    expect(adapter.writes.single.bytes, portableArchiveTestBytes);
    expect(c.phase, PortableArchivePhase.saved);
    expect(c.receipt!.excludedCount, isNull);
    expect(c.busy, isFalse);
  });
  test(
    'canceling destination performs no GET, verification or write',
    () async {
      final repo = PortableArchiveTestRepository(),
          verifier = PortableArchiveTestVerifier(),
          adapter = PortableArchiveTestAdapter();
      final c = PortableArchiveController(
        repo,
        exporter: ScopedCreatedFileExporter(adapter: adapter),
        verifier: verifier,
      );
      addTearDown(c.dispose);
      final pending = c.verifyAndSave();
      await portableArchiveFlush();
      adapter.destinations.single.complete(null);
      await pending;
      expect(c.phase, PortableArchivePhase.canceled);
      expect(repo.requests, isEmpty);
      expect(verifier.calls, isEmpty);
      expect(adapter.writes, isEmpty);
      expect(c.receipt, isNull);
    },
  );
  for (final stage in [
    'chooser',
    'download',
    'verification',
    'write admission',
  ]) {
    test(
      'scope loss at $stage cancels and fences all late work without file admission',
      () async {
        final repo = PortableArchiveTestRepository(),
            verifier = PortableArchiveTestVerifier()..honorCancellation = false,
            adapter = PortableArchiveTestAdapter();
        final c = PortableArchiveController(
          repo,
          exporter: ScopedCreatedFileExporter(adapter: adapter),
          verifier: verifier,
        );
        addTearDown(c.dispose);
        if (stage == 'write admission') {
          adapter.beforeWrite = Completer<void>();
        }
        final pending = c.verifyAndSave();
        await portableArchiveFlush();
        if (stage != 'chooser') {
          adapter.destinations.single.complete('/chosen/archive.json');
          await portableArchiveFlush();
        }
        if (stage == 'verification' || stage == 'write admission') {
          repo.requests.single.result.complete(portableArchiveResponse());
          await portableArchiveFlush();
        }
        if (stage == 'write admission') {
          verifier.calls.single.result.complete(portableArchiveReceipt());
          await portableArchiveFlush();
          expect(adapter.writeCalls, 1);
        }
        var notifications = 0;
        c.addListener(() => notifications++);
        repo.invalidate();
        expect(c.available, isFalse);
        expect(c.receipt, isNull);
        expect(c.busy, isFalse);
        expect(notifications, 0);
        expect(verifier.cancellations, 1);
        if (repo.requests.isNotEmpty) {
          expect(repo.requests.single.cancel.isCancelled, isTrue);
        }
        if (stage == 'chooser') {
          adapter.destinations.single.complete('/chosen/archive.json');
        }
        if (stage == 'download') {
          repo.requests.single.result.complete(portableArchiveResponse());
        }
        if (stage == 'verification') {
          verifier.calls.single.result.complete(portableArchiveReceipt());
        }
        if (stage == 'write admission') {
          adapter.beforeWrite!.complete();
        }
        await pending;
        expect(adapter.writes, isEmpty);
        expect(c.receipt, isNull);
        expect(notifications, greaterThan(0));
        await c.verifyAndSave();
        expect(adapter.destinations, hasLength(1));
      },
    );
  }
  test('scope change after write admission clears receipt without claiming the external file was revoked', () async {
    final repo = PortableArchiveTestRepository()
      ..immediateResponse = portableArchiveResponse();
    final verifier = PortableArchiveTestVerifier()
      ..immediateReceipt = portableArchiveReceipt();
    final adapter = PortableArchiveTestAdapter()
      ..automaticDestination = '/chosen/archive.json'
      ..afterAdmission = Completer<void>();
    final c = PortableArchiveController(
      repo,
      exporter: ScopedCreatedFileExporter(adapter: adapter),
      verifier: verifier,
    );
    addTearDown(c.dispose);
    final pending = c.verifyAndSave();
    await portableArchiveFlush();
    expect(adapter.writes, hasLength(1));
    expect(c.receipt, isNull);
    expect(c.phase, PortableArchivePhase.saving);
    repo.invalidate();
    adapter.afterAdmission!.complete();
    await pending;
    expect(adapter.writes, hasLength(1));
    expect(c.receipt, isNull);
    expect(c.available, isFalse);
  });
  test('write failure never publishes a saved receipt or retries the uncertain destination', () async {
    final repo = PortableArchiveTestRepository()
      ..immediateResponse = portableArchiveResponse();
    final verifier = PortableArchiveTestVerifier()
      ..immediateReceipt = portableArchiveReceipt();
    final adapter = PortableArchiveTestAdapter()
      ..automaticDestination = '/chosen/archive.json'
      ..writeFailure = const FileSystemException('PRIVATE_PATH');
    final c = PortableArchiveController(
      repo,
      exporter: ScopedCreatedFileExporter(adapter: adapter),
      verifier: verifier,
    );
    addTearDown(c.dispose);
    await c.verifyAndSave();
    expect(c.phase, PortableArchivePhase.failed);
    expect(c.receipt, isNull);
    expect(c.error, contains('partial destination file'));
    expect(c.error, isNot(contains('PRIVATE_PATH')));
    expect(adapter.writeCalls, 1);
    expect(repo.requests, hasLength(1));
  });
  for (final failure in [
    const NativeAuthorityVerificationException(),
    const ApiException('Expired', statusCode: 401),
    const ApiException('Forbidden', statusCode: 403),
    const ApiException('Large', diagnosticCode: 'download_size_limit'),
    const ApiException('Slow', diagnosticCode: 'download_deadline'),
  ]) {
    test(
      '${failure.diagnosticCode ?? failure.statusCode} download refusal cannot admit a file',
      () async {
        final repo = PortableArchiveTestRepository(),
            verifier = PortableArchiveTestVerifier(),
            adapter = PortableArchiveTestAdapter()
              ..automaticDestination = '/chosen/archive.json';
        final c = PortableArchiveController(
          repo,
          exporter: ScopedCreatedFileExporter(adapter: adapter),
          verifier: verifier,
        );
        addTearDown(c.dispose);
        final pending = c.verifyAndSave();
        await portableArchiveFlush();
        repo.requests.single.result.completeError(failure);
        await pending;
        expect(c.receipt, isNull);
        expect(adapter.writeCalls, 0);
        expect(verifier.calls, isEmpty);
        expect(c.busy, isFalse);
        if (failure is NativeAuthorityVerificationException ||
            failure.statusCode == 401 ||
            failure.statusCode == 403) {
          expect(c.available, isFalse);
          expect(c.authorizationDenied, isTrue);
        } else {
          expect(c.phase, PortableArchivePhase.failed);
          expect(c.available, isTrue);
        }
      },
    );
  }
  test('verification failure stays content-free and a fresh explicit retry can succeed', () async {
    final repo = PortableArchiveTestRepository()
      ..immediateResponse = portableArchiveResponse();
    final verifier = PortableArchiveTestVerifier();
    final adapter = PortableArchiveTestAdapter()
      ..automaticDestination = '/chosen/archive.json';
    final c = PortableArchiveController(
      repo,
      exporter: ScopedCreatedFileExporter(adapter: adapter),
      verifier: verifier,
    );
    addTearDown(c.dispose);
    final first = c.verifyAndSave();
    await portableArchiveFlush();
    verifier.calls.single.result.completeError(
      const PortableArchiveVerificationException(
        'bad_digest',
        'PRIVATE_CONTENT',
      ),
    );
    await first;
    expect(c.receipt, isNull);
    expect(adapter.writeCalls, 0);
    expect(c.error, isNot(contains('PRIVATE_CONTENT')));
    final second = c.verifyAndSave();
    await portableArchiveFlush();
    verifier.calls.last.result.complete(portableArchiveReceipt());
    await second;
    expect(c.phase, PortableArchivePhase.saved);
    expect(adapter.writes, hasLength(1));
    expect(repo.requests, hasLength(2));
  });
  test('unsupported adapter never opens chooser or downloads', () async {
    final repo = PortableArchiveTestRepository(),
        verifier = PortableArchiveTestVerifier(),
        adapter = PortableArchiveTestAdapter(available: false);
    final c = PortableArchiveController(
      repo,
      exporter: ScopedCreatedFileExporter(adapter: adapter),
      verifier: verifier,
    );
    addTearDown(c.dispose);
    await c.verifyAndSave();
    expect(c.phase, PortableArchivePhase.unavailable);
    expect(adapter.destinations, isEmpty);
    expect(repo.requests, isEmpty);
    expect(verifier.calls, isEmpty);
  });
  test('owned isolate verifies a server fixture, terminates canceled startup, and can perform a fresh verification', () async {
    final bytes = await File('test/fixtures/portable_archive/populated.json')
        .readAsBytes();
    final verifier = IsolatePortableArchiveVerifier();
    addTearDown(verifier.dispose);
    final canceled = verifier.verify(
      bytes,
      tenantId: portableArchiveTenant,
      actorId: portableArchiveActor,
    );
    final cancellation = expectLater(
      canceled,
      throwsA(isA<CreatedFileExportScopeChanged>()),
    );
    verifier.cancel();
    await cancellation;
    expect(verifier.running, isFalse);
    final receipt = await verifier.verify(
      bytes,
      tenantId: portableArchiveTenant,
      actorId: portableArchiveActor,
    );
    expect(receipt.includedCount, 9);
    expect(receipt.excludedCount, isNull);
    expect(receipt.byteCount, bytes.length);
    expect(verifier.running, isFalse);
  });
  test(
    'owned isolate deadline kills work without returning a receipt',
    () async {
      final bytes = await File('test/fixtures/portable_archive/populated.json')
          .readAsBytes();
      final verifier = IsolatePortableArchiveVerifier(timeout: Duration.zero);
      addTearDown(verifier.dispose);
      await expectLater(
        verifier.verify(
          bytes,
          tenantId: portableArchiveTenant,
          actorId: portableArchiveActor,
        ),
        throwsA(
          isA<PortableArchiveVerificationException>().having(
            (failure) => failure.code,
            'code',
            'verification_timeout',
          ),
        ),
      );
      expect(verifier.running, isFalse);
    },
  );
}
