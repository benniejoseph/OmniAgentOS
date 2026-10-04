import 'dart:async';
import 'dart:convert';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_controller.dart';
import 'package:asael/features/customers/accounts_repository.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_test_support.dart';

void main() {
  test('the real JSON client converts HTTP refusal to ApiException', () async {
    final harness = await _TransportHarness.create();
    addTearDown(harness.dispose);
    harness.adapter.respond = (_) async => _body(403);
    await expectLater(
      harness.api.getJsonFreshCancelable(
        NativePaths.customersList(),
        cancelToken: CancelToken(),
      ),
      throwsA(
        isA<ApiException>().having((error) => error.statusCode, 'status', 403),
      ),
    );
  });

  for (final selected in [false, true]) {
    for (final status in [401, 403, 404]) {
      test(
        'real $status clears ${selected ? 'detail' : 'list'} and linked intelligence',
        () async {
          final harness = await _TransportHarness.create(selected: selected);
          addTearDown(harness.dispose);
          await harness.controller.refresh();
          expect(harness.controller.intelligence.value, isNotNull);
          final accepted = harness.adapter.respond;
          harness.adapter.respond = (request) =>
              request.path == NativePaths.bootstrapGet
              ? accepted(request)
              : Future.value(_body(status));
          await harness.controller.refreshCore();
          final source = selected
              ? harness.controller.detail
              : harness.controller.overview;
          expect(source.value, isNull);
          expect(source.state, AccountReadState.forbidden);
          expect(harness.controller.intelligence.value, isNull);
          expect(harness.access.readable, isTrue);
        },
      );
    }
  }

  test('domain portfolio refusal clears only intelligence after a valid session probe', () async {
    final harness = await _TransportHarness.create();
    addTearDown(harness.dispose);
    await harness.controller.refresh();
    final accepted = harness.adapter.respond;
    harness.adapter.respond = (request) =>
        request.path == NativePaths.customersPortfolio()
        ? Future.value(_body(403))
        : accepted(request);
    await harness.controller.refreshIntelligence();
    expect(harness.controller.intelligence.state, AccountReadState.forbidden);
    expect(harness.controller.intelligence.value, isNull);
    expect(harness.controller.overview.value, isNotNull);
    expect(harness.controller.readable, isTrue);
  });

  for (final status in [401, 403]) {
    test(
      'bootstrap $status erases all snapshots during intelligence-only refresh',
      () async {
        final harness = await _TransportHarness.create();
        addTearDown(harness.dispose);
        final selected = AccountsController(
          harness.repository,
          active: true,
          accountId: customerId,
        );
        addTearDown(selected.dispose);
        await harness.controller.refresh();
        await selected.refreshCore();
        expect(harness.controller.overview.value, isNotNull);
        expect(harness.controller.intelligence.value, isNotNull);
        expect(selected.detail.value, isNotNull);
        harness.adapter.requests.clear();
        harness.adapter.respond = (_) async => _body(status);
        await harness.controller.refreshIntelligence();
        expect(harness.access.readable, isFalse);
        expect(harness.controller.readable, isFalse);
        expect(harness.controller.overview.value, isNull);
        expect(harness.controller.detail.value, isNull);
        expect(harness.controller.intelligence.value, isNull);
        expect(selected.detail.value, isNull);
        expect(selected.readable, isFalse);
        expect(harness.adapter.requests.map((request) => request.path), [
          NativePaths.bootstrapGet,
        ]);
      },
    );
  }

  test('bootstrap transport failure retains labelled evidence without revoking access', () async {
    final harness = await _TransportHarness.create();
    addTearDown(harness.dispose);
    await harness.controller.refresh();
    harness.adapter.respond = (_) async => _body(503);
    await harness.controller.refreshIntelligence();
    expect(harness.access.readable, isTrue);
    expect(harness.controller.overview.value, isNotNull);
    expect(harness.controller.intelligence.value, isNotNull);
    expect(harness.controller.intelligence.state, AccountReadState.stale);
  });

  for (final sameOwnerAgain in [false, true]) {
    test(
      'late bootstrap refusal cannot invalidate ${sameOwnerAgain ? 'a later same-owner epoch' : 'the replacement owner'}',
      () async {
        final harness = await _TransportHarness.create();
        addTearDown(harness.dispose);
        final started = Completer<void>(), response = Completer<ResponseBody>();
        harness.adapter.respond = (_) {
          started.complete();
          return response.future;
        };
        final pending = harness.controller.refreshCore();
        await started.future;
        final replacement = AccountsOwner.fromSession(
          accountSession(user: accountOtherUser),
          accountApi,
        )!;
        harness.access.update(replacement, available: true);
        if (sameOwnerAgain) {
          harness.access.update(accountOwner(), available: true);
        }
        final expectedOwner = harness.access.owner!.key;
        response.complete(_body(403));
        await pending;
        expect(harness.access.readable, isTrue);
        expect(harness.access.owner!.key, expectedOwner);
        expect(harness.controller.overview.value, isNull);
        expect(harness.adapter.requests.map((request) => request.path), [
          NativePaths.bootstrapGet,
        ]);
      },
    );
  }
}

ResponseBody _body(int status, [AccountJson? data]) => ResponseBody.fromString(
  jsonEncode(data ?? {'error': 'Synthetic source refusal.'}),
  status,
  headers: {
    Headers.contentTypeHeader: [Headers.jsonContentType],
  },
);

class _AccountsTransport implements HttpClientAdapter {
  _AccountsTransport(this.respond);
  Future<ResponseBody> Function(RequestOptions) respond;
  final requests = <RequestOptions>[];
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) {
    requests.add(options);
    return respond(options);
  }

  @override
  void close({bool force = false}) {}
}

class _TransportHarness {
  _TransportHarness(
    this.dio,
    this.rawDio,
    this.adapter,
    this.api,
    this.access,
    this.repository,
    this.controller,
  );
  final Dio dio, rawDio;
  final _AccountsTransport adapter;
  final ApiClient api;
  final AccountsAccess access;
  final ApiAccountsRepository repository;
  final AccountsController controller;

  static Future<_TransportHarness> create({bool selected = false}) async {
    final session = accountSession();
    final bootstrap = <String, dynamic>{
      'authenticated': true,
      'context': {
        'tenantId': session.tenantId,
        'actorId': session.actorId,
        'role': session.role,
      },
      'user': {
        'id': session.userId,
        'email': session.email,
        'name': session.displayName,
      },
      'membership': {'role': session.role},
      'tenant': {'name': session.workspaceName},
      'api': {
        'nativeContract': {
          'id': NativeContract.id,
          'supportedVersions': NativeContract.supportedVersions,
        },
      },
    };
    final list = await accountListResponse(),
        detail = await accountDetailResponse(),
        portfolio = await accountPortfolioResponse();
    final adapter = _AccountsTransport(
      (request) async => _body(200, switch (request.path) {
        NativePaths.bootstrapGet => bootstrap,
        _ when request.path == NativePaths.customersList() => list,
        _ when request.path == NativePaths.customersPortfolio() => portfolio,
        _ when request.path == NativePaths.customersGet(customerId) => detail,
        _ => throw StateError(
          'Unexpected synthetic Accounts read: ${request.path}',
        ),
      }),
    );
    final dio = Dio(BaseOptions(baseUrl: accountApi))
      ..httpClientAdapter = adapter;
    final rawDio = Dio();
    final api = ApiClient(
      dio,
      rawDio,
      SecureSessionStore(const FlutterSecureStorage()),
    );
    final access = AccountsAccess(owner: accountOwner(), ready: true);
    final repository = ApiAccountsRepository(
      api,
      access: access,
      authorityProbe: () => true,
    );
    final controller = AccountsController(
      repository,
      active: true,
      accountId: selected ? customerId : null,
    );
    return _TransportHarness(
      dio,
      rawDio,
      adapter,
      api,
      access,
      repository,
      controller,
    );
  }

  void dispose() {
    controller.dispose();
    repository.dispose();
    access.dispose();
    dio.close(force: true);
    rawDio.close(force: true);
  }
}
