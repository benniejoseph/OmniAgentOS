import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import 'talk.dart';
import 'talk_api_repository.dart';

final talkRepositoryProvider = Provider<TalkRepository>(
  (ref) => ApiTalkRepository(ref.watch(apiClientProvider)),
);
final talkControllerProvider = ChangeNotifierProvider<TalkController>((ref) {
  final controller = TalkController(ref.watch(talkRepositoryProvider));
  final unregister = ref
      .read(reconnectCoordinatorProvider)
      .register(
        'talk-history',
        () => controller.loadRecentThreads(force: true),
      );
  ref.onDispose(unregister);
  return controller;
});
