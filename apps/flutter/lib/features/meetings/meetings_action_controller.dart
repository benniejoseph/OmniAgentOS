import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'meetings.dart';
import 'meetings_access.dart';
import 'meetings_api_repository.dart';
import 'meetings_draft_store.dart';
import 'meetings_mutations.dart';
import 'meetings_validation.dart';

class MeetingActionController extends ChangeNotifier {
  MeetingActionController(this.repository, this.store, this.route) {
    repository.access.addListener(_accessChanged);
  }
  final MutatingMeetingsRepository repository;
  final MeetingDraftStore store;
  final String route;
  Json draft = const {};
  Json? recorded;
  MeetingSubmission? submitted;
  MeetingAcceptedReceipt? accepted;
  bool initialized = false,
      busy = false,
      uncertain = false,
      refreshing = false,
      needsRefresh = false,
      recoveryBlocked = false;
  String? error, storageError, refreshError;
  bool _disposed = false;
  bool _initializing = false;
  bool _settling = false;
  int _epoch = 0, _feedback = 0, _draftRevision = 0;
  Timer? _save;
  MeetingsOwner? get owner => repository.access.owner;
  bool get available => !_disposed && repository.authorityCurrent();
  bool supports(String action) =>
      available &&
      owner!.canManage &&
      repository.access.supports(meetingWriteOperations[action]!);
  bool get recovering => _initializing;
  bool get canReloadRecovery =>
      available && !busy && !_settling && !_initializing;
  bool get blocked =>
      busy ||
      uncertain ||
      recoveryBlocked ||
      _initializing ||
      _settling ||
      !initialized ||
      !available;
  String? disabledReason(String action) => !available
      ? 'Restore the current unlocked workspace session.'
      : !owner!.canManage
      ? 'An operator or administrator role is required.'
      : !supports(action)
      ? 'This Meeting action is not published for this native version.'
      : recoveryBlocked
      ? 'Reload the protected draft before another Meeting action.'
      : !initialized
      ? 'Loading the protected local draft.'
      : uncertain
      ? 'An earlier request has an unconfirmed outcome. Keep its exact identity until reconciled.'
      : busy || _settling || _initializing
      ? 'Another Meeting action is pending.'
      : null;
  void _accessChanged() {
    _epoch++;
    _feedback++;
    _save?.cancel();
    draft = const {};
    recorded = null;
    submitted = null;
    accepted = null;
    initialized = false;
    _initializing = false;
    _settling = false;
    recoveryBlocked = false;
    busy = false;
    uncertain = false;
    refreshing = false;
    needsRefresh = false;
    error = null;
    storageError = null;
    refreshError = null;
    if (!_disposed) {
      notifyListeners();
      if (available) {
        unawaited(initialize());
      }
    }
  }

  Future<void> initialize() async {
    if (!available || initialized || _initializing) {
      return;
    }
    await _readRecovery();
  }

  /// An explicit read adopts the latest protected draft. It never replays an
  /// effect; a restored request still requires its own supported manual retry.
  Future<void> reloadRecovery() async {
    if (!available || busy || _settling || _initializing) {
      return;
    }
    _save?.cancel();
    _save = null;
    await _readRecovery();
  }

  Json _receiptRecord(MeetingAcceptedReceipt receipt) => {
    'action': receipt.submitted.action,
    'targetId': receipt.targetId,
    'receiptSha256': receipt.receiptSha256,
    'key': receipt.submitted.key,
    'meetingRevisionId': receipt.meeting?.revisionId,
    'proposalId': receipt.commitment?.id,
    'resolutionSha256': receipt.commitment?.resolution?['resolutionSha256'],
    'workItemId': receipt.commitment?.resolution?['workItemId'],
    'draftId': receipt.commitment?.resolution?['draftId'],
    'draftState': receipt.draft?['state'],
  };

  Future<void> _readRecovery() async {
    _initializing = true;
    recoveryBlocked = true;
    final epoch = _epoch, binding = owner!;
    final priorPending = uncertain ? submitted : null;
    notifyListeners();
    try {
      final value = await store.read(binding, route);
      if (!_current(epoch, binding)) {
        return;
      }
      var loadedDraft = value == null
          ? <String, dynamic>{}
          : freezeMeeting(meetingMap(value['draft'])) as Json;
      var pending = value?['pending'] == null
          ? null
          : MeetingSubmission.restore(meetingMap(value!['pending']), binding);
      Json? record;
      if (value?['recorded'] != null) {
        record = meetingMap(value!['recorded']);
        meetingHash(record['receiptSha256']);
        meetingMember(record['action'], meetingWriteOperations.keys.toList());
        meetingId(record['targetId']);
        record = freezeMeeting(record) as Json;
      }
      if (priorPending != null &&
          (pending == null ||
              meetingCanonicalJson(priorPending.json) !=
                  meetingCanonicalJson(pending.json))) {
        // A newer local record cannot prove what happened to this window's
        // dispatched request. Do not overwrite either identity to enable work.
        throw const FormatException(
          'Protected recovery no longer contains this exact unconfirmed request.',
        );
      }
      final confirmed = accepted;
      if (pending != null &&
          confirmed != null &&
          meetingCanonicalJson(pending.json) ==
              meetingCanonicalJson(confirmed.submitted.json) &&
          await meetingSha(pending.json) ==
              await meetingSha(confirmed.submitted.json)) {
        // Revalidate the complete accepted receipt and exact frozen request,
        // not just a matching key or target, before settling local recovery.
        await MeetingAcceptedReceipt.parse(confirmed.raw, pending, binding);
        if (!_current(epoch, binding) || !identical(accepted, confirmed)) {
          return;
        }
        if (draft['savedReceipt'] == confirmed.receiptSha256) {
          final savedDraft = {...draft}..remove('savedReceipt');
          if (meetingCanonicalJson(savedDraft) ==
              meetingCanonicalJson(loadedDraft)) {
            loadedDraft = {
              ...loadedDraft,
              'savedReceipt': confirmed.receiptSha256,
            };
          }
        }
        record = _receiptRecord(confirmed);
        await store.write(
          binding,
          route,
          {'draft': loadedDraft, 'pending': null, 'recorded': record},
          isCurrent: () =>
              _current(epoch, binding) && identical(accepted, confirmed),
        );
        pending = null;
      }
      if (!_current(epoch, binding)) {
        return;
      }
      draft = loadedDraft;
      _draftRevision++;
      submitted = pending;
      uncertain = pending != null;
      recorded = record;
      storageError = null;
      recoveryBlocked = false;
      initialized = true;
      error = null;
    } catch (_) {
      if (_current(epoch, binding)) {
        storageError = priorPending == null
            ? 'The protected draft could not be restored. Confirmed receipts remain visible; no Meeting request will be sent until recovery succeeds.'
            : 'The protected record could not safely restore this exact unconfirmed request. Its identity remains visible, and further writes are held.';
      }
    }
    if (_current(epoch, binding)) {
      _initializing = false;
      notifyListeners();
    }
  }

  bool _current(int epoch, MeetingsOwner binding) =>
      !_disposed && epoch == _epoch && available && owner?.key == binding.key;
  Json _payload() => {
    'draft': draft,
    'pending': uncertain || busy ? submitted?.json : null,
    'recorded': recorded,
  };
  Future<void> _persist(int epoch, MeetingsOwner binding) async {
    if (recoveryBlocked) {
      throw StateError('Reload protected Meeting recovery first.');
    }
    await store.write(
      binding,
      route,
      _payload(),
      isCurrent: () => _current(epoch, binding),
    );
  }

  void _holdRecovery(String message) {
    recoveryBlocked = true;
    _save?.cancel();
    _save = null;
    storageError = message;
  }

  void updateDraft(Json value) {
    if (!initialized || !available || _initializing) {
      return;
    }
    draft = freezeMeeting(value) as Json;
    _draftRevision++;
    _save?.cancel();
    final epoch = _epoch, binding = owner!;
    if (!recoveryBlocked) {
      _save = Timer(const Duration(milliseconds: 350), () {
        _save = null;
        unawaited(_saveDraft(epoch, binding));
      });
    }
    notifyListeners();
  }

  Future<void> _saveDraft(int epoch, MeetingsOwner binding) async {
    if (recoveryBlocked || _initializing || !_current(epoch, binding)) {
      return;
    }
    try {
      await _persist(epoch, binding);
      if (_current(epoch, binding) && !recoveryBlocked) {
        storageError = null;
        notifyListeners();
      }
    } catch (_) {
      if (_current(epoch, binding)) {
        _holdRecovery(
          'This draft has not been confirmed in protected storage. Reload the protected draft before another Meeting action.',
        );
        notifyListeners();
      }
    }
  }

  Future<void> flushDraft() async {
    _save?.cancel();
    _save = null;
    if (available && initialized && !recoveryBlocked && !_initializing) {
      await _saveDraft(_epoch, owner!);
    }
  }

  Future<bool> submit(
    MeetingSubmission frozen, {
    required Future<bool> Function() refresh,
  }) async {
    if (blocked || !supports(frozen.action) || frozen.ownerKey != owner?.key) {
      return false;
    }
    return _send(frozen, refresh: refresh, wasUncertain: false);
  }

  Future<bool> retry({required Future<bool> Function() refresh}) async {
    final frozen = submitted;
    if (busy ||
        recoveryBlocked ||
        _initializing ||
        _settling ||
        !initialized ||
        !uncertain ||
        frozen == null ||
        !frozen.replaySupported ||
        !supports(frozen.action) ||
        frozen.ownerKey != owner?.key) {
      return false;
    }
    return _send(frozen, refresh: refresh, wasUncertain: true);
  }

  Future<bool> _send(
    MeetingSubmission frozen, {
    required Future<bool> Function() refresh,
    required bool wasUncertain,
  }) async {
    // Synchronous admission prevents cross-button overlap before storage/network.
    busy = true;
    submitted = frozen;
    error = null;
    _save?.cancel();
    final epoch = _epoch,
        binding = owner!,
        draftRevision = _draftRevision,
        feedback = ++_feedback;
    bool current() => _current(epoch, binding) && identical(submitted, frozen);
    notifyListeners();
    var sent = false;
    try {
      // Durably record uncertainty before dispatch. A restart never silently
      // creates a different key or queues automatic effect replay.
      uncertain = true;
      await _persist(epoch, binding);
      if (!current()) {
        return false;
      }
      sent = true;
      final raw = await repository.mutate(frozen);
      if (!current()) {
        return false;
      }
      final receipt = await MeetingAcceptedReceipt.parse(raw, frozen, binding);
      if (!current()) {
        return false;
      }
      accepted = receipt;
      uncertain = false;
      busy = false;
      _settling = true;
      needsRefresh = true;
      recorded = _receiptRecord(receipt);
      if (_draftRevision == draftRevision) {
        draft = {...draft, 'savedReceipt': receipt.receiptSha256};
      }
      notifyListeners();
      try {
        await _persist(epoch, binding);
      } catch (_) {
        if (current()) {
          _holdRecovery(
            'The accepted receipt is visible here, but its protected local save is unconfirmed. Reload the protected draft before another Meeting action.',
          );
          notifyListeners();
        }
      } finally {
        if (current()) {
          _settling = false;
          notifyListeners();
        }
      }
      if (current()) {
        unawaited(_refreshAfterAcceptance(refresh, epoch, binding, feedback));
      }
      return true;
    } catch (value) {
      if (!current()) {
        return false;
      }
      final refusedBeforeEffect =
          value is ApiException &&
          const [
            400,
            401,
            403,
            404,
            409,
            413,
            415,
          ].contains(value.statusCode) &&
          const ['create', 'update'].contains(frozen.action);
      uncertain = wasUncertain || sent && !refusedBeforeEffect;
      error = !sent
          ? 'The request was not sent because its recovery record could not be saved.'
          : uncertain
          ? 'The server outcome is unconfirmed. Keep this exact submitted request and key; a failed response does not prove that no effect occurred.'
          : 'The request was refused. Refresh the current meeting and review a new draft before submitting again.';
      _settling = sent;
      busy = false;
      if (!sent) {
        _holdRecovery(
          'The recovery save was not confirmed. No server request was sent. Reload the protected draft to inspect the saved state.',
        );
      } else {
        try {
          await _persist(epoch, binding);
        } catch (_) {
          if (current()) {
            _holdRecovery(
              'The recovery record could not be updated. Its previous uncertain request was preserved. Reload before another Meeting action.',
            );
          }
        }
      }
      if (current()) {
        _settling = false;
        notifyListeners();
      }
      return false;
    } finally {
      if (current() && busy) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<void> _refreshAfterAcceptance(
    Future<bool> Function() refresh,
    int epoch,
    MeetingsOwner binding,
    int feedback,
  ) async {
    if (!_current(epoch, binding) || feedback != _feedback) {
      return;
    }
    refreshing = true;
    refreshError = null;
    notifyListeners();
    var fresh = false;
    try {
      fresh = await refresh();
    } catch (_) {
      /* Acceptance remains independent. */
    }
    if (!_current(epoch, binding) || feedback != _feedback) {
      return;
    }
    refreshing = false;
    needsRefresh = !fresh;
    refreshError = fresh ? null : 'The action was accepted. Current workspace reads did not all refresh successfully.';
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _epoch++;
    _feedback++;
    _save?.cancel();
    repository.access.removeListener(_accessChanged);
    draft = const {};
    submitted = null;
    accepted = null;
    recorded = null;
    super.dispose();
  }
}
