import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'accounts_contracts.dart';
import 'accounts_repository.dart';
import 'accounts_advanced_contracts.dart';
import 'accounts_mutation_controller.dart';
import 'accounts_recovery_store.dart';

enum AccountReadState { idle, loading, current, stale, unavailable, forbidden }

class AccountRead<T> {
  AccountRead({this.value, this.state = AccountReadState.idle, this.message});
  T? value;
  AccountReadState state;
  String? message;
  bool get loading => state == AccountReadState.loading;
  void clear() {
    value = null;
    state = AccountReadState.idle;
    message = null;
  }
}

class AccountsController extends ChangeNotifier {
  AccountsController(
    this.repository, {
    this.accountId,
    this._active = false,
    AccountsRecoveryStore? recovery,
  }) {
    _ownerKey = repository.access.owner?.key;
    repository.access.addListener(_authorityChanged);
    if (recovery != null &&
        (repository is AccountsMutationRepository ||
            repository is AccountsHealthRepository)) {
      actions = AccountsMutationController(
        repository,
        recovery,
        isVisible: () => readable,
        canManage: () =>
            (accountId == null ? overview.state : detail.state) ==
                AccountReadState.current &&
            (accountId == null
                        ? overview.value?.context
                        : detail.value?.context)
                    ?.accessLevel !=
                'reader',
      );
      actions!.addListener(_actionsChanged);
    }
  }
  final AccountsRepository repository;
  final String? accountId;
  final overview = AccountRead<AccountsSnapshot>();
  final detail = AccountRead<CustomerDetail>();
  final intelligence = AccountRead<AccountsPortfolio>();
  final advancedReads = {
    for (final kind in AccountAdvancedKind.values)
      kind: AccountRead<AccountAdvancedRead>(),
  };
  AccountsMutationController? actions;
  void _actionsChanged() {
    if (!_disposed) {
      notifyListeners();
    }
  }

  final Set<CancelToken> _reads = {};
  bool _active, _disposed = false;
  int _generation = 0;
  String? _ownerKey;
  bool get active => _active;
  bool get readable {
    if (_disposed || !_active) {
      return false;
    }
    if (!repository.authorityCurrent()) {
      // A dependency can be invalidated before Riverpod delivers its listener.
      // Hide and erase synchronously, without notifying during a widget build
      // or publishing through an outgoing provider's disposal callback.
      invalidateAuthority(notify: false);
      return false;
    }
    return true;
  }

  bool get busy =>
      overview.loading ||
      detail.loading ||
      intelligence.loading ||
      advancedReads.values.any((value) => value.loading) ||
      (actions?.busy ?? false);
  String? get workspaceId => accountId == null
      ? overview.value?.context.workspaceId
      : detail.value?.context.workspaceId;
  void _cancel() {
    _generation++;
    for (final token in _reads.toList()) {
      token.cancel('Customer read no longer visible.');
    }
    _reads.clear();
  }

  void _clear() {
    overview.clear();
    detail.clear();
    intelligence.clear();
    for (final source in advancedReads.values) {
      source.clear();
    }
    actions?.hide();
  }

  void _authorityChanged() {
    if (_disposed) {
      return;
    }
    invalidateAuthority(notify: false);
    _ownerKey = repository.access.owner?.key;
    notifyListeners();
  }

  void invalidateAuthority({bool notify = true}) {
    if (_disposed) {
      return;
    }
    _cancel();
    _clear();
    if (notify) {
      notifyListeners();
    }
  }

  void setActive(bool value, {bool notify = true}) {
    if (_disposed || _active == value) {
      return;
    }
    _active = value;
    if (!value) {
      _cancel();
      _clear();
    }
    if (notify) {
      notifyListeners();
    }
  }

  Future<void> initialize() async {
    if (readable &&
        overview.state == AccountReadState.idle &&
        detail.state == AccountReadState.idle) {
      await refresh();
    }
  }

  Future<void> refresh() async {
    if (!readable || busy) {
      return;
    }
    await refreshCore();
    if (readable) {
      await refreshIntelligence();
    }
  }

  Future<void> refreshCore() async {
    if (accountId == null) {
      await _load(
        overview,
        (cancel) => repository.list(cancel, workspaceId: workspaceId),
      );
    } else {
      await _load(
        detail,
        (cancel) =>
            repository.detail(accountId!, cancel, workspaceId: workspaceId),
      );
    }
    // Independent snapshots are joined only by exact revision, hash and scope.
    if (intelligence.value != null &&
        workspaceId != null &&
        intelligence.value!.context.workspaceId != workspaceId) {
      intelligence.clear();
    }
    if (readable && workspaceId != null) {
      await actions?.bind(workspaceId!);
    }
  }

  Future<void> refreshAdvanced(AccountAdvancedKind kind) async {
    final repo = repository, workspace = workspaceId;
    if (!readable ||
        workspace == null ||
        repo is! AccountsAdvancedRepository ||
        !repository.access.operations.contains(kind.operation) ||
        accountId == null && kind != AccountAdvancedKind.salesforce) {
      return;
    }
    await _load(
      advancedReads[kind]!,
      (cancel) => (repo as AccountsAdvancedRepository).advanced(
        kind,
        cancel,
        workspaceId: workspace,
        accountId: accountId,
      ),
    );
  }

  Future<void> refreshIntelligence() => _load(
    intelligence,
    (cancel) => repository.portfolio(cancel, workspaceId: workspaceId),
  );
  Future<void> _load<T>(
    AccountRead<T> source,
    Future<T> Function(CancelToken) read,
  ) async {
    if (!readable || source.loading) {
      return;
    }
    final generation = _generation, owner = _ownerKey, token = CancelToken();
    _reads.add(token);
    source.state = AccountReadState.loading;
    source.message = null;
    notifyListeners();
    bool current() =>
        readable &&
        generation == _generation &&
        owner == repository.access.owner?.key &&
        !token.isCancelled;
    try {
      final value = await read(token);
      if (!current()) {
        return;
      }
      source.value = value;
      source.state = AccountReadState.current;
    } catch (error) {
      if (!current()) {
        return;
      }
      final status = error is ApiException
          ? error.statusCode
          : error is DioException
          ? error.response?.statusCode
          : null;
      if (status == 401 || status == 403 || status == 404) {
        source.value = null;
        source.state = AccountReadState.forbidden;
        source.message = status == 404
            ? 'This exact customer record is unavailable or was removed.'
            : 'Access to this customer source is no longer available.';
        // The account boundary being refused also invalidates linked health.
        if (identical(source, overview) || identical(source, detail)) {
          intelligence.clear();
          for (final value in advancedReads.values) {
            value.clear();
          }
          actions?.hide();
        }
      } else {
        source.state = source.value == null
            ? AccountReadState.unavailable
            : AccountReadState.stale;
        source.message = error is FormatException
            ? 'The response could not be verified. Previously verified data, if shown, is an older snapshot.'
            : 'The source could not be refreshed. Previously verified data, if shown, is an older snapshot.';
      }
    } finally {
      _reads.remove(token);
      if (current()) {
        notifyListeners();
      }
    }
  }

  CustomerPortfolioItem? intelligenceFor(CustomerAccountSummary account) {
    if (!readable || intelligence.value?.context.workspaceId != workspaceId) {
      return null;
    }
    return intelligence.value?.forAccount(account);
  }

  @override
  void dispose() {
    if (_disposed) {
      return;
    }
    _disposed = true;
    _active = false;
    _cancel();
    _clear();
    repository.access.removeListener(_authorityChanged);
    actions?.removeListener(_actionsChanged);
    actions?.dispose();
    super.dispose();
  }
}
