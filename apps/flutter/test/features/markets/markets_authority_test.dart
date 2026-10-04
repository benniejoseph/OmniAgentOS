import 'dart:async';

import 'package:asael/features/markets/markets_contracts.dart';
import 'package:asael/features/markets/markets_controller.dart';
import 'package:asael/features/markets/markets_repository.dart';
import 'package:asael/features/markets/markets_recovery_store.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'markets_test_support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final close in [true, false]) {
    test(
      'post-probe ${close ? 'closure' : 'disposal'} cannot admit a Market read or mutation',
      () async {
        final errors = <FlutterErrorDetails>[], previous = FlutterError.onError;
        FlutterError.onError = errors.add;
        final api = MarketTestApi(),
            access = MarketsAccess(
              owner: marketOwner,
              ready: true,
              operations: {'market.overview', 'market.journal.score'},
            );
        late ApiMarketsRepository repo;
        repo = ApiMarketsRepository(
          api,
          access: access,
          authorityProbe: () {
            if (close) {
              access.close(notify: false);
            } else {
              repo.dispose();
            }
            return true;
          },
        );
        addTearDown(() {
          repo.dispose();
          access.dispose();
          FlutterError.onError = previous;
          expect(errors, isEmpty);
        });
        expect(repo.authorityCurrent(), isFalse);
        await expectLater(
          repo.read('overview', {}, CancelToken()),
          throwsFormatException,
        );
        await expectLater(
          repo.submit('score', {
            'instrumentId': 'xauusd.spot',
            'maxForecasts': 2,
          }, 'fixed-key'),
          throwsFormatException,
        );
        expect(api.reads, 0);
        expect(api.writes, 0);
      },
    );
  }
  test(
    'cold open reads stored metadata, never provider bars or calendar',
    () async {
      final repo = MarketTestRepository(),
          c = MarketsController(repo, MemoryMarketsRecoveryStore());
      addTearDown(c.dispose);
      c.active = true;
      await c.initialize();
      expect(repo.reads, ['overview', 'snapshots']);
      expect(repo.writes, isEmpty);
    },
  );
  test('uncertain intent survives disposal and cannot create a second child decision', () async {
    final recovery = MemoryMarketsRecoveryStore(),
        repo = MarketTestRepository()..failWrite = true;
    final c = MarketsController(repo, recovery)..active = true;
    await c.initialize();
    await c.submit('score', {'instrumentId': 'xauusd.spot', 'maxForecasts': 2});
    expect(c.intents.single['state'], 'unknown');
    expect(repo.writes, hasLength(1));
    final fixed = c.intents.single;
    c.dispose();
    final restored = MarketsController(repo, recovery)..active = true;
    addTearDown(restored.dispose);
    await restored.initialize();
    expect(restored.intents.single['key'], fixed['key']);
    expect(restored.intents.single['submitted'], fixed['submitted']);
    await restored.refreshTab();
    await restored.submit('score', {
      'instrumentId': 'ndx.cash',
      'maxForecasts': 2,
    });
    expect(repo.writes, hasLength(1));
    expect(restored.canSubmit('score'), isFalse);
  });
  test(
    'accepted decision remains accepted when a separate refresh fails',
    () async {
      final repo = MarketTestRepository(),
          c = MarketsController(repo, MemoryMarketsRecoveryStore())
            ..active = true;
      addTearDown(c.dispose);
      await c.initialize();
      repo.failRead = true;
      await c.submit('score', {
        'instrumentId': 'xauusd.spot',
        'maxForecasts': 2,
      });
      expect(c.intents.single['state'], 'accepted');
      expect(c.failures, isNotEmpty);
      expect(repo.writes, hasLength(1));
    },
  );
  test('owner replacement synchronously clears private projections and rejects a late page', () async {
    final repo = MarketTestRepository(),
        c = MarketsController(repo, MemoryMarketsRecoveryStore())
          ..active = true;
    addTearDown(c.dispose);
    await c.initialize();
    final held = Completer<MarketDocument>(), started = Completer<void>();
    repo.pending = (kind, query, cancel) {
      if (!started.isCompleted) started.complete();
      return held.future;
    };
    final read = c.refresh('overview');
    await started.future;
    repo.access.update(null, available: false);
    expect(c.data('overview'), isNull);
    expect(c.documents, isEmpty);
    held.complete(MarketDocument('overview', marketOverviewFixture()));
    await read;
    expect(c.documents, isEmpty);
    expect(repo.writes, isEmpty);
  });
  test(
    'viewer retains bounded reads and cannot submit governed work',
    () async {
      final owner = MarketsOwner(
        marketOwner.userId,
        marketOwner.tenantId,
        marketOwner.actorId,
        'viewer',
        marketOwner.apiScope,
      );
      final repo = MarketTestRepository(owner: owner),
          c = MarketsController(repo, MemoryMarketsRecoveryStore())
            ..active = true;
      addTearDown(c.dispose);
      await c.initialize();
      await c.submit('score', {
        'instrumentId': 'xauusd.spot',
        'maxForecasts': 2,
      });
      expect(c.readable, isTrue);
      expect(repo.writes, isEmpty);
    },
  );
}
