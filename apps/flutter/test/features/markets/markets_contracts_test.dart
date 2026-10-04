import 'package:asael/features/markets/markets_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'markets_test_support.dart';

void main() {
  test(
    'exact stored price receipt retains source time and immutable bar identity',
    () async {
      final body = await marketSnapshotFixture(),
          envelope = await marketEnvelope('snapshot', body);
      final result = await parseMarketDocument(
        'snapshot',
        envelope,
        marketOwner,
        {
          'snapshotId': body['snapshotId'],
          'instrumentId': 'xauusd.spot',
          'interval': '15min',
        },
      );
      expect(result.data['asOf'], marketStamp);
      expect(result.data['snapshotSource'], 'cache');
      expect(
        () => result.data['instrumentId'] = 'forged',
        throwsUnsupportedError,
      );
    },
  );
  test(
    'validly resealed wrong exact snapshot and owner are rejected',
    () async {
      final body = await marketSnapshotFixture(),
          envelope = await marketEnvelope('snapshot', body);
      await expectLater(
        parseMarketDocument('snapshot', envelope, marketOwner, {
          'snapshotId': 'market_snapshot_${'a' * 48}',
        }),
        throwsFormatException,
      );
      final other = MarketsOwner(
        '22222222-2222-4222-8222-222222222222',
        'tenant-b',
        'other@example.test',
        'operator',
        marketOwner.apiScope,
      );
      await expectLater(
        parseMarketDocument(
          'snapshot',
          await marketEnvelope('snapshot', body, owner: other),
          other,
          {'snapshotId': body['snapshotId']},
        ),
        throwsFormatException,
      );
    },
  );
  test('changed bar content cannot keep an old normalized digest', () async {
    final original = await marketSnapshotFixture(),
        bars = marketRows(original['bars'], 1000);
    final changed = {
      ...original,
      'bars': [
        {...bars.single, 'close': 100.75},
      ],
    };
    await expectLater(
      parseMarketDocument(
        'snapshot',
        await marketEnvelope('snapshot', changed),
        marketOwner,
        {'snapshotId': original['snapshotId']},
      ),
      throwsFormatException,
    );
  });
  test('stored projection cannot silently become a provider result or grow extra fields', () async {
    final original = await marketSnapshotFixture();
    for (final changed in [
      {...original, 'snapshotSource': 'provider'},
      {...original, 'pluginState': {}},
    ]) {
      await expectLater(
        parseMarketDocument(
          'snapshot',
          await marketEnvelope('snapshot', changed),
          marketOwner,
          {'snapshotId': original['snapshotId']},
        ),
        throwsFormatException,
      );
    }
  });
}
