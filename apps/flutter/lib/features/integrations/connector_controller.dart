import 'package:flutter/foundation.dart';

import 'connector_contracts.dart';
import 'connector_control_contracts.dart';
import 'connector_recovery_store.dart';
import 'connector_repository.dart';

class ConnectorPending {
  const ConnectorPending(this.intent, {required this.dispatched});
  final ConnectorIntent intent;
  final bool dispatched;
  ConnectorJson get stored => {
    'intent': intent.stored,
    'dispatched': dispatched,
  };
}

class ConnectorSavedAction {
  const ConnectorSavedAction(
    this.intent,
    this.response,
    this.responder, {
    required this.mutation,
  });
  final ConnectorIntent intent;
  final ConnectorActionRead response;
  final ConnectorOwner responder;
  final bool mutation;
  bool get settled => response.action?['state'] == 'settled';
  ConnectorJson get stored => {
    'intent': intent.stored,
    'response': response.raw,
    'responder': responder.json,
    'mutation': mutation,
  };
  static Future<ConnectorSavedAction> restore(
    Object? value,
    ConnectorOwner owner,
  ) async {
    final row = connectorObject(value, 'intent response responder mutation');
    connectorRequire(row['mutation'] is bool);
    final intent = await ConnectorIntent.restore(row['intent'], owner),
        responder = ConnectorOwner.restore(row['responder'], owner);
    final response = await ConnectorActionRead.parse(
      row['response'],
      responder,
      intent.keySha256,
      intent: intent,
      mutation: row['mutation'] as bool,
    );
    connectorRequire(response.action != null);
    return ConnectorSavedAction(
      intent,
      response,
      responder,
      mutation: row['mutation'] as bool,
    );
  }
}

/// One protected submission slot. Once dispatch is possible, only an exact
/// authenticated receipt read can resolve uncertainty; the POST is never replayed.
class ConnectorController extends ChangeNotifier {
  ConnectorController(this.repository, this.store);
  final ConnectorRepository repository;
  final ConnectorRecoveryStore store;
  ConnectorOwner get owner => repository.owner;
  bool _open = true, _disposed = false;
  int _listEpoch = 0, _selectionEpoch = 0, _actionEpoch = 0;
  bool loaded = false,
      storageUnconfirmed = false,
      busy = false,
      listing = false,
      reading = false;
  ConnectorInventory? inventory;
  ConnectorReview? selected;
  String? selectedKind, selectedId, error, readError;
  ConnectorPending? pending;
  ConnectorSavedAction? accepted;
  bool get current {
    if (!_open) {
      return false;
    }
    if (!repository.current || !_open) {
      invalidate();
      return false;
    }
    return true;
  }

  bool get mayManage => const ['admin', 'system'].contains(owner.role);
  bool get canAct =>
      current &&
      loaded &&
      !busy &&
      !storageUnconfirmed &&
      pending == null &&
      (accepted == null || accepted!.settled) &&
      mayManage;
  void _emit() {
    if (_open) {
      notifyListeners();
    }
  }

  bool _same(ConnectorIntent a, ConnectorIntent b) =>
      a.requestSha256 == b.requestSha256 &&
      a.key == b.key &&
      connectorSame(a.identity, b.identity);
  ConnectorJson _journal() => {
    'schemaVersion': 1,
    'pending': pending?.stored,
    'accepted': accepted?.stored,
  };
  Future<void> _save() => store.write(_journal(), () => current);

  Future<void> initialize() async {
    await reloadProtected();
    if (current) {
      await refresh();
    }
  }

  Future<void> reloadProtected() async {
    if (!current || busy) {
      return;
    }
    busy = true;
    error = null;
    _emit();
    final held = pending, known = accepted;
    try {
      final raw = await store.read();
      if (!current) {
        return;
      }
      ConnectorPending? next;
      ConnectorSavedAction? saved;
      if (raw != null) {
        final row = connectorObject(raw, 'schemaVersion pending accepted');
        connectorRequire(row['schemaVersion'] == 1);
        if (row['pending'] != null) {
          final value = connectorObject(row['pending'], 'intent dispatched');
          connectorRequire(value['dispatched'] is bool);
          next = ConnectorPending(
            await ConnectorIntent.restore(value['intent'], owner),
            dispatched: value['dispatched'] as bool,
          );
        }
        if (row['accepted'] != null) {
          saved = await ConnectorSavedAction.restore(row['accepted'], owner);
        }
      }
      if (!current) {
        return;
      }
      // A missing record cannot disprove possible dispatch. A preparation that
      // never reached dispatch can be discharged by this authenticated read,
      // including when its local discard committed but its response was lost.
      if (held != null &&
          (held.dispatched || next != null) &&
          !(next != null && _same(held.intent, next.intent)) &&
          !(saved != null &&
              saved.settled &&
              _same(held.intent, saved.intent))) {
        storageUnconfirmed = true;
        error = 'The saved action differs from this unconfirmed submission. Keep this window open and check its exact receipt.';
        return;
      }
      if (known != null &&
          (saved == null ||
              !_same(known.intent, saved.intent) ||
              !connectorSame(
                known.response.acceptance,
                saved.response.acceptance,
              ) ||
              known.settled &&
                  (!saved.settled ||
                      !connectorSame(
                        known.response.action!['settlement'],
                        saved.response.action!['settlement'],
                      )))) {
        if (next != null && _same(next.intent, known.intent)) {
          pending = known.settled ? null : next;
          accepted = known;
          storageUnconfirmed = true;
          loaded = true;
          error = 'The accepted receipt is retained. Save it locally before another change.';
          return;
        }
        if (held == null ||
            saved == null ||
            !saved.settled ||
            !_same(held.intent, saved.intent)) {
          storageUnconfirmed = true;
          error = 'The protected record changed. The accepted receipt is retained in this window.';
          return;
        }
      }
      if (held != null && held.dispatched && next != null && !next.dispatched) {
        storageUnconfirmed = true;
        error = 'Dispatch remains unconfirmed. Check the exact receipt before another change.';
        return;
      }
      pending = next;
      accepted = saved;
      // A committed settled receipt always closes its matching pending slot.
      if (pending != null &&
          accepted != null &&
          accepted!.settled &&
          _same(pending!.intent, accepted!.intent)) {
        pending = null;
        storageUnconfirmed = true;
      } else {
        storageUnconfirmed = false;
      }
      loaded = true;
    } catch (_) {
      if (current) {
        storageUnconfirmed = true;
        error = 'Protected connector recovery could not be verified. New changes are held.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> refresh() async {
    if (!current) {
      return;
    }
    final epoch = ++_listEpoch;
    listing = true;
    readError = null;
    _emit();
    try {
      final result = await repository.list();
      if (current && epoch == _listEpoch) {
        inventory = result;
      }
    } catch (_) {
      if (current && epoch == _listEpoch) {
        readError = 'The current connector list is unavailable. Previously loaded rows may be out of date.';
      }
    } finally {
      if (current && epoch == _listEpoch) {
        listing = false;
        _emit();
      }
    }
  }

  Future<void> select(String kind, String id) async {
    if (!current || busy) {
      return;
    }
    controlKind(kind);
    controlId(id);
    final epoch = ++_selectionEpoch;
    selectedKind = kind;
    selectedId = id;
    selected = null;
    reading = true;
    readError = null;
    _emit();
    try {
      final result = await repository.review(kind, id);
      if (current && epoch == _selectionEpoch) {
        selected = result;
      }
    } catch (_) {
      if (current && epoch == _selectionEpoch) {
        readError = 'This exact connector review is unavailable. Retry the read before changing it.';
      }
    } finally {
      if (current && epoch == _selectionEpoch) {
        reading = false;
        _emit();
      }
    }
  }

  Future<void> act(
    ConnectorReview reviewed,
    String action,
    bool Function() admission,
  ) async {
    if (!canAct ||
        !admission() ||
        !canAct ||
        reviewed.pin == null ||
        !reviewed.actions.contains(action)) {
      return;
    }
    final kind = reviewed.connector!['kind'] as String,
        id = reviewed.connector!['id'] as String;
    if (selectedKind != kind ||
        selectedId != id ||
        selected?.pin?['reviewSha256'] != reviewed.pin!['reviewSha256']) {
      return;
    }
    final epoch = ++_actionEpoch, selection = _selectionEpoch;
    bool owned() => current && epoch == _actionEpoch;
    bool live() =>
        owned() &&
        selection == _selectionEpoch &&
        admission() &&
        owned() &&
        selection == _selectionEpoch;
    busy = true;
    error = null;
    _emit();
    try {
      final fresh = await repository.review(kind, id);
      if (!live()) {
        return;
      }
      connectorRequire(
        fresh.pin != null &&
            connectorSame(fresh.pin, reviewed.pin) &&
            fresh.actions.contains(action),
        'The connector changed. Read and review it again.',
      );
      final intent = await ConnectorIntent.prepare(owner, fresh, action);
      if (!live()) {
        return;
      }
      pending = ConnectorPending(intent, dispatched: false);
      storageUnconfirmed = true;
      await _save();
      if (!owned()) {
        return;
      }
      storageUnconfirmed = false;
      if (!live()) {
        error = 'The prepared action was not sent. Discard the local preparation or review again.';
        return;
      }
      // Saving dispatched=true first makes every crash or lost response recover
      // with GET only, including a cancellation before the HTTP call begins.
      pending = ConnectorPending(intent, dispatched: true);
      storageUnconfirmed = true;
      await _save();
      if (!owned()) {
        return;
      }
      storageUnconfirmed = false;
      if (!live()) {
        error = 'The prepared action was not submitted after access changed. Check its exact receipt before clearing it.';
        return;
      }
      final result = await repository.submit(intent, live);
      if (!owned()) {
        return;
      }
      await _accept(intent, result, mutation: true);
    } catch (_) {
      if (owned()) {
        error = pending == null
            ? 'The current review could not be confirmed. Read it again before submitting.'
            : 'The action or its protected save is unconfirmed. Check the exact receipt; this change will not be sent again.';
      }
    } finally {
      if (owned()) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> _accept(
    ConnectorIntent intent,
    ConnectorActionRead response, {
    required bool mutation,
  }) async {
    connectorRequire(response.action != null);
    final next = ConnectorSavedAction(
      intent,
      response,
      owner,
      mutation: mutation,
    );
    if (accepted != null && _same(accepted!.intent, intent)) {
      connectorRequire(
        connectorSame(accepted!.response.acceptance, next.response.acceptance),
      );
      if (accepted!.settled) {
        connectorRequire(
          next.settled &&
              connectorSame(
                accepted!.response.action!['settlement'],
                next.response.action!['settlement'],
              ),
        );
      }
    }
    final previousSaveUnconfirmed = storageUnconfirmed;
    accepted = next;
    pending = next.settled ? null : ConnectorPending(intent, dispatched: true);
    storageUnconfirmed = true;
    _emit();
    if (previousSaveUnconfirmed) {
      error = 'The exact receipt is verified. Reload the protected record before saving this receipt locally.';
      return;
    }
    await _save();
    if (current) {
      storageUnconfirmed = false;
      error = next.settled ? null : 'The action was accepted. Its final result is not yet confirmed; check the receipt again.';
    }
  }

  Future<void> recover() async {
    final intent =
        pending?.intent ??
        (accepted?.settled == false ? accepted!.intent : null);
    if (!current || busy || intent == null) {
      return;
    }
    busy = true;
    error = null;
    _emit();
    try {
      final result = await repository.recover(intent);
      if (!current) {
        return;
      }
      if (result.action == null) {
        error = 'No matching receipt is currently visible. The original action remains unconfirmed.';
        return;
      }
      await _accept(intent, result, mutation: false);
    } catch (_) {
      if (current) {
        error = 'The exact receipt could not be verified. The original submission and any accepted receipt are retained.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> saveAcceptedLocally() async {
    if (!current ||
        busy ||
        !loaded ||
        accepted == null ||
        !storageUnconfirmed) {
      return;
    }
    busy = true;
    error = null;
    _emit();
    try {
      final raw = await store.read();
      if (!current) {
        return;
      }
      connectorRequire(raw != null);
      final row = connectorObject(raw, 'schemaVersion pending accepted');
      connectorRequire(row['schemaVersion'] == 1);
      var matches = false;
      ConnectorIntent? savedPending;
      if (row['pending'] != null) {
        final saved = connectorObject(row['pending'], 'intent dispatched');
        connectorRequire(saved['dispatched'] is bool);
        savedPending = await ConnectorIntent.restore(saved['intent'], owner);
        // Reading primes the storage CAS. It must not authorize overwriting a
        // different window's unresolved submission just because receipt A matches.
        connectorRequire(
          _same(savedPending, pending?.intent ?? accepted!.intent),
        );
        connectorRequire(
          saved['dispatched'] != true || pending == null || pending!.dispatched,
        );
        matches = _same(savedPending, accepted!.intent);
      }
      if (row['accepted'] != null) {
        final saved = await ConnectorSavedAction.restore(
          row['accepted'],
          owner,
        );
        if (_same(saved.intent, accepted!.intent)) {
          connectorRequire(
            connectorSame(
                  saved.response.acceptance,
                  accepted!.response.acceptance,
                ) &&
                (!saved.settled ||
                    accepted!.settled &&
                        connectorSame(
                          saved.response.action!['settlement'],
                          accepted!.response.action!['settlement'],
                        )),
          );
          matches = true;
        } else {
          connectorRequire(
            savedPending != null && _same(savedPending, accepted!.intent),
          );
        }
      }
      connectorRequire(matches && current);
      await _save();
      if (current) {
        storageUnconfirmed = false;
      }
    } catch (_) {
      if (current) {
        error = 'The accepted receipt is still visible, but its protected local save remains unconfirmed.';
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
      if (current) {
        storageUnconfirmed = false;
      }
    } catch (_) {
      if (current) {
        pending = held;
        error = 'Local discard is unconfirmed. Reload the protected record before another action.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  /// Silent close is safe during Riverpod teardown; no notifier is published.
  void close() {
    if (!_open) {
      return;
    }
    _open = false;
    _listEpoch++;
    _selectionEpoch++;
    _actionEpoch++;
    repository.close();
    inventory = null;
    selected = null;
    selectedKind = null;
    selectedId = null;
    pending = null;
    accepted = null;
    error = null;
    readError = null;
    loaded = false;
    busy = false;
    listing = false;
    reading = false;
  }

  void invalidate() {
    if (!_open) {
      return;
    }
    close();
    // Access can be checked during a build. Clear now and repaint after it.
    Future<void>.microtask(() {
      if (!_disposed) {
        notifyListeners();
      }
    });
  }

  @override
  void dispose() {
    _disposed = true;
    close();
    super.dispose();
  }
}
