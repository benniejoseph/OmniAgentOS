import 'package:asael/features/push/mobile_push.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('accepts every exact causal deep-link family', () {
    expect(
      MobilePushEnvelope.fromData(_data('approval', 'approval/one')).deepLink,
      '/inbox/approvals/approval%2Fone',
    );
    expect(
      MobilePushEnvelope.fromData(
        _data('work_item', 'task/one', parentId: 'project one'),
      ).deepLink,
      '/projects/project%20one?workItemId=task%2Fone',
    );
    expect(
      MobilePushEnvelope.fromData(_data('meeting', 'meeting/one')).deepLink,
      '/meetings/meeting%2Fone',
    );
    expect(
      MobilePushEnvelope.fromData(_data('customer', 'account/one')).deepLink,
      '/customers/account%2Fone',
    );
    expect(
      MobilePushEnvelope.fromData(_data('run', 'run/one')).deepLink,
      '/results/agent%3Arun%2Fone',
    );
  });

  test('rejects a forged or cross-kind deep link', () {
    expect(
      () => MobilePushEnvelope.fromData({
        ..._data('customer', 'account-one'),
        'deepLink': '/meetings/account-one',
      }),
      throwsFormatException,
    );
    expect(
      () => MobilePushEnvelope.fromData({
        ..._data('meeting', 'meeting-one'),
        'parentId': 'project-one',
      }),
      throwsFormatException,
    );
  });
}

Map<String, dynamic> _data(String kind, String id, {String? parentId}) => {
  'schemaVersion': '1',
  'deliveryId': 'mobile-push-delivery-one',
  'causeKind': kind,
  'causeId': id,
  'parentId': ?parentId,
  'deepLink': MobilePushEnvelope.causalDeepLink(kind, id, parentId: parentId),
};
