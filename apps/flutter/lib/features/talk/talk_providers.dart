import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../../generated/native_contract.g.dart';
import '../auth/application/session_controller.dart';
import '../computer_use/local_computer.dart';
import 'talk.dart';
import 'talk_api_repository.dart';

final talkRepositoryProvider = Provider<TalkRepository>(
  (ref) => ApiTalkRepository(ref.watch(apiClientProvider)),
);
final talkControllerProvider = ChangeNotifierProvider<TalkController>((ref) {
  final owner = ref.watch(sessionOwnerKeyProvider);
  final localComputer = ref.watch(localComputerCoordinatorProvider.notifier);
  final controller = TalkController(
    ref.watch(talkRepositoryProvider),
    localComputerPreviews: owner == null ? null : localComputer,
  );
  if (owner != null && NativeContract.supportsOperation('promptQueue.list')) {
    unawaited(controller.initializePromptQueue());
  }
  final unregisterHistory = ref
      .read(reconnectCoordinatorProvider)
      .register(
        'talk-history',
        () => controller.loadRecentThreads(force: true),
        classification: ReconciliationClass.freshness,
        freshnessScope: '/talk',
      );
  final unregisterRun = ref
      .read(reconnectCoordinatorProvider)
      .register(
        'talk-accepted-run',
        () async => controller.reconcileAcceptedRun(),
        priority: 9,
        classification: ReconciliationClass.durable,
        shouldRun: (_) =>
            controller.runId != null &&
            controller.hasPendingConversationWork &&
            !controller.monitoringAcceptedRun,
      );
  final unregisterPromptQueue = ref
      .read(reconnectCoordinatorProvider)
      .register(
        'talk-prompt-queue',
        controller.reconcilePromptQueue,
        priority: 8,
        classification: ReconciliationClass.durable,
        // The encrypted outbox is authoritative. The visible queue can be
        // empty while an offline delete of its final item still needs replay.
        shouldRun: (_) => !controller.promptQueueSyncing,
      );
  ref.onDispose(() {
    unregisterPromptQueue();
    unregisterRun();
    unregisterHistory();
  });
  return controller;
});
