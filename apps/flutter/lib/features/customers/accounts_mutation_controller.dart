import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'accounts_contracts.dart';
import 'accounts_mutation_contracts.dart';
import 'accounts_recovery_store.dart';
import 'accounts_repository.dart';

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
  bool get locked => busy || pending != null || storageUnconfirmed;
  bool _current(int epoch, AccountsOwner owner) =>
      available && epoch == _epoch && owner.key == _owner?.key;
  AccountJson get _journal => {
    'schemaVersion': 1,
    'targetId': targetId,
    'draft': draft,
    'pending': pending?.stored,
    'acceptedIntent': acceptedIntent?.stored,
    'accepted': accepted?.raw,
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
      if (value != null) {
        accountKeys(value, [
          'schemaVersion',
          'targetId',
          'draft',
          'pending',
          'acceptedIntent',
          'accepted',
        ]);
        accountRequire(value['schemaVersion'] == 1);
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
      }
      if (!_current(epoch, owner)) {
        return;
      }
      draft = restoredDraft;
      targetId = restoredTarget;
      pending = restored;
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
      storageUnconfirmed = matchedKnown;
      loaded = true;
      draftVersion++;
      message = matchedKnown
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

  void hide() {
    _saveTimer?.cancel();
    _epoch++;
    _owner = null;
    workspace = null;
    targetId = null;
    draft = null;
    pending = acceptedIntent = null;
    accepted = null;
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
