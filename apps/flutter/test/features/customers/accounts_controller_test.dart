import 'dart:async';

import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_controller.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_test_support.dart';

void main() {
  test('direct authority loss erases previously accepted evidence before a listener turn', () async {
    final repository = TestAccountsRepository();
    final controller = AccountsController(repository, active: true);
    addTearDown(controller.dispose);
    await controller.refresh();
    expect(controller.overview.value, isNotNull);
    expect(controller.intelligence.value, isNotNull);
    repository.current = false;
    expect(controller.readable, isFalse);
    expect(controller.overview.value, isNull);
    expect(controller.detail.value, isNull);
    expect(controller.intelligence.value, isNull);
    expect(controller.busy, isFalse);
  });

  test('inactive and disposed controllers never begin reads', () async {
    final repository = TestAccountsRepository();
    final inactive = AccountsController(repository);
    await inactive.refresh();
    expect(repository.listCalls, 0);
    inactive.dispose();
    inactive.setActive(true);
    await inactive.refresh();
    expect(repository.listCalls, 0);
  });
  test('core failure does not fabricate or suppress independent intelligence status', () async {
    final repository = TestAccountsRepository();
    repository.listRead = (_) => Future.error(StateError('offline'));
    final controller = AccountsController(repository, active: true);
    addTearDown(controller.dispose);
    await controller.refresh();
    expect(controller.overview.state, AccountReadState.unavailable);
    expect(controller.intelligence.state, AccountReadState.current);
    expect(controller.overview.value, isNull);
  });
  test('failed intelligence refresh retains labelled same-owner evidence; forbidden clears it', () async {
    final repository = TestAccountsRepository();
    final current = AccountsController(repository, active: true);
    addTearDown(current.dispose);
    await current.refresh();
    repository.portfolioRead = (_) => Future.error(StateError('offline'));
    await current.refreshIntelligence();
    expect(current.intelligence.state, AccountReadState.stale);
    expect(current.intelligence.value, isNotNull);
    repository.portfolioRead = (_) => Future.error(
      DioException(
        requestOptions: RequestOptions(),
        response: Response(requestOptions: RequestOptions(), statusCode: 403),
      ),
    );
    await current.refreshIntelligence();
    expect(current.intelligence.state, AccountReadState.forbidden);
    expect(current.intelligence.value, isNull);
    expect(current.overview.value, isNotNull);
  });
  test('changed exact account revision cannot inherit old health', () async {
    final repository = TestAccountsRepository();
    final current = AccountsController(repository, active: true);
    addTearDown(current.dispose);
    await current.refresh();
    repository.listRead = (_) async => AccountsSnapshot.parse(
      await accountListResponse(revision: 2),
      accountOwner(),
    );
    await current.refreshCore();
    expect(
      current.intelligenceFor(current.overview.value!.accounts.single),
      isNull,
    );
  });
  test('owner, role, background and disposal cancel and erase pending private reads', () async {
    for (final event in ['owner', 'role', 'background', 'dispose']) {
      final repository = TestAccountsRepository(),
          held = Completer<AccountsSnapshot>();
      repository.listRead = (_) => held.future;
      final controller = AccountsController(repository, active: true),
          read = controller.refreshCore();
      if (event == 'owner') {
        repository.access.update(
          AccountsOwner.fromSession(
            accountSession(user: accountOtherUser),
            accountApi,
          ),
          available: true,
        );
      }
      if (event == 'role') {
        repository.access.update(accountOwner(role: 'admin'), available: true);
      }
      if (event == 'background') {
        controller.setActive(false);
      }
      if (event == 'dispose') {
        controller.dispose();
      }
      held.complete(
        await AccountsSnapshot.parse(
          await accountListResponse(),
          accountOwner(),
        ),
      );
      await read;
      expect(controller.overview.value, isNull, reason: event);
      expect(repository.tokens.single.isCancelled, isTrue, reason: event);
      if (event != 'dispose') {
        controller.dispose();
      }
    }
  });
  test(
    'direct API authority probe fences a late result without a listener pump',
    () async {
      final repository = TestAccountsRepository(),
          held = Completer<AccountsSnapshot>();
      repository.listRead = (_) => held.future;
      final controller = AccountsController(repository, active: true);
      addTearDown(controller.dispose);
      final read = controller.refreshCore();
      repository.current = false;
      held.complete(
        await AccountsSnapshot.parse(
          await accountListResponse(),
          accountOwner(),
        ),
      );
      await read;
      expect(controller.readable, isFalse);
      expect(controller.overview.value, isNull);
    },
  );
}
