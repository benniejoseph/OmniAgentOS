import 'package:asael/app/router/app_router.dart';
import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('mounted Memory inspector follows owner controller replacement', (
    tester,
  ) async {
    const memoryId = 'memory:outside/window%2Fencoded:Ω';
    final first = _Repository('First owner private text'),
        next = _Repository('Replacement owner private text');
    var source = first;
    final container = ProviderContainer(
      overrides: [
        knowledgeControllerProvider.overrideWith(
          (ref) => KnowledgeController(
            source,
            canManage: false,
            mutationsAvailable: false,
          )..refresh(),
        ),
        reconnectCoordinatorProvider.overrideWithValue(
          ReconnectCoordinator(() async => const [], const Stream.empty()),
        ),
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.light(),
          home: const ProviderBoundKnowledgeRoute(initialMemoryId: memoryId),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(first.exact, contains(memoryId));
    expect(find.text('First owner private text'), findsWidgets);
    source = next;
    container.invalidate(knowledgeControllerProvider);
    await tester.pumpAndSettle();
    expect(find.text('First owner private text'), findsNothing);
    expect(next.exact, contains(memoryId));
    expect(find.text('Replacement owner private text'), findsWidgets);
    expect(tester.takeException(), isNull);
  }, variant: TargetPlatformVariant.only(TargetPlatform.android));
}

class _Repository extends Fake implements KnowledgeRepository {
  _Repository(this.content);
  final String content;
  final exact = <String>[];
  @override
  Future<KnowledgeState> load({String query = '', String type = 'all'}) async =>
      const KnowledgeState(memories: [], knowledge: [], nodes: [], edges: []);
  @override
  Future<MemoryRecord> getMemory(String id) async {
    exact.add(id);
    return MemoryRecord.fromJson({
      'id': id,
      'title': 'Exact memory',
      'content': content,
    });
  }
}
