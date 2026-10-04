import 'dart:async';

import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/capture_ciphertext_broker.dart';
import 'package:asael/features/capture/capture.dart';
import 'package:asael/features/capture/capture_outbox.dart';
import 'package:asael/features/capture/capture_projection.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_support.dart';

Future<void> _pump(
  WidgetTester tester,
  CaptureController controller, {
  CaptureTestRecorder? recorder,
  double width = 390,
  double scale = 1,
  bool dark = false,
}) async {
  tester.view.physicalSize = Size(width, 1000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: dark
          ? AppTheme.dark(platform: TargetPlatform.linux)
          : AppTheme.light(platform: TargetPlatform.linux),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          textScaler: TextScaler.linear(scale),
          disableAnimations: true,
        ),
        child: child!,
      ),
      home: CaptureView(
        controller: controller,
        recorder: recorder ?? CaptureTestRecorder(),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _show(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
}

void main() {
  test('unknown cleanup waits for an explicit rescan and preserves its exact local receipt', () async {
    final outbox = _LegacyOutbox()..unknownRemoval = true;
    final controller = CaptureController(
      CaptureTestRepository(),
      outbox,
      captureTestOwner,
    );
    addTearDown(controller.dispose);
    await controller.initialize();
    final inspections = outbox.inspections;
    await controller.discardLegacyInventory(
      controller.legacyInventory!,
      reviewedGeneration: controller.generation,
    );
    expect(outbox.inspections, inspections);
    expect(outbox.discards, 1);
    expect(controller.legacyInventory, isNull);
    expect(
      controller.legacyCleanupNotice,
      contains('1 removals are unconfirmed and may already have completed'),
    );
    expect(
      controller.legacyDeletionReceipts.single.disposition,
      CaptureLocalDeletionDisposition.unconfirmed,
    );
    final receipt = controller.legacyDeletionReceipts.single;
    await controller.refreshLegacyInventory();
    expect(
      controller.legacyCleanupNotice,
      contains('1 absent, 0 retained, 0 changed'),
    );
    expect(controller.legacyDeletionReceipts.single.sha256, receipt.sha256);
    expect(
      controller.legacyDeletionReceipts.single.disposition,
      CaptureLocalDeletionDisposition.absent,
    );
    expect(outbox.discards, 1);
    controller.lock();
    expect(controller.legacyDeletionReceipts, isEmpty);
  });
  testWidgets(
    'legacy cleanup shows only encrypted counts and requires a fresh explicit confirmation',
    (tester) async {
      final outbox = _LegacyOutbox();
      final controller = CaptureController(
        CaptureTestRepository(),
        outbox,
        captureTestOwner,
        canWrite: false,
      );
      await controller.initialize();
      await _pump(tester, controller, width: 320, scale: 2);
      await _show(
        tester,
        find.byKey(const Key('capture-review-legacy-cleanup')),
      );
      expect(
        find.textContaining('2 unclaimed encrypted files'),
        findsOneWidget,
      );
      expect(find.textContaining('Legacy private note'), findsNothing);
      await tester.tap(find.byKey(const Key('capture-review-legacy-cleanup')));
      await tester.pumpAndSettle();
      expect(outbox.inspections, 2);
      expect(outbox.discards, 0);
      expect(find.text('Discard older encrypted files?'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('Keep files'));
      await tester.pumpAndSettle();
      expect(outbox.count, 2);
      expect(outbox.discards, 0);
      await _show(
        tester,
        find.byKey(const Key('capture-review-legacy-cleanup')),
      );
      await tester.tap(find.byKey(const Key('capture-review-legacy-cleanup')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('capture-confirm-legacy-cleanup')));
      await tester.pumpAndSettle();
      expect(
        outbox.inspections,
        4,
      ); // Initial, both dialog reviews, and after cleanup.
      expect(outbox.discards, 1);
      expect(outbox.count, 0);
      expect(
        find.textContaining('2 encrypted legacy files removed.'),
        findsOneWidget,
      );
      expect(
        (controller.repository as CaptureTestRepository).submissions,
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
    variant: TargetPlatformVariant({TargetPlatform.linux}),
  );

  for (final change in ['scope', 'inventory']) {
    testWidgets(
      '$change replacement while the cleanup dialog is open cannot delete the reviewed files',
      (tester) async {
        final outbox = _LegacyOutbox();
        final controller = CaptureController(
          CaptureTestRepository(),
          outbox,
          captureTestOwner,
          canWrite: false,
        );
        await controller.initialize();
        await _pump(tester, controller);
        await _show(
          tester,
          find.byKey(const Key('capture-review-legacy-cleanup')),
        );
        await tester.tap(
          find.byKey(const Key('capture-review-legacy-cleanup')),
        );
        await tester.pumpAndSettle();
        if (change == 'scope') {
          controller.lock();
        } else {
          await controller.refreshLegacyInventory();
        }
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const Key('capture-confirm-legacy-cleanup')),
        );
        await tester.pumpAndSettle();
        expect(outbox.count, 2);
        expect(outbox.discards, 0);
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      },
      variant: TargetPlatformVariant({TargetPlatform.linux}),
    );
  }

  testWidgets(
    'definite filesystem non-removal is shown with the remaining inventory',
    (tester) async {
      final outbox = _LegacyOutbox()..failRemoval = true;
      final controller = CaptureController(
        CaptureTestRepository(),
        outbox,
        captureTestOwner,
        canWrite: false,
      );
      await controller.initialize();
      await _pump(tester, controller);
      await _show(
        tester,
        find.byKey(const Key('capture-review-legacy-cleanup')),
      );
      await tester.tap(find.byKey(const Key('capture-review-legacy-cleanup')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('capture-confirm-legacy-cleanup')));
      await tester.pumpAndSettle();
      expect(find.textContaining('2 removals did not proceed'), findsOneWidget);
      expect(
        find.textContaining('2 unclaimed encrypted files'),
        findsOneWidget,
      );
      expect(outbox.count, 2);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
    variant: TargetPlatformVariant({TargetPlatform.linux}),
  );

  for (final dark in [false, true]) {
    testWidgets(
      'Capture modes and honest source boundaries reflow at 320px 200% ${dark ? 'dark' : 'light'}',
      (tester) async {
        final repository = CaptureTestRepository();
        final controller = CaptureController(
          repository,
          CaptureTestOutbox(),
          captureTestOwner,
        );
        await _pump(tester, controller, width: 320, scale: 2, dark: dark);
        expect(find.text('Note'), findsOneWidget);
        expect(find.text('Record'), findsOneWidget);
        expect(find.text('Upload'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await _show(tester, find.byKey(const Key('capture-mode-upload')));
        await tester.tap(find.byKey(const Key('capture-mode-upload')));
        await tester.pumpAndSettle();
        await _show(tester, find.text('Choose files'));
        expect(tester.takeException(), isNull);
        await _show(
          tester,
          find.textContaining(
            'Capture history, historical versions and reindexing',
          ),
        );
        expect(repository.submissions, isEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      },
      variant: TargetPlatformVariant({TargetPlatform.linux}),
    );
  }
  testWidgets(
    'an accepted note clears only its submitted draft and exposes the exact returned job',
    (tester) async {
      final repository = CaptureTestRepository();
      final controller = CaptureController(
        repository,
        CaptureTestOutbox(),
        captureTestOwner,
      );
      await _pump(tester, controller);
      await _show(tester, find.byKey(const Key('capture-note')));
      await tester.enterText(
        find.byKey(const Key('capture-note')),
        'https://synthetic.invalid/shared-note',
      );
      await _show(tester, find.byKey(const Key('capture-submit')));
      await tester.tap(find.byKey(const Key('capture-submit')));
      await tester.pumpAndSettle();
      expect(
        repository.submissions.single.content,
        'https://synthetic.invalid/shared-note',
      );
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('capture-note')))
            .controller!
            .text,
        '',
      );
      await _show(tester, find.textContaining('Job: job-one'));
      expect(find.textContaining('capture://quick-note'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
    variant: TargetPlatformVariant({TargetPlatform.linux}),
  );
  testWidgets(
    'an outbox failure retains the draft and shows recovery instead of a success receipt',
    (tester) async {
      final outbox = CaptureTestOutbox()
        ..beforeEnqueue = () async =>
            throw const CaptureOutboxCapacityException('Full');
      final repository = CaptureTestRepository();
      final controller = CaptureController(
        repository,
        outbox,
        captureTestOwner,
      );
      await _pump(tester, controller);
      await _show(tester, find.byKey(const Key('capture-note')));
      await tester.enterText(
        find.byKey(const Key('capture-note')),
        'Keep this draft',
      );
      await _show(tester, find.byKey(const Key('capture-submit')));
      await tester.tap(find.byKey(const Key('capture-submit')));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('capture-note')))
            .controller!
            .text,
        'Keep this draft',
      );
      expect(find.textContaining('Your draft is retained'), findsOneWidget);
      expect(repository.submissions, isEmpty);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
    variant: TargetPlatformVariant({TargetPlatform.linux}),
  );
  testWidgets(
    'controller replacement clears private drafts and a late submission cannot clear the next owner draft',
    (tester) async {
      final oldRepository = CaptureTestRepository(),
          held = Completer<CaptureReceipt>();
      oldRepository.submitter = (_) => held.future;
      final old = CaptureController(
        oldRepository,
        CaptureTestOutbox(),
        captureTestOwner,
      );
      final next = CaptureController(
        CaptureTestRepository(),
        CaptureTestOutbox(),
        const CaptureOwnerBinding(
          tenantId: 'other',
          actorId: 'other',
          canonicalUserId: 'user-one',
          apiOrigin: 'https://capture.test',
        ),
      );
      await _pump(tester, old);
      await _show(tester, find.byKey(const Key('capture-note')));
      await tester.enterText(
        find.byKey(const Key('capture-note')),
        'Old private draft',
      );
      await _show(tester, find.byKey(const Key('capture-submit')));
      await tester.tap(find.byKey(const Key('capture-submit')));
      await tester.pump();
      old.lock();
      await _pump(tester, next);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('capture-note')))
            .controller!
            .text,
        '',
      );
      await _show(tester, find.byKey(const Key('capture-note')));
      await tester.enterText(
        find.byKey(const Key('capture-note')),
        'Next owner draft',
      );
      held.complete(
        const CaptureReceipt(jobId: 'old-job', title: 'Old private', tags: []),
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('capture-note')))
            .controller!
            .text,
        'Next owner draft',
      );
      expect(find.textContaining('old-job'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      old.dispose();
      next.dispose();
    },
    variant: TargetPlatformVariant({TargetPlatform.linux}),
  );
  testWidgets(
    'recording requires consent and a denied microphone never shows Recording',
    (tester) async {
      final recorder = CaptureTestRecorder()..permission = () async => false;
      final controller = CaptureController(
        CaptureTestRepository(),
        CaptureTestOutbox(),
        captureTestOwner,
      );
      await _pump(tester, controller, recorder: recorder);
      await tester.tap(find.byKey(const Key('capture-mode-record')));
      await tester.pumpAndSettle();
      await _show(tester, find.byKey(const Key('capture-record-start-stop')));
      expect(
        tester
            .widget<FilledButton>(
              find.byKey(const Key('capture-record-start-stop')),
            )
            .onPressed,
        isNull,
      );
      await _show(tester, find.byType(CheckboxListTile));
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pumpAndSettle();
      await _show(tester, find.byKey(const Key('capture-record-start-stop')));
      await tester.tap(find.byKey(const Key('capture-record-start-stop')));
      await tester.pumpAndSettle();
      expect(find.textContaining('permission was not granted'), findsOneWidget);
      expect(find.text('Microphone active · recording'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
    variant: TargetPlatformVariant({TargetPlatform.linux}),
  );
  testWidgets(
    'failed exact source refresh retains its accepted identity with explicit unavailable metadata',
    (tester) async {
      final repository = CaptureTestRepository();
      final controller = CaptureController(
        repository,
        CaptureTestOutbox(),
        captureTestOwner,
      );
      await controller.submit(captureTestDraft());
      await tester.pump();
      repository.assetReader = (_) async => throw const ApiException(
        'Source temporarily unavailable',
        statusCode: 503,
      );
      await controller.refreshReceipt();
      await _pump(tester, controller, width: 1440);
      await _show(
        tester,
        find.textContaining('Current source state unavailable'),
      );
      expect(find.textContaining(captureTestHash), findsOneWidget);
      expect(controller.assetFresh, isFalse);
      expect(
        tester
            .widget<OutlinedButton>(
              find.byKey(const Key('capture-save-original')),
            )
            .onPressed,
        isNull,
      );
      expect(controller.selectedAsset, isA<CaptureAssetSnapshot>());
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
    variant: TargetPlatformVariant({TargetPlatform.linux}),
  );
}

class _LegacyOutbox extends CaptureTestOutbox
    implements CaptureLegacyOutboxRecovery {
  int count = 2, inspections = 0, discards = 0;
  bool failRemoval = false;
  bool unknownRemoval = false;
  static final uncertain = CaptureLocalDeletionReceipt(
    entryId: 'abcdefghijklmnopqrstuvwx',
    sha256: List.filled(64, 'a').join(),
    encryptedBytes: 512,
    mode: CaptureStorageMode.legacy,
    disposition: CaptureLocalDeletionDisposition.unconfirmed,
  );
  CaptureLegacyInventory? latest;
  @override
  Future<CaptureLegacyInventory> inspectLegacy(
    CaptureOwnerBinding owner,
  ) async => latest = CaptureLegacyInventory(
    identity: 'inventory-${++inspections}',
    count: count,
    encryptedBytes: count * 512,
    reconciledDeletions: unknownRemoval && discards > 0
        ? [uncertain.withDisposition(CaptureLocalDeletionDisposition.absent)]
        : const [],
  );
  @override
  Future<CaptureLegacyCleanupResult> discardLegacy(
    CaptureOwnerBinding owner,
    CaptureLegacyInventory reviewed, {
    required bool Function() authorityCurrent,
  }) async {
    if (!authorityCurrent()) {
      return const CaptureLegacyCleanupResult(stopped: true);
    }
    if (!identical(reviewed, latest)) {
      return const CaptureLegacyCleanupResult(stale: true);
    }
    discards++;
    if (unknownRemoval) {
      count--;
      return CaptureLegacyCleanupResult(
        unconfirmed: 1,
        stopped: true,
        receipts: [uncertain],
      );
    }
    if (failRemoval) {
      return CaptureLegacyCleanupResult(failed: count);
    }
    final removed = count;
    count = 0;
    return CaptureLegacyCleanupResult(removed: removed);
  }
}
