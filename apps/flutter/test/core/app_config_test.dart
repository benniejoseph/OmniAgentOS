import 'dart:io';

import 'package:asael/core/config/app_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('attests the version in pubspec.yaml', () {
    final version = RegExp(
      r'^version: (\d+\.\d+\.\d+)\+(\d+)$',
      multiLine: true,
    ).firstMatch(File('pubspec.yaml').readAsStringSync());

    expect(version, isNotNull);
    expect(AppConfig.appVersion, version!.group(1));
    expect(AppConfig.appBuildNumber, int.parse(version.group(2)!));
  });
}
