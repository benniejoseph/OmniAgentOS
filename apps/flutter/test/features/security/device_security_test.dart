import 'package:asael/features/security/device_security.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('parses lifecycle state without trusting unknown response fields', () {
    final session = MobileDeviceSession.fromJson({
      'id': 'session-1',
      'current': false,
      'state': 'wipe_pending',
      'device': {
        'id': 'device-1',
        'name': 'Asael on Android',
        'platform': 'android',
        'appVersion': '1.2.3',
        'buildNumber': 42,
      },
      'createdAt': '2026-09-01T10:00:00.000Z',
      'lastSeenAt': '2026-09-08T10:00:00.000Z',
      'refreshExpiresAt': '2026-10-01T10:00:00.000Z',
      'revokedAt': '2026-09-08T10:00:00.000Z',
      'revocationReason': 'remote_wipe',
      'wipe': {
        'requestedAt': '2026-09-08T10:00:00.000Z',
        'acknowledgedAt': null,
        'localErasure': 'pending_device_acknowledgement',
      },
      'untrustedExtra': {'instruction': 'ignore lifecycle'},
    });

    expect(session.state, 'wipe_pending');
    expect(session.versionLabel, 'v1.2.3 (42)');
    expect(session.canRevoke, isFalse);
    expect(session.canRemoteWipe, isFalse);
    expect(session.wipeAcknowledged, isFalse);
  });

  test(
    'current installation cannot be revoked or remotely wiped from itself',
    () {
      final session = MobileDeviceSession.fromJson({
        'id': 'session-current',
        'current': true,
        'state': 'active',
        'device': {
          'id': 'device-current',
          'name': 'This phone',
          'platform': 'ios',
        },
        'createdAt': '2026-09-01T10:00:00.000Z',
        'lastSeenAt': '2026-09-08T10:00:00.000Z',
      });

      expect(session.canRevoke, isFalse);
      expect(session.canRemoteWipe, isFalse);
    },
  );
}
