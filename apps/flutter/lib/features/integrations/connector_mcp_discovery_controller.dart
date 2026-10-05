import 'package:flutter/foundation.dart';

import 'connector_contracts.dart';
import 'connector_control_contracts.dart';
import 'connector_mcp_discovery_contracts.dart';
import 'connector_mcp_discovery_recovery_store.dart';
import 'connector_mcp_discovery_repository.dart';

class ConnectorMcpDiscoverySequence {
  const ConnectorMcpDiscoverySequence({
    required this.intent,
    this.dispatched = false,
    this.closeDispatched = false,
    this.response,
    this.responseKind = 'read',
    this.responder,
  });
  final ConnectorMcpDiscoveryIntent intent;
  final bool dispatched, closeDispatched;
  final ConnectorMcpDiscoveryRead? response;
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
  ConnectorMcpDiscoverySequence next({
    bool? dispatched,
    bool? closing,
    ConnectorMcpDiscoveryRead? response,
    String? kind,
    ConnectorOwner? responder,
  }) => ConnectorMcpDiscoverySequence(
    intent: intent,
    dispatched: dispatched ?? this.dispatched,
    closeDispatched: closing ?? closeDispatched,
    response: response ?? this.response,
    responseKind: kind ?? responseKind,
    responder: responder ?? this.responder,
  );

  static Future<ConnectorMcpDiscoverySequence> restore(
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
    final intent = await ConnectorMcpDiscoveryIntent.restore(
      row['intent'],
      owner,
    );
    final responder = row['responder'] == null
        ? null
        : ConnectorOwner.restore(row['responder'], owner);
    final response = responder == null
        ? null
        : await ConnectorMcpDiscoveryRead.parse(
            row['response'],
            responder,
            intent: intent,
            kind: row['responseKind'] as String,
          );
    connectorRequire(
      (response == null || response.discovery != null) &&
          (row['dispatched'] == true ||
              response == null && row['closeDispatched'] == false) &&
          (row['responseKind'] != 'close' || row['closeDispatched'] == true),
    );
    return ConnectorMcpDiscoverySequence(
      intent: intent,
      dispatched: row['dispatched'] as bool,
      closeDispatched: row['closeDispatched'] as bool,
      response: response,
      responseKind: row['responseKind'] as String,
      responder: responder,
    );
  }
}

class ConnectorMcpDiscoveryController extends ChangeNotifier {
  ConnectorMcpDiscoveryController(this.repository, this.store);
  final ConnectorMcpDiscoveryRepository repository;
  final ConnectorMcpDiscoveryRecoveryStore store;
  ConnectorOwner get owner => repository.owner;
  bool _open = true, _disposed = false;
  int _epoch = 0, _reviewEpoch = 0;
  Future<void>? _initialization;
  ConnectorJson? _expected;
  bool loaded = false,
      busy = false,
      reading = false,
      storageUnconfirmed = false;
  String? error, readError, selectedId;
  ConnectorReview? reviewed;
  ConnectorMcpDiscoverySequence? sequence;

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
  bool get canAct =>
      _idle &&
      mayChange &&
      (sequence == null || sequence!.terminal) &&
      reviewed != null &&
      mcpDiscoveryEligible(reviewed!);
  bool get canCloseAttempt =>
      _idle && sequence != null && sequence!.dispatched && !sequence!.terminal;
  void _emit() {
    if (_open) {
      notifyListeners();
    }
  }

  void hideReview() {
    _reviewEpoch++;
    reviewed = null;
    reading = false;
    readError = null;
    repository.cancelReads();
    Future<void>.microtask(() {
      if (_open && !_disposed) {
        notifyListeners();
      }
    });
  }

  ConnectorJson _journal() => {
    'schemaVersion': 'connector-mcp-discovery:1',
    'sequence': sequence?.stored,
  };
  Future<ConnectorMcpDiscoverySequence?> _parse(ConnectorJson? raw) async {
    if (raw == null) {
      return null;
    }
    final row = connectorObject(raw, 'schemaVersion sequence');
    connectorRequire(row['schemaVersion'] == 'connector-mcp-discovery:1');
    return row['sequence'] == null
        ? null
        : ConnectorMcpDiscoverySequence.restore(row['sequence'], owner);
  }

  Future<void> _save() async {
    storageUnconfirmed = true;
    final snapshot = _journal();
    final raw = await store.read();
    if (!current) {
      return;
    }
    connectorRequire(
      connectorSame(raw, _expected),
      'Protected discovery recovery changed in another window.',
    );
    await store.write(snapshot, () => current);
    if (!current) {
      return;
    }
    _expected = connectorFreeze(snapshot);
    storageUnconfirmed = false;
  }

  bool _progress(
    ConnectorMcpDiscoverySequence before,
    ConnectorMcpDiscoverySequence after,
  ) {
    if (!connectorSame(before.intent.stored, after.intent.stored) ||
        before.dispatched && !after.dispatched ||
        before.closeDispatched && !after.closeDispatched) {
      return false;
    }
    final previous = before.response, next = after.response;
    if (previous == null) {
      return true;
    }
    if (next == null ||
        previous.attempt != null &&
            !connectorSame(previous.attempt, next.attempt) ||
        previous.state == 'expired' && next.state == 'pending') {
      return false;
    }
    return !previous.terminal ||
        connectorSame(previous.discovery, next.discovery);
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
      hideReview();
      final raw = await store.read();
      if (!current) {
        return;
      }
      final next = await _parse(raw);
      if (!current) {
        return;
      }
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
            ? 'The protected save is unconfirmed. Save the retained evidence locally before another attempt.'
            : 'Another protected sequence differs. The original attempt and verified evidence are retained.';
      }
    } catch (_) {
      if (current) {
        storageUnconfirmed = true;
        error = 'Protected discovery recovery could not be verified.';
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
    repository.cancelReads();
    final epoch = ++_reviewEpoch;
    reading = true;
    reviewed = null;
    readError = null;
    _emit();
    try {
      final value = await repository.review(id);
      if (current && epoch == _reviewEpoch) {
        reviewed = value;
      }
    } catch (_) {
      if (current && epoch == _reviewEpoch) {
        readError = 'The exact connection review is unavailable. Reload it before confirming discovery.';
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
    final epoch = ++_epoch, selection = _reviewEpoch;
    var prepared = false;
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
        mcpDiscoveryEligible(fresh) && connectorSame(fresh.pin, review.pin),
      );
      final intent = await ConnectorMcpDiscoveryIntent.prepare(owner, fresh);
      if (!live()) {
        return;
      }
      sequence = ConnectorMcpDiscoverySequence(intent: intent);
      prepared = true;
      await _save();
      if (!live() || storageUnconfirmed) {
        return;
      }
      // A protected possible-dispatch marker always precedes provider work.
      sequence = sequence!.next(dispatched: true);
      await _save();
      if (!live() || storageUnconfirmed) {
        return;
      }
      final response = await repository.submit(intent, live);
      if (owned()) {
        await _accept(response, 'submit');
      }
    } catch (_) {
      if (owned()) {
        error = prepared && sequence?.dispatched == true
            ? 'Discovery or its protected save is unconfirmed. Check the exact attempt; discovery will not be repeated.'
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

  Future<void> _accept(ConnectorMcpDiscoveryRead response, String kind) async {
    connectorRequire(response.discovery != null);
    final held = sequence!;
    connectorRequire(
      connectorSame(response.discovery!['intent'], held.intent.identity),
    );
    final next = held.next(response: response, kind: kind, responder: owner);
    connectorRequire(_progress(held, next));
    sequence = next;
    final unconfirmed = storageUnconfirmed;
    storageUnconfirmed = true;
    if (response.terminal) {
      // A historical receipt cannot authorize another attempt against the
      // review retained before that receipt. Require a fresh visible review.
      hideReview();
    }
    _emit();
    if (!unconfirmed) {
      await _save();
    }
  }

  Future<void> recover() async {
    if (!current || busy || reading || sequence?.dispatched != true) {
      return;
    }
    busy = true;
    error = null;
    _emit();
    try {
      final response = await repository.recover(sequence!.intent);
      if (!current) {
        return;
      }
      if (response.discovery == null) {
        error = 'No exact attempt is visible yet. A delayed request may still arrive; retain this key or explicitly close it.';
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
    if (!canCloseAttempt || !admission() || !current) {
      return;
    }
    final held = sequence!, epoch = ++_epoch;
    bool owned() => current && epoch == _epoch;
    bool live() {
      if (!owned() || !admission()) {
        return false;
      }
      return owned();
    }

    busy = true;
    error = null;
    _emit();
    try {
      // Whole-record CAS prevents this window from closing a different slot.
      sequence = held.next(closing: true);
      await _save();
      if (!live() || storageUnconfirmed) {
        return;
      }
      final response = await repository.closeAttempt(held.intent, live);
      if (owned()) {
        await _accept(response, 'close');
      }
    } catch (_) {
      if (owned()) {
        error = 'Close is unconfirmed. Check exact recovery or explicitly reconfirm this same close; discovery will not be repeated.';
      }
    } finally {
      if (owned()) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> discardLocal() async {
    if (!_idle || sequence == null || sequence!.dispatched) {
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
