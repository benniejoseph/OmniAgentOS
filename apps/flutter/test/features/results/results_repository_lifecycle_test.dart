import 'dart:async';
import 'dart:typed_data';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/results/result_contracts.dart';
import 'package:asael/features/results/result_detail_controller.dart';
import 'package:asael/features/results/results_api_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _run(
  String id, {
  String status = 'running',
  String tenant = 'tenant',
}) => {
  'id': id,
  'tenantId': tenant,
  'agentId': 'executor',
  'prompt': 'Exact prompt',
  'status': status,
};
ResultsAccess _access() => ResultsAccess(
  deployment: 'https://synthetic.invalid',
  tenantId: 'tenant',
  actorId: 'actor',
  role: 'operator',
);
Map<String, dynamic> _approval(String kind) => {
  'id': 'shared:approval',
  'kind': kind,
  'title': 'Review $kind',
  'status': 'pending',
  'riskLevel': kind == 'slo_policy' ? 3 : 2,
  'canonicalStatus': {
    'schemaVersion': 1,
    'domain': kind == 'slo_policy' ? 'slo_policy_change' : 'approval',
    'status': 'waiting',
    'basis': 'legacy_status',
    'source': 'legacy_adapter',
    'sourceStatus': 'pending',
    'verificationState': 'unassessed',
  },
};

class _Api extends ApiClient {
  _Api()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));
  final reads = <({String path, Map<String, dynamic>? query})>[];
  final deletes = <({String path, Map<String, dynamic>? headers})>[];
  Future<Map<String, dynamic>> Function(String, Map<String, dynamic>?) read = (
    path,
    _,
  ) async => {'run': _run(Uri.decodeComponent(path.split('/').last))};
  Future<Map<String, dynamic>> Function(String) remove = (path) async => {
    'run': _run(Uri.decodeComponent(path.split('/').last), status: 'canceled'),
    'canceledJobs': 0,
  };
  @override
  Future<Map<String, dynamic>> getJsonFreshCancelable(
    String path, {
    Map<String, dynamic>? query,
    Map<String, dynamic>? headers,
    required CancelToken cancelToken,
  }) {
    reads.add((path: path, query: query));
    return read(path, query);
  }

  @override
  Future<Map<String, dynamic>> deleteJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? query,
    Map<String, dynamic>? headers,
  }) {
    deletes.add((path: path, headers: headers));
    return remove(path);
  }

  @override
  Future<Uint8List> getBytes(
    String path, {
    Map<String, dynamic>? query,
    int maximumBytes = 64 * 1024 * 1024,
  }) async => Uint8List.fromList([1, 2]);
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  test('exact detail encodes the full ID once and never needs the initial list window', () async {
    final api = _Api(), access = _access();
    final repository = ApiResultsRepository(api, access: access);
    const id = 'run/東京:part%2F';
    final item = await repository.detail('agent:$id');
    expect(item!.key, 'agent:$id');
    expect(api.reads.single.path, '/api/runs/${Uri.encodeComponent(id)}');
    repository.dispose();
    access.dispose();
  });
  test(
    'approval kind is required and exact response kind cannot be substituted',
    () async {
      final api = _Api(), access = _access();
      final repository = ApiResultsRepository(api, access: access);
      await expectLater(repository.detail('approval:shared'), throwsStateError);
      expect(api.reads, isEmpty);
      api.read = (_, query) async => {
        'item': {
          'id': 'shared',
          'kind': 'tool',
          'title': 'Other kind',
          'status': 'pending',
        },
      };
      await expectLater(
        repository.detailFresh(
          'approval:shared',
          CancelToken(),
          approvalKind: 'workflow',
        ),
        throwsFormatException,
      );
      expect(api.reads.single.query, {'id': 'shared', 'kind': 'workflow'});
      repository.dispose();
      access.dispose();
    },
  );
  test('live numeric approval shapes remain visible in the summary and exact kind reads', () async {
    final api = _Api(), access = _access();
    final repository = ApiResultsRepository(api, access: access);
    api.read = (_, _) async => {
      'summary': {
        'tenantId': 'tenant',
        'generatedAt': '2026-10-04T00:00:00Z',
        'sources': {
          'runs': {'status': 'ready', 'data': []},
          'workflows': {'status': 'ready', 'data': []},
          'approvals': {
            'status': 'ready',
            'data': [
              for (final kind in ['tool', 'workflow', 'slo_policy'])
                _approval(kind),
            ],
          },
        },
      },
    };
    final part = await repository.readWork(CancelToken());
    expect(part.items, hasLength(3));
    expect(
      part.reads[ResultsSource.approvals]!.state,
      ResultsAvailability.ready,
    );
    expect(part.items.map((item) => item.approvalKind), [
      'tool',
      'workflow',
      'slo_policy',
    ]);
    api.read = (_, query) async => {
      'item': _approval(query!['kind'] as String),
    };
    for (final kind in ['tool', 'workflow', 'slo_policy']) {
      final exact = await repository.detailFresh(
        'approval:shared:approval',
        CancelToken(),
        approvalKind: kind,
      );
      expect(exact!.approvalKind, kind);
      expect(exact.meta, contains('risk ${kind == 'slo_policy' ? 3 : 2}'));
      expect(exact.canonical!.status, 'waiting');
    }
    repository.dispose();
    access.dispose();
  });
  test('wrong tenant and returned ID cannot authorize cancellation', () async {
    final api = _Api(), access = _access();
    final repository = ApiResultsRepository(api, access: access);
    api.read = (_, _) async => {'run': _run('one', tenant: 'other')};
    await expectLater(repository.detail('agent:one'), throwsFormatException);
    api.read = (_, _) async => {'run': _run('wrong')};
    await expectLater(repository.detail('agent:one'), throwsFormatException);
    await expectLater(repository.cancel('one'), throwsStateError);
    expect(api.deletes, isEmpty);
    repository.dispose();
    access.dispose();
  });
  test('summary metadata never admits an effect; fresh exact run and role are required', () async {
    final api = _Api(), access = _access();
    final repository = ApiResultsRepository(api, access: access);
    await expectLater(repository.cancel('one'), throwsStateError);
    await repository.detail('agent:one');
    access.update(
      tenant: 'tenant',
      actor: 'actor',
      nextRole: 'viewer',
      available: true,
    );
    await expectLater(repository.cancel('one'), throwsStateError);
    expect(api.deletes, isEmpty);
    repository.dispose();
    access.dispose();
  });
  test('uncertain retry reuses its key after a role change, and a terminal response is inspected', () async {
    final api = _Api(), access = _access();
    final repository = ApiResultsRepository(api, access: access);
    api.remove = (_) async =>
        throw const ApiException('Unconfirmed network', statusCode: 503);
    await repository.detail('agent:one');
    await expectLater(repository.cancel('one'), throwsA(isA<ApiException>()));
    final key = api.deletes.single.headers!['idempotency-key'];
    access.update(
      tenant: 'tenant',
      actor: 'actor',
      nextRole: 'viewer',
      available: true,
    );
    access.update(
      tenant: 'tenant',
      actor: 'actor',
      nextRole: 'operator',
      available: true,
    );
    await repository.detail('agent:one');
    api.remove = (_) async => {
      'run': _run('one', status: 'completed'),
      'canceledJobs': 0,
    };
    final receipt = await repository.cancelConfirmed('one');
    expect(api.deletes.last.headers!['idempotency-key'], key);
    expect(receipt.message, contains('already completed'));
    await expectLater(repository.detail('agent:one'), throwsFormatException);
    repository.dispose();
    access.dispose();
  });
  test('30 uncertain keys fail closed, exact retries remain possible, confirmation releases capacity', () async {
    final api = _Api(), access = _access();
    final repository = ApiResultsRepository(api, access: access);
    api.remove = (_) async =>
        throw const ApiException('Unconfirmed', statusCode: 503);
    for (var index = 0; index < 30; index++) {
      await repository.detail('agent:run-$index');
      await expectLater(
        repository.cancel('run-$index'),
        throwsA(isA<ApiException>()),
      );
    }
    await repository.detail('agent:overflow');
    await expectLater(repository.cancel('overflow'), throwsStateError);
    expect(api.deletes.length, 30);
    await repository.detail('agent:run-0');
    await expectLater(repository.cancel('run-0'), throwsA(isA<ApiException>()));
    expect(api.deletes.last.headers, api.deletes.first.headers);
    api.remove = (path) async => {
      'run': _run(
        Uri.decodeComponent(path.split('/').last),
        status: 'canceled',
      ),
      'canceledJobs': 1,
    };
    await repository.detail('agent:run-0');
    await repository.cancel('run-0');
    await repository.detail('agent:overflow');
    await repository.cancel('overflow');
    expect(api.deletes.length, 33);
    repository.dispose();
    access.dispose();
  });
  for (final terminal in ['canceled', 'completed', 'failed']) {
    test(
      'fresh exact $terminal read retires a lost cancellation admission and restores capacity',
      () async {
        final api = _Api(), access = _access();
        final repository = ApiResultsRepository(api, access: access);
        api.remove = (_) async =>
            throw const ApiException('Lost DELETE reply', statusCode: 503);
        for (var index = 0; index < 30; index++) {
          await repository.detail('agent:run-$index');
          await expectLater(
            repository.cancel('run-$index'),
            throwsA(isA<ApiException>()),
          );
        }
        await repository.detail('agent:overflow');
        await expectLater(repository.cancel('overflow'), throwsStateError);
        api.read = (_, _) async => {
          'run': _run('run-0', status: terminal, tenant: 'other'),
        };
        await expectLater(
          repository.detail('agent:run-0'),
          throwsFormatException,
        );
        await expectLater(repository.cancel('overflow'), throwsStateError);
        api.read = (path, _) async => {
          'run': _run(
            Uri.decodeComponent(path.split('/').last),
            status: path.endsWith('run-0') ? terminal : 'running',
          ),
        };
        final item = await repository.detail('agent:run-0');
        expect(item!.status, terminal);
        expect(item.canCancel, isFalse);
        await expectLater(repository.cancel('run-0'), throwsStateError);
        await repository.detail('agent:overflow');
        await expectLater(
          repository.cancel('overflow'),
          throwsA(isA<ApiException>()),
        );
        expect(api.deletes, hasLength(31));
        api.read = (_, _) async => {'run': _run('run-0')};
        await expectLater(
          repository.detail('agent:run-0'),
          throwsFormatException,
        );
        repository.dispose();
        access.dispose();
      },
    );
  }
  test('a terminal GET after a lost DELETE reply never fabricates an accepted cancellation receipt', () async {
    final api = _Api(), access = _access();
    final repository = ApiResultsRepository(api, access: access);
    final controller = ResultDetailController(repository, 'agent:one');
    await controller.refresh();
    api.remove = (_) async =>
        throw const ApiException('Lost DELETE reply', statusCode: 503);
    expect(await controller.cancelReviewed(controller.version), isFalse);
    expect(controller.receipt, isNull);
    api.read = (_, _) async => {'run': _run('one', status: 'completed')};
    await controller.refresh();
    expect(controller.item!.status, 'completed');
    expect(controller.canCancel, isFalse);
    expect(controller.receipt, isNull);
    expect(api.deletes, hasLength(1));
    controller.dispose();
    repository.dispose();
    access.dispose();
  });
  test('wrong or missing cancellation receipt remains uncertain with the same retry key', () async {
    final api = _Api(), access = _access();
    final repository = ApiResultsRepository(api, access: access);
    api.remove = (_) async => {
      'run': _run('other', status: 'canceled'),
      'canceledJobs': 0,
    };
    await repository.detail('agent:one');
    await expectLater(repository.cancel('one'), throwsFormatException);
    api.remove = (_) async => {'run': _run('one', status: 'canceled')};
    await repository.detail('agent:one');
    await expectLater(repository.cancel('one'), throwsFormatException);
    expect(api.deletes.first.headers, api.deletes.last.headers);
    repository.dispose();
    access.dispose();
  });
  test('stale detail settling during cancellation cannot restore mutation admission', () async {
    final api = _Api(), access = _access();
    final repository = ApiResultsRepository(api, access: access);
    await repository.detail('agent:one');
    final held = Completer<Map<String, dynamic>>();
    api.read = (_, _) => held.future;
    final late = repository.detail('agent:one');
    // A second exact read clears admission immediately, before it returns.
    await expectLater(repository.cancel('one'), throwsStateError);
    access.close();
    held.complete({'run': _run('one')});
    await expectLater(late, throwsFormatException);
    expect(api.deletes, isEmpty);
    repository.dispose();
    access.dispose();
  });
  test('source failure and malformed rows are separate from a successful empty source', () async {
    final api = _Api(), access = _access();
    final repository = ApiResultsRepository(api, access: access);
    api.read = (_, _) async => {
      'summary': {
        'tenantId': 'tenant',
        'generatedAt': '2026-10-04T00:00:00Z',
        'sources': {
          'runs': {
            'status': 'ready',
            'data': [
              _run('one'),
              {
                'id': 'bad',
                'status': ['completed'],
              },
            ],
          },
          'workflows': {'status': 'ready', 'data': []},
          'approvals': {
            'status': 'restricted',
            'error': 'Current role cannot read approvals',
          },
        },
      },
    };
    final part = await repository.readWork(CancelToken());
    expect(part.items.single.key, 'agent:one');
    expect(part.reads[ResultsSource.runs]!.omitted, 1);
    expect(part.reads[ResultsSource.workflows]!.loaded, isTrue);
    expect(part.reads[ResultsSource.approvals]!.loaded, isFalse);
    expect(
      part.reads[ResultsSource.approvals]!.state,
      ResultsAvailability.restricted,
    );
    repository.dispose();
    access.dispose();
  });
  test(
    'missing evaluation counts stay unknown and conflicting counts are omitted',
    () async {
      final api = _Api(), access = _access();
      final repository = ApiResultsRepository(api, access: access);
      api.read = (_, _) async => {
        'runs': [
          {'id': 'unknown', 'suite': 'Suite', 'status': 'running'},
          {
            'id': 'bad',
            'suite': 'Suite',
            'status': 'completed',
            'summary': {'passed': 2, 'total': 1},
          },
        ],
      };
      final part = await repository.readEvaluations(CancelToken());
      expect(part.evaluations.single.countLabel, 'Counts unavailable');
      expect(part.reads[ResultsSource.evaluations]!.omitted, 1);
      repository.dispose();
      access.dispose();
    },
  );
  test('one repository gate prevents a second distinct cancellation while the first is pending', () async {
    final api = _Api(), access = _access();
    final repository = ApiResultsRepository(api, access: access);
    await repository.detail('agent:one');
    await repository.detail('agent:two');
    final held = Completer<Map<String, dynamic>>();
    api.remove = (_) => held.future;
    final first = repository.cancel('one');
    await expectLater(repository.cancel('two'), throwsStateError);
    expect(api.deletes.length, 1);
    held.complete({'run': _run('one', status: 'canceled'), 'canceledJobs': 0});
    await first;
    repository.dispose();
    access.dispose();
  });
}
