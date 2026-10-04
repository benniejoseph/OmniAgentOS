import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'meetings_access.dart';
import 'meetings_api_repository.dart';
import 'meetings_calendar_contracts.dart';
import 'meetings_draft_store.dart';
import 'meetings_mutations.dart';
import 'meetings_validation.dart';

/// One protected Calendar intent per current Meeting owner. Recovery only
/// reads the accepted request; this controller never retries a POST.
class MeetingCalendarController extends ChangeNotifier {
  MeetingCalendarController(this.repository, this.store) {
    repository.access.addListener(_accessChanged);
  }
  final CalendarMeetingsRepository repository;
  final MeetingDraftStore store;
  static const route = 'calendar-sync';
  MeetingCalendarStatus? status;
  MeetingCalendarResult? result;
  MeetingCalendarSubmission? pending;
  bool initialized = false,
      loading = false,
      busy = false,
      recovering = false,
      recoveryBlocked = false;
  String? error, storageError;
  bool _disposed = false,
      _active = false,
      _denied = false,
      _pendingSent = false;
  int _epoch = 0;
  CancelToken? _cancel;
  MeetingsOwner? get owner => repository.access.owner;
  bool get available =>
      !_disposed && _active && !_denied && repository.authorityCurrent();
  bool get canRead =>
      available && repository.access.supports('meetings.calendar.get');
  bool get uncertain =>
      pending != null ||
      status?.blocked != null ||
      result != null && !result!.sync.settled;
  bool get canSync =>
      canRead &&
      initialized &&
      !loading &&
      !busy &&
      !recovering &&
      !recoveryBlocked &&
      !uncertain &&
      error == null &&
      owner?.canManage == true &&
      repository.access.supports('meetings.calendar.sync') &&
      status?.connection?.ready == true;
  bool get canRecover =>
      available &&
      initialized &&
      !loading &&
      !busy &&
      !recovering &&
      !recoveryBlocked &&
      repository.access.supports('meetings.calendar.sync.get') &&
      uncertain;
  bool _current(int epoch, MeetingsOwner binding) =>
      available && epoch == _epoch && owner?.key == binding.key;

  void _clear() {
    _epoch++;
    _cancel?.cancel('Calendar authority or visibility changed.');
    status = null;
    result = null;
    pending = null;
    initialized = false;
    _pendingSent = false;
    loading = false;
    busy = false;
    recovering = false;
    recoveryBlocked = false;
    error = null;
    storageError = null;
  }

  void _accessChanged() {
    _clear();
    _denied = false;
    if (!_disposed) {
      notifyListeners();
      if (canRead) {
        unawaited(_start());
      }
    }
  }

  void setActive(bool active) {
    if (_disposed || _active == active) {
      return;
    }
    _active = active;
    if (!active) {
      _clear();
      notifyListeners();
    } else if (canRead) {
      unawaited(_start());
    }
  }

  Future<void> _start() async {
    await reloadRecovery();
    if (canRead) {
      await refresh();
    }
  }

  void _failure(Object value, String message) {
    error = message;
    if (value is ApiException && const [401, 403].contains(value.statusCode)) {
      _denied = true;
      status = null;
      result = null;
      pending = null;
      initialized = false;
      loading = false;
      busy = false;
      recovering = false;
      error = 'Restore the current unlocked account session before reading Calendar again.';
      notifyListeners();
    }
  }

  Future<void> reloadRecovery() async {
    if (!available || busy || recovering || loading) {
      return;
    }
    final epoch = _epoch,
        binding = owner!,
        previous = _pendingSent ? pending : null;
    recovering = true;
    recoveryBlocked = true;
    notifyListeners();
    try {
      final saved = await store.read(binding, route);
      if (!_current(epoch, binding)) {
        return;
      }
      meetingRequire(
        saved == null ||
            saved.keys.toSet().containsAll(['pending', 'recorded']) &&
                saved.length == 2,
      );
      final restored = saved?['pending'] == null
          ? null
          : MeetingCalendarSubmission.restore(saved!['pending'], binding);
      MeetingCalendarResult? recorded;
      MeetingCalendarSubmission? recordedRequest;
      if (saved?['recorded'] != null) {
        final record = meetingMap(saved!['recorded']);
        meetingRequire(
          record.length == 2 &&
              record.containsKey('request') &&
              record.containsKey('response'),
        );
        recordedRequest = record['request'] == null
            ? null
            : MeetingCalendarSubmission.restore(record['request'], binding);
        final response = meetingMap(record['response']);
        recorded = await MeetingCalendarResult.parse(
          response,
          binding,
          sent: recordedRequest,
          mutation: response['contract'] == meetingCalendarSyncContract,
        );
        meetingRequire(recorded.sync.settled);
      }
      var settledPrevious = false;
      if (previous != null) {
        if (recorded != null) {
          // A settlement can be durable even when the storage acknowledgement
          // is lost. Only its complete verified receipt for this exact frozen
          // request may discharge the still-visible pending identity.
          meetingRequire(
            restored == null &&
                (recordedRequest == null ||
                    meetingCanonicalJson(previous.json) ==
                        meetingCanonicalJson(recordedRequest.json)),
            'Protected settlement belongs to a different Calendar request.',
          );
          recorded = await MeetingCalendarResult.parse(
            recorded.raw,
            binding,
            sent: previous,
            mutation: recorded.raw['contract'] == meetingCalendarSyncContract,
          );
          final observed = result?.sync;
          if (observed != null && observed.id == recorded.sync.id) {
            meetingRequire(
              meetingCanonicalJson(observed.acceptance) ==
                      meetingCanonicalJson(recorded.sync.acceptance) &&
                  (observed.state == 'accepted' ||
                      meetingCanonicalJson(observed.raw) ==
                          meetingCanonicalJson(recorded.sync.raw)),
              'Protected settlement conflicts with the observed Calendar receipt.',
            );
          }
          settledPrevious = true;
        } else {
          meetingRequire(
            restored != null &&
                meetingCanonicalJson(previous.json) ==
                    meetingCanonicalJson(restored.json),
            'Protected recovery changed while this exact Calendar request remained unconfirmed.',
          );
        }
      }
      if (!_current(epoch, binding)) {
        return;
      }
      pending = restored;
      _pendingSent = restored != null;
      result = recorded;
      initialized = true;
      recoveryBlocked = false;
      storageError = null;
      if (settledPrevious) {
        status = null;
        error = null;
      }
    } catch (_) {
      if (_current(epoch, binding)) {
        storageError = 'Protected Calendar recovery could not be restored. Reload it before another sync.';
      }
    } finally {
      if (_current(epoch, binding)) {
        recovering = false;
        notifyListeners();
      }
    }
  }

  Future<void> refresh() async {
    if (!canRead || loading || busy) {
      return;
    }
    final epoch = _epoch, binding = owner!, cancel = _cancel = CancelToken();
    loading = true;
    notifyListeners();
    try {
      final raw = await repository.calendarStatus(cancel);
      final current = await MeetingCalendarStatus.parse(raw, binding);
      if (!_current(epoch, binding) || cancel.isCancelled) {
        return;
      }
      status = current;
      error = null;
    } catch (value) {
      if (_current(epoch, binding) && !cancel.isCancelled) {
        _failure(
          value,
          'Calendar status could not be refreshed. Read the current account and authorization before syncing.',
        );
      }
    } finally {
      if (_current(epoch, binding)) {
        loading = false;
        notifyListeners();
      }
    }
  }

  Future<bool> submit(MeetingCalendarStatus reviewed) async {
    if (!canSync || !identical(status, reviewed)) {
      return false;
    }
    final epoch = _epoch, binding = owner!;
    final submission = MeetingCalendarSubmission.freeze(
      binding,
      reviewed.connection!,
    );
    busy = true;
    error = null;
    pending = submission;
    notifyListeners();
    bool current() =>
        _current(epoch, binding) && identical(pending, submission);
    try {
      await store.write(binding, route, {
        'pending': submission.json,
        'recorded': null,
      }, isCurrent: current);
    } catch (_) {
      if (current()) {
        busy = false;
        recoveryBlocked = true;
        storageError = 'The exact request was not confirmed in protected storage. No sync was dispatched; reload recovery before continuing.';
        notifyListeners();
      }
      return false;
    }
    if (!current()) {
      return false;
    }
    try {
      _pendingSent = true;
      final raw = await repository.calendarSync(submission, isCurrent: current);
      final accepted = await MeetingCalendarResult.parse(
        raw,
        binding,
        sent: submission,
        mutation: true,
      );
      if (!current()) {
        return false;
      }
      result = accepted;
      if (accepted.sync.settled) {
        await _record(accepted, submission, epoch, binding);
      } else {
        error = 'This Calendar request is accepted but completion is unconfirmed. Read its exact receipt before any further sync.';
      }
      return accepted.sync.settled;
    } catch (value) {
      if (current()) {
        _failure(
          value,
          'The Calendar result is unconfirmed. Its exact saved request is held; checking status will not resend it.',
        );
      }
      return false;
    } finally {
      if (_current(epoch, binding)) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<void> _record(
    MeetingCalendarResult accepted,
    MeetingCalendarSubmission? submitted,
    int epoch,
    MeetingsOwner binding,
  ) async {
    result = accepted;
    try {
      await store.write(
        binding,
        route,
        {
          'pending': null,
          'recorded': {'request': submitted?.json, 'response': accepted.raw},
        },
        isCurrent: () =>
            _current(epoch, binding) && identical(result, accepted),
      );
      if (!_current(epoch, binding) || !identical(result, accepted)) {
        return;
      }
      pending = null;
      _pendingSent = false;
      recoveryBlocked = false;
      storageError = null;
      error = null;
      // Refresh is required before another intentional sync; completion does
      // not establish that connection authorization remains current.
      status = null;
    } catch (_) {
      if (_current(epoch, binding)) {
        recoveryBlocked = true;
        storageError = 'The server receipt is confirmed, but local recovery was not settled. Reload recovery and check the exact receipt again.';
      }
    }
  }

  Future<void> recover() async {
    if (!canRecover) {
      return;
    }
    final epoch = _epoch, binding = owner!, submission = pending;
    final held =
        status?.blocked ??
        (result?.sync.settled == false ? result!.sync : null);
    if (submission == null && held == null) {
      return;
    }
    recovering = true;
    error = null;
    notifyListeners();
    final cancel = _cancel = CancelToken();
    try {
      final id = submission == null ? held!.id : await submission.id;
      final keyHash = submission == null
          ? held!.keySha256
          : await submission.keySha256;
      if (!_current(epoch, binding) || cancel.isCancelled) {
        return;
      }
      final raw = await repository.calendarSyncRead(id, keyHash, cancel);
      final accepted = await MeetingCalendarResult.parse(
        raw,
        binding,
        sent: submission,
        exactId: id,
        exactKey: keyHash,
      );
      if (!_current(epoch, binding) || cancel.isCancelled) {
        return;
      }
      result = accepted;
      if (accepted.sync.settled) {
        await _record(accepted, submission, epoch, binding);
      } else {
        error = 'The exact receipt still has no confirmed completion. Another Calendar sync remains blocked.';
      }
    } catch (value) {
      if (_current(epoch, binding) && !cancel.isCancelled) {
        _failure(
          value,
          'No exact completion was confirmed. The saved Calendar request remains held, including when its receipt is not found.',
        );
      }
    } finally {
      if (_current(epoch, binding)) {
        recovering = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _epoch++;
    _cancel?.cancel('Calendar disposed.');
    repository.access.removeListener(_accessChanged);
    super.dispose();
  }
}
