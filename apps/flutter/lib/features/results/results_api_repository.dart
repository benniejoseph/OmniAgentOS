import '../../core/network/api_client.dart';
import 'results.dart';

String _value(Object? value, [String fallback = '']) =>
    value == null ? fallback : value.toString();
Map<String, dynamic> _record(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};
Object? _readPath(Object? source, String path) {
  Object? value = source;
  for (final key in path.split('.')) {
    value = _record(value)[key];
  }
  return value;
}

class ApiResultsRepository implements ResultsRepository {
  const ApiResultsRepository(this.api);
  final ApiClient api;
  @override
  Future<ResultsSnapshot> list() async {
    final responses = await Future.wait([
      api.getJson(
        '/api/workspace-summary',
        query: {'limit': 12, 'approvalLimit': 12},
      ),
      api.getJson('/api/evaluations', query: {'limit': 8}),
    ]);
    final summary = _record(responses[0]['summary']),
        items = <ResultItem>[],
        errors = <String>[];
    void source(String name, String key, ResultItem Function(Json) parse) {
      final src = _record(_readPath(summary, 'sources.$name'));
      if (src['status'] == 'ready') {
        for (final raw in (src['data'] as List? ?? const [])) {
          if (raw is Map) items.add(parse(Map<String, dynamic>.from(raw)));
        }
      } else {
        errors.add(_value(src['error'], '$name unavailable'));
      }
    }

    source('runs', 'runs', ResultItem.agent);
    source('workflows', 'runs', ResultItem.workflow);
    source('approvals', 'items', ResultItem.approval);
    final unique = <String, ResultItem>{};
    for (final i in items) {
      final old = unique[i.key];
      if (old == null ||
          (i.timestamp?.isAfter(
                old.timestamp ?? DateTime.fromMillisecondsSinceEpoch(0),
              ) ??
              false)) {
        unique[i.key] = i;
      }
    }
    final sorted = unique.values.toList()
      ..sort(
        (a, b) => (b.timestamp ?? DateTime.fromMillisecondsSinceEpoch(0))
            .compareTo(a.timestamp ?? DateTime.fromMillisecondsSinceEpoch(0)),
      );
    final evals = ((responses[1]['runs'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => EvaluationResult.fromJson(Map<String, dynamic>.from(e)))
        .toList();
    return ResultsSnapshot(
      items: sorted,
      evaluations: evals,
      sourceErrors: errors,
    );
  }

  @override
  Future<ResultItem?> detail(String key) async {
    if (key.startsWith('agent:')) {
      final j = await api.getJson(
        '/api/runs/${Uri.encodeComponent(key.substring(6))}',
      );
      return j['run'] is Map
          ? ResultItem.agent(Map<String, dynamic>.from(j['run'] as Map))
          : null;
    }
    if (key.startsWith('workflow:')) {
      final j = await api.getJson(
        '/api/workflows/${Uri.encodeComponent(key.substring(9))}',
      );
      return j['run'] is Map
          ? ResultItem.workflow(Map<String, dynamic>.from(j['run'] as Map))
          : null;
    }
    return null;
  }

  @override
  Future<void> cancel(String runId) async {
    await api.deleteJson('/api/runs/${Uri.encodeComponent(runId)}');
  }
}
