import 'package:flutter/foundation.dart';

import '../config/app_config.dart';

class NativeClientInfo {
  const NativeClientInfo._();

  static String get platform => switch (defaultTargetPlatform) {
    TargetPlatform.android => 'android',
    TargetPlatform.iOS => 'ios',
    _ => throw UnsupportedError(
      'Native authentication currently supports Android and iOS only.',
    ),
  };

  static String get platformLabel => platform == 'ios' ? 'iOS' : 'Android';

  static Map<String, dynamic> attestation() => {
    'platform': platform,
    'appVersion': AppConfig.appVersion,
    'buildNumber': AppConfig.appBuildNumber,
    'clientContractVersion': AppConfig.nativeClientContractVersion,
  };

  static Map<String, String> attestationHeaders() => {
    'x-asael-native-platform': platform,
    'x-asael-native-app-version': AppConfig.appVersion,
    'x-asael-native-build-number': AppConfig.appBuildNumber.toString(),
    'x-asael-native-contract-version':
        AppConfig.nativeClientContractVersion.toString(),
  };

  static Map<String, dynamic> legacyDevice(String deviceId) => {
    'id': deviceId,
    'name': 'Asael on $platformLabel',
    'platform': platform,
    'appVersion': AppConfig.appVersion,
  };
}
