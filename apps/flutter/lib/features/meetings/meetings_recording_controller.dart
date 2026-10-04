import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'meetings_access.dart';
import 'meetings_api_repository.dart';
import 'meetings_draft_store.dart';
import 'meetings_mutations.dart';
import 'meetings_recording_contracts.dart';
import 'meetings_validation.dart';

class MeetingRecordingSaved {
  const MeetingRecordingSaved(this.request, this.result);
  final MeetingRecordingSubmission request;
  final MeetingRecordingResult result;
  MeetingJson get stored => {'request': request.stored, 'response': result.raw};
}

/// One protected outstanding admission per owner. Accepted requests remain
/// addressable for exact read-only progress checks across navigation/restarts.
class MeetingRecordingController extends ChangeNotifier {
  MeetingRecordingController(this.repository, this.store) {
    repository.access.addListener(_accessChanged);
    _owner = repository.access.owner;
  }
  static const route = 'recording-processing';
  static const maxSaved = 32;
  final RecordingMeetingsRepository repository;
  final MeetingDraftStore store;
  MeetingsOwner? _owner;
  bool _active = false, _disposed = false, _denied = false;
  int _epoch = 0;
  CancelToken? _read;
  bool initialized = false,
      busy = false,
      loading = false,
      storageUnconfirmed = false;
  String? error, storageError;
  MeetingRecordingSubmission? pending;
  bool pendingDispatched = false;
  final Map<String, MeetingRecordingSaved> _saved = {};
  MeetingsOwner? get owner => _owner;
  bool get available =>
      !_disposed &&
      _active &&
      !_denied &&
      repository.authorityCurrent() &&
      _owner?.key == repository.access.owner?.key;
  bool get canRead => available && initialized && !busy && !loading;
  bool get canSubmit =>
      canRead &&
      !storageUnconfirmed &&
      pending == null &&
      _saved.length < maxSaved &&
      owner?.canManage == true &&
      repository.access.supports('meetings.recordings.process');
  List<MeetingRecordingSaved> get saved => List.unmodifiable(_saved.values);
  MeetingRecordingSaved? acceptedFor(String meeting, String recording) => _saved
      .values
      .where(
        (value) =>
            value.request.scope['meetingId'] == meeting &&
            value.request.recordingId == recording,
      )
      .firstOrNull;
  bool _current(int epoch, MeetingsOwner owner) =>
      available && epoch == _epoch && _owner?.key == owner.key;
  void _notify() {
    if (!_disposed) {
      notifyListeners();
    }
  }

  void _accessChanged() {
    _epoch++;
    _read?.cancel();
    _owner = repository.access.owner;
    pending = null;
    pendingDispatched = false;
    _saved.clear();
    initialized = false;
    busy = false;
    loading = false;
    storageUnconfirmed = false;
    error = null;
    storageError = null;
    _denied = false;
    _notify();
    if (available) {
      reload();
    }
  }

  void setActive(bool value) {
    if (_disposed || _active == value) {
      return;
    }
    _active = value;
    _epoch++;
    _read?.cancel();
    busy = false;
    loading = false;
    // Hide all private presentation while inactive; the encrypted journal is
    // retained and is authenticated again before this controller can submit.
    if (!value) {
      _notify();
      return;
    }
    reload();
  }

  void _failure(Object failure, String message) {
    if (failure is ApiException && [401, 403].contains(failure.statusCode)) {
      _denied = true;
    }
    error = message;
  }

  Future<void> _save(MeetingsOwner owner, int epoch) async {
    await store.write(owner, route, {
      'schemaVersion': 1,
      'pending': pending?.stored,
      'pendingDispatched': pending != null && pendingDispatched,
      'accepted': _saved.values.map((value) => value.stored).toList(),
    }, isCurrent: () => _current(epoch, owner));
    if (!_current(epoch, owner)) {
      throw StateError('Recording storage authority changed.');
    }
    storageUnconfirmed = false;
    storageError = null;
  }

  Future<void> reload() async {
    if (!available || busy || loading) {
      return;
    }
    final owner = _owner!, epoch = _epoch, held = pending;
    loading = true;
    _notify();
    try {
      final payload = await store.read(owner, route);
      if (!_current(epoch, owner)) {
        return;
      }
      MeetingRecordingSubmission? restored;
      var dispatched = false;
      final records = <String, MeetingRecordingSaved>{};
      if (payload != null) {
        meetingRequire(
          payload.length == 4 &&
              payload['schemaVersion'] == 1 &&
              payload.containsKey('pending') &&
              payload.containsKey('accepted') &&
              payload['pendingDispatched'] is bool,
        );
        if (payload['pending'] != null) {
          restored = await MeetingRecordingSubmission.restore(
            payload['pending'],
            owner,
          );
        }
        dispatched = payload['pendingDispatched'] == true;
        meetingRequire(!dispatched || restored != null);
        final accepted = payload['accepted'];
        meetingRequire(accepted is List && accepted.length <= maxSaved);
        for (final item in accepted as List) {
          final row = meetingMap(item);
          meetingRequire(
            row.length == 2 &&
                row.containsKey('request') &&
                row.containsKey('response'),
          );
          final request = await MeetingRecordingSubmission.restore(
                row['request'],
                owner,
              ),
              response = meetingMap(row['response']);
          final result = await MeetingRecordingResult.parse(
            response,
            owner,
            request,
            mutation: response.containsKey('replayed'),
          );
          meetingRequire(
            result.acceptance != null &&
                !records.containsKey(request.keySha256),
          );
          records[request.keySha256] = MeetingRecordingSaved(request, result);
        }
      }
      if (!_current(epoch, owner)) {
        return;
      }
      bool matches(
        MeetingRecordingSubmission? a,
        MeetingRecordingSubmission? b,
      ) =>
          a != null &&
          b != null &&
          meetingCanonicalJson(a.stored) == meetingCanonicalJson(b.stored);
      if (held != null && pendingDispatched) {
        meetingRequire(
          matches(restored, held) ||
              matches(records[held.keySha256]?.request, held),
          'The protected recording request is absent or differs. Its outcome remains held.',
        );
        meetingRequire(dispatched || records.containsKey(held.keySha256));
      } else if (held != null && restored != null) {
        meetingRequire(
          matches(restored, held),
          'Another protected recording request needs review.',
        );
      }
      var needsSave = false;
      // A locally verified acceptance survives an older saved receipt or a
      // failed local acknowledgement. Never replace it with null/older data.
      for (final known in _saved.values) {
        final existing = records[known.request.keySha256];
        if (existing != null) {
          meetingRequire(
            meetingCanonicalJson(existing.result.acceptance) ==
                meetingCanonicalJson(known.result.acceptance),
          );
        }
        if (existing == null || matches(restored, known.request)) {
          needsSave = true;
        }
        records[known.request.keySha256] = known;
      }
      meetingRequire(records.length <= maxSaved);
      if (restored != null && records.containsKey(restored.keySha256)) {
        meetingRequire(matches(records[restored.keySha256]!.request, restored));
        restored = null;
        needsSave = true;
      }
      pending = restored;
      pendingDispatched = restored != null && dispatched;
      _saved
        ..clear()
        ..addAll(records);
      initialized = true;
      storageUnconfirmed = needsSave;
      storageError = needsSave
          ? 'An accepted recording receipt still needs a protected local save.'
          : null;
      error = null;
    } catch (_) {
      if (_current(epoch, owner)) {
        storageUnconfirmed = true;
        storageError = 'Protected recording recovery could not be confirmed. Existing requests and receipts remain held.';
      }
    } finally {
      if (_current(epoch, owner)) {
        loading = false;
        _notify();
      }
    }
  }

  Future<MeetingRecordingReview?> review(
    String workspace,
    String meeting,
    String recording,
  ) async {
    if (!canRead || !repository.access.supports('meetings.recordings.review')) {
      return null;
    }
    final owner = _owner!, epoch = _epoch, cancel = CancelToken();
    _read = cancel;
    loading = true;
    error = null;
    _notify();
    try {
      final scope = recordingScope(owner, workspace, meeting, recording);
      final result = await MeetingRecordingReview.parse(
        await repository.recordingReview(scope, cancel),
        owner,
        scope,
      );
      return _current(epoch, owner) && !cancel.isCancelled ? result : null;
    } catch (failure) {
      if (_current(epoch, owner)) {
        _failure(
          failure,
          'The current recording review is unavailable. Refresh before submitting.',
        );
      }
      return null;
    } finally {
      if (epoch == _epoch && !_disposed) {
        loading = false;
        _notify();
      }
    }
  }

  Future<void> submit(
    MeetingRecordingReview reviewed, {
    required List<String> languages,
    required List<MeetingJson> mappings,
    required bool Function() isCurrent,
  }) async {
    if (!canSubmit || !isCurrent()) {
      return;
    }
    final owner = _owner!, epoch = _epoch;
    bool owned() => _current(epoch, owner);
    bool admitted() => owned() && isCurrent();
    busy = true;
    error = null;
    _notify();
    var journalAttempted = false;
    try {
      final cancel = CancelToken();
      _read = cancel;
      final fresh = await MeetingRecordingReview.parse(
        await repository.recordingReview(reviewed.scope, cancel),
        owner,
        reviewed.scope,
      );
      if (!admitted()) {
        return;
      }
      meetingRequire(
        fresh.processable &&
            meetingCanonicalJson(fresh.pin) ==
                meetingCanonicalJson(reviewed.pin),
        'The recording or consent review changed.',
      );
      final submitted = await MeetingRecordingSubmission.prepare(
        owner,
        fresh,
        languages: languages,
        mappings: mappings,
      );
      if (!admitted()) {
        return;
      }
      pending = submitted;
      pendingDispatched = false;
      journalAttempted = true;
      await _save(owner, epoch);
      if (!admitted()) {
        // Restored prepared requests may be explicitly discarded locally:
        // transport is admitted only after the dispatched phase is durable.
        return;
      }
      pendingDispatched = true;
      await _save(owner, epoch);
      if (!admitted()) {
        return;
      }
      final response = await repository.recordingProcess(
        submitted,
        isCurrent: admitted,
      );
      final result = await MeetingRecordingResult.parse(
        response,
        owner,
        submitted,
        mutation: true,
      );
      if (!owned()) {
        return;
      }
      _saved[submitted.keySha256] = MeetingRecordingSaved(submitted, result);
      pending = null;
      try {
        await _save(owner, epoch);
      } catch (_) {
        if (owned()) {
          storageUnconfirmed = true;
          storageError = 'Processing was accepted. The exact receipt still needs a protected local save.';
        }
      }
    } catch (failure) {
      if (owned()) {
        if (journalAttempted && pending != null) {
          storageUnconfirmed = true;
          storageError = 'The request or its local acknowledgement is unconfirmed. Reload protected recovery and check only its exact receipt.';
        }
        _failure(
          failure,
          pending != null
              ? 'Recording submission is unconfirmed. It will not be sent again.'
              : 'Recording review changed or is unavailable. Refresh it before submitting.',
        );
      }
    } finally {
      if (epoch == _epoch && !_disposed) {
        busy = false;
        _notify();
      }
    }
  }

  Future<void> check(MeetingRecordingSubmission submitted) async {
    if (!canRead ||
        !repository.access.supports('meetings.recordings.processing.get') ||
        submitted.ownerKey != _owner?.key) {
      return;
    }
    final owner = _owner!, epoch = _epoch, cancel = CancelToken();
    _read = cancel;
    loading = true;
    error = null;
    _notify();
    try {
      final result = await MeetingRecordingResult.parse(
        await repository.recordingProcessing(submitted, cancel),
        owner,
        submitted,
        mutation: false,
      );
      if (!_current(epoch, owner)) {
        return;
      }
      if (result.acceptance == null) {
        error = 'No matching acceptance is currently visible. The request remains unconfirmed; no processing was restarted.';
        return;
      }
      final previous = _saved[submitted.keySha256];
      meetingRequire(
        previous == null ||
            meetingCanonicalJson(previous.result.acceptance) ==
                meetingCanonicalJson(result.acceptance),
      );
      _saved[submitted.keySha256] = MeetingRecordingSaved(submitted, result);
      if (pending?.keySha256 == submitted.keySha256) {
        pending = null;
      }
      try {
        await _save(owner, epoch);
      } catch (_) {
        if (_current(epoch, owner)) {
          storageUnconfirmed = true;
          storageError = 'The verified receipt remains visible. Reload recovery, then save it locally.';
        }
      }
    } catch (failure) {
      if (_current(epoch, owner)) {
        _failure(
          failure,
          'The exact recording read is unavailable. Previously accepted receipts remain recorded; processing freshness is unknown.',
        );
      }
    } finally {
      if (epoch == _epoch && !_disposed) {
        loading = false;
        _notify();
      }
    }
  }

  Future<void> saveLocally() async {
    if (!canRead || !storageUnconfirmed || pending != null || _saved.isEmpty) {
      return;
    }
    final owner = _owner!, epoch = _epoch;
    busy = true;
    _notify();
    try {
      await _save(owner, epoch);
    } catch (_) {
      if (_current(epoch, owner)) {
        storageUnconfirmed = true;
        storageError = 'The protected receipt save is still unconfirmed. Reload before trying the local save again.';
      }
    } finally {
      if (epoch == _epoch && !_disposed) {
        busy = false;
        _notify();
      }
    }
  }

  Future<void> discardPrepared() async {
    if (!canRead ||
        storageUnconfirmed ||
        pending == null ||
        pendingDispatched) {
      return;
    }
    final owner = _owner!, epoch = _epoch, held = pending;
    busy = true;
    pending = null;
    _notify();
    try {
      await _save(owner, epoch);
    } catch (_) {
      if (_current(epoch, owner)) {
        pending = held;
        storageUnconfirmed = true;
        storageError = 'Local discard is unconfirmed. Reload the protected request before continuing.';
      }
    } finally {
      if (epoch == _epoch && !_disposed) {
        busy = false;
        _notify();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _epoch++;
    _read?.cancel();
    repository.access.removeListener(_accessChanged);
    super.dispose();
  }
}
