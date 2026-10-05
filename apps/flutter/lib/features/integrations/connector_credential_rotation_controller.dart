import 'package:flutter/foundation.dart';

import 'connector_contracts.dart';
import 'connector_control_contracts.dart';
import 'connector_credential_rotation_contracts.dart';
import 'connector_credential_rotation_recovery_store.dart';
import 'connector_credential_rotation_repository.dart';

class ConnectorCredentialRotationSequence {
  const ConnectorCredentialRotationSequence({
    required this.intent,
    this.prepareDispatched = false,
    this.prepared,
    this.preparedKind = 'read',
    this.preparedResponder,
    this.finalIntent,
    this.abandonDispatched = false,
    this.action,
    this.actionKind = 'read',
    this.actionResponder,
  });
  final ConnectorCredentialPreparationIntent intent;
  final bool prepareDispatched, abandonDispatched;
  final ConnectorCredentialPreparationRead? prepared;
  final String preparedKind, actionKind;
  final ConnectorOwner? preparedResponder, actionResponder;
  final ConnectorCredentialRotationIntent? finalIntent;
  final ConnectorCredentialRotationRead? action;
  bool get terminal =>
      action?.settled == true ||
      finalIntent == null && prepared?.availability == 'abandoned';
  ConnectorJson get stored => {
    'intent': intent.stored,
    'prepareDispatched': prepareDispatched,
    'prepared': prepared?.raw,
    'preparedKind': preparedKind,
    'preparedResponder': preparedResponder?.json,
    'finalIntent': finalIntent?.stored,
    'abandonDispatched': abandonDispatched,
    'action': action?.raw,
    'actionKind': actionKind,
    'actionResponder': actionResponder?.json,
  };
  ConnectorCredentialRotationSequence next({
    bool? dispatched,
    ConnectorCredentialPreparationRead? preparation,
    String? preparationKind,
    ConnectorOwner? responder,
    ConnectorCredentialRotationIntent? finalAction,
    bool? abandoning,
    ConnectorCredentialRotationRead? result,
    String? resultKind,
  }) => ConnectorCredentialRotationSequence(
    intent: intent,
    prepareDispatched: dispatched ?? prepareDispatched,
    prepared: preparation ?? prepared,
    preparedKind: preparationKind ?? preparedKind,
    preparedResponder: preparation != null ? responder : preparedResponder,
    finalIntent: finalAction ?? finalIntent,
    abandonDispatched: abandoning ?? abandonDispatched,
    action: result ?? action,
    actionKind: resultKind ?? actionKind,
    actionResponder: result != null ? responder : actionResponder,
  );
  static Future<ConnectorCredentialRotationSequence> restore(
    Object? value,
    ConnectorOwner owner,
  ) async {
    final row = connectorObject(
      value,
      'intent prepareDispatched prepared preparedKind preparedResponder finalIntent abandonDispatched action actionKind actionResponder',
    );
    connectorRequire(
      row['prepareDispatched'] is bool && row['abandonDispatched'] is bool,
    );
    final intent = await ConnectorCredentialPreparationIntent.restore(
      row['intent'],
      owner,
    );
    final pr = row['preparedResponder'] == null
        ? null
        : ConnectorOwner.restore(row['preparedResponder'], owner);
    final ar = row['actionResponder'] == null
        ? null
        : ConnectorOwner.restore(row['actionResponder'], owner);
    connectorRequire(
      (pr == null) == (row['prepared'] == null) &&
          (ar == null) == (row['action'] == null),
    );
    final prepared = pr == null
        ? null
        : await ConnectorCredentialPreparationRead.parse(
            row['prepared'],
            pr,
            intent: intent,
            kind: connectorText(row['preparedKind'], 10),
          );
    final finalIntent = row['finalIntent'] == null
        ? null
        : await ConnectorCredentialRotationIntent.restore(
            row['finalIntent'],
            owner,
          );
    final action = ar == null
        ? null
        : await ConnectorCredentialRotationRead.parse(
            row['action'],
            ar,
            intent: finalIntent!,
            kind: connectorText(row['actionKind'], 10),
          );
    connectorRequire(
      (prepared == null || prepared.prepared != null) &&
          (action == null || action.action != null) &&
          (row['prepareDispatched'] == true ||
              prepared == null &&
                  finalIntent == null &&
                  row['abandonDispatched'] == false) &&
          (finalIntent == null ||
              connectorSame(finalIntent.preparation.stored, intent.stored) &&
                  prepared?.proof != null &&
                  finalIntent.proof.sha256 == prepared!.proof!.sha256 &&
                  row['abandonDispatched'] == false) &&
          (prepared?.availability != 'consumed' ||
              finalIntent?.keySha256 == prepared?.consumedKeySha256),
    );
    return ConnectorCredentialRotationSequence(
      intent: intent,
      prepareDispatched: row['prepareDispatched'] as bool,
      prepared: prepared,
      preparedKind: connectorText(row['preparedKind'], 10),
      preparedResponder: pr,
      finalIntent: finalIntent,
      abandonDispatched: row['abandonDispatched'] as bool,
      action: action,
      actionKind: connectorText(row['actionKind'], 10),
      actionResponder: ar,
    );
  }
}

class ConnectorCredentialRotationController extends ChangeNotifier {
  ConnectorCredentialRotationController(
    this.repository,
    this.store, {
    DateTime Function()? now,
  }) : now = now ?? DateTime.now;
  final ConnectorCredentialRotationRepository repository;
  final ConnectorCredentialRotationRecoveryStore store;
  final DateTime Function() now;
  ConnectorOwner get owner => repository.owner;
  bool _open = true, _disposed = false;
  int _epoch = 0, _reviewEpoch = 0;
  Future<void>? _initialization;
  ConnectorJson? _expected;
  bool loaded = false,
      busy = false,
      reading = false,
      storageUnconfirmed = false;
  String? selectedId, error, readError;
  ConnectorReview? reviewed;
  ConnectorCredentialRotationSequence? sequence;
  bool get current {
    if (!_open) {
      return false;
    }
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
  bool get canPrepare =>
      _idle &&
      mayChange &&
      (sequence == null || sequence!.terminal) &&
      reviewed != null &&
      credentialRotationEligible(reviewed!);
  bool get canConfirm =>
      _idle &&
      mayChange &&
      sequence != null &&
      sequence!.intent.owner.key == owner.key &&
      sequence!.finalIntent == null &&
      !sequence!.abandonDispatched &&
      sequence!.prepared?.availability == 'ready' &&
      sequence!.prepared!.proof!.freshAt(now()) &&
      reviewed != null &&
      credentialRotationEligible(reviewed!) &&
      connectorSame(reviewed!.pin, sequence!.intent.review);
  bool get canAbandon =>
      _idle &&
      sequence != null &&
      sequence!.prepareDispatched &&
      sequence!.finalIntent == null &&
      !sequence!.terminal &&
      sequence!.prepared?.availability != 'consumed';
  ConnectorJson _journal([ConnectorCredentialRotationSequence? value]) => {
    'schemaVersion': 'connector-credential-rotation:1',
    'sequence': (value ?? sequence)?.stored,
  };
  Future<ConnectorCredentialRotationSequence?> _parse(
    ConnectorJson? raw,
  ) async {
    if (raw == null) {
      return null;
    }
    final row = connectorObject(raw, 'schemaVersion sequence');
    connectorRequire(row['schemaVersion'] == 'connector-credential-rotation:1');
    return row['sequence'] == null
        ? null
        : ConnectorCredentialRotationSequence.restore(row['sequence'], owner);
  }

  void _emit() {
    if (_open) {
      notifyListeners();
    }
  }

  /// Compare the complete journal before each host-broker CAS. A verified old
  /// receipt cannot overwrite a different window's pending sequence.
  Future<void> _save() async {
    storageUnconfirmed = true;
    final snapshot = _journal();
    final raw = await store.read();
    if (!current) {
      return;
    }
    connectorRequire(
      connectorSame(raw, _expected),
      'Protected credential recovery changed in another window.',
    );
    await store.write(snapshot, () => current);
    if (!current) {
      return;
    }
    _expected = connectorFreeze(snapshot);
    storageUnconfirmed = false;
  }

  bool _progress(
    ConnectorCredentialRotationSequence old,
    ConnectorCredentialRotationSequence next,
  ) {
    if (!connectorSame(old.intent.stored, next.intent.stored) ||
        old.prepareDispatched && !next.prepareDispatched ||
        old.abandonDispatched &&
            !next.abandonDispatched &&
            !(const [
              'abandoned',
              'consumed',
            ].contains(next.prepared?.availability)) ||
        old.finalIntent != null &&
            (next.finalIntent == null ||
                !connectorSame(
                  old.finalIntent!.identity,
                  next.finalIntent!.identity,
                ))) {
      return false;
    }
    final previous = old.prepared, following = next.prepared;
    if (previous != null) {
      if (following == null ||
          previous.proof != null &&
              !connectorSame(previous.proof!.raw, following.proof?.raw)) {
        return false;
      }
      if (const ['consumed', 'abandoned'].contains(previous.availability) &&
          !connectorSame(previous.prepared, following.prepared)) {
        return false;
      }
      if (previous.availability == 'expired' &&
          following.availability == 'ready') {
        return false;
      }
    }
    if (old.action != null &&
        (next.action == null ||
            !connectorSame(old.action!.acceptance, next.action!.acceptance) ||
            old.action!.settled &&
                !connectorSame(old.action!.action, next.action!.action))) {
      return false;
    }
    return true;
  }

  Future<void> initialize() => _initialization ??= reloadProtected();
  Future<void> reloadProtected() async {
    if (!current || busy) {
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
      final restored = await _parse(raw);
      if (!current) {
        return;
      }
      final held = sequence;
      if (!loaded ||
          connectorSame(raw, _journal()) ||
          held == null ||
          restored != null && _progress(held, restored) ||
          !held.prepareDispatched) {
        sequence = restored;
        _expected = raw;
        storageUnconfirmed = false;
        loaded = true;
      } else {
        storageUnconfirmed = true;
        error = connectorSame(raw, _expected)
            ? 'The protected save is unconfirmed. Save the retained evidence locally before another change.'
            : 'Another protected sequence differs. The original attempt and its verified evidence are retained.';
      }
    } catch (_) {
      if (current) {
        storageUnconfirmed = true;
        error = 'Protected credential recovery could not be verified.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> saveLocally() async {
    if (!current || busy || !loaded || !storageUnconfirmed) {
      return;
    }
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
    if (!current || busy) {
      return;
    }
    selectedId = controlId(id);
    await refresh();
  }

  Future<void> refresh() async {
    final id = selectedId ?? sequence?.intent.id;
    if (!current || busy || id == null) {
      return;
    }
    final epoch = ++_reviewEpoch;
    reading = true;
    reviewed = null;
    readError = null;
    _emit();
    try {
      final result = await repository.review(id);
      if (current && epoch == _reviewEpoch) {
        reviewed = result;
      }
    } catch (_) {
      if (current && epoch == _reviewEpoch) {
        readError = 'The exact connection review is unavailable. Read it again before confirming.';
      }
    } finally {
      if (current && epoch == _reviewEpoch) {
        reading = false;
        _emit();
      }
    }
  }

  Future<void> prepare(
    ConnectorReview review,
    String token,
    bool Function() admission, {
    required VoidCallback clearSecret,
  }) async {
    if (!canPrepare ||
        !identical(reviewed, review) ||
        !credentialRotationTokenValid(token) ||
        !admission() ||
        !current) {
      clearSecret();
      return;
    }
    final epoch = ++_epoch, selection = _reviewEpoch;
    bool owned() => current && epoch == _epoch;
    bool live() {
      if (!owned() || selection != _reviewEpoch || !admission()) {
        return false;
      }
      return owned();
    }

    busy = true;
    error = null;
    _emit();
    try {
      final fresh = await repository.review(review.connector!['id'] as String);
      if (!live()) {
        return;
      }
      connectorRequire(
        credentialRotationEligible(fresh) &&
            connectorSame(fresh.pin, review.pin),
      );
      final intent = await ConnectorCredentialPreparationIntent.prepare(
        owner,
        review,
      );
      if (!live()) {
        return;
      }
      sequence = ConnectorCredentialRotationSequence(intent: intent);
      await _save();
      if (!live() || storageUnconfirmed) {
        return;
      }
      sequence = sequence!.next(dispatched: true);
      // Erase the editor before the durable possible-dispatch marker. The
      // request's temporary local value is never part of the saved sequence.
      clearSecret();
      await _save();
      if (!live() || storageUnconfirmed) {
        return;
      }
      final response = await repository.prepare(intent, token, live);
      if (!owned()) {
        return;
      }
      await _acceptPreparation(response, 'submit');
    } catch (_) {
      if (owned()) {
        error = 'Preparation or its protected save is unconfirmed. Check exact recovery; the token will not be sent again.';
      }
    } finally {
      clearSecret();
      if (owned()) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> _acceptPreparation(
    ConnectorCredentialPreparationRead response,
    String kind,
  ) async {
    final held = sequence!;
    connectorRequire(response.prepared != null && held.finalIntent == null);
    var next = held.next(
      preparation: response,
      preparationKind: kind,
      responder: owner,
    );
    if (response.availability == 'consumed') {
      final linked = await ConnectorCredentialRotationIntent.create(
        held.intent,
        response.proof!,
        consumedKeySha256: response.consumedKeySha256,
      );
      if (!current) {
        return;
      }
      next = next.next(finalAction: linked, abandoning: false);
    }
    connectorRequire(_progress(held, next));
    sequence = next;
    final unconfirmed = storageUnconfirmed;
    storageUnconfirmed = true;
    _emit();
    if (!unconfirmed) {
      await _save();
    }
  }

  Future<void> confirm(
    ConnectorReview review,
    bool Function() admission,
  ) async {
    if (!canConfirm ||
        !identical(reviewed, review) ||
        !admission() ||
        !current) {
      return;
    }
    final held = sequence!, epoch = ++_epoch, selection = _reviewEpoch;
    bool owned() => current && epoch == _epoch;
    bool live() {
      if (!owned() ||
          !admission() ||
          selection != _reviewEpoch ||
          !held.prepared!.proof!.freshAt(now())) {
        return false;
      }
      return owned();
    }

    busy = true;
    error = null;
    _emit();
    try {
      final fresh = await repository.review(held.intent.id);
      if (!live()) {
        return;
      }
      connectorRequire(
        credentialRotationEligible(fresh) &&
            connectorSame(fresh.pin, held.intent.review),
      );
      final intent = await ConnectorCredentialRotationIntent.create(
        held.intent,
        held.prepared!.proof!,
      );
      if (!live()) {
        return;
      }
      // From this persisted identity onward, every recovery is the original
      // action GET. Even a later abandoned/expired preparation cannot clear it.
      sequence = held.next(finalAction: intent);
      await _save();
      if (!live() || storageUnconfirmed) {
        return;
      }
      final response = await repository.submit(intent, live);
      if (owned()) {
        await _acceptAction(response, 'submit');
      }
    } catch (_) {
      if (owned()) {
        error = 'Credential save or its protected receipt is unconfirmed. Check the exact action; it will not be repeated.';
      }
    } finally {
      if (owned()) {
        reviewed = null;
        _reviewEpoch++;
        busy = false;
        _emit();
      }
    }
  }

  Future<void> _acceptAction(
    ConnectorCredentialRotationRead response,
    String kind,
  ) async {
    connectorRequire(response.action != null && sequence!.finalIntent != null);
    final next = sequence!.next(
      result: response,
      resultKind: kind,
      responder: owner,
    );
    connectorRequire(_progress(sequence!, next));
    sequence = next;
    final unconfirmed = storageUnconfirmed;
    storageUnconfirmed = true;
    _emit();
    if (!unconfirmed) {
      await _save();
    }
  }

  Future<void> recover() async {
    if (!current || busy || sequence == null || !sequence!.prepareDispatched) {
      return;
    }
    busy = true;
    error = null;
    _emit();
    try {
      final held = sequence!;
      if (held.finalIntent != null) {
        final response = await repository.readAction(held.finalIntent!);
        if (!current) {
          return;
        }
        if (response.action == null) {
          error = 'No matching action receipt is visible. The original final action remains unconfirmed.';
        } else {
          await _acceptAction(response, 'read');
        }
      } else {
        final response = await repository.readPreparation(held.intent);
        if (!current) {
          return;
        }
        if (response.prepared == null) {
          error = 'No preparation is visible yet. A delayed attempt may still arrive; retain this key or explicitly abandon it.';
        } else {
          await _acceptPreparation(response, 'read');
          if (current && !storageUnconfirmed && sequence?.finalIntent != null) {
            final result = await repository.readAction(sequence!.finalIntent!);
            if (!current) {
              return;
            }
            if (result.action != null) {
              await _acceptAction(result, 'read');
            } else {
              error = 'The preparation was consumed. Its exact action receipt remains unconfirmed.';
            }
          }
        }
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

  Future<void> abandon(bool Function() admission) async {
    if (!canAbandon || !admission() || !current) {
      return;
    }
    final held = sequence!, epoch = ++_epoch;
    bool live() {
      if (!current || epoch != _epoch || !admission()) {
        return false;
      }
      return current;
    }

    busy = true;
    error = null;
    _emit();
    try {
      connectorRequire(held.finalIntent == null);
      sequence = held.next(abandoning: true);
      // The exact full-record comparison catches another window's final
      // dispatch before this distinct abandonment marker can be committed.
      await _save();
      if (!live() || storageUnconfirmed) {
        return;
      }
      final response = await repository.abandon(held.intent, live);
      if (current && epoch == _epoch) {
        await _acceptPreparation(response, 'abandon');
      }
    } catch (_) {
      if (current) {
        error = 'Abandonment is unconfirmed. Read the exact preparation; no connector change is authorized by this cleanup.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> discardLocal() async {
    if (!_idle || sequence == null || sequence!.prepareDispatched) {
      return;
    }
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
    if (!_open) {
      return;
    }
    _open = false;
    _epoch++;
    _reviewEpoch++;
    repository.close();
    reviewed = null;
    sequence = null;
    _expected = null;
    selectedId = null;
    loaded = false;
    busy = false;
    reading = false;
    storageUnconfirmed = false;
    error = null;
    readError = null;
  }

  void invalidate() {
    if (!_open) {
      return;
    }
    close();
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
