import 'dart:async';

import 'package:asael/features/capture/capture_controller.dart';
import 'package:asael/features/capture/capture_recording.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_support.dart';

void main() {
  late CaptureTestRecorder recorder;
  late CaptureController capture;
  late CaptureRecordingController recording;
  setUp(() {
    recorder = CaptureTestRecorder();
    capture = CaptureController(
      CaptureTestRepository(),
      CaptureTestOutbox(),
      captureTestOwner,
    );
    recording = CaptureRecordingController(capture, recorder);
  });
  tearDown(() {
    recording.dispose();
    capture.dispose();
  });
  test('starting requires explicit consent and denied OS permission never becomes a live microphone', () async {
    await recording.start();
    expect(recorder.starts, 0);
    recording.setConsent(true);
    recorder.permission = () async => false;
    await recording.start();
    expect(recorder.starts, 0);
    expect(recording.microphoneActive, isFalse);
    expect(recording.message, contains('permission was not granted'));
  });
  test(
    'a permission reply after Capture locks cannot start recording',
    () async {
      final held = Completer<bool>();
      recorder.permission = () => held.future;
      recording.setConsent(true);
      final start = recording.start();
      capture.lock();
      held.complete(true);
      await start;
      expect(recorder.starts, 0);
      expect(recording.attachment, isNull);
    },
  );
  test('a native start completing after scope loss is canceled before a draft is exposed', () async {
    final held = Completer<void>();
    recorder.beforeStart = () => held.future;
    recording.setConsent(true);
    final start = recording.start();
    await Future<void>.delayed(Duration.zero);
    capture.lock();
    held.complete();
    await start;
    expect(recorder.active, isFalse);
    expect(recorder.cancels, greaterThanOrEqualTo(1));
    expect(recording.attachment, isNull);
  });
  test('stopping remains pending until the native stop confirms and only then returns an original', () async {
    recording.setConsent(true);
    await recording.start();
    expect(recording.microphoneActive, isTrue);
    final held = Completer<void>();
    recorder.beforeStop = () => held.future;
    final stop = recording.stop();
    expect(recording.phase, CaptureRecordingPhase.stopping);
    expect(recording.attachment, isNull);
    held.complete();
    await stop;
    expect(recording.phase, CaptureRecordingPhase.ready);
    expect(recording.microphoneActive, isFalse);
    final original = recording.takeAttachment();
    expect(original!.name, 'audio-note.wav');
    expect(original.bytes, [1, 2, 3]);
    expect(recording.attachment, isNull);
  });
  test('failed stop keeps the actual live-microphone warning and allows another stop attempt', () async {
    recording.setConsent(true);
    await recording.start();
    recorder.stopFails = true;
    await recording.stop();
    expect(recording.microphoneActive, isTrue);
    expect(recording.phase, CaptureRecordingPhase.recording);
    expect(recording.message, contains('still active'));
    recorder.stopFails = false;
    await recording.stop();
    expect(recording.microphoneActive, isFalse);
  });
  test(
    'OS microphone interruption does not fabricate a stopped recording file',
    () async {
      recording.setConsent(true);
      await recording.start();
      recorder.active = false;
      recorder.states.add(false);
      await Future<void>.delayed(Duration.zero);
      expect(recording.microphoneActive, isFalse);
      expect(recording.attachment, isNull);
      expect(recording.phase, CaptureRecordingPhase.unavailable);
    },
  );
  test('a draft is wiped on scope change and recording never submits or transcribes by itself', () async {
    recording.setConsent(true);
    await recording.start();
    await recording.stop();
    final bytes = recording.attachment!.bytes;
    capture.lock();
    await Future<void>.delayed(Duration.zero);
    expect(bytes, everyElement(0));
    expect(recording.attachment, isNull);
    expect((capture.repository as CaptureTestRepository).submissions, isEmpty);
  });
  test(
    'a viewer cannot request microphone permission or start a recording',
    () async {
      final restricted = CaptureController(
        CaptureTestRepository(),
        CaptureTestOutbox(),
        captureTestOwner,
        canWrite: false,
      );
      var permissions = 0;
      final mic = CaptureTestRecorder()
        ..permission = () async {
          permissions++;
          return true;
        };
      final actual = CaptureRecordingController(restricted, mic)
        ..setConsent(true);
      await actual.start();
      expect(permissions, 0);
      expect(mic.starts, 0);
      actual.dispose();
      restricted.dispose();
    },
  );
  testWidgets(
    'time limit has bounded cancellation recovery and keeps an honest active warning',
    (tester) async {
      recording.setConsent(true);
      await recording.start();
      recorder.cancelFails = true;
      await tester.pump(const Duration(minutes: 2));
      await tester.pump();
      expect(recording.deadlineExceeded, isTrue);
      expect(recording.phase, CaptureRecordingPhase.unavailable);
      expect(recording.microphoneActive, isTrue);
      expect(recording.microphoneStateKnown, isTrue);
      expect(recording.message, contains('still active'));
      expect(recording.attachment, isNull);
      expect(recorder.cancels, 2);
      await tester.pump(const Duration(minutes: 10));
      expect(recorder.cancels, 2);
      expect(recording.canStart, isFalse);
      recorder.cancelFails = false;
      await recording.discard();
      expect(recording.microphoneActive, isFalse);
      expect(recording.deadlineExceeded, isFalse);
    },
  );
  testWidgets(
    'time-limit failure with unreadable microphone status is unknown rather than stopped',
    (tester) async {
      recording.setConsent(true);
      await recording.start();
      recorder.cancelFails = recorder.stateFails = true;
      await tester.pump(const Duration(minutes: 2));
      await tester.pump();
      expect(recording.phase, CaptureRecordingPhase.unavailable);
      expect(recording.microphoneStateKnown, isFalse);
      expect(recording.message, contains('stop is unconfirmed'));
      expect(recording.canStart, isFalse);
      expect(recorder.cancels, 2);
      recorder.cancelFails = recorder.stateFails = false;
    },
  );
  testWidgets(
    'a held manual stop cannot extend the absolute recording limit or publish late audio',
    (tester) async {
      recording.setConsent(true);
      await recording.start();
      final held = Completer<void>();
      recorder.beforeStop = () => held.future;
      final stop = recording.stop();
      await tester.pump(const Duration(minutes: 2));
      await tester.pump();
      expect(recorder.cancels, 1);
      expect(recording.microphoneActive, isFalse);
      expect(recording.deadlineExceeded, isTrue);
      held.complete();
      await stop;
      expect(recording.attachment, isNull);
      expect(recording.phase, CaptureRecordingPhase.unavailable);
    },
  );

  testWidgets(
    'discard after the deadline returns from a hung native cancel with an honest unknown state',
    (tester) async {
      final mic = _HeldCancelRecorder();
      final actual = CaptureRecordingController(
        capture,
        mic,
        maximumDuration: const Duration(seconds: 1),
        recoveryTimeout: const Duration(milliseconds: 10),
      );
      actual.setConsent(true);
      await actual.start();
      mic.cancelFails = true;
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
      expect(actual.deadlineExceeded, isTrue);
      expect(actual.microphoneActive, isTrue);
      mic.holdCancellation = true;
      mic.stateFails = true;
      final discard = actual.discard();
      expect(actual.busy, isTrue);
      await tester.pump(const Duration(milliseconds: 10));
      await tester.pump(const Duration(milliseconds: 10));
      await discard;
      expect(actual.busy, isFalse);
      expect(actual.phase, CaptureRecordingPhase.unavailable);
      expect(actual.microphoneStateKnown, isFalse);
      expect(actual.message, contains('could not be confirmed'));
      expect(actual.attachment, isNull);
      actual.dispose();
      mic.release.complete();
    },
  );
}

class _HeldCancelRecorder extends CaptureTestRecorder {
  bool holdCancellation = false;
  final release = Completer<void>();
  @override
  Future<void> cancel() async {
    if (holdCancellation) {
      cancels++;
      await release.future;
      return;
    }
    await super.cancel();
  }
}
