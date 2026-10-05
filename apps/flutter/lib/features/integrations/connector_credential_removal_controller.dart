import 'package:flutter/foundation.dart';

import 'connector_contracts.dart';
import 'connector_control_contracts.dart';
import 'connector_credential_removal_contracts.dart';
import 'connector_credential_removal_recovery_store.dart';
import 'connector_credential_removal_repository.dart';

bool _sameIntent(
  ConnectorCredentialRemovalIntent a,
  ConnectorCredentialRemovalIntent b,
) =>
    a.key == b.key &&
    a.requestSha256 == b.requestSha256 &&
    connectorSame(a.identity, b.identity);

class ConnectorCredentialRemovalPending {
  const ConnectorCredentialRemovalPending(
    this.intent, {
    required this.dispatched,
  });
  final ConnectorCredentialRemovalIntent intent;
  final bool dispatched;
  ConnectorJson get stored => {
    'intent': intent.stored,
    'dispatched': dispatched,
  };
}

class ConnectorCredentialRemovalSavedAction {
  const ConnectorCredentialRemovalSavedAction(
    this.intent,
    this.response,
    this.responder, {
    required this.mutation,
  });
  final ConnectorCredentialRemovalIntent intent;
  final ConnectorCredentialRemovalRead response;
  final ConnectorOwner responder;
  final bool mutation;
  bool get settled => response.settled;
  ConnectorJson get stored => {
    'intent': intent.stored,
    'response': response.raw,
    'responder': responder.json,
    'mutation': mutation,
  };

  static Future<ConnectorCredentialRemovalSavedAction> restore(
    Object? value,
    ConnectorOwner owner,
  ) async {
    final row = connectorObject(value, 'intent response responder mutation');
    connectorRequire(row['mutation'] is bool);
    final intent = await ConnectorCredentialRemovalIntent.restore(
      row['intent'],
      owner,
    );
    final responder = ConnectorOwner.restore(row['responder'], owner);
    final response = await ConnectorCredentialRemovalRead.parse(
      row['response'],
      responder,
      kind: row['mutation'] == true ? 'submit' : 'read',
      keySha256: intent.keySha256,
      intent: intent,
    );
    connectorRequire(response.action != null);
    return ConnectorCredentialRemovalSavedAction(
      intent,
      response,
      responder,
      mutation: row['mutation'] as bool,
    );
  }
}

class _Journal {
  const _Journal(this.pending, this.accepted);
  final ConnectorCredentialRemovalPending? pending;
  final ConnectorCredentialRemovalSavedAction? accepted;

  static Future<_Journal> parse(Object? value, ConnectorOwner owner) async {
    if (value == null) return const _Journal(null, null);
    final row = connectorObject(value, 'schemaVersion pending accepted');
    connectorRequire(row['schemaVersion'] == 'connector-credential-removal:1');
    ConnectorCredentialRemovalPending? pending;
    if (row['pending'] != null) {
      final held = connectorObject(row['pending'], 'intent dispatched');
      connectorRequire(held['dispatched'] is bool);
      pending = ConnectorCredentialRemovalPending(
        await ConnectorCredentialRemovalIntent.restore(held['intent'], owner),
        dispatched: held['dispatched'] as bool,
      );
    }
    final accepted = row['accepted'] == null
        ? null
        : await ConnectorCredentialRemovalSavedAction.restore(
            row['accepted'],
            owner,
          );
    connectorRequire(
      accepted == null ||
          accepted.settled ||
          (pending != null &&
              pending.dispatched &&
              _sameIntent(pending.intent, accepted.intent)),
    );
    return _Journal(pending, accepted);
  }
}

/// A protected submission is never an upload queue. After dispatch becomes
/// possible, only the exact authenticated receipt may settle that submission.
class ConnectorCredentialRemovalController extends ChangeNotifier {
  ConnectorCredentialRemovalController(
    this.repository,
    this.store,
    String connectorId,
  ) : connectorId = controlId(connectorId);
  final String connectorId;
  final ConnectorCredentialRemovalRepository repository;
  final ConnectorCredentialRemovalRecoveryStore store;
  ConnectorOwner get owner => repository.owner;

  bool _open = true, _disposed = false;
  int _reviewEpoch = 0, _actionEpoch = 0;
  bool loaded = false,
      storageUnconfirmed = false,
      busy = false,
      reading = false;
  ConnectorReview? reviewed;
  ConnectorCredentialRemovalPending? pending;
  ConnectorCredentialRemovalSavedAction? accepted;
  String? error, readError;

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

  bool get canAct =>
      current &&
      mayChange &&
      loaded &&
      !busy &&
      !reading &&
      !storageUnconfirmed &&
      pending == null &&
      (accepted == null || accepted!.settled) &&
      reviewed != null &&
      credentialRemovalEligible(reviewed!);

  void _emit() {
    if (_open) notifyListeners();
  }

  ConnectorJson _journal() => {
    'schemaVersion': 'connector-credential-removal:1',
    'pending': pending?.stored,
    'accepted': accepted?.stored,
  };
  Future<void> _save() => store.write(_journal(), () => current);

  Future<_Journal> _readJournal(Object? value) async {
    final journal = await _Journal.parse(value, owner);
    connectorRequire(
      (journal.pending == null || journal.pending!.intent.id == connectorId) &&
          (journal.accepted == null ||
              journal.accepted!.intent.id == connectorId),
    );
    return journal;
  }

  Future<void> initialize() async {
    await reloadProtected();
    if (current) await refresh();
  }

  Future<void> reloadProtected() async {
    if (!current || busy) return;
    busy = true;
    error = null;
    _emit();
    final held = pending, known = accepted;
    try {
      final raw = await store.read();
      if (!current) return;
      final next = await _readJournal(raw);
      if (!current) return;
      if (held != null &&
          !(next.pending != null &&
              _sameIntent(held.intent, next.pending!.intent)) &&
          !(next.accepted != null &&
              next.accepted!.settled &&
              _sameIntent(held.intent, next.accepted!.intent))) {
        // An authenticated empty slot proves a never-dispatched preparation or
        // discard did not leave a pending operation. It cannot disprove a POST.
        connectorRequire(
          !held.dispatched && next.pending == null,
          'The protected record differs from this unconfirmed submission.',
        );
      }
      if (held != null &&
          held.dispatched &&
          next.pending != null &&
          !next.pending!.dispatched) {
        throw const FormatException('Dispatch remains unconfirmed.');
      }
      if (known != null &&
          next.accepted != null &&
          _sameIntent(known.intent, next.accepted!.intent)) {
        _assertReceiptProgress(known.response, next.accepted!.response);
      } else if (known != null) {
        final matchesPending =
            next.pending != null &&
            _sameIntent(next.pending!.intent, known.intent);
        final empty = next.pending == null && next.accepted == null;
        if (matchesPending || empty && held?.dispatched != true) {
          // A lost local receipt save may leave its exact pending record (and
          // an older settled receipt). Retain the newer verified receipt.
          connectorRequire(next.accepted == null || next.accepted!.settled);
          pending = known.settled
              ? null
              : ConnectorCredentialRemovalPending(
                  known.intent,
                  dispatched: true,
                );
          accepted = known;
          loaded = true;
          storageUnconfirmed = true;
          error = 'The verified receipt is retained. Save it locally before another change.';
          return;
        }
        connectorRequire(held != null);
      }
      pending = next.pending;
      accepted = next.accepted;
      storageUnconfirmed = false;
      if (pending != null &&
          accepted != null &&
          accepted!.settled &&
          _sameIntent(pending!.intent, accepted!.intent)) {
        pending = null;
        storageUnconfirmed = true;
      }
      loaded = true;
    } catch (_) {
      if (current) {
        storageUnconfirmed = true;
        error = 'Protected credential-removal recovery could not be reconciled. The original submission and verified receipt are retained.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> refresh() async {
    if (!current || busy) return;
    final epoch = ++_reviewEpoch;
    reading = true;
    reviewed = null;
    readError = null;
    _emit();
    try {
      final result = await repository.review(connectorId);
      if (current && epoch == _reviewEpoch) reviewed = result;
    } catch (_) {
      if (current && epoch == _reviewEpoch) {
        readError = 'This account’s credential removal review is unavailable. Read it again before making a change.';
      }
    } finally {
      if (current && epoch == _reviewEpoch) {
        reading = false;
        _emit();
      }
    }
  }

  Future<void> act(ConnectorReview review, bool Function() admission) async {
    if (!canAct ||
        !admission() ||
        !current ||
        !identical(reviewed, review) ||
        review.connector?['id'] != connectorId ||
        !credentialRemovalEligible(review)) {
      return;
    }
    final epoch = ++_actionEpoch, selection = _reviewEpoch;
    bool owned() => current && epoch == _actionEpoch;
    bool live() {
      if (!owned() || selection != _reviewEpoch || !admission()) return false;
      return owned();
    }

    busy = true;
    error = null;
    _emit();
    try {
      final fresh = await repository.review(connectorId);
      if (!live()) return;
      connectorRequire(
        credentialRemovalEligible(fresh) &&
            connectorSame(fresh.pin, review.pin),
      );
      final intent = await ConnectorCredentialRemovalIntent.prepare(
        owner,
        fresh,
      );
      if (!live()) return;
      pending = ConnectorCredentialRemovalPending(intent, dispatched: false);
      storageUnconfirmed = true;
      await _save();
      if (!owned()) return;
      storageUnconfirmed = false;
      if (!live()) {
        error = 'This preparation was not sent. Discard it locally before reviewing again.';
        return;
      }
      // Persist before POST. A crash at either side of dispatch therefore
      // restores an exact GET-only recovery, never an automatic retry.
      pending = ConnectorCredentialRemovalPending(intent, dispatched: true);
      storageUnconfirmed = true;
      await _save();
      if (!owned()) return;
      storageUnconfirmed = false;
      if (!live()) {
        error = 'Access changed before submission. Check the exact receipt; this action will not be resent.';
        return;
      }
      final result = await repository.submit(intent, live);
      if (!owned()) return;
      await _accept(intent, result, mutation: true);
    } catch (_) {
      if (owned()) {
        error = pending == null
            ? 'The connector or its credential version changed. Read and review it again.'
            : 'The action or protected save is unconfirmed. Check the exact receipt; this action will not be resent.';
      }
    } finally {
      if (owned()) {
        // Current data in a submission or receipt never authorizes a successor.
        reviewed = null;
        _reviewEpoch++;
        busy = false;
        _emit();
      }
    }
  }

  void _assertReceiptProgress(
    ConnectorCredentialRemovalRead previous,
    ConnectorCredentialRemovalRead next,
  ) {
    connectorRequire(connectorSame(previous.acceptance, next.acceptance));
    if (previous.settled) {
      connectorRequire(
        next.settled &&
            connectorSame(
              previous.action!['settlement'],
              next.action!['settlement'],
            ),
      );
    }
  }

  Future<void> _accept(
    ConnectorCredentialRemovalIntent intent,
    ConnectorCredentialRemovalRead response, {
    required bool mutation,
  }) async {
    connectorRequire(response.action != null);
    if (accepted != null && _sameIntent(accepted!.intent, intent)) {
      _assertReceiptProgress(accepted!.response, response);
    }
    final previousSaveUnconfirmed = storageUnconfirmed;
    final next = ConnectorCredentialRemovalSavedAction(
      intent,
      response,
      owner,
      mutation: mutation,
    );
    accepted = next;
    pending = next.settled
        ? null
        : ConnectorCredentialRemovalPending(intent, dispatched: true);
    storageUnconfirmed = true;
    _emit();
    if (previousSaveUnconfirmed) {
      error = 'The exact receipt is verified. Save it locally after reconciling protected recovery.';
      return;
    }
    await _save();
    if (current) {
      storageUnconfirmed = false;
      error = next.settled ? null : 'The action was accepted. Its result is unconfirmed; check its receipt again.';
    }
  }

  Future<void> recover() async {
    final intent =
        pending?.intent ??
        (accepted?.settled == false ? accepted!.intent : null);
    if (!current || busy || intent == null) return;
    busy = true;
    error = null;
    _emit();
    try {
      final result = await repository.recover(intent.keySha256, intent: intent);
      if (!current) return;
      if (result.action == null) {
        error = 'No matching receipt is visible. The original submission remains unconfirmed.';
        return;
      }
      await _accept(intent, result, mutation: false);
    } catch (_) {
      if (current) {
        error = 'The exact receipt could not be verified. The original submission and any verified receipt are retained.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> saveAcceptedLocally() async {
    final known = accepted;
    if (!current || busy || !loaded || known == null || !storageUnconfirmed) {
      return;
    }
    busy = true;
    error = null;
    _emit();
    try {
      final raw = await store.read();
      if (!current) return;
      final next = await _readJournal(raw);
      if (!current) return;
      // Matching an old accepted receipt is insufficient: another window may
      // own a newer pending slot. Never overwrite that key with this receipt.
      connectorRequire(
        next.pending == null || _sameIntent(next.pending!.intent, known.intent),
      );
      if (next.accepted != null) {
        if (_sameIntent(next.accepted!.intent, known.intent)) {
          _assertReceiptProgress(next.accepted!.response, known.response);
        } else {
          connectorRequire(next.accepted!.settled && next.pending != null);
        }
      }
      connectorRequire(current);
      await _save();
      if (current) storageUnconfirmed = false;
    } catch (_) {
      if (current) {
        error = 'The verified receipt is retained. Its local save cannot replace another protected submission.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> discardPrepared() async {
    if (!current ||
        busy ||
        storageUnconfirmed ||
        pending == null ||
        pending!.dispatched) {
      return;
    }
    final held = pending;
    busy = true;
    error = null;
    pending = null;
    storageUnconfirmed = true;
    _emit();
    try {
      await _save();
      if (current) storageUnconfirmed = false;
    } catch (_) {
      if (current) {
        pending = held;
        error = 'Local discard is unconfirmed. Reload protected recovery before another action.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  /// Synchronous and silent during Riverpod disposal.
  void close() {
    if (!_open) return;
    _open = false;
    _reviewEpoch++;
    _actionEpoch++;
    repository.close();
    reviewed = null;
    pending = null;
    accepted = null;
    error = null;
    readError = null;
    loaded = false;
    storageUnconfirmed = false;
    busy = false;
    reading = false;
  }

  void invalidate() {
    if (!_open) return;
    close();
    // Authority probes may run during build. Clear private state immediately
    // and repaint after the current stack, never from provider teardown.
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
