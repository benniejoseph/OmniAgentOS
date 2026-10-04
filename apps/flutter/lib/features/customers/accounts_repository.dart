import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../generated/native_contract.g.dart';
import '../auth/domain/app_session.dart';
import 'accounts_contracts.dart';
import 'accounts_mutation_contracts.dart';
import 'accounts_advanced_contracts.dart';

class AccountsAccess extends ChangeNotifier {
  AccountsAccess({
    this.owner,
    this.ready = false,
    this.operations = const {
      'customers.list',
      'customers.portfolio',
      'customers.get',
    },
  });
  AccountsOwner? owner;
  bool ready, closed = false;
  final Set<String> operations;
  int generation = 0;
  bool get readable => !closed && ready && owner != null;
  void update(AccountsOwner? next, {required bool available}) {
    if (closed || owner?.key == next?.key && ready == available) {
      return;
    }
    owner = next;
    ready = available;
    generation++;
    notifyListeners();
  }

  void close({bool notify = true}) {
    if (closed) {
      return;
    }
    closed = true;
    ready = false;
    generation++;
    if (notify) {
      notifyListeners();
    }
  }
}

abstract interface class AccountsRepository {
  AccountsAccess get access;
  bool authorityCurrent();
  Future<AccountsSnapshot> list(CancelToken cancel, {String? workspaceId});
  Future<AccountsPortfolio> portfolio(
    CancelToken cancel, {
    String? workspaceId,
  });
  Future<CustomerDetail> detail(
    String id,
    CancelToken cancel, {
    String? workspaceId,
  });
}

abstract interface class AccountsMutationRepository {
  Future<AccountMutationReceipt> mutate(
    AccountMutationIntent intent, {
    required bool Function() isCurrent,
  });
}

abstract interface class AccountsAdvancedRepository {
  Future<AccountAdvancedRead> advanced(
    AccountAdvancedKind kind,
    CancelToken cancel, {
    required String workspaceId,
    String? accountId,
  });
}

class ApiAccountsRepository
    implements
        AccountsRepository,
        AccountsMutationRepository,
        AccountsAdvancedRepository {
  ApiAccountsRepository(
    this.api, {
    required this.access,
    required bool Function() authorityProbe,
  }) : _probe = authorityProbe {
    access.addListener(_changed);
  }
  final ApiClient api;
  @override
  final AccountsAccess access;
  final bool Function() _probe;
  final Set<CancelToken> _reads = {};
  bool _disposed = false;
  @override
  bool authorityCurrent() =>
      !_disposed &&
      access.readable &&
      _probe() &&
      !_disposed &&
      access.readable;
  void _changed() {
    for (final cancel in _reads.toList()) {
      cancel.cancel('Customer access changed.');
    }
  }

  void _require(String operation, int generation, CancelToken cancel) {
    accountRequire(
      authorityCurrent() &&
          generation == access.generation &&
          !cancel.isCancelled &&
          access.operations.contains(operation),
      'Current customer access and a published read operation are required.',
    );
  }

  Future<T> _read<T>(
    String operation,
    String path,
    CancelToken cancel,
    Map<String, dynamic> query,
    Future<T> Function(AccountJson, AccountsOwner) parse,
  ) async {
    final generation = access.generation;
    _require(operation, generation, cancel);
    final owner = access.owner!;
    _reads.add(cancel);
    try {
      // A fresh same-API session probe binds canonical identity even when an
      // outgoing provider has not yet rebuilt. Never use the offline cache.
      late final Map<String, dynamic> bootstrap;
      try {
        bootstrap = await api.getJsonFreshCancelable(
          NativePaths.bootstrapGet,
          cancelToken: cancel,
        );
      } catch (error) {
        final status = error is ApiException
            ? error.statusCode
            : error is DioException
            ? error.response?.statusCode
            : null;
        // A refused live session probe removes every private projection. An
        // independent domain refusal below only removes that domain's source.
        // An outgoing read must never invalidate a replacement owner or epoch.
        if ((status == 401 || status == 403) &&
            generation == access.generation &&
            owner.key == access.owner?.key &&
            !cancel.isCancelled &&
            authorityCurrent()) {
          access.update(null, available: false);
        }
        rethrow;
      }
      _require(operation, generation, cancel);
      try {
        final session = AccountsOwner.fromSession(
          AppSession.fromJson(bootstrap),
          owner.apiScope,
        );
        accountRequire(
          bootstrap['authenticated'] == true &&
              accountMap(bootstrap['context'])['role'] == owner.role &&
              session?.key == owner.key,
          'The API session changed. Reconnect before reading customer data.',
        );
      } on FormatException {
        // A live identity mismatch is an authority change, never a stale-data
        // refresh failure that may keep the prior user's projection visible.
        access.update(null, available: false);
        rethrow;
      }
      final raw = await api.getJsonFreshCancelable(
        path,
        query: query,
        cancelToken: cancel,
      );
      _require(operation, generation, cancel);
      accountRequire(
        utf8.encode(jsonEncode(raw)).length <= 16 * 1024 * 1024,
        'This customer projection exceeds the supported read size.',
      );
      final value = await parse(accountFreeze(raw), owner);
      _require(operation, generation, cancel);
      return value;
    } finally {
      _reads.remove(cancel);
    }
  }

  @override
  Future<AccountsSnapshot> list(CancelToken cancel, {String? workspaceId}) =>
      _read(
        'customers.list',
        NativePaths.customersList(),
        cancel,
        {'limit': 200, 'workspaceId': ?workspaceId},
        (value, owner) =>
            AccountsSnapshot.parse(value, owner, workspaceId: workspaceId),
      );
  @override
  Future<AccountsPortfolio> portfolio(
    CancelToken cancel, {
    String? workspaceId,
  }) => _read(
    'customers.portfolio',
    NativePaths.customersPortfolio(),
    cancel,
    {'limit': 200, 'workspaceId': ?workspaceId},
    (value, owner) =>
        AccountsPortfolio.parse(value, owner, workspaceId: workspaceId),
  );
  @override
  Future<CustomerDetail> detail(
    String id,
    CancelToken cancel, {
    String? workspaceId,
  }) {
    accountId(id, 'customer-account');
    return _read(
      'customers.get',
      NativePaths.customersGet(id),
      cancel,
      {'workspaceId': ?workspaceId},
      (value, owner) =>
          CustomerDetail.parse(value, owner, id, workspaceId: workspaceId),
    );
  }

  void dispose() {
    if (_disposed) {
      return;
    }
    _disposed = true;
    _changed();
    access.removeListener(_changed);
  }

  @override
  Future<AccountMutationReceipt> mutate(
    AccountMutationIntent intent, {
    required bool Function() isCurrent,
  }) async {
    final generation = access.generation;
    bool current() =>
        authorityCurrent() &&
        generation == access.generation &&
        access.owner?.key == intent.owner.key &&
        isCurrent();
    accountRequire(
      current() &&
          intent.owner.role != 'viewer' &&
          access.operations.contains(intent.operation),
      'Current Account management access is required.',
    );
    final authority = NativeRequestAuthority(
      tenantId: intent.owner.tenantId,
      actorId: intent.owner.actorId,
      canonicalUserId: intent.owner.userId,
      role: intent.owner.role,
      apiBaseUrl: intent.owner.apiScope,
      isCurrent: current,
    );
    final raw = intent.create
        ? await api.postJsonAuthorized(
            NativePaths.customersCreate,
            authority: authority,
            data: intent.body,
            headers: {'Idempotency-Key': intent.key},
          )
        : await api.patchJsonAuthorized(
            NativePaths.customersUpdate(intent.accountId),
            authority: authority,
            data: intent.body,
            headers: {'Idempotency-Key': intent.key},
          );
    accountRequire(
      current(),
      'Account access changed after the request. Its outcome remains unconfirmed.',
    );
    accountRequire(utf8.encode(jsonEncode(raw)).length <= 1000000);
    final receipt = await AccountMutationReceipt.parse(
      accountFreeze(raw),
      intent,
    );
    accountRequire(
      current(),
      'Account access changed after the request. Its outcome remains unconfirmed.',
    );
    return receipt;
  }

  @override
  Future<AccountAdvancedRead> advanced(
    AccountAdvancedKind kind,
    CancelToken cancel, {
    required String workspaceId,
    String? accountId,
  }) {
    if (kind != AccountAdvancedKind.salesforce) {
      accountRequire(accountId != null);
      // Exact path helpers encode the complete identity once.
    }
    final path = switch (kind) {
      AccountAdvancedKind.health => NativePaths.customersHealth(accountId!),
      AccountAdvancedKind.intelligence => NativePaths.customersIntelligence(
        accountId!,
      ),
      AccountAdvancedKind.workflows => NativePaths.customersWorkflows(
        accountId!,
      ),
      AccountAdvancedKind.salesforce => NativePaths.customersSalesforceStatus(),
    };
    return _read(
      kind.operation,
      path,
      cancel,
      {
        'workspaceId': workspaceId,
        if (kind == AccountAdvancedKind.health) 'historyLimit': 20,
        if (kind == AccountAdvancedKind.intelligence) ...{
          'historyLimit': 100,
          'timelineLimit': 100,
        },
        if (kind == AccountAdvancedKind.workflows) 'limit': 50,
      },
      (row, owner) =>
          AccountAdvancedRead.parse(kind, row, owner, workspaceId, accountId),
    );
  }
}
