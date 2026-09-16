import 'package:asael/app/router/app_router.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  tearDown(() => debugDefaultTargetPlatformOverride = null);

  test('opens Command first on macOS', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    expect(appHomePath(), '/talk');
  });

  test('keeps Today first on Android', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    expect(appHomePath(), '/today');
  });
}
