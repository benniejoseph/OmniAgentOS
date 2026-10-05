import 'package:flutter/foundation.dart';

import 'connector_contracts.dart';
import 'connector_control_contracts.dart';
import 'connector_github_upgrade_contracts.dart';
import 'connector_github_upgrade_recovery_store.dart';
import 'connector_github_upgrade_repository.dart';

class ConnectorGithubUpgradeSequence {
  const ConnectorGithubUpgradeSequence({
    required this.intent,
    this.dispatched = false,
    this.closeDispatched = false,
    this.response,
    this.responseKind = 'read',
    this.responder,
  });

  final ConnectorGithubUpgradeIntent intent;
  final bool dispatched, closeDispatched;
  final ConnectorGithubUpgradeRead? response;
  final String responseKind;
  final ConnectorOwner? responder;
  bool get terminal => response?.terminal == true;
  ConnectorJson get stored => {
    'intent': intent.stored,
    'dispatched': dispatched,
    'closeDispatched': closeDispatched,
    'response': response?.raw,
    'responseKind': responseKind,
    'responder': responder?.json,
  };

  ConnectorGithubUpgradeSequence next({
    bool? dispatched,
    bool? closing,
    ConnectorGithubUpgradeRead? response,
    String? kind,
    ConnectorOwner? responder,
  }) => ConnectorGithubUpgradeSequence(
    intent: intent,
    dispatched: dispatched ?? this.dispatched,
    closeDispatched: closing ?? closeDispatched,
    response: response ?? this.response,
    responseKind: kind ?? responseKind,
    responder: responder ?? this.responder,
  );

  static Future<ConnectorGithubUpgradeSequence> restore(
    Object? value,
    ConnectorOwner owner,
  ) async {
    final row = connectorObject(
      value,
      'intent dispatched closeDispatched response responseKind responder',
    );
    connectorRequire(
      row['dispatched'] is bool &&
          row['closeDispatched'] is bool &&
          const ['read', 'submit', 'close'].contains(row['responseKind']) &&
          (row['response'] == null) == (row['responder'] == null),
    );
    final intent = await ConnectorGithubUpgradeIntent.restore(
      row['intent'],
      owner,
    );
    final responder = row['responder'] == null
        ? null
        : ConnectorOwner.restore(row['responder'], owner);
    final response = responder == null
        ? null
        : await ConnectorGithubUpgradeRead.parse(
            row['response'],
            responder,
            intent: intent,
            kind: row['responseKind'] as String,
          );
    connectorRequire(
      (row['dispatched'] == true ||
              response == null && row['closeDispatched'] == false) &&
          (row['responseKind'] != 'close' || row['closeDispatched'] == true),
    );
    return ConnectorGithubUpgradeSequence(
      intent: intent,
      dispatched: row['dispatched'] as bool,
      closeDispatched: row['closeDispatched'] as bool,
      response: response,
      responseKind: row['responseKind'] as String,
      responder: responder,
    );
  }
}

class ConnectorGithubUpgradeController extends ChangeNotifier {
  ConnectorGithubUpgradeController(this.repository, this.store);

  final ConnectorGithubUpgradeRepository repository;
  final ConnectorGithubUpgradeRecoveryStore store;
  ConnectorOwner get owner => repository.owner;
  bool _open = true, _disposed = false;
  int _actionEpoch = 0, _reviewEpoch = 0;
  Future<void>? _initialization;
  ConnectorJson? _expected;
  bool loaded = false,
      busy = false,
      reading = false,
      storageUnconfirmed = false;
  String? error, readError, selectedId;
  ConnectorReview? reviewed;
  ConnectorGithubUpgradeReview? eligibility;
  ConnectorGithubUpgradeSequence? sequence;

  bool get current {
    if (!_open) return false;
    final allowed = repository.current;
    if (!_open || !allowed) {
      invalidate();
      return false;
    }
    return true;
  }

  bool get mayChange => const ['admin', 'system'].contains(owner.role);
  bool get _idle =>
      current && loaded && !busy && !reading && !storageUnconfirmed;
  bool get canAct =>
      _idle &&
      mayChange &&
      (sequence == null || sequence!.terminal) &&
      reviewed != null &&
      githubUpgradeEligible(reviewed!) &&
      eligibility?.matches(reviewed!) == true;
  bool eligibleFor(ConnectorReview review) =>
      current &&
      mayChange &&
      !reading &&
      reviewed != null &&
      eligibility?.matches(review) == true &&
      connectorSame(reviewed!.pin, review.pin) &&
      githubUpgradeEligible(review);
  bool get canRecover =>
      current && loaded && !busy && !reading && sequence?.dispatched == true;
  bool get canCloseAttempt =>
      _idle && sequence != null && sequence!.dispatched && !sequence!.terminal;

  void _emit() {
    if (_open) notifyListeners();
  }

  void hideReview() {
    _reviewEpoch++;
    reviewed = null;
    eligibility = null;
    reading = false;
    readError = null;
    repository.cancelReads();
    Future<void>.microtask(() {
      if (_open && !_disposed) notifyListeners();
    });
  }

  ConnectorJson _journal() => {
    'schemaVersion': 'connector-github-upgrade:1',
    'sequence': sequence?.stored,
  };

  Future<ConnectorGithubUpgradeSequence?> _parse(ConnectorJson? raw) async {
    if (raw == null) return null;
    final row = connectorObject(raw, 'schemaVersion sequence');
    connectorRequire(row['schemaVersion'] == 'connector-github-upgrade:1');
    return row['sequence'] == null
        ? null
        : ConnectorGithubUpgradeSequence.restore(row['sequence'], owner);
  }

  Future<void> _save() async {
    storageUnconfirmed = true;
    final snapshot = _journal();
    final raw = await store.read();
    if (!current) return;
    connectorRequire(
      connectorSame(raw, _expected),
      'Protected GitHub upgrade recovery changed in another window.',
    );
    await store.write(snapshot, () => current);
    if (!current) return;
    _expected = connectorFreeze(snapshot);
    storageUnconfirmed = false;
  }

  bool _progress(
    ConnectorGithubUpgradeSequence before,
    ConnectorGithubUpgradeSequence after,
  ) {
    if (!connectorSame(before.intent.stored, after.intent.stored) ||
        before.dispatched && !after.dispatched ||
        before.closeDispatched && !after.closeDispatched) {
      return false;
    }
    final old = before.response, next = after.response;
    if (old == null) return true;
    if (next == null ||
        !connectorSame(old.attempt, next.attempt) ||
        old.state == 'expired' && next.state == 'pending') {
      return false;
    }
    if (old.state == 'settled') {
      return next.state == 'settled' &&
          connectorSame(old.upgrade, next.upgrade);
    }
    if (old.state == 'closed') {
      return next.state == 'closed' && connectorSame(old.upgrade, next.upgrade);
    }
    if (old.state == 'expired' && next.state == 'settled') {
      return next.result?['status'] == 'failed';
    }
    return true;
  }

  Future<void> initialize() => _initialization ??= reloadProtected();

  Future<void> reloadProtected() async {
    if (!current || busy) return;
    busy = true;
    error = null;
    _emit();
    try {
      hideReview();
      final raw = await store.read();
      if (!current) return;
      final next = await _parse(raw);
      if (!current) return;
      final held = sequence;
      if (!loaded ||
          connectorSame(raw, _journal()) ||
          held == null ||
          next != null && _progress(held, next) ||
          !held.dispatched) {
        sequence = next;
        _expected = raw;
        storageUnconfirmed = false;
        loaded = true;
      } else {
        storageUnconfirmed = true;
        error = connectorSame(raw, _expected)
            ? 'The protected save is unconfirmed. Save retained evidence locally before another upgrade.'
            : 'Another protected sequence differs. The original attempt and verified evidence are retained.';
      }
    } catch (_) {
      if (current) {
        storageUnconfirmed = true;
        error = 'Protected GitHub upgrade recovery could not be verified.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> saveLocally() async {
    if (!current || busy || !loaded || !storageUnconfirmed) return;
    busy = true;
    error = null;
    _emit();
    try {
      await _save();
    } catch (_) {
      if (current) {
        error = 'Retained evidence cannot replace another protected sequence. Reload recovery.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> select(String id) async {
    if (!current || busy) return;
    selectedId = controlId(id);
    await refresh();
  }

  Future<void> refresh() async {
    final id = selectedId ?? sequence?.intent.id;
    if (!current || busy || id == null) return;
    repository.cancelReads();
    final epoch = ++_reviewEpoch;
    reading = true;
    reviewed = null;
    eligibility = null;
    readError = null;
    _emit();
    try {
      final value = await repository.review(id);
      if (current && epoch == _reviewEpoch) reviewed = value;
      if (!current || epoch != _reviewEpoch) return;
      final proof = await repository.eligibility(id);
      if (current && epoch == _reviewEpoch) eligibility = proof;
    } catch (_) {
      if (current && epoch == _reviewEpoch) {
        readError = 'The exact GitHub connection review is unavailable. Reload it before confirming.';
      }
    } finally {
      if (current && epoch == _reviewEpoch) {
        reading = false;
        _emit();
      }
    }
  }

  Future<void> act(ConnectorReview review, bool Function() admission) async {
    if (!canAct || !identical(review, reviewed) || !admission() || !current) {
      return;
    }
    final epoch = ++_actionEpoch, selection = _reviewEpoch;
    var prepared = false;
    bool owned() => current && epoch == _actionEpoch;
    bool live() {
      if (!owned() || selection != _reviewEpoch || !admission()) return false;
      return owned();
    }

    busy = true;
    error = null;
    _emit();
    try {
      final fresh = await repository.review(review.connector!['id'] as String);
      if (!live()) return;
      final freshEligibility = await repository.eligibility(
        review.connector!['id'] as String,
      );
      if (!live()) return;
      connectorRequire(
        githubUpgradeEligible(fresh) &&
            connectorSame(fresh.pin, review.pin) &&
            freshEligibility.matches(fresh),
      );
      final intent = await ConnectorGithubUpgradeIntent.prepare(
        owner,
        fresh,
        eligibility: freshEligibility,
      );
      if (!live()) return;
      sequence = ConnectorGithubUpgradeSequence(intent: intent);
      prepared = true;
      await _save();
      if (!live() || storageUnconfirmed) return;
      // Persist a possible-dispatch marker before the one-shot provider work.
      sequence = sequence!.next(dispatched: true);
      await _save();
      if (!live() || storageUnconfirmed) return;
      final response = await repository.submit(intent, live);
      if (owned()) await _accept(response, 'submit');
    } catch (_) {
      if (owned()) {
        error = prepared && sequence?.dispatched == true
            ? 'Upgrade or protected save is unconfirmed. Check the exact attempt; the upgrade will not be repeated automatically.'
            : 'The review or protected save changed. Reload recovery and review the connection again.';
      }
    } finally {
      if (owned()) {
        hideReview();
        busy = false;
        _emit();
      }
    }
  }

  Future<void> _accept(ConnectorGithubUpgradeRead response, String kind) async {
    connectorRequire(response.upgrade != null);
    final held = sequence!;
    connectorRequire(
      connectorSame(response.upgrade!['intent'], held.intent.identity),
    );
    final next = held.next(response: response, kind: kind, responder: owner);
    connectorRequire(_progress(held, next));
    sequence = next;
    final unconfirmed = storageUnconfirmed;
    storageUnconfirmed = true;
    if (response.terminal) hideReview();
    _emit();
    if (!unconfirmed) await _save();
  }

  Future<void> recover() async {
    if (!canRecover) return;
    busy = true;
    error = null;
    _emit();
    try {
      final response = await repository.recover(sequence!.intent);
      if (!current) return;
      if (response.upgrade == null) {
        error = 'No exact attempt is visible yet. A delayed request may still arrive; retain the original key.';
      } else {
        await _accept(response, 'read');
      }
    } catch (_) {
      if (current) {
        error = 'Exact recovery could not be verified. The original attempt and verified evidence remain protected.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> closeAttempt(bool Function() admission) async {
    if (!canCloseAttempt || !admission() || !current) return;
    final held = sequence!, epoch = ++_actionEpoch;
    bool owned() => current && epoch == _actionEpoch;
    bool live() {
      if (!owned() || !admission()) return false;
      return owned();
    }

    busy = true;
    error = null;
    _emit();
    try {
      // Keep the same original intent/key even if the close acknowledgement
      // is lost. Whole-record CAS protects a competing window's slot.
      sequence = held.next(closing: true);
      await _save();
      if (!live() || storageUnconfirmed) return;
      final response = await repository.closeAttempt(held.intent, live);
      if (owned()) await _accept(response, 'close');
    } catch (_) {
      if (owned()) {
        error = 'Close is unconfirmed. Check exact recovery or explicitly reconfirm this same close; the GitHub upgrade will not be repeated.';
      }
    } finally {
      if (owned()) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> discardLocal() async {
    if (!_idle || sequence == null || sequence!.dispatched) return;
    final held = sequence;
    busy = true;
    sequence = null;
    error = null;
    _emit();
    try {
      await _save();
    } catch (_) {
      if (current) {
        sequence = held;
        error = 'Local discard is unconfirmed. Reload protected recovery.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  void close() {
    if (!_open) return;
    _open = false;
    _actionEpoch++;
    _reviewEpoch++;
    repository.close();
    reviewed = null;
    eligibility = null;
    sequence = null;
    selectedId = null;
    _expected = null;
    loaded = false;
    busy = false;
    reading = false;
    storageUnconfirmed = false;
    error = null;
    readError = null;
  }

  void invalidate() {
    if (!_open) return;
    close();
    Future<void>.microtask(() {
      if (!_disposed) notifyListeners();
    });
  }

  @override
  void dispose() {
    _disposed = true;
    close();
    super.dispose();
  }
}
