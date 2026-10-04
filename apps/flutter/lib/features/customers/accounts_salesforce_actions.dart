part of 'accounts_mutation_controller.dart';

extension AccountSalesforceActions on AccountsMutationController {
  bool get salesforceWritable =>
      available &&
      canManage() &&
      loaded &&
      _owner?.role != 'viewer' &&
      repository is AccountsSalesforceRepository &&
      repository.access.operations.contains(
        'customers.salesforce.actions.submit',
      );
  Future<void> loadSalesforceReview({
    required bool Function() isReviewCurrent,
  }) async {
    final owner = _owner, scope = workspace, transport = repository;
    if (!available ||
        !loaded ||
        busy ||
        owner == null ||
        scope == null ||
        transport is! AccountsSalesforceRepository ||
        !repository.access.operations.contains(
          'customers.salesforce.actions.review',
        ) ||
        !isReviewCurrent()) {
      return;
    }
    final epoch = _epoch, token = CancelToken();
    busy = true;
    message = null;
    _salesforceRead = token;
    _factsChanged();
    try {
      final review = await (transport as AccountsSalesforceRepository)
          .reviewSalesforce(scope, token);
      if (_current(epoch, owner) && workspace == scope && isReviewCurrent()) {
        salesforceReview = review;
      }
    } catch (_) {
      if (_current(epoch, owner) && workspace == scope) {
        salesforceReview = null;
        message = 'The current Salesforce connection review is unavailable.';
      }
    } finally {
      if (identical(_salesforceRead, token)) {
        _salesforceRead = null;
      }
      if (!_disposed && epoch == _epoch && owner.key == _owner?.key) {
        busy = false;
        _factsChanged();
      }
    }
  }

  Future<void> submitSalesforceAction(
    String action,
    AccountJson reviewed, {
    required bool Function() isReviewCurrent,
  }) async {
    final owner = _owner, scope = workspace, transport = repository;
    if (!salesforceWritable ||
        locked ||
        owner == null ||
        scope == null ||
        transport is! AccountsSalesforceRepository ||
        !isReviewCurrent()) {
      return;
    }
    final epoch = _epoch, token = CancelToken();
    bool owned() =>
        !_disposed &&
        epoch == _epoch &&
        owner.key == _owner?.key &&
        workspace == scope;
    bool current() =>
        _current(epoch, owner) && workspace == scope && isReviewCurrent();
    busy = true;
    message = null;
    _saveTimer?.cancel();
    _salesforceRead = token;
    _factsChanged();
    var prepared = false, dispatched = false;
    try {
      final fresh = await (transport as AccountsSalesforceRepository)
          .reviewSalesforce(scope, token);
      if (!current()) {
        return;
      }
      accountRequire(
        fresh.connection != null &&
            fresh.allowed.contains(action) &&
            accountCanonical(fresh.connection) == accountCanonical(reviewed),
        'The Salesforce connection or available actions changed. Refresh and review again.',
      );
      final key =
          'salesforce-${base64UrlEncode(List<int>.generate(24, (_) => Random.secure().nextInt(256))).replaceAll('=', '')}';
      final intent = await AccountSalesforceIntent.prepare(
        owner,
        scope,
        key,
        action,
        reviewed,
      );
      if (!current()) {
        return;
      }
      salesforceState.pending = intent;
      salesforceState.notSubmitted = null;
      _journalVersion = 5;
      prepared = true;
      await _save(epoch, owner, scope);
      if (!current()) {
        if (_current(epoch, owner) && workspace == scope) {
          salesforceState.pending = null;
          salesforceState.notSubmitted = intent;
          salesforceState.needsLocalSave = true;
          await _save(epoch, owner, scope);
          salesforceState.needsLocalSave = false;
          message = 'The review closed before dispatch. No Salesforce action was sent.';
        }
        return;
      }
      dispatched = true;
      final receipt = await (transport as AccountsSalesforceRepository)
          .submitSalesforce(intent, isCurrent: current);
      if (!_current(epoch, owner) || workspace != scope) {
        return;
      }
      accountRequire(receipt.action != null);
      await _retainSalesforceReceipt(receipt, intent, epoch, owner, scope);
    } catch (error) {
      if (!owned() || !_current(epoch, owner)) {
        return;
      }
      if (prepared && !dispatched) {
        storageUnconfirmed = true;
      }
      message = dispatched
          ? 'The Salesforce outcome is unconfirmed. Read the exact saved receipt; no action will be sent again.'
          : prepared
          ? 'The protected Salesforce intent save is unconfirmed. Reload recovery before another action.'
          : error is FormatException
          ? error.message
          : 'The current Salesforce review could not be verified. Nothing was submitted.';
    } finally {
      if (identical(_salesforceRead, token)) {
        _salesforceRead = null;
      }
      if (owned()) {
        busy = false;
        _factsChanged();
      }
    }
  }

  Future<void> _retainSalesforceReceipt(
    AccountSalesforceRead receipt,
    AccountSalesforceIntent intent,
    int epoch,
    AccountsOwner owner,
    String scope,
  ) async {
    final prior = salesforceState.observed;
    if (prior?.action != null &&
        AccountSalesforceState.same(salesforceState.observedIntent, intent)) {
      accountRequire(
        accountCanonical(prior!.action!['acceptance']) ==
            accountCanonical(receipt.action!['acceptance']),
      );
      if (prior.settled) {
        accountRequire(
          receipt.settled &&
              accountCanonical(prior.action) ==
                  accountCanonical(receipt.action),
        );
      }
    }
    salesforceState.observed = receipt;
    salesforceState.observedIntent = intent;
    salesforceState.pending = receipt.settled ? null : intent;
    salesforceState.needsLocalSave = true;
    salesforceReview = receipt;
    try {
      await _save(epoch, owner, scope);
      if (!_current(epoch, owner) || workspace != scope) {
        return;
      }
      salesforceState.needsLocalSave = false;
      message = receipt.settled
          ? 'The exact Salesforce outcome was saved. Review its completion and provider details below.'
          : 'The action was admitted, but completion is unconfirmed. It remains held; read its exact receipt to recover.';
    } catch (_) {
      if (_current(epoch, owner) && workspace == scope) {
        storageUnconfirmed = true;
        message = 'The Salesforce receipt is verified, but its protected local save is unconfirmed. Reload recovery.';
      }
    }
  }

  Future<void> recoverSalesforceAction() async {
    final owner = _owner,
        scope = workspace,
        intent = salesforceState.pending,
        transport = repository;
    if (!available ||
        !loaded ||
        busy ||
        storageUnconfirmed ||
        owner == null ||
        scope == null ||
        intent == null ||
        transport is! AccountsSalesforceRepository ||
        !repository.access.operations.contains(
          'customers.salesforce.actions.get',
        )) {
      return;
    }
    final epoch = _epoch, token = CancelToken();
    busy = true;
    message = null;
    _salesforceRead = token;
    _factsChanged();
    try {
      final receipt = await (transport as AccountsSalesforceRepository)
          .readSalesforceAction(intent, token);
      if (!_current(epoch, owner) || workspace != scope) {
        return;
      }
      if (receipt.action == null) {
        message = 'No matching Salesforce receipt is available. The original action remains held.';
        return;
      }
      await _retainSalesforceReceipt(receipt, intent, epoch, owner, scope);
    } catch (_) {
      if (_current(epoch, owner) && workspace == scope) {
        message = 'The exact Salesforce receipt could not be confirmed. No provider action was repeated.';
      }
    } finally {
      if (identical(_salesforceRead, token)) {
        _salesforceRead = null;
      }
      if (!_disposed && epoch == _epoch && owner.key == _owner?.key) {
        busy = false;
        _factsChanged();
      }
    }
  }

  Future<void> settleSalesforceLocally() async {
    final owner = _owner, scope = workspace;
    if (!available ||
        !loaded ||
        busy ||
        owner == null ||
        scope == null ||
        !salesforceState.needsLocalSave ||
        pending != null ||
        pendingHealth != null ||
        pendingWorkflow != null ||
        factState.pending != null ||
        factState.needsLocalSave) {
      return;
    }
    final epoch = _epoch;
    busy = true;
    _factsChanged();
    try {
      await _save(epoch, owner, scope);
      if (_current(epoch, owner) && workspace == scope) {
        salesforceState.needsLocalSave = false;
        storageUnconfirmed = false;
        message = 'Salesforce recovery was saved locally. No provider action was repeated.';
      }
    } catch (_) {
      if (_current(epoch, owner) && workspace == scope) {
        storageUnconfirmed = true;
        message = 'Local Salesforce recovery remains unconfirmed. Reload protected recovery.';
      }
    } finally {
      if (_current(epoch, owner)) {
        busy = false;
        _factsChanged();
      }
    }
  }
}
