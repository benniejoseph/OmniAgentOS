import 'package:asael/app/router/app_router.dart';
import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/meetings/meetings_draft_store.dart';
import 'package:asael/features/meetings/meetings_providers.dart';
import 'package:asael/features/meetings/meetings_snapshots.dart';
import 'package:asael/features/meetings/meetings_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'features/meetings/meetings_test_support.dart';

void main() {
  testWidgets(
    'exact Meeting bookmark binds current read and governed action providers',
    (tester) async {
      tester.view.physicalSize = const Size(1200, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = FakeMeetingsRepository();
      final route = '/meetings/${Uri.encodeComponent(meetingTestId)}';
      expect(isSafeInitialAppLocation(route), isTrue);
      final container = ProviderContainer(
        overrides: [
          sessionControllerProvider.overrideWith(_Sessions.new),
          appInitialLocationProvider.overrideWithValue(route),
          meetingsRepositoryProvider.overrideWithValue(repository),
          meetingDraftStoreProvider.overrideWithValue(
            MemoryMeetingDraftStore(),
          ),
          reconnectCoordinatorProvider.overrideWithValue(
            ReconnectCoordinator(() async => const [], const Stream.empty()),
          ),
        ],
      );
      addTearDown(container.dispose);
      await container.read(sessionControllerProvider.future);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );
      await tester.pumpAndSettle();
      final view = tester.widget<MeetingDetailView>(
        find.byType(MeetingDetailView),
      );
      expect(view.id, meetingTestId);
      expect(view.repository, same(repository));
      expect(view.actions, isNotNull);
      expect(repository.detailReads, greaterThan(0));
      expect(repository.commitmentReads, greaterThan(0));
      expect(repository.writes, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );

  testWidgets(
    'mounted Meeting detail replaces private repository state without a route change',
    (tester) async {
      final first = FakeMeetingsRepository(), next = FakeMeetingsRepository();
      MeetingDetailSnapshot named(String title) {
        final row = meetingDetailJson();
        (row['meeting'] as Map<String, dynamic>)['title'] = title;
        return MeetingDetailSnapshot.parse(
          row,
          id: meetingTestId,
          tenantId: meetingOwner.tenantId,
        );
      }

      first.detailReader = (_) async => named('Earlier private Meeting');
      next.detailReader = (_) async => named('Current private Meeting');
      var source = first;
      final container = ProviderContainer(
        overrides: [
          meetingsRepositoryProvider.overrideWith((ref) => source),
          meetingDraftStoreProvider.overrideWithValue(
            MemoryMeetingDraftStore(),
          ),
        ],
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: AppTheme.light(),
            home: const ProviderBoundMeetingRoute(id: meetingTestId),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Earlier private Meeting'), findsWidgets);
      source = next;
      container.invalidate(meetingsRepositoryProvider);
      await tester.pumpAndSettle();
      expect(find.text('Earlier private Meeting'), findsNothing);
      expect(find.text('Current private Meeting'), findsWidgets);
      expect(
        tester
            .widget<MeetingDetailView>(find.byType(MeetingDetailView))
            .repository,
        same(next),
      );
      expect(first.writes + next.writes, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );

  testWidgets(
    'an ambiguous Meeting identity cannot initialize private read or action providers',
    (tester) async {
      final container = ProviderContainer(
        overrides: [
          meetingsRepositoryProvider.overrideWith(
            (ref) => throw StateError('No private read allowed'),
          ),
        ],
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: ProviderBoundMeetingRoute(
              id: 'meeting%3A11111111-1111-4111-8111-111111111111',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('This Meeting link is invalid.'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}

class _RouterHarness extends ConsumerWidget {
  const _RouterHarness();
  @override
  Widget build(BuildContext context, WidgetRef ref) => MaterialApp.router(
    theme: AppTheme.light(),
    routerConfig: ref.watch(appRouterProvider),
  );
}

class _Sessions extends SessionController {
  @override
  Future<AppSession?> build() async => const AppSession(
    tenantId: 'tenant-native',
    actorId: 'owner@example.test',
    userId: meetingUserId,
    email: 'owner@example.test',
    displayName: 'Owner',
    workspaceName: 'Native',
    role: 'operator',
  );
}
