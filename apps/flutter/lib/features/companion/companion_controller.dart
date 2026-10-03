import 'dart:async';
import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'companion_models.dart';

class CompanionWritePolicy {
  const CompanionWritePolicy({required this.active, required this.reason});
  final bool active;
  final String reason;
}

abstract interface class CompanionRepository {
  Future<CompanionResponse> read(CancelToken cancelToken);
  Future<CompanionWritePolicy> readPolicy(CancelToken cancelToken);
  Future<CompanionResponse> submit(CompanionSubmission submission);
  Future<({List<CompanionConversation> threads, int omitted})> conversations(
    CancelToken cancelToken,
  );
}

String newCompanionSubmissionKey() {
  final random = Random.secure();
  return 'companion-native:${List.generate(32, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
}

/// The provider owns one controller per deployment, tenant, actor and role.
/// Reads can be canceled; canceling the view never claims a PATCH was canceled.
class CompanionController extends ChangeNotifier {
  CompanionController(this.repository, {String Function()? createKey})
    : createKey = createKey ?? newCompanionSubmissionKey;
  final CompanionRepository repository;
  final String Function() createKey;
  CompanionResponse? current;
  CompanionPreferences? draft;
  int? draftRevision;
  CompanionReceipt? receipt;
  CompanionSubmission? submission;
  CompanionWritePolicy? policy;
  bool loading = false;
  bool writing = false;
  bool uncertain = false;
  bool disposed = false;
  bool loadingConversations = false;
  String? readError;
  String? writeError;
  String? conversationError;
  List<CompanionConversation>? threads;
  int omittedThreads = 0;
  int _readEpoch = 0;
  int _writeEpoch = 0;
  int _conversationEpoch = 0;
  CancelToken? _readCancel;
  CancelToken? _conversationCancel;

  bool get dirty =>
      draft != null && current != null && draft != current!.preferences;
  bool get staleRevision =>
      draftRevision != null &&
      current != null &&
      draftRevision != current!.revision;
  bool get canSubmit =>
      !disposed &&
      !writing &&
      submission == null &&
      current != null &&
      draft != null &&
      draftRevision != null &&
      draftRevision! < companionMaximumRevision &&
      !staleRevision &&
      policy?.active == true;
  bool get canRetry =>
      !disposed &&
      !writing &&
      submission != null &&
      uncertain &&
      policy?.active == true;

  void edit(CompanionPreferences value) {
    if (disposed || draft == null) return;
    CompanionPreferences.fromJson(value.toJson());
    draft = value;
    notifyListeners();
  }

  void discardDraft() {
    if (disposed || writing || submission != null || current == null) return;
    draft = current!.preferences;
    draftRevision = current!.revision;
    writeError = null;
    notifyListeners();
  }

  /// Explicit review of a newer snapshot retains the user's edited values.
  void reviewAgainstCurrent() {
    if (disposed || writing || submission != null || current == null) return;
    draftRevision = current!.revision;
    writeError = null;
    notifyListeners();
  }

  void _applyRead(CompanionResponse response) {
    final old = current;
    if (old != null && response.revision < old.revision) return;
    if (old != null &&
        response.revision == old.revision &&
        (response.preferences != old.preferences ||
            response.updatedAt != old.updatedAt)) {
      throw const FormatException(
        'Saved preferences changed without a confirmed revision.',
      );
    }
    final clean = draft == null || (submission == null && !dirty);
    current = response;
    if (clean) {
      draft = response.preferences;
      draftRevision = response.revision;
    }
  }

  Future<void> refresh() async {
    if (disposed || writing) return;
    final epoch = ++_readEpoch;
    _readCancel?.cancel();
    final cancel = _readCancel = CancelToken();
    loading = true;
    readError = null;
    // A previously granted enrollment is not authority while a new read runs.
    policy = null;
    notifyListeners();
    final policyFuture = repository
        .readPolicy(cancel)
        .then<CompanionWritePolicy?>(
          (value) => value,
          onError: (Object _) => const CompanionWritePolicy(
            active: false,
            reason: 'Native preference access could not be confirmed. Refresh to check again.',
          ),
        );
    try {
      final response = await repository.read(cancel);
      if (disposed || epoch != _readEpoch || writing) return;
      _applyRead(response);
    } catch (_) {
      if (disposed || epoch != _readEpoch || writing) return;
      readError = current == null
          ? 'Companion preferences are unavailable. Defaults below are a read-only preview.'
          : 'Refresh failed. Last-loaded preferences and your draft are retained.';
    } finally {
      final nextPolicy = await policyFuture;
      if (!disposed && epoch == _readEpoch && !writing) {
        policy = nextPolicy;
        loading = false;
        notifyListeners();
      }
    }
  }

  Future<void> save({bool reset = false}) async {
    if (!canSubmit) return;
    final frozen = CompanionSubmission(
      key: createKey(),
      expectedRevision: draftRevision!,
      draftAtStart: draft!,
      reset: reset,
    );
    submission = frozen;
    uncertain = false;
    await _send(frozen);
  }

  Future<void> retrySubmission() async {
    if (!canRetry) return;
    await _send(submission!);
  }

  Future<void> _send(CompanionSubmission frozen) async {
    if (disposed || writing || !identical(frozen, submission)) return;
    // Admission is synchronous, before any await. A second tap cannot write.
    writing = true;
    final epoch = ++_writeEpoch;
    final wasUncertain = uncertain;
    ++_readEpoch;
    _readCancel?.cancel();
    loading = false;
    writeError = null;
    notifyListeners();
    try {
      final response = await repository.submit(frozen);
      if (disposed || epoch != _writeEpoch || !identical(submission, frozen)) {
        return;
      }
      final accepted = response.receipt;
      if (accepted == null ||
          accepted.revision != frozen.expectedRevision + 1 ||
          accepted.preferences != frozen.submitted ||
          response.revision < accepted.revision) {
        throw const FormatException(
          'Submission receipt could not be verified.',
        );
      }
      // Keep a known newer snapshot and an older replay receipt independently.
      final newest = current == null || response.revision >= current!.revision
          ? response
          : current!;
      if (current != null &&
          response.revision == current!.revision &&
          (response.preferences != current!.preferences ||
              response.updatedAt != current!.updatedAt)) {
        throw const FormatException('Current snapshot could not be verified.');
      }
      final untouched = draft == frozen.draftAtStart;
      current = newest;
      receipt = accepted;
      submission = null;
      uncertain = false;
      if (newest.revision == accepted.revision) {
        if (untouched) draft = newest.preferences;
        draftRevision = newest.revision;
      }
    } catch (error) {
      if (disposed || epoch != _writeEpoch || !identical(submission, frozen)) {
        return;
      }
      // ApiClient deliberately does not expose Companion's top-level codes.
      // After uncertainty, even a refusal cannot disprove the earlier commit.
      final refused =
          !wasUncertain &&
          error is ApiException &&
          const {400, 403, 404, 409, 422}.contains(error.statusCode);
      if (refused) {
        submission = null;
        uncertain = false;
        writeError = error.statusCode == 409
            ? 'This change was refused. Refresh saved preferences, then review your retained draft before saving again.'
            : 'This preference change was refused. Your draft is retained; refresh access before trying again.';
        policy = null;
      } else {
        uncertain = true;
        writeError = 'Save is unconfirmed. The server may have accepted it. Retry this exact submission to reconcile its receipt; your draft is retained.';
      }
    } finally {
      if (!disposed && epoch == _writeEpoch) {
        writing = false;
        notifyListeners();
      }
    }
  }

  Future<void> loadConversations() async {
    if (disposed) return;
    final epoch = ++_conversationEpoch;
    _conversationCancel?.cancel();
    final cancel = _conversationCancel = CancelToken();
    loadingConversations = true;
    conversationError = null;
    notifyListeners();
    try {
      final result = await repository.conversations(cancel);
      if (disposed || epoch != _conversationEpoch) return;
      threads = result.threads;
      omittedThreads = result.omitted;
    } catch (_) {
      if (disposed || epoch != _conversationEpoch) return;
      conversationError = threads == null
          ? 'Owned conversations are unavailable.'
          : 'Refresh failed. Last-loaded conversation choices are retained.';
    } finally {
      if (!disposed && epoch == _conversationEpoch) {
        loadingConversations = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    disposed = true;
    ++_readEpoch;
    ++_writeEpoch;
    ++_conversationEpoch;
    _readCancel?.cancel();
    _conversationCancel?.cancel();
    super.dispose();
  }
}
