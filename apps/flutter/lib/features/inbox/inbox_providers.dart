import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import 'inbox.dart';
import 'inbox_api_repository.dart';

final inboxRepositoryProvider = Provider<InboxRepository>(
  (ref) => ApiInboxRepository(ref.watch(apiClientProvider)),
);
final inboxControllerProvider = ChangeNotifierProvider<InboxController>((ref) {
  final controller = InboxController(ref.watch(inboxRepositoryProvider));
  final unregister = ref
      .read(reconnectCoordinatorProvider)
      .register(
        'inbox',
        controller.refresh,
        classification: ReconciliationClass.freshness,
        freshnessScope: '/inbox',
      );
  ref.onDispose(unregister);
  controller.refresh();
  return controller;
});
