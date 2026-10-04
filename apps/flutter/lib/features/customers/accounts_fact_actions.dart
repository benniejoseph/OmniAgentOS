part of 'accounts_mutation_controller.dart';

extension AccountFactActions on AccountsMutationController {
  bool get factWritable =>
      available &&
      canManage() &&
      loaded &&
      _owner?.role != 'viewer' &&
      repository is AccountsFactRepository &&
      repository.access.operations.contains('customers.facts.record');
  AccountFactIntent? get pendingFact => factState.pending;
  void editFactDraft(AccountJson value) {
    final owner = _owner;
    if (!factWritable || locked || owner == null) {
      return;
    }
    factState.draft = AccountFactState.validateDraft(value, owner);
    if (_journalVersion < 4) {
      _journalVersion = 4;
    }
    _scheduleSave();
  }

  Future<void> submitFact(
    CustomerAccountSummary reviewed,
    AccountJson request, {
    required bool Function() isReviewCurrent,
  }) async {
    final owner = _owner, scope = workspace, transport = repository;
    if (!factWritable ||
        locked ||
        owner == null ||
        scope == null ||
        transport is! AccountsFactRepository ||
        !isReviewCurrent()) {
      return;
    }
    final epoch = _epoch, token = CancelToken();
    bool owned() => !_disposed && epoch == _epoch && owner.key == _owner?.key;
    bool current() => _current(epoch, owner) && isReviewCurrent();
    busy = true;
    message = null;
    _saveTimer?.cancel();
    _factRead = token;
    _factsChanged();
    var dispatched = false, prepared = false;
    try {
      final body = validateAccountFactRequest(request);
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
        'The Account changed. Refresh and review the manual assertion again.',
      );
      if (body['operation'] != 'create') {
        final selected = fresh.facts
            .where((fact) => fact.id == body['factId'])
            .firstOrNull;
        accountRequire(
          selected != null &&
              selected.fact['revision'] == body['expectedFactRevision'] &&
              selected.fact['factSha256'] == body['expectedFactSha256'] &&
              selected.source['sourceKind'] == 'manual' &&
              selected.source['permissionBasis'] == 'operator_assertion' &&
              selected.fact['recordedByActorId'] == 'actor:${owner.userId}',
          'The exact fact changed or was not authored manually by this account owner.',
        );
      }
      final key =
          'account-fact-${base64UrlEncode(List<int>.generate(24, (_) => Random.secure().nextInt(256))).replaceAll('=', '')}';
      final intent = await AccountFactIntent.prepare(
        owner,
        scope,
        key,
        fresh.account,
        body,
      );
      if (!current()) {
        return;
      }
      factState.pending = intent;
      factState.notSubmitted = null;
      if (_journalVersion < 4) {
        _journalVersion = 4;
      }
      prepared = true;
      await _save(epoch, owner, scope);
      if (!current()) {
        if (_current(epoch, owner)) {
          factState.pending = null;
          factState.notSubmitted = intent;
          await _save(epoch, owner, scope);
          message = 'The fact review closed before dispatch. No manual assertion was sent.';
        }
        return;
      }
      dispatched = true;
      final receipt = await (transport as AccountsFactRepository).mutateFact(
        intent,
        isCurrent: current,
      );
      if (!_current(epoch, owner)) {
        return;
      }
      accountRequire(receipt.acceptance != null);
      factState.accepted = receipt;
      factState.acceptedIntent = intent;
      factState.pending = null;
      factState.draft = null;
      factState.needsLocalSave = true;
      try {
        await _save(epoch, owner, scope);
        factState.needsLocalSave = false;
        message =
            'Manual fact ${body['operation']} accepted. This is an operator assertion, not verified external provenance.';
      } catch (_) {
        storageUnconfirmed = true;
        message = 'The fact acceptance is verified, but its local save is unconfirmed. Reload protected recovery.';
      }
    } catch (error) {
      if (!owned() || !_current(epoch, owner)) {
        return;
      }
      if (prepared && !dispatched) {
        storageUnconfirmed = true;
      }
      message = dispatched
          ? 'The fact outcome is unconfirmed. Read the exact saved receipt; this request will not be sent again.'
          : prepared
          ? 'The protected fact intent save is unconfirmed. Reload it before another action.'
          : error is FormatException
          ? error.message
          : 'The current fact review could not be verified. Nothing was submitted.';
    } finally {
      if (identical(_factRead, token)) {
        _factRead = null;
      }
      if (owned()) {
        busy = false;
        _factsChanged();
      }
    }
  }

  Future<void> recoverFact() async {
    final owner = _owner,
        scope = workspace,
        intent = factState.pending,
        transport = repository;
    if (!available ||
        !loaded ||
        busy ||
        storageUnconfirmed ||
        owner == null ||
        scope == null ||
        intent == null ||
        transport is! AccountsFactRepository ||
        !repository.access.operations.contains(
          'customers.facts.acceptance.get',
        )) {
      return;
    }
    final epoch = _epoch, token = CancelToken();
    busy = true;
    message = null;
    _factRead = token;
    _factsChanged();
    try {
      final receipt = await (transport as AccountsFactRepository)
          .readFactAcceptance(intent, token);
      if (!_current(epoch, owner)) {
        return;
      }
      if (receipt.acceptance == null) {
        message = 'No matching fact acceptance is available. The original request remains held.';
        return;
      }
      factState.pending = null;
      factState.acceptedIntent = intent;
      factState.accepted = receipt;
      factState.draft = null;
      factState.needsLocalSave = true;
      try {
        await _save(epoch, owner, scope);
        factState.needsLocalSave = false;
        message = 'The exact manual fact receipt was recovered. Current facts may be newer.';
      } catch (_) {
        storageUnconfirmed = true;
        message = 'The fact receipt is verified, but its protected local save is unconfirmed.';
      }
    } catch (_) {
      if (_current(epoch, owner)) {
        message = 'The exact fact receipt could not be confirmed. Its original request remains held; no write was repeated.';
      }
    } finally {
      if (identical(_factRead, token)) {
        _factRead = null;
      }
      if (!_disposed && epoch == _epoch && owner.key == _owner?.key) {
        busy = false;
        _factsChanged();
      }
    }
  }

  Future<void> settleFactLocally() async {
    final owner = _owner, scope = workspace;
    if (!available ||
        !loaded ||
        busy ||
        pending != null ||
        pendingHealth != null ||
        pendingWorkflow != null ||
        factState.pending != null ||
        _salesforceRecoveryHeld ||
        owner == null ||
        scope == null ||
        (factState.accepted == null && factState.notSubmitted == null)) {
      return;
    }
    final epoch = _epoch;
    busy = true;
    _factsChanged();
    try {
      await _save(epoch, owner, scope);
      if (_current(epoch, owner)) {
        factState.needsLocalSave = false;
        storageUnconfirmed = false;
        message = 'The verified fact outcome was saved locally. No server request was repeated.';
      }
    } catch (_) {
      if (_current(epoch, owner)) {
        storageUnconfirmed = true;
        message = 'Local fact recovery remains unconfirmed. Reload the protected journal.';
      }
    } finally {
      if (_current(epoch, owner)) {
        busy = false;
        _factsChanged();
      }
    }
  }
}
