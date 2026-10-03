import 'package:asael/features/activity/activity_providers.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'activity_fixture.dart';

void main() {
  test(
    'owner and role changes dispose old reads and never inherit private rows',
    () async {
      late _Sessions sessions;
      final repository = ControlledActivityRepository();
      final container = ProviderContainer(
        overrides: [
          sessionControllerProvider.overrideWith(() => sessions = _Sessions()),
          activityRepositoryProvider.overrideWithValue(repository),
        ],
      );
      addTearDown(container.dispose);
      await container.read(sessionControllerProvider.future);
      final subscription = container.listen(
        activityControllerProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);
      final first = container.read(activityControllerProvider);
      final firstRead = repository.reads.single;
      sessions.replace(_owner('owner-b'));
      await container.pump();
      final second = container.read(activityControllerProvider);
      expect(second, isNot(same(first)));
      expect(firstRead.cancelToken.isCancelled, isTrue);
      firstRead.result.complete(
        snapshot(items: [runFixture(id: 'old-owner-private')]),
      );
      await Future<void>.delayed(Duration.zero);
      expect(second.snapshot, isNull);
      repository.reads.last.result.complete(
        snapshot(items: [runFixture(id: 'owner-b')]),
      );
      await Future<void>.delayed(Duration.zero);
      expect(second.snapshot!.items.single.sourceRef.id, 'owner-b');
      sessions.replace(_owner('owner-b', role: 'viewer'));
      await container.pump();
      final restricted = container.read(activityControllerProvider);
      expect(restricted, isNot(same(second)));
      expect(restricted.snapshot, isNull);
      final restrictedRead = repository.reads.last;
      sessions.replace(null);
      await container.pump();
      expect(restrictedRead.cancelToken.isCancelled, isTrue);
      final signedOut = container.read(activityControllerProvider);
      expect(signedOut.snapshot, isNull);
      expect(signedOut.loading, isFalse);
      restrictedRead.result.complete(snapshot());
      await Future<void>.delayed(Duration.zero);
      expect(signedOut.snapshot, isNull);
      expect(repository.reads, hasLength(3));
    },
  );
}

AppSession _owner(String actor, {String role = 'member'}) => AppSession(
  tenantId: 'tenant',
  actorId: actor,
  userId: actor,
  email: '$actor@example.test',
  displayName: actor,
  workspaceName: 'Synthetic',
  role: role,
);

class _Sessions extends SessionController {
  @override
  Future<AppSession?> build() async => _owner('owner-a');
  void replace(AppSession? session) {
    state = AsyncData(session);
  }
}
