import 'dart:async';
import 'dart:typed_data';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/results/result_contracts.dart';
import 'package:asael/features/results/result_detail_controller.dart';
import 'package:asael/features/results/results.dart' hide ResultsController;
import 'package:asael/features/results/results_controller.dart';
import 'package:asael/features/results/results_repository_contracts.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

ResultItem _run(
  String id, {
  String status = 'running',
  String body = 'Exact output',
}) => ResultItem(
  key: 'agent:$id',
  kind: ResultKind.agent,
  title: 'Prompt $id',
  status: status,
  body: body,
  meta: 'Agent executor-$id',
  tone: ResultTone.neutral,
);
const _ready = ResultsRead(state: ResultsAvailability.ready, loaded: true);
ResultsReadPart _work(List<ResultItem> items) => ResultsReadPart(
  items: items,
  reads: const {
    ResultsSource.runs: _ready,
    ResultsSource.workflows: _ready,
    ResultsSource.approvals: _ready,
  },
);

class _Repository
    implements
        ResultsRepository,
        ScopedResultsRepository,
        FreshResultsRepository,
        FreshResultDetailRepository,
        ConfirmedResultsCancellationRepository {
  @override
  final access = ResultsAccess(
    deployment: 'https://synthetic.invalid',
    tenantId: 'tenant',
    actorId: 'actor',
    role: 'operator',
  );
  Future<ResultsReadPart> Function() work = () async => _work([_run('one')]);
  Future<ResultsReadPart> Function() evaluations = () async =>
      const ResultsReadPart(reads: {ResultsSource.evaluations: _ready});
  Future<ResultsReadPart> Function() files = () async =>
      const ResultsReadPart(reads: {ResultsSource.createdFiles: _ready});
  Future<ResultItem?> Function(String) exact = (key) async =>
      _run(key.substring(6));
  Future<ResultCancelReceipt> Function(String) cancellation = (id) async =>
      ResultCancelReceipt(
        runId: id,
        returnedRun: _run(id, status: 'canceled'),
        canceledJobs: 1,
      );
  int cancels = 0, details = 0;
  String? requestedApprovalKind;
  @override
  Future<ResultsReadPart> readWork(CancelToken cancel) => work();
  @override
  Future<ResultsReadPart> readEvaluations(CancelToken cancel) => evaluations();
  @override
  Future<ResultsReadPart> readCreatedFiles(CancelToken cancel) => files();
  @override
  Future<ResultItem?> detailFresh(
    String key,
    CancelToken cancel, {
    String? approvalKind,
  }) {
    details++;
    requestedApprovalKind = approvalKind;
    return exact(key);
  }

  @override
  Future<ResultCancelReceipt> cancelConfirmed(String id) {
    cancels++;
    return cancellation(id);
  }

  @override
  Future<ResultItem?> detail(String key) => exact(key);
  @override
  Future<void> cancel(String id) async {
    await cancelConfirmed(id);
  }

  @override
  Future<ResultsSnapshot> list() async =>
      const ResultsSnapshot(items: [], evaluations: [], sourceErrors: []);
}

Future<void> _flush() async {
  await Future<void>.delayed(Duration.zero);
}

class _FilesRepository extends _Repository
    implements GeneratedArtifactResultsRepository {
  final bytes = Completer<Uint8List>();
  @override
  Future<Uint8List> downloadGeneratedArtifact(
    GeneratedArtifactSummary artifact,
  ) => bytes.future;
}

void main() {
  test(
    'optional hanging reads do not hold the primary returned window',
    () async {
      final repository = _Repository(), held = Completer<ResultsReadPart>();
      repository.files = () => held.future;
      final controller = ResultsController(repository);
      final read = controller.refresh();
      await _flush();
      expect(controller.snapshot!.items.single.key, 'agent:one');
      expect(
        controller.readFor(ResultsSource.createdFiles).state,
        ResultsAvailability.loading,
      );
      expect(controller.readFor(ResultsSource.createdFiles).loaded, isFalse);
      held.complete(
        const ResultsReadPart(reads: {ResultsSource.createdFiles: _ready}),
      );
      await read;
      controller.dispose();
      repository.access.dispose();
    },
  );
  test('failed refresh retains source rows and filters; restricted read removes only its source', () async {
    final repository = _Repository();
    final current = ResultsController(repository);
    await current.refresh();
    current.filter(search: 'one');
    current.select('agent:one');
    repository.work = () async =>
        throw const ApiException('Synthetic read failed', statusCode: 503);
    await current.refresh();
    expect(current.filtered.single.key, 'agent:one');
    expect(current.readFor(ResultsSource.runs).retained, isTrue);
    expect(current.selectedKey, 'agent:one');
    repository.work = () async => const ResultsReadPart(
      reads: {
        ResultsSource.runs: ResultsRead(
          state: ResultsAvailability.restricted,
          error: 'Denied',
        ),
        ResultsSource.workflows: _ready,
        ResultsSource.approvals: _ready,
      },
    );
    await current.refresh();
    expect(current.snapshot!.items, isEmpty);
    expect(current.readFor(ResultsSource.runs).loaded, isFalse);
    expect(current.query, 'one');
    current.dispose();
    repository.access.dispose();
  });
  test(
    'replaced read and disposed reads cannot overwrite the current window',
    () async {
      final repository = _Repository(), first = Completer<ResultsReadPart>();
      repository.work = () => first.future;
      final controller = ResultsController(repository);
      final old = controller.refresh();
      repository.work = () async => _work([_run('new')]);
      await controller.refresh();
      first.complete(_work([_run('old')]));
      await old;
      expect(controller.snapshot!.items.single.key, 'agent:new');
      final last = Completer<ResultsReadPart>();
      repository.work = () => last.future;
      final pending = controller.refresh();
      controller.dispose();
      last.complete(_work([_run('late')]));
      await pending;
      expect(controller.snapshot!.items.single.key, 'agent:new');
      repository.access.dispose();
    },
  );
  test(
    'owner and role change clear private rows before an old response settles',
    () async {
      final repository = _Repository();
      final current = ResultsController(repository);
      await current.refresh();
      final held = Completer<ResultsReadPart>();
      repository.work = () => held.future;
      final pending = current.refresh();
      repository.access.update(
        tenant: 'tenant',
        actor: 'other',
        nextRole: 'viewer',
        available: false,
        clear: true,
      );
      expect(current.snapshot, isNull);
      held.complete(_work([_run('old-owner')]));
      await pending;
      expect(current.snapshot, isNull);
      current.dispose();
      repository.access.dispose();
    },
  );
  test(
    'local page/filter covers the returned window and retains exact selection',
    () async {
      final repository = _Repository();
      repository.work = () async =>
          _work(List.generate(24, (index) => _run('item-$index')));
      final controller = ResultsController(repository);
      await controller.refresh();
      expect(controller.pageCount, 3);
      controller.movePage(2);
      expect(controller.pageItems.length, 4);
      controller.select('agent:item-23');
      controller.filter(search: 'item-1');
      expect(controller.page, 0);
      expect(controller.selectedKey, 'agent:item-23');
      expect(controller.filtered.length, 11);
      controller.dispose();
      repository.access.dispose();
    },
  );
  test('exact detail outside the list keeps full encoded identity and rejects a mismatched record', () async {
    final repository = _Repository();
    final current = ResultDetailController(repository, 'agent:run/東京:part%2F');
    await current.refresh();
    expect(current.item!.key, 'agent:run/東京:part%2F');
    repository.exact = (_) async => _run('different');
    await current.refresh();
    expect(current.fresh, isFalse);
    expect(current.item!.key, 'agent:run/東京:part%2F');
    expect(current.readError, contains('exact requested key'));
    current.dispose();
    repository.access.dispose();
  });
  test('confirmation is bound to reviewed state and cancellation has one synchronous slot', () async {
    final repository = _Repository(),
        pending = Completer<ResultCancelReceipt>();
    final controller = ResultDetailController(repository, 'agent:one');
    await controller.refresh();
    final oldVersion = controller.version;
    repository.exact = (_) async => _run('one', body: 'Changed output');
    await controller.refresh();
    expect(await controller.cancelReviewed(oldVersion), isFalse);
    expect(repository.cancels, 0);
    repository.cancellation = (_) => pending.future;
    final action = controller.cancelReviewed(controller.version);
    expect(controller.canceling, isTrue);
    expect(await controller.cancelReviewed(controller.version), isFalse);
    expect(repository.cancels, 1);
    pending.complete(
      ResultCancelReceipt(
        runId: 'one',
        returnedRun: _run('one', status: 'canceled'),
        canceledJobs: 2,
      ),
    );
    await action;
    controller.dispose();
    repository.access.dispose();
  });
  test('validated terminal response survives follow-up failure without claiming undo', () async {
    final repository = _Repository();
    final current = ResultDetailController(repository, 'agent:one');
    await current.refresh();
    repository.cancellation = (id) async => ResultCancelReceipt(
      runId: id,
      returnedRun: _run(id, status: 'completed'),
      canceledJobs: 0,
    );
    repository.exact = (_) async =>
        throw const ApiException('Follow-up unavailable', statusCode: 503);
    expect(await current.cancelReviewed(current.version), isTrue);
    await _flush();
    expect(current.canceling, isFalse);
    expect(current.receipt!.message, contains('already completed'));
    expect(current.item!.status, 'completed');
    expect(current.readError, 'Follow-up unavailable');
    current.dispose();
    repository.access.dispose();
  });
  test('wrong cancellation identity stays unconfirmed and closed scope discards a late receipt', () async {
    final repository = _Repository();
    final current = ResultDetailController(repository, 'agent:one');
    await current.refresh();
    repository.cancellation = (_) async => ResultCancelReceipt(
      runId: 'other',
      returnedRun: _run('other', status: 'canceled'),
      canceledJobs: 0,
    );
    expect(await current.cancelReviewed(current.version), isFalse);
    expect(current.receipt, isNull);
    expect(current.actionError, contains('unconfirmed'));
    await current.refresh();
    final held = Completer<ResultCancelReceipt>();
    repository.cancellation = (_) => held.future;
    final action = current.cancelReviewed(current.version);
    repository.access.close();
    held.complete(
      ResultCancelReceipt(
        runId: 'one',
        returnedRun: _run('one', status: 'canceled'),
        canceledJobs: 0,
      ),
    );
    expect(await action, isFalse);
    expect(current.item, isNull);
    expect(current.receipt, isNull);
    current.dispose();
    repository.access.dispose();
  });
  test('read-only authority never sends cancellation and approval kind is passed unchanged', () async {
    final repository = _Repository();
    repository.access.role = 'viewer';
    final controller = ResultDetailController(repository, 'agent:one');
    await controller.refresh();
    expect(await controller.cancelReviewed(controller.version), isFalse);
    expect(repository.cancels, 0);
    final approval = ResultDetailController(
      repository,
      'approval:shared/id',
      approvalKind: 'slo_policy',
    );
    repository.exact = (_) async => null;
    await approval.refresh();
    expect(repository.requestedApprovalKind, 'slo_policy');
    expect(approval.missing, isTrue);
    approval.dispose();
    controller.dispose();
    repository.access.dispose();
  });
  test(
    'a stale successful read cannot replace a confirmed terminal response',
    () async {
      final repository = _Repository();
      final current = ResultDetailController(repository, 'agent:one');
      await current.refresh();
      expect(await current.cancelReviewed(current.version), isTrue);
      await _flush();
      expect(current.item!.status, 'canceled');
      expect(current.receipt, isNotNull);
      expect(current.readError, contains('predates the confirmed terminal'));
      current.dispose();
      repository.access.dispose();
    },
  );
  test('private file bytes are discarded if authority changes before Save can open', () async {
    final repository = _FilesRepository();
    final file = GeneratedArtifactSummary(
      id: 'generated_artifact_${List.filled(48, 'a').join()}',
      kind: GeneratedArtifactKind.pdf,
      title: 'Exact file',
      filename: 'exact.pdf',
      version: 2,
      status: GeneratedArtifactStatus.ready,
      mediaType: 'application/pdf',
      byteCount: 2,
      createdAt: DateTime.utc(2026),
      updatedAt: DateTime.utc(2026),
      queuedAt: DateTime.utc(2026),
      readyAt: DateTime.utc(2026),
      failedAt: null,
    );
    final controller = ResultsController(repository)
      ..snapshot = ResultsSnapshot(
        items: const [],
        evaluations: const [],
        sourceErrors: const [],
        createdFiles: [file],
      );
    final bytes = controller.downloadCreatedFile(file);
    repository.access.close();
    repository.bytes.complete(Uint8List.fromList([1, 2]));
    await expectLater(bytes, throwsStateError);
    expect(controller.snapshot, isNull);
    controller.dispose();
    repository.access.dispose();
  });
}
