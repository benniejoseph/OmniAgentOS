import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/results/created_file_export.dart';
import 'package:asael/features/settings/portable_archive_controller.dart';
import 'package:asael/features/settings/portable_archive_panel.dart';
import 'package:asael/features/settings/portable_archive_providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'portable_archive_test_support.dart';

void main() {
  for (final spec in [
    (platform: TargetPlatform.macOS, dark: false, scale: 1.0),
    (platform: TargetPlatform.macOS, dark: true, scale: 2.0),
    (platform: TargetPlatform.android, dark: false, scale: 2.0),
    (platform: TargetPlatform.iOS, dark: true, scale: 2.0),
  ]) {
    testWidgets(
      '${spec.platform.name} ${spec.dark ? 'dark' : 'light'} ${spec.scale}x panel is explicit and shows only verification receipt',
      (tester) async {
        final desktop = spec.platform == TargetPlatform.macOS;
        tester.view.physicalSize = desktop
            ? const Size(1000, 1100)
            : const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final repo = PortableArchiveTestRepository()
              ..immediateResponse = portableArchiveResponse(),
            verifier = PortableArchiveTestVerifier()
              ..immediateReceipt = portableArchiveReceipt(),
            adapter = PortableArchiveTestAdapter()
              ..automaticDestination = '/chosen/archive.json';
        final c = PortableArchiveController(
          repo,
          exporter: ScopedCreatedFileExporter(adapter: adapter),
          verifier: verifier,
        );
        var browser = 0;
        await tester.pumpWidget(
          MaterialApp(
            theme: desktop
                ? spec.dark
                      ? MacosAppTheme.dark()
                      : MacosAppTheme.light()
                : spec.dark
                ? AppTheme.dark()
                : AppTheme.light(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(spec.scale)),
              child: child!,
            ),
            home: Scaffold(
              body: SingleChildScrollView(
                child: PortableArchivePanelView(
                  controller: c,
                  onOpenBrowser: () => browser++,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(repo.requests, isEmpty);
        expect(verifier.calls, isEmpty);
        expect(adapter.destinations, isEmpty);
        if (desktop) {
          await tester.ensureVisible(
            find.byKey(const Key('portable-archive-save')),
          );
          await tester.tap(find.byKey(const Key('portable-archive-save')));
          await tester.pumpAndSettle();
          expect(
            find.text('Archive integrity verified and file saved.'),
            findsOneWidget,
          );
          expect(find.text('Verification receipt'), findsOneWidget);
          expect(find.text('1 included · unknown excluded'), findsOneWidget);
          expect(adapter.writes.single.bytes, portableArchiveTestBytes);
        } else {
          expect(find.byKey(const Key('portable-archive-save')), findsNothing);
          expect(
            find.textContaining(
              'Saving archives is available in the desktop app.',
            ),
            findsOneWidget,
          );
          expect(repo.requests, isEmpty);
          expect(adapter.writes, isEmpty);
        }
        expect(find.textContaining('PRIVATE_ARCHIVE_CONTENT'), findsNothing);
        final handoff = find.text('Open archive controls in browser');
        await tester.ensureVisible(handoff);
        await tester.pumpAndSettle();
        await tester.tap(handoff);
        expect(browser, 1);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        expect(c.receipt, isNull);
        c.dispose();
      },
      variant: TargetPlatformVariant.only(spec.platform),
    );
  }
  for (final end in ['replace', 'dispose']) {
    testWidgets(
      'view $end invalidates the outgoing verification before a late result can save',
      (tester) async {
        final repo = PortableArchiveTestRepository()
              ..immediateResponse = portableArchiveResponse(),
            verifier = PortableArchiveTestVerifier()..honorCancellation = false,
            adapter = PortableArchiveTestAdapter()
              ..automaticDestination = '/chosen/archive.json';
        final c = PortableArchiveController(
          repo,
          exporter: ScopedCreatedFileExporter(adapter: adapter),
          verifier: verifier,
        );
        final nextRepo = PortableArchiveTestRepository(),
            nextVerifier = PortableArchiveTestVerifier();
        final next = PortableArchiveController(
          nextRepo,
          exporter: ScopedCreatedFileExporter(
            adapter: PortableArchiveTestAdapter(),
          ),
          verifier: nextVerifier,
        );
        Widget app(PortableArchiveController controller) => MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: PortableArchivePanelView(
                controller: controller,
                onOpenBrowser: () {},
              ),
            ),
          ),
        );
        await tester.pumpWidget(app(c));
        await tester.pumpAndSettle();
        final pending = c.verifyAndSave();
        await tester.pump();
        expect(verifier.calls, hasLength(1));
        await tester.pumpWidget(
          end == 'replace' ? app(next) : const SizedBox.shrink(),
        );
        expect(c.available, isFalse);
        expect(verifier.cancellations, greaterThan(0));
        verifier.calls.single.result.complete(portableArchiveReceipt());
        await tester.pumpAndSettle();
        await pending;
        expect(adapter.writes, isEmpty);
        expect(c.receipt, isNull);
        expect(nextRepo.requests, isEmpty);
        expect(find.text('Verification receipt'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        c.dispose();
        next.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  }
  for (final change in ['hidden chooser', 'background verifier']) {
    testWidgets(
      'actual panel $change creates a fresh idle lifetime and fences old operation',
      (tester) async {
        tester.view.physicalSize = const Size(1000, 1100);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final api = PortableArchiveTestApi(),
            adapter = PortableArchiveTestAdapter(),
            controllers = <PortableArchiveController>[],
            verifiers = <PortableArchiveTestVerifier>[];
        if (change == 'background verifier') {
          adapter.automaticDestination = '/chosen/archive.json';
        }
        final container = ProviderContainer(
          overrides: [
            apiClientProvider.overrideWithValue(api),
            sessionControllerProvider.overrideWith(
              PortableArchiveTestSessions.new,
            ),
            biometricSessionLockControllerProvider.overrideWith(
              (ref) => PortableArchiveTestLock(),
            ),
            portableArchiveControllerProvider.overrideWith((ref, visibility) {
              final repository = ref.watch(portableArchiveRepositoryProvider);
              if (repository == null || !repository.current) return null;
              final verifier = PortableArchiveTestVerifier()
                ..honorCancellation = false;
              verifiers.add(verifier);
              final controller = PortableArchiveController(
                repository,
                exporter: ScopedCreatedFileExporter(adapter: adapter),
                verifier: verifier,
              );
              controllers.add(controller);
              ref.onDispose(controller.dispose);
              return controller;
            }),
          ],
        );
        addTearDown(container.dispose);
        await container.read(sessionControllerProvider.future);
        Widget app(bool shown) => UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            home: Scaffold(
              body: SingleChildScrollView(
                child: TickerMode(
                  enabled: shown,
                  child: const PortableArchivePanel(),
                ),
              ),
            ),
          ),
        );
        await tester.pumpWidget(app(true));
        await tester.pumpAndSettle();
        expect(api.paths, isEmpty);
        final original = controllers.single, verifier = verifiers.single;
        final pending = original.verifyAndSave();
        await tester.pump();
        if (change == 'hidden chooser') {
          expect(api.paths, isEmpty);
          await tester.pumpWidget(app(false));
          await tester.pumpAndSettle();
          adapter.destinations.single.complete('/chosen/archive.json');
          await tester.pumpAndSettle();
          await pending;
          await tester.pumpWidget(app(true));
          await tester.pumpAndSettle();
        } else {
          expect(verifier.calls, hasLength(1));
          tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.inactive,
          );
          await tester.pumpAndSettle();
          verifier.calls.single.result.complete(portableArchiveReceipt());
          await tester.pumpAndSettle();
          await pending;
          tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.resumed,
          );
          await tester.pumpAndSettle();
        }
        expect(original.available, isFalse);
        expect(original.receipt, isNull);
        expect(adapter.writes, isEmpty);
        expect(controllers.length, greaterThanOrEqualTo(2));
        expect(controllers.last.phase, PortableArchivePhase.idle);
        expect(api.paths.length, change == 'hidden chooser' ? 0 : 1);
        expect(find.text('Verification receipt'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  }
}
