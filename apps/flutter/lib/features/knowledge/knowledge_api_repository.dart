import '../../core/network/api_client.dart';
import 'knowledge.dart';

class ApiKnowledgeRepository implements KnowledgeRepository {
  const ApiKnowledgeRepository(this.api);
  final ApiClient api;
  List<dynamic> _list(Object? value) => value is List ? value : const [];

  @override
  Future<KnowledgeState> load({String query = '', String type = 'all'}) async {
    final responses = await Future.wait([
      api.getJson(
        '/api/memory',
        query: {if (query.isNotEmpty) 'q': query, 'limit': 100},
      ),
      api.getJson(
        '/api/knowledge',
        query: {if (query.isNotEmpty) 'q': query, 'limit': 100},
      ),
      api.getJson(
        '/api/memory/graph',
        query: {if (query.isNotEmpty) 'q': query, 'limit': 50},
      ),
    ]);
    final memoryJson = responses[0],
        knowledgeJson = responses[1],
        graphJson = responses[2];
    final rawMemories = query.isEmpty
        ? _list(memoryJson['memories'])
        : _list(memoryJson['results'])
              .map((e) => (e as Map)['record'])
              .toList();
    final knowledge = query.isEmpty
        ? <KnowledgeItem>[
            ..._list(knowledgeJson['documents']).whereType<Map>().map(
              (e) => KnowledgeItem.fromJson(Map<String, dynamic>.from(e)),
            ),
            ..._list(knowledgeJson['chunks']).whereType<Map>().map(
              (e) => KnowledgeItem.fromJson(
                Map<String, dynamic>.from(e),
                kind: 'chunk',
              ),
            ),
          ]
        : _list(knowledgeJson['results'])
              .whereType<Map>()
              .map(
                (e) => KnowledgeItem.fromJson(
                  Map<String, dynamic>.from(e['chunk'] as Map),
                  kind: 'match',
                ),
              )
              .toList();
    final rawNodes = query.isEmpty
        ? _list(graphJson['nodes'])
        : _list(graphJson['results']).map((e) => (e as Map)['node']).toList();
    return KnowledgeState(
      memories: rawMemories
          .whereType<Map>()
          .map((e) => MemoryRecord.fromJson(Map<String, dynamic>.from(e)))
          .where((e) => type == 'all' || e.type == type)
          .toList(),
      knowledge: knowledge,
      nodes: rawNodes
          .whereType<Map>()
          .map((e) => GraphNode.fromJson(Map<String, dynamic>.from(e)))
          .toList(),
      edges: _list(graphJson['edges'])
          .whereType<Map>()
          .map((e) => GraphEdge.fromJson(Map<String, dynamic>.from(e)))
          .toList(),
      stats: graphJson['stats'] is Map
          ? Map<String, dynamic>.from(graphJson['stats'] as Map)
          : const {},
    );
  }

  @override
  Future<void> addMemory(Json input) async =>
      api.postJson('/api/memory', data: input);
  @override
  Future<void> correctMemory(String id, Json input) async =>
      api.patchJson('/api/memory/$id', data: input);
  @override
  Future<void> forgetMemory(String id) async =>
      api.deleteJson('/api/memory/$id');
  @override
  Future<void> rebuildGraph() async =>
      api.postJson('/api/memory/graph', data: {'source': 'flutter'});
  @override
  Future<void> deleteConnectedSource(String source) async =>
      api.deleteJson('/api/knowledge', query: {'source': source});
}
