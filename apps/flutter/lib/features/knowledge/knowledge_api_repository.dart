import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'knowledge.dart';

class ApiKnowledgeRepository implements KnowledgeRepository {
  const ApiKnowledgeRepository(this.api);
  final ApiClient api;
  List<dynamic> _list(Object? value) => value is List ? value : const [];

  @override
  Future<KnowledgeState> load({String query = '', String type = 'all'}) async {
    final responses = await Future.wait([
      api.getJson(
        NativePaths.memoryIntelligenceGet,
        query: {'view': 'overview', 'limit': 40},
      ),
      api.getJson(
        NativePaths.memoryIntelligenceGet,
        query: {
          'view': 'memory',
          if (query.isNotEmpty) 'q': query,
          'limit': 100,
        },
      ),
      api.getJson(
        NativePaths.memoryIntelligenceGet,
        query: {
          'view': 'knowledge',
          if (query.isNotEmpty) 'q': query,
          'limit': 100,
        },
      ),
      api.getJson(NativePaths.memoryGraphGet, query: {'limit': 100}),
    ]);
    final overviewJson = responses[0],
        memoryJson = responses[1],
        knowledgeJson = responses[2],
        graphJson = responses[3];
    final memoryPage = memoryJson['memory'] is Map
        ? Map<String, dynamic>.from(memoryJson['memory'] as Map)
        : const <String, dynamic>{};
    final knowledgePage = knowledgeJson['knowledge'] is Map
        ? Map<String, dynamic>.from(knowledgeJson['knowledge'] as Map)
        : const <String, dynamic>{};
    return KnowledgeState(
      memories: _list(memoryPage['items'])
          .whereType<Map>()
          .map((e) => MemoryRecord.fromJson(Map<String, dynamic>.from(e)))
          .where((e) => type == 'all' || e.type == type)
          .toList(),
      knowledge: _list(knowledgePage['items'])
          .whereType<Map>()
          .map((e) => KnowledgeItem.fromJson(Map<String, dynamic>.from(e)))
          .toList(),
      nodes: _list(graphJson['nodes'])
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
      overview: overviewJson['overview'] is Map
          ? Map<String, dynamic>.from(overviewJson['overview'] as Map)
          : const {},
    );
  }

  @override
  Future<MemoryRecord> getMemory(String id) async {
    final response = await api.getJson(NativePaths.memoryGet(id));
    if (response['memory'] is! Map) {
      throw const FormatException('The selected memory is unavailable.');
    }
    return MemoryRecord.fromJson(
      Map<String, dynamic>.from(response['memory'] as Map),
    );
  }

  @override
  Future<void> addMemory(Json input) async =>
      api.postJson(NativePaths.memoryCreate, data: input);
  @override
  Future<void> correctMemory(String id, Json input) async =>
      api.patchJson(NativePaths.memoryUpdate(id), data: input);
  @override
  Future<MemoryForgetPreview> previewForgetMemory(String id) async {
    final response = await api.getJson(
      NativePaths.memoryGet(id),
      query: {'view': 'deletion-preview'},
    );
    final preview = response['preview'];
    if (preview is! Map) {
      throw const FormatException(
        'The deletion impact preview is unavailable.',
      );
    }
    final result = MemoryForgetPreview.fromJson(
      Map<String, dynamic>.from(preview),
    );
    if (result.expectedReceiptManifestSha256.isEmpty) {
      throw const FormatException('The deletion impact preview is incomplete.');
    }
    return result;
  }

  @override
  Future<void> forgetMemory(String id, String expectedManifestSha256) async {
    await api.deleteJson(
      NativePaths.memoryDelete(id),
      headers: {'x-asael-deletion-preview': expectedManifestSha256},
    );
  }

  @override
  Future<void> rebuildGraph() async =>
      api.postJson(NativePaths.memoryGraphRebuild, data: {'source': 'flutter'});
  @override
  Future<void> deleteConnectedSource(String source) async => api.deleteJson(
    NativePaths.knowledgeSourceDelete,
    query: {'source': source},
  );
}
