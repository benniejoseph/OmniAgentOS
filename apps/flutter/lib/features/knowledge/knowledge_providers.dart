import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
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
    );
    c.refresh();
    return c;
  },
);
