import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/inbox/inbox.dart';
import 'package:asael/features/inbox/inbox_api_repository.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

const _shaA =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _shaB =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const _shaC =
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const _shaD =
    'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const _dispositionId =
    'notification_disposition_111111111111111111111111111111111111111111111111';

void main() {
  test('loads exact actor-private content-free delivery decisions', () async {
    final api = _DispositionApiClient();
    final history = await ApiInboxRepository(api)
        .loadNotificationDispositions();

    expect(api.path, NativePaths.notificationsDispositionsList(limit: 100));
    expect(history.version, 'notification-disposition-projection:1');
    expect(history.items.single.id, _dispositionId);
    expect(history.items.single.outcome, 'digest');
    expect(history.items.single.policySha256, _shaA);
    expect(history.items.single.decisionReceiptSha256, _shaB);
    expect(history.items.single.occurrenceSha256, _shaC);
    expect(history.items.single.candidateSha256, _shaD);
    expect(history.items.single.deliveryKind, 'digest_ledger');
  });

  test('refuses decision history containing content or authority', () {
    final content = _historyResponse();
    final contentItem = Map<String, dynamic>.from(
      (content['dispositions']! as List).single as Map,
    )..['contentIncluded'] = true;
    content['dispositions'] = [contentItem];
    expect(
      () => NotificationDispositionHistory.fromJson(content),
      throwsFormatException,
    );

    final authority = _historyResponse();
    final authorityItem = Map<String, dynamic>.from(
      (authority['dispositions']! as List).single as Map,
    )..['decisionGrantsAuthority'] = true;
    authority['dispositions'] = [authorityItem];
    expect(
      () => NotificationDispositionHistory.fromJson(authority),
      throwsFormatException,
    );
  });

  test('refuses unsupported projection versions and malformed digests', () {
    expect(
      () => NotificationDispositionHistory.fromJson({
        ..._historyResponse(),
        'version': 'notification-disposition-projection:2',
      }),
      throwsFormatException,
    );
    final malformed = _historyResponse();
    final item = Map<String, dynamic>.from(
      (malformed['dispositions']! as List).single as Map,
    )..['policySha256'] = 'unsafe';
    malformed['dispositions'] = [item];
    expect(
      () => NotificationDispositionHistory.fromJson(malformed),
      throwsFormatException,
    );
  });

  test('refuses malformed decision lists and lifecycle coordinates', () {
    expect(
      () => NotificationDispositionHistory.fromJson({
        ..._historyResponse(),
        'dispositions': ['malformed'],
      }),
      throwsFormatException,
    );

    final unsupported = _historyResponse();
    final unsupportedItem = Map<String, dynamic>.from(
      (unsupported['dispositions']! as List).single as Map,
    )..['outcome'] = 'archive';
    unsupported['dispositions'] = [unsupportedItem];
    expect(
      () => NotificationDispositionHistory.fromJson(unsupported),
      throwsFormatException,
    );

    final unboundDigest = _historyResponse();
    final unboundItem = Map<String, dynamic>.from(
      (unboundDigest['dispositions']! as List).single as Map,
    )..['digestDeliveryId'] = null;
    unboundDigest['dispositions'] = [unboundItem];
    expect(
      () => NotificationDispositionHistory.fromJson(unboundDigest),
      throwsFormatException,
    );
  });
}

class _DispositionApiClient extends ApiClient {
  _DispositionApiClient()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  String? path;

  @override
  Future<Map<String, dynamic>> getJsonFresh(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    this.path = path;
    return _historyResponse();
  }
}

Map<String, dynamic> _historyResponse() => {
  'version': 'notification-disposition-projection:1',
  'contentIncluded': false,
  'dispositions': [
    {
      'dispositionId': _dispositionId,
      'sourceKind': 'today_reminder',
      'sourceId': 'notification-one',
      'occurrenceSha256': _shaC,
      'candidateSha256': _shaD,
      'outcome': 'digest',
      'state': 'terminal',
      'reason': 'quiet_hours',
      'mustSend': false,
      'critical': false,
      'policySha256': _shaA,
      'decisionReceiptSha256': _shaB,
      'evaluatedAt': '2026-09-22T10:00:00.000Z',
      'dueAt': null,
      'digestDeliveryId': 'notification_digest_222222222222222222222222222222222222222222222222',
      'deliveryKind': 'digest_ledger',
      'deliveryBindingSha256': _shaA,
      'lifecycleRevision': 1,
      'updatedAt': '2026-09-22T10:05:00.000Z',
      'terminalAt': '2026-09-22T10:01:00.000Z',
      'contentIncluded': false,
      'decisionGrantsAuthority': false,
    },
  ],
};
