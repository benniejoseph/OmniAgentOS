import 'package:asael/features/capture/capture.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('picker diagnostics classify configuration without exposing platform content', () {
    for (final code in ['ENTITLEMENT_NOT_FOUND', 'ENTITLEMENT_CHECK_FAILED']) {
      final error = PlatformException(
        code: code,
        message: '/private/customer-contract.docx',
        details: {'secret': 'must not be logged'},
      );
      expect(
        captureFileSelectionFailureCategory(error),
        'picker_configuration',
      );
    }
    expect(
      captureFileSelectionFailureCategory(
        MissingPluginException('private data'),
      ),
      'picker_unavailable',
    );
    expect(
      captureFileSelectionFailureCategory(
        PlatformException(code: 'unknown-private-value'),
      ),
      'selection_failed',
    );
    expect(
      captureFileSelectionFailureCategory(StateError('private path')),
      'selection_failed',
    );
  });
}
