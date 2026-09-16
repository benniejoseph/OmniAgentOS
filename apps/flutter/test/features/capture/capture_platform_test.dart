import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:asael/features/capture/capture.dart';

void main() {
  test('interrupted image recovery is limited to Android', () {
    expect(
      shouldRecoverInterruptedImagePick(
        isWeb: false,
        platform: TargetPlatform.android,
      ),
      isTrue,
    );
    expect(
      shouldRecoverInterruptedImagePick(
        isWeb: false,
        platform: TargetPlatform.macOS,
      ),
      isFalse,
    );
    expect(
      shouldRecoverInterruptedImagePick(
        isWeb: false,
        platform: TargetPlatform.iOS,
      ),
      isFalse,
    );
    expect(
      shouldRecoverInterruptedImagePick(
        isWeb: true,
        platform: TargetPlatform.android,
      ),
      isFalse,
    );
  });
}
