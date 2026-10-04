import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import 'result_contracts.dart';
import 'result_detail_controller.dart';
import 'results.dart' hide ResultsController;
import 'results_repository_contracts.dart';

class ResultsController extends ChangeNotifier {
  ResultsController(this.repository) {
    _scope = access?.scope;
    access?.addListener(_authorityChanged);
  }
  final ResultsRepository repository;
  ResultsAccess? get access => resultsAccess(repository);
  ResultsSnapshot? snapshot;
  final Map<ResultsSource, ResultsRead> reads = {};
  bool loading = false, downloading = false;
  Object? error;
  String query = '';
  ResultKind? kind;
  String? status, selectedKey;
  int page = 0;
  static const pageSize = 10;
  bool _disposed = false;
  int _generation = 0;
  String? _scope;
  CancelToken? _read;
  bool get readable => !_disposed && (access?.readable ?? true);
  int get generation => _generation;
  ResultsRead readFor(ResultsSource source) =>
      reads[source] ??
      (snapshot == null
          ? const ResultsRead()
          : ResultsRead(
              state: snapshot!.sourceErrors.isEmpty
                  ? ResultsAvailability.ready
                  : ResultsAvailability.partial,
              loaded: true,
            ));
  bool get workKnown => const [
    ResultsSource.runs,
    ResultsSource.workflows,
    ResultsSource.approvals,
  ].every((source) => readFor(source).loaded);
  bool get workFresh => const [
    ResultsSource.runs,
    ResultsSource.workflows,
    ResultsSource.approvals,
  ].every((source) => readFor(source).fresh);
  bool get workComplete => const [
    ResultsSource.runs,
    ResultsSource.workflows,
    ResultsSource.approvals,
  ].every((source) => readFor(source).state == ResultsAvailability.ready);
  void _authorityChanged() {
    _generation++;
    _read?.cancel('Results authority changed');
    loading = downloading = false;
    if (_scope != access?.scope || access?.closed == true) {
      _scope = access?.scope;
      snapshot = null;
      reads.clear();
      error = null;
      selectedKey = null;
      page = 0;
      query = '';
      kind = null;
      status = null;
    } else {
      for (final source in ResultsSource.values) {
        reads[source] = readFor(source)
            .failed('Results access is temporarily unavailable.');
      }
    }
    if (!_disposed) {
      notifyListeners();
    }
    if (readable) {
      unawaited(refresh());
    }
  }

  Future<void> refresh() async {
    if (!readable || downloading) {
      return;
    }
    final generation = ++_generation;
    _read?.cancel('Results refresh replaced');
    final cancel = _read = CancelToken();
    loading = true;
    error = null;
    for (final source in ResultsSource.values) {
      reads[source] = readFor(source).pending();
    }
    notifyListeners();
    bool current() =>
        readable && generation == _generation && !cancel.isCancelled;
    Future<void> part(
      List<ResultsSource> sources,
      Future<ResultsReadPart> Function() load,
    ) async {
      try {
        final value = await load();
        if (current()) {
          _merge(value);
          notifyListeners();
        }
      } catch (failure) {
        if (current()) {
          error = failure;
          _merge(
            ResultsReadPart(
              reads: {
                for (final source in sources)
                  source: readFor(source).failed(
                    resultFailure(failure),
                    restricted: resultAccessDenied(failure),
                  ),
              },
            ),
          );
          notifyListeners();
        }
      }
    }

    try {
      final source = repository;
      if (source is FreshResultsRepository) {
        final fresh = source as FreshResultsRepository;
        await Future.wait([
          part(const [
            ResultsSource.runs,
            ResultsSource.workflows,
            ResultsSource.approvals,
          ], () => fresh.readWork(cancel)),
          part(const [
            ResultsSource.evaluations,
          ], () => fresh.readEvaluations(cancel)),
          part(const [
            ResultsSource.createdFiles,
          ], () => fresh.readCreatedFiles(cancel)),
        ]);
      } else {
        final value = await source.list();
        if (current()) {
          snapshot = value;
          for (final source in ResultsSource.values) {
            reads[source] = ResultsRead(
              state: value.sourceErrors.isEmpty
                  ? ResultsAvailability.ready
                  : ResultsAvailability.partial,
              loaded: true,
            );
          }
        }
      }
    } catch (failure) {
      if (current()) {
        error = failure;
        _merge(
          ResultsReadPart(
            reads: {
              for (final source in ResultsSource.values)
                source: readFor(source).failed(
                  resultFailure(failure),
                  restricted: resultAccessDenied(failure),
                ),
            },
          ),
        );
      }
    } finally {
      if (current()) {
        loading = false;
        notifyListeners();
      }
    }
  }

  void _merge(ResultsReadPart part) {
    final old = snapshot;
    final items = <ResultItem>[...?old?.items];
    for (final entry in part.reads.entries) {
      var read = entry.value;
      if (!read.fresh && read.state != ResultsAvailability.restricted) {
        read = readFor(entry.key)
            .failed(read.error ?? 'This source could not be checked.');
      }
      reads[entry.key] = read;
      final kind = switch (entry.key) {
        ResultsSource.runs => ResultKind.agent,
        ResultsSource.workflows => ResultKind.workflow,
        ResultsSource.approvals => ResultKind.approval,
        _ => null,
      };
      if (kind != null &&
          (read.fresh || read.state == ResultsAvailability.restricted)) {
        items.removeWhere((item) => item.kind == kind);
        if (read.fresh) {
          items.addAll(part.items.where((item) => item.kind == kind));
        }
      }
    }
    items.sort((a, b) {
      final date = (b.timestamp ?? DateTime.fromMillisecondsSinceEpoch(0))
          .compareTo(a.timestamp ?? DateTime.fromMillisecondsSinceEpoch(0));
      return date == 0 ? a.key.compareTo(b.key) : date;
    });
    bool replaces(ResultsSource source) =>
        part.reads.containsKey(source) &&
        (readFor(source).fresh ||
            readFor(source).state == ResultsAvailability.restricted);
    snapshot = ResultsSnapshot(
      items: List.unmodifiable(items),
      evaluations: replaces(ResultsSource.evaluations)
          ? part.evaluations
          : old?.evaluations ?? const [],
      createdFiles: replaces(ResultsSource.createdFiles)
          ? part.files
          : old?.createdFiles ?? const [],
      sourceErrors: [
        for (final entry in reads.entries)
          if (entry.value.error != null)
            '${resultsSourceLabel(entry.key)}: ${entry.value.error}',
      ],
    );
    if (page >= pageCount) {
      page = pageCount - 1;
    }
  }

  void filter({
    String? search,
    ResultKind? resultKind,
    String? resultStatus,
    bool clearKind = false,
  }) {
    if (search != null) {
      query = search;
    }
    if (clearKind) {
      kind = null;
    } else if (resultKind != null) {
      kind = resultKind;
    }
    if (resultStatus != null) {
      status = resultStatus.isEmpty ? null : resultStatus;
    }
    page = 0;
    notifyListeners();
  }

  List<ResultItem> get filtered {
    final q = query.toLowerCase();
    return (snapshot?.items ?? const <ResultItem>[])
        .where(
          (item) =>
              (kind == null || item.kind == kind) &&
              (status == null || item.status == status) &&
              (q.isEmpty ||
                  [
                    item.key,
                    item.title,
                    item.body,
                    item.meta,
                    ...item.evidence,
                  ].any((text) => text.toLowerCase().contains(q))),
        )
        .toList();
  }

  int get pageCount =>
      ((filtered.length + pageSize - 1) ~/ pageSize).clamp(1, 1000000).toInt();
  List<ResultItem> get pageItems =>
      filtered.skip(page * pageSize).take(pageSize).toList();
  void movePage(int next) {
    if (next >= 0 && next < pageCount) {
      page = next;
      notifyListeners();
    }
  }

  void select(String key) {
    selectedKey = key;
    notifyListeners();
  }

  ResultItem? get selected {
    for (final item in snapshot?.items ?? const <ResultItem>[]) {
      if (item.selectionIdentity == selectedKey) {
        return item;
      }
    }
    return null;
  }

  bool fileCurrent(GeneratedArtifactSummary artifact) =>
      readable &&
      readFor(ResultsSource.createdFiles).fresh &&
      (snapshot?.createdFiles.any(
            (current) =>
                current.id == artifact.id &&
                current.version == artifact.version &&
                current.byteCount == artifact.byteCount &&
                current.filename == artifact.filename &&
                current.ready,
          ) ??
          false);
  Future<Uint8List> downloadCreatedFile(
    GeneratedArtifactSummary artifact,
  ) async {
    final source = repository;
    if (downloading ||
        source is! GeneratedArtifactResultsRepository ||
        !fileCurrent(artifact)) {
      throw StateError('Refresh this exact ready file before saving it.');
    }
    final generation = _generation;
    downloading = true;
    notifyListeners();
    try {
      final bytes = await (source as GeneratedArtifactResultsRepository)
          .downloadGeneratedArtifact(artifact);
      if (!readable || generation != _generation || !fileCurrent(artifact)) {
        throw StateError(
          'The file or Results access changed. This download was discarded.',
        );
      }
      return bytes;
    } finally {
      if (!_disposed && generation == _generation) {
        downloading = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _read?.cancel('Results closed');
    access?.removeListener(_authorityChanged);
    super.dispose();
  }
}
