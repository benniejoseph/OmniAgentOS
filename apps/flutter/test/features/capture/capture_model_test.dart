import 'dart:typed_data';

import 'package:asael/features/capture/capture.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('allows an attachment-only capture within the governed draft', () {
    final draft = CaptureDraft(
      content: '',
      file: CaptureAttachment(
        name: 'launch-brief.pdf',
        bytes: Uint8List.fromList([1, 2, 3]),
        contentType: 'application/pdf',
      ),
    );

    expect(draft.valid, isTrue);
    expect(draft.file?.name, 'launch-brief.pdf');
  });

  test('rejects an empty text-only capture', () {
    expect(const CaptureDraft(content: '   ').valid, isFalse);
  });
}
