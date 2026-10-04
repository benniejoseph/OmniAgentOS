import 'dart:math';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'result_contracts.dart';
import 'result_detail_controller.dart';
import 'results.dart';
import 'results_repository_contracts.dart';

class ApiResultsRepository
    implements
        ResultsRepository,
        ProgressiveResultsRepository,
        GeneratedArtifactResultsRepository,
        ScopedResultsRepository,
        FreshResultsRepository,
        FreshResultDetailRepository,
        ConfirmedResultsCancellationRepository {
  ApiResultsRepository(this.api, {ResultsAccess? access})
    : access = access ?? ResultsAccess(deployment: 'unbound', ready: false) {
    _owner = this.access.owner;
    _scope = this.access.scope;
    this.access.addListener(_changed);
  }
  final ApiClient api;
  @override
  final ResultsAccess access;
  final Map<String, ResultItem> _seen = {};
  final Map<String, String> _uncertain = {};
  final Map<String, String> _terminalFloor = {};
  final Map<String, int> _detailEpoch = {};
  late String _owner, _scope;
  bool _disposed = false, _acting = false;
  void _changed() {
    if (_owner != access.owner || access.closed) {
      _owner = access.owner;
      _uncertain.clear();
    }
    if (_scope != access.scope || access.closed) {
      _scope = access.scope;
      _seen.clear();
      _terminalFloor.clear();
      _detailEpoch.clear();
    }
    if (!access.readable) {
      _seen.clear();
    }
  }

  void dispose() {
    _disposed = true;
    access.removeListener(_changed);
    _seen.clear();
    _uncertain.clear();
    _terminalFloor.clear();
  }

  void _readable() {
    if (_disposed ||
        !access.readable ||
        access.tenantId?.isNotEmpty != true ||
        access.actorId?.isNotEmpty != true) {
      throw StateError('Results access is unavailable. Sign in and refresh.');
    }
  }

  bool _current(int generation) =>
      !_disposed && access.readable && generation == access.generation;
  void _tenant(Map<String, dynamic> value) {
    resultRequire(
      access.tenantId != null && value['tenantId'] == access.tenantId,
      'The returned Results tenant did not match this session.',
    );
  }

  ResultsRead _ready({int omitted = 0, DateTime? at}) => ResultsRead(
    state: omitted == 0
        ? ResultsAvailability.ready
        : ResultsAvailability.partial,
    loaded: true,
    omitted: omitted,
    checkedAt: at ?? DateTime.now().toUtc(),
  );
  Future<ResultsReadPart> _safe(
    Future<ResultsReadPart> Function() load,
    List<ResultsSource> sources,
  ) async {
    try {
      return await load();
    } catch (error) {
      return ResultsReadPart(
        reads: {
          for (final source in sources)
            source: ResultsRead(
              state: resultAccessDenied(error)
                  ? ResultsAvailability.restricted
                  : ResultsAvailability.unavailable,
              error: resultFailure(error),
            ),
        },
      );
    }
  }

  @override
  Future<ResultsReadPart> readWork(CancelToken cancel) async {
    _readable();
    final generation = access.generation;
    final response = await api.getJsonFreshCancelable(
      NativePaths.workspaceSummary,
      query: {'limit': 12, 'approvalLimit': 12},
      cancelToken: cancel,
    );
    resultRequire(
      _current(generation),
      'Results access changed during the read.',
    );
    final summary = resultRecord(response['summary']);
    _tenant(summary);
    final at = resultDate(summary['generatedAt']),
        sources = resultRecord(summary['sources']);
    final items = <ResultItem>[], reads = <ResultsSource, ResultsRead>{};
    for (final pair in [
      (ResultsSource.runs, 'runs', ResultItem.agent),
      (ResultsSource.workflows, 'workflows', ResultItem.workflow),
      (ResultsSource.approvals, 'approvals', ResultItem.approval),
    ]) {
      try {
        final source = resultRecord(sources[pair.$2]);
        final state = resultMember(source['status'], [
          'ready',
          'restricted',
          'error',
        ]);
        if (state != 'ready') {
          reads[pair.$1] = ResultsRead(
            state: state == 'restricted'
                ? ResultsAvailability.restricted
                : ResultsAvailability.unavailable,
            error:
                resultOptionalText(source['error']) ??
                'This source is unavailable.',
          );
          continue;
        }
        final data = source['data'];
        resultRequire(data is List && data.length <= 12);
        var omitted = 0;
        final seen = <String>{};
        for (final raw in data as List) {
          try {
            final item = pair.$3(resultRecord(raw));
            final identity = '${item.key}:${item.approvalKind ?? ''}';
            if (!seen.add(identity)) {
              final index = items.indexWhere(
                (existing) =>
                    '${existing.key}:${existing.approvalKind ?? ''}' ==
                    identity,
              );
              if (index >= 0) {
                items.removeAt(index);
                omitted++;
              }
              throw const FormatException(
                'Conflicting duplicate result identity.',
              );
            }
            items.add(item);
          } catch (_) {
            omitted++;
          }
        }
        reads[pair.$1] = _ready(omitted: omitted, at: at);
      } catch (error) {
        reads[pair.$1] = ResultsRead(
          state: ResultsAvailability.unavailable,
          error: resultFailure(error),
        );
      }
    }
    return ResultsReadPart(reads: reads, items: List.unmodifiable(items));
  }

  @override
  Future<ResultsReadPart> readEvaluations(CancelToken cancel) async {
    _readable();
    final generation = access.generation;
    final response = await api.getJsonFreshCancelable(
      NativePaths.evaluationsList,
      query: {'limit': 8},
      cancelToken: cancel,
    );
    resultRequire(_current(generation));
    final rows = response['runs'];
    resultRequire(rows is List && rows.length <= 8);
    final values = <EvaluationResult>[], seen = <String>{};
    var omitted = 0;
    for (final row in rows as List) {
      try {
        final value = EvaluationResult.fromJson(resultRecord(row));
        if (!seen.add(value.id)) {
          final index = values.indexWhere((item) => item.id == value.id);
          if (index >= 0) {
            values.removeAt(index);
            omitted++;
          }
          throw const FormatException('Duplicate evaluation identity.');
        }
        values.add(value);
      } catch (_) {
        omitted++;
      }
    }
    return ResultsReadPart(
      reads: {ResultsSource.evaluations: _ready(omitted: omitted)},
      evaluations: List.unmodifiable(values),
    );
  }

  @override
  Future<ResultsReadPart> readCreatedFiles(CancelToken cancel) async {
    _readable();
    final generation = access.generation;
    final response = await api.getJsonFreshCancelable(
      NativePaths.artifactsList(limit: 50),
      cancelToken: cancel,
    );
    resultRequire(_current(generation));
    final rows = response['artifacts'];
    resultRequire(rows is List && rows.length <= 50);
    final values = <GeneratedArtifactSummary>[], seen = <String>{};
    var omitted = 0;
    for (final row in rows as List) {
      final value = GeneratedArtifactSummary.tryParse(row);
      if (value == null) {
        omitted++;
      } else if (!seen.add(value.id)) {
        final index = values.indexWhere((item) => item.id == value.id);
        if (index >= 0) {
          values.removeAt(index);
          omitted++;
        }
        omitted++;
      } else {
        values.add(value);
      }
    }
    values.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return ResultsReadPart(
      reads: {ResultsSource.createdFiles: _ready(omitted: omitted)},
      files: List.unmodifiable(values),
    );
  }

  ResultsSnapshot _snapshot(List<ResultsReadPart> parts) => ResultsSnapshot(
    items: [for (final part in parts) ...part.items],
    evaluations: [for (final part in parts) ...part.evaluations],
    createdFiles: [for (final part in parts) ...part.files],
    sourceErrors: [
      for (final part in parts)
        for (final entry in part.reads.entries)
          if (entry.value.error != null)
            '${resultsSourceLabel(entry.key)}: ${entry.value.error}'
          else if (entry.value.omitted > 0)
            '${resultsSourceLabel(entry.key)}: ${entry.value.omitted} invalid or duplicate records omitted.',
    ],
  );
  @override
  Future<ResultsSnapshot> list() async => _snapshot(
    await Future.wait([
      _safe(() => readWork(CancelToken()), const [
        ResultsSource.runs,
        ResultsSource.workflows,
        ResultsSource.approvals,
      ]),
      _safe(() => readEvaluations(CancelToken()), const [
        ResultsSource.evaluations,
      ]),
      _safe(() => readCreatedFiles(CancelToken()), const [
        ResultsSource.createdFiles,
      ]),
    ]),
  );
  @override
  Future<ResultsSnapshot> listPrimary() async => _snapshot(
    await Future.wait([
      _safe(() => readWork(CancelToken()), const [
        ResultsSource.runs,
        ResultsSource.workflows,
        ResultsSource.approvals,
      ]),
      _safe(() => readEvaluations(CancelToken()), const [
        ResultsSource.evaluations,
      ]),
    ]),
  );
  @override
  Future<GeneratedArtifactsSnapshot> listGeneratedArtifacts() async {
    final part = await _safe(() => readCreatedFiles(CancelToken()), const [
      ResultsSource.createdFiles,
    ]);
    return GeneratedArtifactsSnapshot(
      files: part.files,
      sourceError: part.reads[ResultsSource.createdFiles]?.error,
    );
  }

  @override
  Future<ResultItem?> detail(String key) => detailFresh(key, CancelToken());
  @override
  Future<ResultItem?> detailFresh(
    String value,
    CancelToken cancel, {
    String? approvalKind,
  }) async {
    _readable();
    final key = ResultKey.parse(value), generation = access.generation;
    final epoch = (_detailEpoch[value] ?? 0) + 1;
    _detailEpoch[value] = epoch;
    _seen.remove(value);
    if (key.kind == 'approval') {
      if (!const ['tool', 'workflow', 'slo_policy'].contains(approvalKind)) {
        throw StateError(
          'This approval link does not include its exact kind. Open Inbox to select the current request.',
        );
      }
      final response = await api.getJsonFreshCancelable(
        NativePaths.approvalsList,
        query: {'id': key.id, 'kind': approvalKind},
        cancelToken: cancel,
      );
      resultRequire(_current(generation));
      if (response['item'] == null) {
        return null;
      }
      final item = ResultItem.approval(resultRecord(response['item']));
      resultRequire(
        item.key == value && item.approvalKind == approvalKind,
        'The returned approval did not match its exact identity and kind.',
      );
      return item;
    }
    final response = await api.getJsonFreshCancelable(
      key.kind == 'agent'
          ? NativePaths.evidenceRun(key.id)
          : NativePaths.evidenceWorkflow(key.id),
      cancelToken: cancel,
    );
    resultRequire(
      _current(generation) &&
          !cancel.isCancelled &&
          _detailEpoch[value] == epoch,
    );
    final run = resultRecord(response['run']);
    _tenant(run);
    final enriched = {
      ...run,
      for (final field in [
        'agentIdentity',
        'contextReceipt',
        'steps',
        'serviceReceipt',
        'fileArtifactState',
        'fileArtifacts',
        'workspaceArtifactState',
        'workspaceArtifacts',
        'mediaArtifacts',
        'plan',
        'execution',
      ])
        if (response[field] != null) field: response[field],
    };
    final item = key.kind == 'agent'
        ? ResultItem.agent(enriched)
        : ResultItem.workflow(enriched);
    resultRequire(
      item.key == value,
      'The returned result did not match the exact requested key.',
    );
    final floor = _terminalFloor[value];
    resultRequire(
      floor == null || item.status == floor,
      'This read predates a confirmed terminal response. Last-loaded output is retained.',
    );
    if (key.kind == 'agent' &&
        const ['canceled', 'completed', 'failed'].contains(item.status)) {
      // A current exact terminal read closes a lost cancellation admission. It
      // does not prove DELETE was accepted, or produce a cancellation receipt.
      _uncertain.remove(key.id);
      _terminalFloor[value] = item.status;
    }
    _seen[value] = item;
    return item;
  }

  @override
  Future<void> cancel(String runId) async {
    await cancelConfirmed(runId);
  }

  @override
  Future<ResultCancelReceipt> cancelConfirmed(String runId) async {
    _readable();
    final key = ResultKey.parse('agent:$runId');
    if (_acting ||
        !access.writable ||
        !NativeContract.supportsOperation('evidence.run.cancel')) {
      throw StateError(
        'Run cancellation requires operator permission, a supported native capability, and no pending action.',
      );
    }
    if (_seen[key.value]?.canCancel != true) {
      throw StateError(
        'Refresh this exact active run before requesting cancellation.',
      );
    }
    if (!_uncertain.containsKey(runId) && _uncertain.length >= 30) {
      throw StateError(
        'There are 30 unconfirmed cancellation requests. Retry an existing request before starting another.',
      );
    }
    final idempotency = _uncertain.putIfAbsent(
      runId,
      () =>
          'results-cancel-${List.generate(24, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}',
    );
    final generation = access.generation;
    _acting = true;
    _seen.remove(key.value);
    _detailEpoch[key.value] = (_detailEpoch[key.value] ?? 0) + 1;
    try {
      final response = await api.deleteJson(
        NativePaths.evidenceRunCancel(runId),
        headers: {'idempotency-key': idempotency},
      );
      final run = resultRecord(response['run']);
      _tenant(run);
      final item = ResultItem.agent(run),
          jobs = resultCount(response['canceledJobs']);
      resultRequire(
        item.key == key.value &&
            const ['canceled', 'completed', 'failed'].contains(item.status),
        'The cancellation response did not confirm this exact terminal run.',
      );
      resultRequire(
        _current(generation),
        'Results access changed before the response was confirmed.',
      );
      _uncertain.remove(runId);
      _terminalFloor[key.value] = item.status;
      _seen[key.value] = item;
      return ResultCancelReceipt(
        runId: runId,
        returnedRun: item,
        canceledJobs: jobs,
      );
    } finally {
      _acting = false;
    }
  }

  @override
  Future<Uint8List> downloadGeneratedArtifact(
    GeneratedArtifactSummary artifact,
  ) async {
    _readable();
    final generation = access.generation;
    resultRequire(
      RegExp(r'^generated_artifact_[a-f0-9]{48}$').hasMatch(artifact.id) &&
          artifact.version > 0 &&
          artifact.version <= 2147483647 &&
          artifact.ready &&
          artifact.byteCount! > 0 &&
          artifact.byteCount! <= 64 * 1024 * 1024,
      'This exact created file is not ready to save.',
    );
    final bytes = await api.getBytes(
      NativePaths.artifactsContent(artifact.id, version: artifact.version),
      maximumBytes: artifact.byteCount!,
    );
    resultRequire(
      _current(generation),
      'Results access changed while the file was loading.',
    );
    resultRequire(
      bytes.length == artifact.byteCount,
      'The generated file did not match its exact version metadata.',
    );
    return bytes;
  }
}
