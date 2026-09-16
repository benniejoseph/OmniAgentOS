import 'package:asael/core/auth/native_client_info.dart';
import 'package:asael/core/config/app_config.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  tearDown(() => debugDefaultTargetPlatformOverride = null);

  for (final expectation in <(TargetPlatform, String, String)>[
    (TargetPlatform.android, 'android', 'Android'),
    (TargetPlatform.iOS, 'ios', 'iOS'),
    (TargetPlatform.macOS, 'macos', 'macOS'),
  ]) {
    test('reports ${expectation.$3} native attestation', () {
      debugDefaultTargetPlatformOverride = expectation.$1;

      expect(NativeClientInfo.platform, expectation.$2);
      expect(NativeClientInfo.platformLabel, expectation.$3);
      expect(NativeClientInfo.attestation(), {
        'platform': expectation.$2,
        'appVersion': AppConfig.appVersion,
        'buildNumber': AppConfig.appBuildNumber,
        'clientContractVersion': NativeContract.currentVersion,
      });
      expect(
        NativeClientInfo.legacyDevice('device-1'),
        containsPair('name', 'Asael on ${expectation.$3}'),
      );
    });
  }
}
