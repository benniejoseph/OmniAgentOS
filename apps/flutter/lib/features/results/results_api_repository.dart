import 'dart:typed_data';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
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

class ApiResultsRepository
    implements
        ResultsRepository,
        ProgressiveResultsRepository,
        GeneratedArtifactResultsRepository {
  const ApiResultsRepository(this.api);
  final ApiClient api;
  @override
  Future<ResultsSnapshot> list() async {
    final primary = await listPrimary();
    final generated = await listGeneratedArtifacts();
    return ResultsSnapshot(
      items: primary.items,
      evaluations: primary.evaluations,
      sourceErrors: [
        ...primary.sourceErrors,
        if (generated.sourceError != null) generated.sourceError!,
      ],
      createdFiles: generated.files,
    );
  }

  @override
  Future<ResultsSnapshot> listPrimary() async {
    final responses = await Future.wait([
      api.getJson(
        NativePaths.workspaceSummary,
        query: {'limit': 12, 'approvalLimit': 12},
      ),
      api.getJson(NativePaths.evaluationsList, query: {'limit': 8}),
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
  Future<GeneratedArtifactsSnapshot> listGeneratedArtifacts() async {
    final artifactResponse = await _loadGeneratedArtifacts();
    if (artifactResponse.error != null) {
      return const GeneratedArtifactsSnapshot(
        files: [],
        sourceError: 'created files unavailable',
      );
    }
    final rawArtifacts = artifactResponse.value?['artifacts'];
    if (rawArtifacts is! List) {
      return const GeneratedArtifactsSnapshot(
        files: [],
        sourceError: 'created files unavailable',
      );
    }
    final seen = <String>{};
    final createdFiles = <GeneratedArtifactSummary>[];
    for (final raw in rawArtifacts.take(50)) {
      final artifact = GeneratedArtifactSummary.tryParse(raw);
      if (artifact != null && seen.add(artifact.id)) {
        createdFiles.add(artifact);
      }
    }
    createdFiles.sort(
      (left, right) => right.updatedAt.compareTo(left.updatedAt),
    );
    return GeneratedArtifactsSnapshot(files: List.unmodifiable(createdFiles));
  }

  Future<({Map<String, dynamic>? value, Object? error})>
  _loadGeneratedArtifacts() async {
    try {
      return (
        value: await api.getJson(NativePaths.artifactsList(limit: 50)),
        error: null,
      );
    } catch (error) {
      return (value: null, error: error);
    }
  }

  @override
  Future<Uint8List> downloadGeneratedArtifact(
    GeneratedArtifactSummary artifact,
  ) async {
    if (!RegExp(r'^generated_artifact_[a-f0-9]{48}$').hasMatch(artifact.id) ||
        artifact.version < 1 ||
        artifact.version > 2_147_483_647 ||
        artifact.byteCount == null ||
        artifact.byteCount! < 1 ||
        artifact.byteCount! > 64 * 1024 * 1024 ||
        !artifact.ready) {
      throw StateError('This generated file is not ready to download.');
    }
    final bytes = await api.getBytes(
      NativePaths.artifactsContent(artifact.id, version: artifact.version),
      maximumBytes: artifact.byteCount!,
    );
    if (bytes.length != artifact.byteCount) {
      throw const FormatException(
        'The generated file did not match its verified metadata.',
      );
    }
    return bytes;
  }

  @override
  Future<ResultItem?> detail(String key) async {
    if (key.startsWith('agent:')) {
      final j = await api.getJson(NativePaths.evidenceRun(key.substring(6)));
      return j['run'] is Map
          ? ResultItem.agent(Map<String, dynamic>.from(j['run'] as Map))
          : null;
    }
    if (key.startsWith('workflow:')) {
      final j = await api.getJson(
        NativePaths.evidenceWorkflow(key.substring(9)),
      );
      return j['run'] is Map
          ? ResultItem.workflow(Map<String, dynamic>.from(j['run'] as Map))
          : null;
    }
    return null;
  }

  @override
  Future<void> cancel(String runId) async {
    await api.deleteJson(
      NativePaths.evidenceRunCancel(runId),
      headers: {
        'idempotency-key':
            'evidence-cancel-$runId-${DateTime.now().microsecondsSinceEpoch}',
      },
    );
  }
}
