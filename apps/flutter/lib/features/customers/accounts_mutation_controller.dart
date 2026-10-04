import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:dio/dio.dart';

import '../../core/network/api_exception.dart';
import 'accounts_contracts.dart';
import 'accounts_mutation_contracts.dart';
import 'accounts_recovery_store.dart';
import 'accounts_repository.dart';
import 'accounts_health_contracts.dart';

class AccountsMutationController extends ChangeNotifier {
  AccountsMutationController(
    this.repository,
    this.store, {
    required this.isVisible,
    required this.canManage,
  });
  final AccountsRepository repository;
  final AccountsRecoveryStore store;
  final bool Function() isVisible, canManage;
  AccountsOwner? _owner;
  String? workspace, targetId;
  AccountJson? draft;
  AccountMutationIntent? pending, acceptedIntent;
  AccountMutationReceipt? accepted;
  AccountHealthIntent? pendingHealth, acceptedHealthIntent;
  AccountHealthRead? acceptedHealth;
  AccountJson? healthDisposition;
  int _journalVersion = 1;
  CancelToken? _healthRead;
  bool busy = false,
      loaded = false,
      storageUnconfirmed = false,
      _disposed = false;
  String? message;
  int _epoch = 0, draftVersion = 0;
  Timer? _saveTimer;
  bool get available =>
      !_disposed &&
      isVisible() &&
      repository.authorityCurrent() &&
      repository.access.owner?.key == _owner?.key;
  bool get writable =>
      available &&
      canManage() &&
      _owner?.role != 'viewer' &&
      repository is AccountsMutationRepository &&
      loaded;
  bool get locked =>
      busy || pending != null || pendingHealth != null || storageUnconfirmed;
  bool get healthWritable =>
      available &&
      canManage() &&
      loaded &&
      _owner?.role != 'viewer' &&
      repository is AccountsHealthRepository &&
      repository.access.operations.contains('customers.health.evaluate');
  bool _current(int epoch, AccountsOwner owner) =>
      available && epoch == _epoch && owner.key == _owner?.key;
  AccountJson get _journal => {
    'schemaVersion': _journalVersion,
    'targetId': targetId,
    'draft': draft,
    'pending': pending?.stored,
    'acceptedIntent': acceptedIntent?.stored,
    'accepted': accepted?.raw,
    if (_journalVersion == 2)
      'health': {
        'pending': pendingHealth?.stored,
        'acceptedIntent': acceptedHealthIntent?.stored,
        'accepted': acceptedHealth?.raw,
        'disposition': healthDisposition,
      },
  };
  Future<void> _save(int epoch, AccountsOwner owner, String scope) => store
      .write(owner, scope, _journal, isCurrent: () => _current(epoch, owner));

  Future<void> bind(String scope) async {
    final owner = repository.access.owner;
    if (_disposed ||
        !isVisible() ||
        owner == null ||
        !repository.authorityCurrent()) {
      return;
    }
    if (_owner?.key == owner.key && workspace == scope && loaded) {
      return;
    }
    if (busy) {
      return;
    }
    if (_owner?.key != owner.key || workspace != scope) {
      pendingHealth = acceptedHealthIntent = null;
      acceptedHealth = null;
      healthDisposition = null;
      _journalVersion = 1;
    }
    _owner = owner;
    workspace = scope;
    await reload();
  }

  Future<void> reload() async {
    final owner = _owner, scope = workspace;
    if (!available || busy || owner == null || scope == null) {
      return;
    }
    final epoch = _epoch;
    _saveTimer?.cancel();
    busy = true;
    notifyListeners();
    try {
      final value = await store.read(owner, scope);
      if (!_current(epoch, owner)) {
        return;
      }
      AccountMutationIntent? restored, receiptIntent;
      AccountMutationReceipt? receipt;
      AccountJson? restoredDraft;
      String? restoredTarget;
      AccountHealthIntent? restoredHealth, healthReceiptIntent;
      AccountHealthRead? healthReceipt;
      AccountJson? restoredDisposition;
      var journalVersion = 1;
      if (value != null) {
        journalVersion = accountInt(value['schemaVersion'], min: 1, max: 2);
        accountKeys(value, [
          'schemaVersion',
          'targetId',
          'draft',
          'pending',
          'acceptedIntent',
          'accepted',
          if (journalVersion == 2) 'health',
        ]);
        restoredTarget = value['targetId'] == null
            ? null
            : accountId(value['targetId'], 'customer-account');
        if (value['draft'] != null) {
          restoredDraft = accountMap(value['draft']);
          accountRequire(
            utf8.encode(jsonEncode(restoredDraft)).length <= 20000,
          );
          accountKeys(restoredDraft, [
            'name',
            'lifecycle',
            'organizationEntityId',
            'accountOwner',
            'customerDataPurposeIds',
            if (restoredTarget != null) 'expectedRevision',
          ]);
          final displayOwner = accountMap(restoredDraft['accountOwner']);
          for (final text in [
            restoredDraft['name'],
            displayOwner['displayName'],
          ]) {
            accountRequire(
              text is String && text.trim() == text && text.length <= 240,
            );
          }
          accountMutationFields({
            ...restoredDraft,
            'name': restoredDraft['name'] == ''
                ? 'Draft'
                : restoredDraft['name'],
            'accountOwner': {
              ...displayOwner,
              'displayName': displayOwner['displayName'] == ''
                  ? 'Draft'
                  : displayOwner['displayName'],
            },
          }, create: restoredTarget == null);
        }
        if (value['pending'] != null) {
          restored = await AccountMutationIntent.restore(
            value['pending'],
            owner,
            scope,
          );
        }
        if (value['acceptedIntent'] != null) {
          receiptIntent = await AccountMutationIntent.restore(
            value['acceptedIntent'],
            owner,
            scope,
          );
        }
        accountRequire((receiptIntent == null) == (value['accepted'] == null));
        if (receiptIntent != null) {
          receipt = await AccountMutationReceipt.parse(
            accountMap(value['accepted']),
            receiptIntent,
          );
        }
        if (journalVersion == 2) {
          final health = accountMap(value['health']);
          accountKeys(health, [
            'pending',
            'acceptedIntent',
            'accepted',
            'disposition',
          ]);
          if (health['pending'] != null) {
            restoredHealth = await AccountHealthIntent.restore(
              health['pending'],
              owner,
              scope,
            );
          }
          if (health['acceptedIntent'] != null) {
            healthReceiptIntent = await AccountHealthIntent.restore(
              health['acceptedIntent'],
              owner,
              scope,
            );
          }
          accountRequire(
            (healthReceiptIntent == null) == (health['accepted'] == null),
          );
          if (healthReceiptIntent != null) {
            final raw = accountMap(health['accepted']);
            healthReceipt = await AccountHealthRead.parse(
              raw,
              healthReceiptIntent,
              mutation: raw.containsKey('replayed'),
            );
            accountRequire(healthReceipt.acceptance != null);
          }
          if (health['disposition'] != null) {
            final disposition = accountMap(health['disposition']);
            accountKeys(disposition, ['intent', 'response']);
            final intent = await AccountHealthIntent.restore(
              disposition['intent'],
              owner,
              scope,
            );
            if (disposition['response'] != null) {
              AccountHealthRefusal.parse(disposition['response'], intent);
            }
            restoredDisposition = accountFreeze(disposition);
          }
          accountRequire(
            restored == null || restoredHealth == null,
            'Only one Account request may await confirmation.',
          );
        }
      }
      if (!_current(epoch, owner)) {
        return;
      }
      // A readable journal is not evidence that an already dispatched request
      // disappeared. Retain its exact identity until this journal proves the
      // same pending intent or its bound settlement.
      final heldHealth = pendingHealth;
      bool matchesHeld(AccountHealthIntent? intent) =>
          heldHealth != null &&
          intent?.owner.key == heldHealth.owner.key &&
          intent?.workspaceId == heldHealth.workspaceId &&
          intent?.requestSha256 == heldHealth.requestSha256;
      final storedDispositionIntent = restoredDisposition == null
          ? null
          : accountMap(restoredDisposition['intent']);
      final dispositionSettlesHeld =
          heldHealth != null &&
          storedDispositionIntent?['workspaceId'] == scope &&
          storedDispositionIntent?['requestSha256'] == heldHealth.requestSha256;
      accountRequire(
        heldHealth == null ||
            matchesHeld(restoredHealth) ||
            (healthReceipt != null && matchesHeld(healthReceiptIntent)) ||
            dispositionSettlesHeld,
        'The protected journal does not confirm the pending health request. Its original identity remains held.',
      );
      draft = restoredDraft;
      targetId = restoredTarget;
      pending = restored;
      final knownHealth = acceptedHealth,
          knownHealthIntent = acceptedHealthIntent,
          knownDisposition = healthDisposition;
      final healthMatchesKnown =
          restoredHealth != null &&
          knownHealth != null &&
          knownHealthIntent?.owner.key == owner.key &&
          knownHealthIntent?.workspaceId == scope &&
          knownHealthIntent?.requestSha256 == restoredHealth.requestSha256;
      final dispositionMatchesKnown =
          restoredHealth != null &&
          knownDisposition != null &&
          accountMap(knownDisposition['intent'])['workspaceId'] == scope &&
          accountMap(knownDisposition['intent'])['requestSha256'] ==
              restoredHealth.requestSha256;
      pendingHealth = healthMatchesKnown || dispositionMatchesKnown
          ? null
          : restoredHealth;
      acceptedHealthIntent =
          (healthMatchesKnown ? knownHealthIntent : healthReceiptIntent) ??
          (knownHealthIntent?.owner.key == owner.key &&
                  knownHealthIntent?.workspaceId == scope
              ? knownHealthIntent
              : null);
      acceptedHealth =
          (healthMatchesKnown ? knownHealth : healthReceipt) ??
          (acceptedHealthIntent == knownHealthIntent ? knownHealth : null);
      healthDisposition = dispositionMatchesKnown
          ? knownDisposition
          : restoredDisposition;
      _journalVersion =
          journalVersion == 2 ||
              acceptedHealth != null ||
              healthDisposition != null
          ? 2
          : 1;
      // A later local read cannot revoke an already validated server receipt.
      final knownReceipt = accepted, knownIntent = acceptedIntent;
      acceptedIntent = receiptIntent ?? knownIntent;
      accepted = receipt ?? knownReceipt;
      final matchedKnown =
          restored != null &&
          knownIntent?.requestSha256 == restored.requestSha256 &&
          knownReceipt != null;
      if (matchedKnown) {
        pending = null;
        accepted = knownReceipt;
        acceptedIntent = knownIntent;
        draft = null;
        targetId = null;
      }
      storageUnconfirmed =
          matchedKnown || healthMatchesKnown || dispositionMatchesKnown;
      loaded = true;
      draftVersion++;
      message = healthMatchesKnown || dispositionMatchesKnown
          ? 'The verified health outcome is retained. Save it locally without another evaluation.'
          : restoredHealth != null
          ? 'A saved health evaluation is unconfirmed. Read its exact receipt; evaluation is never repeated during recovery.'
          : matchedKnown
          ? 'The accepted server receipt is retained. Save this receipt locally to settle recovery; no server request is needed.'
          : restored == null
          ? 'Protected Account recovery loaded. Nothing was submitted.'
          : 'A saved request may already have committed. Review it, then retry only this same request and key.';
    } catch (_) {
      if (!_current(epoch, owner)) {
        return;
      }
      storageUnconfirmed = true;
      message = 'Protected Account recovery could not be verified. Reload before any new submission.';
    } finally {
      if (_current(epoch, owner)) {
        busy = false;
        notifyListeners();
      }
    }
  }

  void begin({CustomerAccountSummary? account}) {
    if (!writable || locked) {
      return;
    }
    if (account != null &&
        account.raw['ownerActorId'] != 'actor:${_owner!.userId}') {
      return;
    }
    targetId = account?.id;
    draft = account == null
        ? {
            'name': '',
            'lifecycle': 'prospect',
            'organizationEntityId': null,
            'accountOwner': {
              'ownerKind': 'actor',
              'ownerId': 'actor:${_owner!.userId}',
              'displayName': 'Current account owner',
            },
            'customerDataPurposeIds': [
              'customer_success.account.manage',
              'customer_success.account.read',
            ],
          }
        : {
            'expectedRevision': account.revision,
            'name': account.name,
            'lifecycle': account.lifecycle,
            'organizationEntityId': account.raw['organizationEntityId'],
            'accountOwner': account.raw['accountOwner'],
            'customerDataPurposeIds':
                (account.raw['crmPermissions']
                    as Map)['customerDataPurposeIds'],
          };
    draftVersion++;
    message = null;
    notifyListeners();
    _scheduleSave();
  }

  Future<void> settleReceiptLocally() async {
    final owner = _owner, scope = workspace;
    if (!writable ||
        busy ||
        pending != null ||
        pendingHealth != null ||
        accepted == null ||
        owner == null ||
        scope == null) {
      return;
    }
    final epoch = _epoch;
    busy = true;
    notifyListeners();
    try {
      await _save(epoch, owner, scope);
      if (_current(epoch, owner)) {
        storageUnconfirmed = false;
        message = 'Accepted Account receipt saved locally. No server request was repeated.';
      }
    } catch (_) {
      if (_current(epoch, owner)) {
        storageUnconfirmed = true;
        message = 'Local settlement remains unconfirmed. Reload the protected journal before trying again.';
      }
    } finally {
      if (_current(epoch, owner)) {
        busy = false;
        notifyListeners();
      }
    }
  }

  void edit(AccountJson value) {
    if (!writable || locked || draft == null) {
      return;
    }
    accountRequire(utf8.encode(jsonEncode(value)).length <= 20000);
    draft = accountFreeze(value);
    _scheduleSave();
  }

  void _scheduleSave() {
    _saveTimer?.cancel();
    _saveTimer = Timer(const Duration(milliseconds: 500), saveDraft);
  }

  Future<void> saveDraft() async {
    final owner = _owner, scope = workspace;
    if (!writable || locked || owner == null || scope == null) {
      return;
    }
    final epoch = _epoch;
    busy = true;
    notifyListeners();
    try {
      await _save(epoch, owner, scope);
      if (_current(epoch, owner)) {
        message = 'Draft saved encrypted on this device. Nothing submitted.';
      }
    } catch (_) {
      if (_current(epoch, owner)) {
        storageUnconfirmed = true;
        message = 'The protected save is unconfirmed. Reload its exact journal before submitting.';
      }
    } finally {
      if (_current(epoch, owner)) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<void> submit({bool recover = false}) async {
    final owner = _owner, scope = workspace, transport = repository;
    if (!writable ||
        busy ||
        storageUnconfirmed ||
        pendingHealth != null ||
        owner == null ||
        scope == null ||
        transport is! AccountsMutationRepository) {
      return;
    }
    if (recover ? pending == null : pending != null || draft == null) {
      return;
    }
    final epoch = _epoch;
    _saveTimer?.cancel();
    busy = true;
    message = null;
    notifyListeners();
    var dispatched = false;
    try {
      if (!recover) {
        final key =
            'account-${base64UrlEncode(List<int>.generate(24, (_) => Random.secure().nextInt(256))).replaceAll('=', '')}';
        final intent = await AccountMutationIntent.prepare(
          owner,
          scope,
          key,
          draft!,
          selectedId: targetId,
        );
        if (!_current(epoch, owner)) {
          return;
        }
        pending = intent;
      }
      // A durable exact intent is required before every initial dispatch.
      await _save(epoch, owner, scope);
      if (!_current(epoch, owner)) {
        return;
      }
      final intent = pending!;
      dispatched = true;
      final receipt = await (transport as AccountsMutationRepository).mutate(
        intent,
        isCurrent: () => _current(epoch, owner),
      );
      if (!_current(epoch, owner)) {
        return;
      }
      accepted = receipt;
      acceptedIntent = intent;
      pending = null;
      draft = null;
      targetId = null;
      draftVersion++;
      try {
        await _save(epoch, owner, scope);
      } catch (_) {
        if (_current(epoch, owner)) {
          storageUnconfirmed = true;
          message = 'The exact Account change was accepted. Its local receipt save is unconfirmed; reload recovery before another change.';
        }
        return;
      }
      if (_current(epoch, owner)) {
        message =
            'Account revision ${receipt.account.revision} accepted. Refresh current account data separately; this receipt remains valid if that read fails.';
      }
    } catch (error) {
      if (!_current(epoch, owner)) {
        return;
      }
      if (!dispatched) {
        if (pending != null) {
          storageUnconfirmed = true;
        }
        message = error is FormatException && pending == null ? error.message : 'The protected request save is unconfirmed. Reload before any submission.';
      } else if (!recover &&
          error is ApiException &&
          [400, 401, 403, 404, 409, 413, 415, 422].contains(error.statusCode)) {
        pending = null;
        message = 'The server refused this attempt. Refresh the Account and review the draft before creating a new request.';
        try {
          await _save(epoch, owner, scope);
        } catch (_) {
          storageUnconfirmed = true;
        }
      } else {
        message = 'The Account outcome is unconfirmed. The exact saved request and key are retained. No automatic retry or replacement request was sent.';
      }
    } finally {
      if (_current(epoch, owner)) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<void> evaluateHealth(
    CustomerAccountSummary reviewed, {
    required bool Function() isReviewCurrent,
  }) async {
    final owner = _owner, scope = workspace, transport = repository;
    if (!healthWritable ||
        locked ||
        owner == null ||
        scope == null ||
        transport is! AccountsHealthRepository ||
        !isReviewCurrent()) {
      return;
    }
    final epoch = _epoch, token = CancelToken();
    bool owned() => !_disposed && epoch == _epoch && owner.key == _owner?.key;
    bool current() => _current(epoch, owner) && isReviewCurrent();
    busy = true;
    message = null;
    _saveTimer?.cancel();
    _healthRead = token;
    notifyListeners();
    var dispatched = false, prepared = false;
    try {
      final fresh = await repository.detail(
        reviewed.id,
        token,
        workspaceId: scope,
      );
      if (!current()) {
        return;
      }
      accountRequire(
        fresh.context.accessLevel != 'reader' &&
            fresh.account.id == reviewed.id &&
            fresh.account.revision == reviewed.revision &&
            fresh.account.sha256 == reviewed.sha256 &&
            fresh.account.raw['ownerActorId'] == 'actor:${owner.userId}',
        'The Account changed. Refresh and review it again before evaluating health.',
      );
      final key =
          'account-health-${base64UrlEncode(List<int>.generate(24, (_) => Random.secure().nextInt(256))).replaceAll('=', '')}';
      final intent = await AccountHealthIntent.prepare(
        owner,
        scope,
        key,
        reviewed,
      );
      if (!current()) {
        return;
      }
      pendingHealth = intent;
      prepared = true;
      healthDisposition = null;
      _journalVersion = 2;
      await _save(epoch, owner, scope);
      if (!current()) {
        // While this owner remains current, persist the locally known absence
        // of dispatch. Scope loss leaves the original protected intent held.
        if (_current(epoch, owner)) {
          pendingHealth = null;
          healthDisposition = accountFreeze({
            'intent': intent.stored,
            'response': null,
          });
          await _save(epoch, owner, scope);
          message = 'The review closed before submission. No health evaluation was sent.';
        }
        return;
      }
      dispatched = true;
      final receipt = await (transport as AccountsHealthRepository)
          .evaluateHealth(intent, isCurrent: current);
      if (!_current(epoch, owner)) {
        return;
      }
      accountRequire(receipt.acceptance != null);
      acceptedHealth = receipt;
      acceptedHealthIntent = intent;
      pendingHealth = null;
      try {
        await _save(epoch, owner, scope);
        message = 'Health evaluation accepted. Its saved receipt is separate from current health reads.';
      } catch (_) {
        storageUnconfirmed = true;
        message = 'Health evaluation accepted. Its local receipt save is unconfirmed; reload recovery before another action.';
      }
    } catch (error) {
      if (!owned() || !_current(epoch, owner)) {
        return;
      }
      if (!dispatched) {
        if (prepared) {
          storageUnconfirmed = true;
          message = 'The protected health request save is unconfirmed. Reload it before any submission.';
        } else {
          message = error is FormatException ? error.message : 'The current Account could not be confirmed. No health evaluation was sent.';
        }
      } else {
        AccountHealthRefusal? refusal;
        if (error is ApiException &&
            error.statusCode == 409 &&
            error.responseData != null &&
            pendingHealth != null) {
          try {
            refusal = AccountHealthRefusal.parse(
              error.responseData,
              pendingHealth!,
            );
          } on FormatException {
            // Generic or mismatched errors do not establish non-admission.
          }
        }
        if (refusal != null) {
          healthDisposition = accountFreeze({
            'intent': pendingHealth!.stored,
            'response': refusal.raw,
          });
          pendingHealth = null;
          message =
              '${refusal.message} This exact attempt was not admitted. Refresh before another review.';
          try {
            await _save(epoch, owner, scope);
          } catch (_) {
            storageUnconfirmed = true;
          }
        } else {
          message = 'Health evaluation is unconfirmed. The saved request is retained. Read its exact receipt; no evaluation will be repeated.';
        }
      }
    } finally {
      if (identical(_healthRead, token)) {
        _healthRead = null;
      }
      if (owned()) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<void> recoverHealth() async {
    final owner = _owner,
        scope = workspace,
        intent = pendingHealth,
        transport = repository;
    if (!available ||
        !loaded ||
        busy ||
        storageUnconfirmed ||
        owner == null ||
        scope == null ||
        intent == null ||
        transport is! AccountsHealthRepository ||
        !repository.access.operations.contains(
          'customers.health.evaluations.get',
        )) {
      return;
    }
    final epoch = _epoch, token = CancelToken();
    _healthRead = token;
    busy = true;
    notifyListeners();
    try {
      final receipt = await (transport as AccountsHealthRepository)
          .readHealthEvaluation(intent, token);
      if (!_current(epoch, owner)) {
        return;
      }
      if (receipt.acceptance == null) {
        message = 'No matching acceptance was returned. This evaluation remains unconfirmed; no request was repeated.';
        return;
      }
      acceptedHealth = receipt;
      acceptedHealthIntent = intent;
      pendingHealth = null;
      try {
        await _save(epoch, owner, scope);
        message = 'The original health evaluation acceptance was recovered. Current Account or health data may be newer.';
      } catch (_) {
        storageUnconfirmed = true;
        message = 'The health receipt was recovered, but its local save is unconfirmed. Reload recovery before another action.';
      }
    } catch (_) {
      if (_current(epoch, owner)) {
        message = 'The exact health receipt could not be confirmed. The saved request remains held; no evaluation was repeated.';
      }
    } finally {
      if (identical(_healthRead, token)) {
        _healthRead = null;
      }
      if (_current(epoch, owner)) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<void> settleHealthLocally() async {
    final owner = _owner, scope = workspace;
    if (!available ||
        !loaded ||
        busy ||
        pendingHealth != null ||
        pending != null ||
        owner == null ||
        scope == null ||
        (acceptedHealth == null && healthDisposition == null)) {
      return;
    }
    final epoch = _epoch;
    busy = true;
    notifyListeners();
    try {
      await _save(epoch, owner, scope);
      if (_current(epoch, owner)) {
        storageUnconfirmed = false;
        message = 'The verified health outcome was saved locally. No server request was repeated.';
      }
    } catch (_) {
      if (_current(epoch, owner)) {
        storageUnconfirmed = true;
        message = 'Local health recovery remains unconfirmed. Reload the protected journal.';
      }
    } finally {
      if (_current(epoch, owner)) {
        busy = false;
        notifyListeners();
      }
    }
  }

  void hide() {
    _saveTimer?.cancel();
    _healthRead?.cancel('Account health access changed.');
    _healthRead = null;
    _epoch++;
    _owner = null;
    workspace = null;
    targetId = null;
    draft = null;
    pending = acceptedIntent = null;
    accepted = null;
    pendingHealth = acceptedHealthIntent = null;
    acceptedHealth = null;
    healthDisposition = null;
    _journalVersion = 1;
    busy = loaded = storageUnconfirmed = false;
    message = null;
    draftVersion++;
  }

  @override
  void dispose() {
    _disposed = true;
    hide();
    super.dispose();
  }
}
