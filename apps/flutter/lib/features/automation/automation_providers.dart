import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/native_workspace_access.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../../generated/native_contract.g.dart';
import '../agents/specialist_api_client.dart';
import 'automation_api_repository.dart';
import 'automation_controller.dart';

final automationRepositoryProvider = Provider.autoDispose<AutomationRepository>(
  (ref) =>
      ApiAutomationRepository(ref.watch(specialistApiProvider('automation'))),
);

final automationControllerProvider =
    ChangeNotifierProvider.autoDispose<AutomationController>((ref) {
      final controller = AutomationController(
        ref.watch(automationRepositoryProvider),
        canManage: ref.watch(nativeWorkspaceAccessProvider)?.canManage ?? false,
        mutationsAvailable: const [
          'plugins.preview',
          'plugins.install',
          'plugins.change',
          'plugins.uninstall',
        ].every(NativeContract.supportsOperation),
      );
      final unregister = ref
          .read(reconnectCoordinatorProvider)
          .register(
            'automation-studio',
            controller.refresh,
            classification: ReconciliationClass.freshness,
            freshnessScope: '/automation',
          );
      ref.onDispose(unregister);
      unawaited(controller.refresh());
      return controller;
    });
