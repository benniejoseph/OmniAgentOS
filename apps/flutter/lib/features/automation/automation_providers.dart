import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../../generated/native_contract.g.dart';
import '../auth/application/session_controller.dart';
import 'automation_api_repository.dart';
import 'automation_controller.dart';

final automationRepositoryProvider = Provider<AutomationRepository>(
  (ref) => ApiAutomationRepository(ref.watch(apiClientProvider)),
);

final automationControllerProvider =
    ChangeNotifierProvider<AutomationController>((ref) {
      final controller = AutomationController(
        ref.watch(automationRepositoryProvider),
        canManage:
            ref.watch(sessionControllerProvider).value?.canManage ?? false,
        mutationsAvailable: const [
          'plugins.preview',
          'plugins.install',
          'plugins.change',
          'plugins.uninstall',
        ].every(NativeContract.supportsOperation),
      );
      final unregister = ref
          .read(reconnectCoordinatorProvider)
          .register('automation-studio', controller.refresh);
      ref.onDispose(unregister);
      unawaited(controller.refresh());
      return controller;
    });
