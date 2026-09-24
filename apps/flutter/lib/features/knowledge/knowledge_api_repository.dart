import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'knowledge.dart';

class ApiKnowledgeRepository implements KnowledgeRepository {
  const ApiKnowledgeRepository(this.api);
  final ApiClient api;
  List<dynamic> _list(Object? value) => value is List ? value : const [];

  @override
  Future<KnowledgeState> load({String query = '', String type = 'all'}) async {
    final response = await api.getJson(
      NativePaths.memoryIntelligenceGet,
      query: {
        'view': 'workspace',
        if (query.isNotEmpty) 'q': query,
        'limit': 100,
      },
    );
    final graphJson = response['graph'] is Map
        ? Map<String, dynamic>.from(response['graph'] as Map)
        : const <String, dynamic>{};
    final memoryPage = response['memory'] is Map
        ? Map<String, dynamic>.from(response['memory'] as Map)
        : const <String, dynamic>{};
    final knowledgePage = response['knowledge'] is Map
        ? Map<String, dynamic>.from(response['knowledge'] as Map)
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
      overview: response['overview'] is Map
          ? Map<String, dynamic>.from(response['overview'] as Map)
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
  Future<void> addMemory(Json input) => Future.error(
    UnsupportedError(
      'Memory mutations are not published by native contract v8.',
    ),
  );
  @override
  Future<void> correctMemory(String id, Json input) => Future.error(
    UnsupportedError(
      'Memory mutations are not published by native contract v8.',
    ),
  );
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
    throw UnsupportedError(
      'Memory mutations are not published by native contract v8.',
    );
  }

  @override
  Future<void> rebuildGraph() => Future.error(
    UnsupportedError('Graph rebuild is not published by native contract v8.'),
  );
  @override
  Future<void> deleteConnectedSource(String source) => Future.error(
    UnsupportedError(
      'Knowledge source deletion is not published by native contract v8.',
    ),
  );
}
