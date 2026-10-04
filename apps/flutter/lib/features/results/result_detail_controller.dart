import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'result_contracts.dart';
import 'results.dart';
import 'results_repository_contracts.dart';

String resultFailure(Object error) => error is ApiException
    ? error.message
    : error is FormatException
    ? error.message
    : error is StateError
    ? error.message.toString()
    : 'Results could not be checked. Refresh and try again.';
bool resultAccessDenied(Object error) =>
    error is ApiException && const [401, 403].contains(error.statusCode);

class ResultDetailController extends ChangeNotifier {
  ResultDetailController(this.repository, this.keyValue, {this.approvalKind}) {
    _scope = access?.scope;
    access?.addListener(_authorityChanged);
  }
  final ResultsRepository repository;
  final String keyValue;
  final String? approvalKind;
  ResultsAccess? get access => resultsAccess(repository);
  ResultItem? item;
  ResultCancelReceipt? receipt;
  bool loading = false, fresh = false, missing = false, canceling = false;
  String? readError, actionError;
  String? _scope;
  String? _confirmedTerminal;
  bool _disposed = false;
  int _generation = 0;
  int get generation => _generation;
  CancelToken? _read;
  bool get readable => !_disposed && (access?.readable ?? true);
  bool get canCancel =>
      readable &&
      fresh &&
      !loading &&
      !canceling &&
      (access?.writable ?? true) &&
      item?.canCancel == true;
  String? get cancelBlocked => !readable
      ? 'Results access is unavailable.'
      : access != null && !access!.writable
      ? 'Operator permission and the native cancellation capability are required.'
      : canceling
      ? 'A cancellation request is pending.'
      : !fresh || loading
      ? 'Refresh this exact result before requesting cancellation.'
      : item?.canCancel != true
      ? 'This stored state does not offer run cancellation.'
      : null;
  String get version => item == null
      ? ''
      : jsonEncode([
          item!.key,
          item!.status,
          item!.timestamp?.toIso8601String(),
          item!.body,
          item!.meta,
          item!.groundingStatus,
          item!.evidence,
          item!.metadata,
          item!.canonical?.status,
        ]);
  String get readLabel => loading
      ? item == null
            ? 'Loading exact result…'
            : 'Refreshing exact result · last-loaded output is retained.'
      : !readable
      ? 'Results access is unavailable.'
      : readError != null
      ? item == null
            ? 'This result could not be checked.'
            : 'Refresh unavailable · last-loaded output is shown.'
      : missing
      ? 'This exact result was not returned by the authorized read.'
      : fresh
      ? 'Current exact result read'
      : 'This result has not been checked.';
  void _authorityChanged() {
    _generation++;
    _read?.cancel('Results authority changed');
    loading = fresh = canceling = false;
    if (_scope != access?.scope || access?.closed == true) {
      _scope = access?.scope;
      item = null;
      receipt = null;
      missing = false;
      readError = actionError = null;
      _confirmedTerminal = null;
    }
    if (!_disposed) {
      notifyListeners();
    }
    if (readable) {
      unawaited(refresh());
    }
  }

  Future<void> refresh() async {
    if (!readable || canceling) {
      return;
    }
    final generation = ++_generation;
    _read?.cancel('Exact result read replaced');
    final cancel = _read = CancelToken();
    loading = true;
    fresh = false;
    readError = null;
    notifyListeners();
    bool current() =>
        readable && generation == _generation && !cancel.isCancelled;
    try {
      final key = ResultKey.parse(keyValue);
      if (key.kind == 'approval' &&
          !const ['tool', 'workflow', 'slo_policy'].contains(approvalKind)) {
        throw StateError(
          'This approval link does not include its exact kind. Open Inbox to select the current request.',
        );
      }
      final source = repository;
      final value = source is FreshResultDetailRepository
          ? await (source as FreshResultDetailRepository).detailFresh(
              keyValue,
              cancel,
              approvalKind: approvalKind,
            )
          : await source.detail(keyValue);
      resultRequire(
        value == null || value.key == keyValue && value.kind.name == key.kind,
        'The returned result did not match the exact requested key.',
      );
      resultRequire(
        value == null ||
            key.kind != 'approval' ||
            value.approvalKind == approvalKind,
        'The returned approval did not match the exact requested kind.',
      );
      resultRequire(
        value == null ||
            _confirmedTerminal == null ||
            value.status == _confirmedTerminal,
        'This read predates the confirmed terminal response. Last-loaded output is retained.',
      );
      if (current()) {
        item = value;
        missing = value == null;
        fresh = true;
      }
    } catch (error) {
      if (current()) {
        readError = resultFailure(error);
        if (resultAccessDenied(error) ||
            error is ApiException && error.statusCode == 404) {
          item = null;
          receipt = null;
          missing = false;
        }
      }
    } finally {
      if (current()) {
        loading = false;
        notifyListeners();
      }
    }
  }

  Future<bool> cancelReviewed(String reviewedVersion) async {
    if (!canCancel) {
      actionError = cancelBlocked;
      if (!_disposed) {
        notifyListeners();
      }
      return false;
    }
    if (reviewedVersion != version) {
      actionError = 'The result changed while confirmation was open. Review its current state before requesting cancellation.';
      notifyListeners();
      return false;
    }
    final key = ResultKey.parse(keyValue);
    if (key.kind != 'agent') {
      return false;
    }
    final generation = ++_generation;
    _read?.cancel('Cancellation started');
    canceling = true;
    actionError = null;
    notifyListeners();
    bool current() => readable && generation == _generation;
    try {
      final source = repository;
      ResultCancelReceipt accepted;
      if (source is ConfirmedResultsCancellationRepository) {
        accepted = await (source as ConfirmedResultsCancellationRepository)
            .cancelConfirmed(key.id);
        resultRequire(
          accepted.runId == key.id &&
              accepted.returnedRun?.key == keyValue &&
              accepted.returnedRun?.kind == ResultKind.agent &&
              const [
                'canceled',
                'completed',
                'failed',
              ].contains(accepted.returnedRun?.status) &&
              accepted.canceledJobs != null &&
              accepted.canceledJobs! >= 0,
          'The cancellation response did not confirm this exact run.',
        );
      } else {
        await source.cancel(key.id);
        accepted = ResultCancelReceipt(runId: key.id);
      }
      if (!current()) {
        return false;
      }
      receipt = accepted;
      if (accepted.returnedRun != null) {
        item = accepted.returnedRun;
        _confirmedTerminal = accepted.returnedRun!.status;
      }
      canceling = false;
      fresh = false;
      notifyListeners();
      unawaited(refresh());
      return true;
    } catch (error) {
      if (current()) {
        actionError =
            '${resultFailure(error)} The requested outcome is unconfirmed. Refresh before retrying.';
        fresh = false;
      }
      return false;
    } finally {
      if (!_disposed && generation == _generation) {
        canceling = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _read?.cancel('Exact result closed');
    access?.removeListener(_authorityChanged);
    super.dispose();
  }
}
