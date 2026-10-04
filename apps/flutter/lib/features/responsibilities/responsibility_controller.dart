import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'responsibility_contracts.dart';
import 'responsibility_recovery_store.dart';
import '../../core/storage/ciphertext_recovery_broker.dart';
import 'responsibility_repository.dart';

class ResponsibilityIntent {
  ResponsibilityIntent({
    required this.lane,
    required this.body,
    required this.key,
    this.id,
  });
  final ResponsibilityLane lane;
  final ResponsibilityJson body;
  final String key;
  final String? id;
  ResponsibilityJson get json => {
    'lane': lane.name,
    'body': body,
    'key': key,
    'id': id,
  };
  factory ResponsibilityIntent.parse(Object? raw) {
    final value = responsibilityMap(raw);
    responsibilityRequire(
      value.length == 4 &&
          value.keys.toSet().containsAll({'lane', 'body', 'key', 'id'}),
    );
    final lane = ResponsibilityLane.values.byName(value['lane'] as String),
        body = responsibilityMap(value['body']);
    validateResponsibilityMutation(lane, body);
    final key = value['key'];
    responsibilityRequire(
      key is String &&
          RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    final id = value['id'] == null ? null : responsibilityId(value['id']);
    responsibilityRequire(
      (lane == ResponsibilityLane.draft && body['action'] == 'create') ==
          (id == null),
    );
    return ResponsibilityIntent(
      lane: lane,
      body: freezeResponsibility(body) as ResponsibilityJson,
      key: key as String,
      id: id,
    );
  }
}

class ResponsibilityController extends ChangeNotifier {
  ResponsibilityController(this.repository, this.recovery) {
    repository.access.addListener(_accessChanged);
    repository.access.addSilentCloseListener(_silentlyInvalidate);
  }
  final ResponsibilityRepository repository;
  final ResponsibilityRecoveryStore recovery;
  final Map<String, ResponsibilityJson> _editors = {};
  final Map<String, int> _editorRevisions = {};
  final Map<ResponsibilityRead, int> _readVersions = {};
  final Map<ResponsibilityRead, ResponsibilityJson> _views = {};
  final Map<ResponsibilityRead, ResponsibilityJson> _confirmedHeads = {};
  final Map<ResponsibilityRead, String> readErrors = {};
  final Set<ResponsibilityRead> _fresh = {};
  final Set<CancelToken> _reads = {};
  final List<ResponsibilityJson> accepted = [];
  final Set<String> invalidDraftInputs = {};
  ResponsibilityJson? listing, references;
  ResponsibilityIntent? pending;
  String? selectedId, error, notice, recoveryError;
  bool loading = false, busy = false, recoveryReady = false;
  int _epoch = 0, _selectionEpoch = 0;
  bool _disposed = false;
  bool _authorityInvalidated = false;
  String? _loadedOwner;
  Timer? _saveTimer;
  Future<void>? _initializing;

  bool get available =>
      !_disposed && !_authorityInvalidated && repository.authorityCurrent();
  bool get canManage => available && repository.access.writable;
  bool get canMutate => canManage && recoveryReady && !busy && pending == null;
  bool get canSaveDraft =>
      canMutate &&
      invalidDraftInputs.isEmpty &&
      !draftRevisionConflict &&
      (selectedId == null ||
          isFresh(ResponsibilityRead.detail) && record != null);
  bool get uncertain => pending != null;
  int get authorityEpoch => _epoch;
  List<ResponsibilityRecord> get records =>
      ((listing?['records'] as List?) ?? const [])
          .map((item) => ResponsibilityRecord(responsibilityMap(item)))
          .toList(growable: false);
  ResponsibilityJson? view(ResponsibilityRead kind) => _views[kind];
  bool isFresh(ResponsibilityRead kind) => available && _fresh.contains(kind);
  ResponsibilityRecord? get record =>
      _views[ResponsibilityRead.detail]?['record'] == null
      ? null
      : ResponsibilityRecord(
          responsibilityMap(_views[ResponsibilityRead.detail]!['record']),
        );
  ResponsibilityJson get draft =>
      _editors[selectedId ?? 'new'] ??
      record?.draft ??
      emptyResponsibilityDraft();
  bool get dirty => selectedId == null
      ? !responsibilitySame(draft, emptyResponsibilityDraft())
      : record != null && !responsibilitySame(draft, record!.draft);
  bool get draftRevisionConflict =>
      selectedId != null &&
      _editorRevisions.containsKey(selectedId) &&
      record != null &&
      _editorRevisions[selectedId] != record!.revision;
  ResponsibilityJson? head(ResponsibilityRead kind) =>
      _views[kind]?['current'] == null
      ? null
      : responsibilityMap(_views[kind]!['current']);
  ResponsibilityJson? preview(ResponsibilityRead kind) =>
      _views[kind]?[kind == ResponsibilityRead.detail
              ? 'readiness'
              : 'preview'] ==
          null
      ? null
      : responsibilityMap(
          _views[kind]![kind == ResponsibilityRead.detail
              ? 'readiness'
              : 'preview'],
        );

  void _notify() {
    if (!_disposed && !_authorityInvalidated) notifyListeners();
  }

  bool _current(int epoch, ResponsibilityOwner owner) =>
      available && epoch == _epoch && repository.access.owner?.key == owner.key;
  void _accessChanged() {
    if (_disposed) return;
    _epoch++;
    _selectionEpoch++;
    _saveTimer?.cancel();
    for (final token in _reads.toList()) {
      token.cancel('Responsibility account or role changed.');
    }
    _reads.clear();
    _fresh.clear();
    _views.clear();
    _confirmedHeads.clear();
    _editors.clear();
    _editorRevisions.clear();
    _readVersions.clear();
    accepted.clear();
    readErrors.clear();
    invalidDraftInputs.clear();
    listing = null;
    references = null;
    selectedId = null;
    pending = null;
    error = null;
    notice = null;
    recoveryError = null;
    recoveryReady = false;
    busy = false;
    loading = false;
    _loadedOwner = null;
    _initializing = null;
    _notify();
    if (available) unawaited(initialize());
  }

  void _silentlyInvalidate() => invalidateAuthority(notify: false);
  void invalidateAuthority({bool notify = true}) {
    if (_disposed || _authorityInvalidated) return;
    _authorityInvalidated = true;
    _accessChanged();
    if (notify) notifyListeners();
  }

  Future<void> initialize({String? focusId}) {
    if (!available) return Future.value();
    final existing = _initializing;
    if (existing != null) {
      return existing.then((_) async {
        if (focusId != null && available) await select(focusId);
      });
    }
    final task = _initialize(focusId);
    _initializing = task;
    return task.whenComplete(() {
      if (identical(_initializing, task)) _initializing = null;
    });
  }

  Future<void> _initialize(String? focusId) async {
    final owner = repository.access.owner!, epoch = _epoch;
    if (_loadedOwner != owner.key) {
      loading = true;
      _notify();
      try {
        final saved = await recovery.read(owner);
        if (!_current(epoch, owner)) return;
        if (saved != null) await _restore(saved, owner, epoch);
        if (!_current(epoch, owner)) return;
        recoveryReady = true;
        _loadedOwner = owner.key;
        recoveryError = null;
      } catch (_) {
        if (!_current(epoch, owner)) return;
        recoveryReady = false;
        recoveryError = 'Protected recovery could not be read. Changes are disabled so an earlier uncertain action cannot be lost.';
      }
    }
    if (!_current(epoch, owner)) return;
    if (focusId != null) {
      responsibilityId(focusId);
      selectedId = focusId;
    }
    await refresh();
  }

  Future<void> _restore(
    ResponsibilityJson saved,
    ResponsibilityOwner owner,
    int epoch,
  ) async {
    responsibilityRequire(
      saved['schemaVersion'] == 1 &&
          saved.keys.toSet().difference({
            'schemaVersion',
            'selectedId',
            'editors',
            'editorRevisions',
            'pending',
            'accepted',
          }).isEmpty,
    );
    final editors = responsibilityMap(saved['editors']);
    responsibilityRequire(editors.length <= 25);
    final revisions = responsibilityMap(saved['editorRevisions']);
    responsibilityRequire(
      revisions.length == editors.length &&
          editors.keys.every(revisions.containsKey),
    );
    for (final entry in editors.entries) {
      if (entry.key != 'new') responsibilityId(entry.key);
      validateResponsibilityDraft(entry.value);
      responsibilityRequire(
        revisions[entry.key] is int &&
            (entry.key == 'new'
                ? revisions[entry.key] == 0
                : revisions[entry.key] > 0),
      );
    }
    final restoredPending = saved['pending'] == null
        ? null
        : ResponsibilityIntent.parse(saved['pending']);
    final restoredAccepted = <ResponsibilityJson>[];
    responsibilityRequire(
      saved['accepted'] is List && (saved['accepted'] as List).length <= 12,
    );
    for (final item in saved['accepted'] as List) {
      final raw = responsibilityMap(item),
          intent = ResponsibilityIntent.parse(raw['intent']);
      final result = await ResponsibilityVerifier(owner).mutation(
        raw['result'],
        intent.lane,
        intent.body,
        intent.key,
        intent.id,
      );
      if (!_current(epoch, owner)) return;
      restoredAccepted.add({'intent': intent.json, 'result': result});
    }
    final selection = saved['selectedId'] == null
        ? null
        : responsibilityId(saved['selectedId']);
    if (!_current(epoch, owner)) return;
    // Retain any unsaved in-memory edits while importing another window's
    // durable pending intent. Its frozen body is always recovered verbatim.
    for (final entry in editors.entries) {
      if (!_editors.containsKey(entry.key)) {
        _editors[entry.key] =
            freezeResponsibility(entry.value) as ResponsibilityJson;
        _editorRevisions[entry.key] = revisions[entry.key] as int;
      }
    }
    responsibilityRequire(
      _editors.length <= 25,
      'The combined protected draft inventory is full.',
    );
    selectedId ??= selection;
    pending = restoredPending;
    for (final item in restoredAccepted) {
      if (!accepted.any(
        (old) =>
            responsibilityMap(old['intent'])['key'] ==
            responsibilityMap(item['intent'])['key'],
      )) {
        accepted.add(item);
      }
    }
    if (accepted.length > 12) accepted.removeRange(12, accepted.length);
    if (pending != null) notice = 'A saved change has an unconfirmed outcome. Recover only this exact request with its original key.';
  }

  ResponsibilityJson _recoveryPayload() => {
    'schemaVersion': 1,
    'selectedId': selectedId,
    'editors': {..._editors},
    'editorRevisions': {..._editorRevisions},
    'pending': pending?.json,
    'accepted': accepted.toList(growable: false),
  };
  Future<void> _persist(int epoch, ResponsibilityOwner owner) => recovery.write(
    owner,
    freezeResponsibility(_recoveryPayload()) as ResponsibilityJson,
    isCurrent: () => _current(epoch, owner),
  );
  void _scheduleSave() {
    _saveTimer?.cancel();
    if (!available || !recoveryReady) return;
    final epoch = _epoch, owner = repository.access.owner!;
    _saveTimer = Timer(const Duration(milliseconds: 250), () async {
      if (!_current(epoch, owner)) return;
      try {
        await _persist(epoch, owner);
        if (_current(epoch, owner)) recoveryError = null;
      } catch (problem) {
        if (_current(epoch, owner)) {
          _recoveryConflict(problem);
          recoveryError ??= 'The latest local edits could not be saved securely. Keep this screen open and retry protected recovery.';
        }
      }
      _notify();
    });
  }

  void _recoveryConflict(Object problem) {
    if (problem is ResponsibilityRecoveryChanged ||
        problem is RecoveryStorageUnknown) {
      recoveryReady = false;
      _loadedOwner = null;
      recoveryError = 'Protected recovery changed or its save outcome is unknown. Retry protected recovery to read its exact pending request before making another change. Your current local edits are retained.';
    }
  }

  Future<void> retryProtectedRecovery() async {
    if (!available || busy) return;
    if (!recoveryReady) {
      await initialize();
      return;
    }
    final epoch = _epoch, owner = repository.access.owner!;
    try {
      await _persist(epoch, owner);
      if (_current(epoch, owner)) recoveryError = null;
    } catch (problem) {
      if (_current(epoch, owner)) {
        _recoveryConflict(problem);
        recoveryError ??= 'Protected local saving is still unavailable.';
      }
    }
    _notify();
  }

  void edit(ResponsibilityJson value) {
    if (!canManage || busy || pending != null) return;
    try {
      validateResponsibilityDraft(value);
      final key = selectedId ?? 'new';
      responsibilityRequire(
        _editors.containsKey(key) || _editors.length < 25,
        'This account has 25 local drafts. Save an existing draft before adding another.',
      );
      _editors[key] = freezeResponsibility(value) as ResponsibilityJson;
      _editorRevisions.putIfAbsent(key, () => record?.revision ?? 0);
      error = null;
      _scheduleSave();
      _notify();
    } catch (problem) {
      error = problem.toString();
      _notify();
    }
  }

  void draftInputValidity(String field, bool valid) {
    if (valid) {
      invalidDraftInputs.remove(field);
    } else {
      invalidDraftInputs.add(field);
    }
    _notify();
  }

  void rebaseDraft() {
    if (!canMutate ||
        !isFresh(ResponsibilityRead.detail) ||
        selectedId == null ||
        record == null ||
        !draftRevisionConflict) {
      return;
    }
    _editorRevisions[selectedId!] = record!.revision;
    _scheduleSave();
    _notify();
  }

  Future<void> select(String? id) async {
    if (!available) return;
    if (id != null) responsibilityId(id);
    if (id == selectedId && _views.isNotEmpty) return;
    selectedId = id;
    _selectionEpoch++;
    _views.clear();
    _confirmedHeads.clear();
    _fresh.clear();
    readErrors.clear();
    invalidDraftInputs.clear();
    error = null;
    _scheduleSave();
    _notify();
    if (id != null) await refreshDetail();
  }

  Future<void> refresh() async {
    if (!available) return;
    loading = true;
    _notify();
    final epoch = _epoch;
    await Future.wait([
      _read(ResponsibilityRead.list),
      _read(ResponsibilityRead.references),
      if (selectedId != null) refreshDetail(),
    ]);
    if (epoch == _epoch) {
      loading = false;
      _notify();
    }
  }

  Future<void> refreshDetail() async {
    if (!available || selectedId == null) return;
    await Future.wait([
      for (final kind in [
        ResponsibilityRead.detail,
        ResponsibilityRead.runtime,
        ResponsibilityRead.observations,
        ResponsibilityRead.notifications,
      ])
        _read(kind),
    ]);
  }

  Future<void> requestPreview(ResponsibilityRead kind) async {
    if (!canMutate ||
        selectedId == null ||
        dirty ||
        invalidDraftInputs.isNotEmpty ||
        !const {
          ResponsibilityRead.detail,
          ResponsibilityRead.runtime,
          ResponsibilityRead.notifications,
        }.contains(kind)) {
      return;
    }
    await _read(kind, preview: true);
  }

  Future<void> _read(ResponsibilityRead kind, {bool preview = false}) async {
    if (!available) return;
    final epoch = _epoch,
        selection = _selectionEpoch,
        owner = repository.access.owner!,
        id = selectedId,
        cancel = CancelToken();
    final readVersion = (_readVersions[kind] ?? 0) + 1;
    _readVersions[kind] = readVersion;
    final global =
        kind == ResponsibilityRead.list ||
        kind == ResponsibilityRead.references;
    _reads.add(cancel);
    _fresh.remove(kind);
    readErrors.remove(kind);
    _notify();
    try {
      final value = await repository.read(
        kind,
        cancel,
        id: global ? null : id,
        preview: preview,
      );
      if (!_current(epoch, owner) ||
          cancel.isCancelled ||
          _readVersions[kind] != readVersion ||
          !global && (selection != _selectionEpoch || selectedId != id)) {
        return;
      }
      if (!global && kind != ResponsibilityRead.observations) {
        final field = kind == ResponsibilityRead.detail ? 'record' : 'current',
            old = _confirmedHeads[kind];
        if (old != null) {
          final before = responsibilityMap(old),
              after = value[field] == null
                  ? null
                  : responsibilityMap(value[field]);
          responsibilityRequire(
            after != null &&
                (after['revision'] as int) >= before['revision'] &&
                (after['revision'] != before['revision'] ||
                    responsibilitySame(after, before)),
            'A fresh read regressed a confirmed Responsibility revision.',
          );
        }
        if (value[field] != null) {
          _confirmedHeads[kind] = responsibilityMap(value[field]);
        }
      }
      if (kind == ResponsibilityRead.list) {
        listing = value;
      } else if (kind == ResponsibilityRead.references) {
        references = value;
      } else {
        _views[kind] = value;
      }
      _fresh.add(kind);
      readErrors.remove(kind);
    } catch (_) {
      if (_current(epoch, owner) &&
          !cancel.isCancelled &&
          _readVersions[kind] == readVersion &&
          (global || selection == _selectionEpoch)) {
        readErrors[kind] =
            'The latest ${kind.name} read failed. Previously loaded evidence is retained; current authority is unconfirmed.';
      }
    } finally {
      _reads.remove(cancel);
      _notify();
    }
  }

  String _newKey() =>
      'responsibility-native-${base64UrlEncode(List<int>.generate(24, (_) => Random.secure().nextInt(256))).replaceAll('=', '')}';
  Future<void> saveDraft() async {
    if (!canSaveDraft ||
        !repository.supportsMutation(ResponsibilityLane.draft)) {
      return;
    }
    await _start(ResponsibilityLane.draft, {
      'action': selectedId == null ? 'create' : 'update',
      'expectedRevision': record?.revision ?? 0,
      'draft': draft,
    }, id: selectedId);
  }

  Future<void> acceptReview() async {
    final ready = preview(ResponsibilityRead.detail), current = record;
    if (!canMutate ||
        dirty ||
        invalidDraftInputs.isNotEmpty ||
        !isFresh(ResponsibilityRead.detail) ||
        ready?['state'] != 'ready' ||
        current == null) {
      return;
    }
    await _start(ResponsibilityLane.draft, {
      'action': 'review',
      'expectedRevision': current.revision,
      'draftSha256': ready!['draftSha256'],
      'reviewSha256': ready['reviewSha256'],
    }, id: current.id);
  }

  Future<void> lifecycle(String action) async {
    if (!canMutate ||
        !isFresh(ResponsibilityRead.runtime) ||
        selectedId == null) {
      return;
    }
    final current = head(ResponsibilityRead.runtime),
        ready = preview(ResponsibilityRead.runtime);
    if (action == 'activate' && current != null ||
        action == 'resume' && current?['state'] != 'paused' ||
        action == 'pause' && current?['state'] != 'active' ||
        action == 'end' &&
            (current == null ||
                const {'ending', 'ended'}.contains(current['state']))) {
      return;
    }
    if (const {'activate', 'resume'}.contains(action) &&
        (ready?['state'] != 'ready' ||
            dirty ||
            invalidDraftInputs.isNotEmpty)) {
      return;
    }
    if (!const {'activate', 'resume', 'pause', 'end'}.contains(action)) return;
    await _start(ResponsibilityLane.runtime, {
      'action': action,
      'expectedRevision': current?['revision'] ?? 0,
      'expectedGeneration': current?['generation'] ?? 0,
      if (action == 'activate' || action == 'resume') ...{
        'configurationSha256': responsibilityMap(
          ready!['configuration'],
        )['configurationSha256'],
        'acknowledgePilot': responsibilityPilot,
      },
    }, id: selectedId);
  }

  Future<void> notification(String action) async {
    if (!canMutate ||
        !isFresh(ResponsibilityRead.notifications) ||
        selectedId == null) {
      return;
    }
    final current = head(ResponsibilityRead.notifications),
        ready = preview(ResponsibilityRead.notifications);
    if (action == 'enable') {
      if (current != null ||
          ready?['state'] != 'ready' ||
          dirty ||
          invalidDraftInputs.isNotEmpty) {
        return;
      }
      await _start(ResponsibilityLane.notifications, {
        'action': 'enable',
        'expectedRuntimeRevision': ready!['expectedRuntimeRevision'],
        'expectedRuntimeGeneration': ready['expectedRuntimeGeneration'],
        'configurationSha256': responsibilityMap(
          ready['configuration'],
        )['configurationSha256'],
        'acknowledgeDestination': 'owner_in_app',
      }, id: selectedId);
    } else if (action == 'stop' &&
        current != null &&
        current['state'] != 'ended') {
      await _start(ResponsibilityLane.notifications, {
        'action': 'stop',
        'expectedRevision': current['revision'],
        'expectedGeneration': current['generation'],
      }, id: selectedId);
    }
  }

  Future<void> _start(
    ResponsibilityLane lane,
    ResponsibilityJson body, {
    String? id,
  }) async {
    if (!canMutate || !repository.supportsMutation(lane)) return;
    try {
      validateResponsibilityMutation(lane, body);
    } catch (_) {
      error = 'This exact request exceeds the supported shape or size bound. Shorten the draft before submitting.';
      _notify();
      return;
    }
    final epoch = _epoch, owner = repository.access.owner!;
    busy = true;
    error = null;
    notice = null;
    recoveryError = null;
    _saveTimer?.cancel();
    final intent = ResponsibilityIntent(
      lane: lane,
      body: freezeResponsibility(body) as ResponsibilityJson,
      key: _newKey(),
      id: id,
    );
    pending = intent;
    _notify();
    try {
      await _persist(epoch, owner);
    } catch (problem) {
      if (_current(epoch, owner)) {
        pending = null;
        busy = false;
        _recoveryConflict(problem);
        recoveryError ??=
            'The request could not be saved securely. It was not submitted.';
        _notify();
      }
      return;
    }
    if (!_current(epoch, owner)) return;
    await _dispatch(intent, epoch, owner, recovering: false);
  }

  Future<void> recoverPending() async {
    if (!canManage ||
        !recoveryReady ||
        busy ||
        pending == null ||
        !repository.supportsMutation(pending!.lane)) {
      return;
    }
    busy = true;
    error = null;
    _notify();
    await _dispatch(
      pending!,
      _epoch,
      repository.access.owner!,
      recovering: true,
    );
  }

  Future<void> _dispatch(
    ResponsibilityIntent intent,
    int epoch,
    ResponsibilityOwner owner, {
    required bool recovering,
  }) async {
    try {
      final result = await repository.mutate(
        intent.lane,
        intent.body,
        intent.key,
        id: intent.id,
        isCurrent: () => _current(epoch, owner) && identical(pending, intent),
      );
      if (!_current(epoch, owner) || !identical(pending, intent)) return;
      final record = {'intent': intent.json, 'result': result};
      accepted.removeWhere(
        (item) => responsibilityMap(item['intent'])['key'] == intent.key,
      );
      accepted.insert(0, freezeResponsibility(record) as ResponsibilityJson);
      if (accepted.length > 12) accepted.removeLast();
      pending = null;
      final current = responsibilityMap(result['current']),
          id =
              current[intent.lane == ResponsibilityLane.draft
                      ? 'id'
                      : 'responsibilityId']
                  as String;
      if (intent.lane == ResponsibilityLane.draft &&
          intent.body['action'] != 'review' &&
          responsibilitySame(
            _editors[intent.id ?? 'new'],
            intent.body['draft'],
          )) {
        _editors.remove(intent.id ?? 'new');
        _editorRevisions.remove(intent.id ?? 'new');
      }
      if (selectedId == intent.id || intent.id == null && selectedId == null) {
        selectedId = id;
        _selectionEpoch++;
        _fresh.clear();
        if (intent.lane == ResponsibilityLane.draft) {
          _views[ResponsibilityRead.detail] = {
            'record': current,
            'readiness': {'state': 'not_checked', 'issues': <String>[]},
          };
        }
        final kind = switch (intent.lane) {
          ResponsibilityLane.draft => ResponsibilityRead.detail,
          ResponsibilityLane.runtime => ResponsibilityRead.runtime,
          ResponsibilityLane.notifications => ResponsibilityRead.notifications,
        };
        _confirmedHeads[kind] = current;
      }
      notice =
          '${result['replayed'] == true ? 'Recovered' : 'Accepted'} ${intent.body['action']} receipt. Current reads may reflect a later revision.';
      try {
        await _persist(epoch, owner);
        if (_current(epoch, owner)) recoveryError = null;
      } catch (problem) {
        if (_current(epoch, owner)) {
          pending = intent;
          _recoveryConflict(problem);
          recoveryError ??= 'The server accepted this receipt, but local recovery could not be updated. Save recovery or recover this same request before another change.';
        }
      }
      if (!_current(epoch, owner)) return;
      _notify();
      await refresh();
    } catch (problem) {
      if (!_current(epoch, owner)) return;
      final status = problem is ApiException ? problem.statusCode : null;
      final rejected =
          !recovering &&
          const {400, 401, 403, 404, 409, 413, 415}.contains(status);
      error = rejected
          ? 'The server rejected this change (${status ?? 'unknown'}). Reload and review the current revision before another change.'
          : 'The outcome is unconfirmed. No new change or automatic retry will run. Recover the frozen request with its original key.';
      if (rejected) {
        pending = null;
        _fresh.clear();
        try {
          await _persist(epoch, owner);
        } catch (_) {
          if (_current(epoch, owner)) {
            pending = intent;
            recoveryError = 'The rejection could not be saved locally. The original request is retained for recovery.';
          }
        }
      }
    } finally {
      if (_current(epoch, owner)) {
        busy = false;
        _notify();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _epoch++;
    _saveTimer?.cancel();
    for (final token in _reads) {
      token.cancel();
    }
    repository.access.removeListener(_accessChanged);
    repository.access.removeSilentCloseListener(_silentlyInvalidate);
    super.dispose();
  }
}
