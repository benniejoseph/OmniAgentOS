import 'package:asael/features/ambient_voice/voice_approval_presentation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final mediaClick = {
    'toolId': 'local.macos.click',
    'title': 'Click on This Mac',
    'input': {
      'snapshotRevision': 'a' * 64,
      'interactionPurpose': 'media_control',
      'coordinateSpace': 'screenshot_pixel',
      'x': 143,
      'y': 312,
    },
  };

  test(
    'media click says what is known without inventing a control or video',
    () {
      final description = voiceApprovalPresentation(mediaClick);
      expect(
        description.summary,
        'Click the selected media control on This Mac',
      );
      expect(
        description.detail,
        contains('does not identify the control by name'),
      );
      expect(description.summary, isNot(contains('Pause')));
      expect(description.summary, isNot(contains('2819')));
    },
  );

  test('only validated media inputs receive the media label', () {
    for (final changedInput in [
      {...mediaClick['input'] as Map, 'interactionPurpose': 'financial'},
      {...mediaClick['input'] as Map, 'snapshotRevision': 'old'},
      {...mediaClick['input'] as Map, 'coordinateSpace': 'global'},
      {...mediaClick['input'] as Map, 'x': double.nan},
      {...mediaClick['input'] as Map, 'x': -1},
      {...mediaClick['input'] as Map, 'elementId': 'button-1'},
      {...mediaClick['input'] as Map, 'destination': 'unrecognized'},
    ]) {
      expect(
        voiceApprovalPresentation({...mediaClick, 'input': changedInput})
            .summary,
        'Click on This Mac',
      );
    }
  });

  test('known browser activation gives a readable name and exact launch consequence', () {
    expect(
      voiceApprovalPresentation({
        'toolId': 'local.macos.activate_app',
        'input': {'bundleId': 'com.google.Chrome', 'launchIfNeeded': true},
      }),
      (
        summary: 'Bring Google Chrome to the front on This Mac',
        detail: 'Google Chrome will open if it is not already running.',
      ),
    );
    expect(
      voiceApprovalPresentation({
        'toolId': 'local.macos.activate_app',
        'title': 'Activate app',
        'input': {'bundleId': 'com.unknown.app', 'launchIfNeeded': true},
      }).summary,
      'Activate app',
    );
  });
}
