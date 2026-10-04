import 'package:dio/dio.dart';

import 'result_contracts.dart';
import 'results.dart';

abstract interface class ScopedResultsRepository {
  ResultsAccess get access;
}

abstract interface class FreshResultDetailRepository {
  Future<ResultItem?> detailFresh(
    String key,
    CancelToken cancel, {
    String? approvalKind,
  });
}

/// Each read owns a separate source window. Optional failures must not hide a
/// successful run read or turn unavailable data into an empty collection.
abstract interface class FreshResultsRepository {
  Future<ResultsReadPart> readWork(CancelToken cancel);
  Future<ResultsReadPart> readEvaluations(CancelToken cancel);
  Future<ResultsReadPart> readCreatedFiles(CancelToken cancel);
}

class ResultsReadPart {
  const ResultsReadPart({
    required this.reads,
    this.items = const [],
    this.evaluations = const [],
    this.files = const [],
  });
  final Map<ResultsSource, ResultsRead> reads;
  final List<ResultItem> items;
  final List<EvaluationResult> evaluations;
  final List<GeneratedArtifactSummary> files;
}

abstract interface class ConfirmedResultsCancellationRepository {
  Future<ResultCancelReceipt> cancelConfirmed(String runId);
}

class ResultCancelReceipt {
  const ResultCancelReceipt({
    required this.runId,
    this.returnedRun,
    this.canceledJobs,
  });
  final String runId;
  final ResultItem? returnedRun;
  final int? canceledJobs;
  String get message => returnedRun == null
      ? 'The cancellation request returned. Refresh to check the stored run status.'
      : returnedRun!.status == 'canceled'
      ? 'Cancellation confirmed. Completed tool actions are not undone.'
      : 'The returned run was already ${returnedRun!.status}. Cancellation did not change that stored outcome.';
}

ResultsAccess? resultsAccess(ResultsRepository repository) =>
    repository is ScopedResultsRepository
    ? (repository as ScopedResultsRepository).access
    : null;
