import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../../generated/native_contract.g.dart';
import '../auth/application/session_controller.dart';
import 'knowledge.dart';
import 'knowledge_api_repository.dart';

final knowledgeRepositoryProvider = Provider<KnowledgeRepository>(
  (ref) => ApiKnowledgeRepository(ref.watch(apiClientProvider)),
);
final knowledgeControllerProvider = ChangeNotifierProvider<KnowledgeController>(
  (ref) {
    final c = KnowledgeController(
      ref.watch(knowledgeRepositoryProvider),
      canManage: ref.watch(sessionControllerProvider).value?.canManage ?? false,
      mutationsAvailable: const [
        'memory.create',
        'memory.update',
        'memory.delete',
        'memory.graph.rebuild',
        'knowledge.source.delete',
      ].every(NativeContract.supportsOperation),
    );
    final unregister = ref
        .read(reconnectCoordinatorProvider)
        .register('knowledge', c.refresh);
    ref.onDispose(unregister);
    c.refresh();
    return c;
  },
);
