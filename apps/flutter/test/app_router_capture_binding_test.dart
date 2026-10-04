import 'package:asael/app/router/app_router.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/capture/capture_controller.dart';
import 'package:asael/features/capture/capture_providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'features/capture/capture_test_support.dart';

void main() {
  testWidgets(
    'mounted Capture clears private intake when its provider is replaced',
    (tester) async {
      final repository = CaptureTestRepository(), outbox = CaptureTestOutbox();
      final container = ProviderContainer(
        overrides: [
          captureControllerProvider.overrideWith(
            (ref) => CaptureController(repository, outbox, captureTestOwner),
          ),
        ],
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: MacosAppTheme.light(),
            home: const ProviderBoundCaptureRoute(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('capture-title')),
        'Private title from prior session',
      );
      final prior = container.read(captureControllerProvider);
      container.invalidate(captureControllerProvider);
      await tester.pumpAndSettle();
      expect(prior.available, isFalse);
      expect(container.read(captureControllerProvider), isNot(same(prior)));
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('capture-title')))
            .controller!
            .text,
        isEmpty,
      );
      expect(repository.submissions, isEmpty);
      expect(tester.takeException(), isNull);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );
}
