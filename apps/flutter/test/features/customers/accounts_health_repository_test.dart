import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_health_contracts.dart';
import 'package:asael/features/customers/accounts_repository.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_health_fixtures.dart';
import 'accounts_test_support.dart';

void main() {
  test(
    'health transport binds guarded owner/body/key and exact read path',
    () async {
      final intent = await AccountHealthIntent.prepare(
            healthOwner,
            accountWorkspace,
            'exact-health-key',
            await healthAccount(),
          ),
          api = _HealthApi(),
          access = AccountsAccess(
            owner: healthOwner,
            ready: true,
            operations: const {
              'customers.health.evaluate',
              'customers.health.evaluations.get',
            },
          );
      api.session = accountSession(role: 'admin');
      final repo = ApiAccountsRepository(
        api,
        access: access,
        authorityProbe: () => true,
      );
      addTearDown(repo.dispose);
      api.response = await healthResponse(intent);
      await repo.evaluateHealth(intent, isCurrent: () => true);
      expect(api.path, NativePaths.customersHealthEvaluate(intent.accountId));
      expect(accountCanonical(api.body), accountCanonical(intent.body));
      expect(api.headers!['Idempotency-Key'], intent.key);
      expect(api.authority!.canonicalUserId, healthOwner.userId);
      expect(api.authority!.tenantId, healthOwner.tenantId);
      expect(api.authority!.role, healthOwner.role);
      final path = NativePaths.customersHealthEvaluationsGet(
        intent.accountId,
        intent.evaluationId,
        workspaceId: accountWorkspace,
      );
      api.read = (requested, query, _) async {
        expect(requested, path);
        expect(query, isEmpty);
        return healthResponse(intent, mutation: false);
      };
      await repo.readHealthEvaluation(intent, CancelToken());
      expect(api.paths.last, path);
      expect(api.posts, 1);
    },
  );

  test('authority replacement before a delayed receipt keeps the evaluation unconfirmed', () async {
    final intent = await AccountHealthIntent.prepare(
          healthOwner,
          accountWorkspace,
          'health-key',
          await healthAccount(),
        ),
        api = _HealthApi()..held = Completer<AccountJson>(),
        access = AccountsAccess(
          owner: healthOwner,
          ready: true,
          operations: const {'customers.health.evaluate'},
        );
    final repo = ApiAccountsRepository(
      api,
      access: access,
      authorityProbe: () => true,
    );
    addTearDown(repo.dispose);
    final operation = repo.evaluateHealth(intent, isCurrent: () => true);
    final rejected = expectLater(operation, throwsFormatException);
    access.close();
    api.held!.complete(await healthResponse(intent));
    await rejected;
    expect(api.authority!.isCurrent(), isFalse);
  });
}

class _HealthApi extends AccountsTestApi {
  NativeRequestAuthority? authority;
  String? path;
  AccountJson? body, headers;
  AccountJson response = {};
  int posts = 0;
  Completer<AccountJson>? held;
  @override
  Future<AccountJson> postJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    AccountJson? data,
    AccountJson? headers,
  }) async {
    authority.requireCurrent(apiBaseUrl);
    this.authority = authority;
    this.path = path;
    body = data;
    this.headers = headers;
    posts++;
    return held == null ? response : held!.future;
  }
}
