import 'package:asael/features/companion/microphone_observation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

class _Track extends Fake implements MediaStreamTrack {
  @override
  String get kind => 'audio';
  @override
  bool enabled = true;
  @override
  void Function()? onEnded;
}

void main() {
  test('only an acquired enabled track is active; ended and release preserve callbacks', () {
    final observer = CompanionMicrophoneObservation();
    final track = _Track();
    var originalCalls = 0;
    var observedCalls = 0;
    void original() => originalCalls++;
    track.onEnded = original;
    expect(observer.active, false);
    observer.bind([track], () => observedCalls++);
    expect(observer.active, true);
    track.enabled = false;
    expect(observer.active, false);
    track.enabled = true;
    track.onEnded!();
    expect(observer.active, false);
    expect(originalCalls, 1);
    expect(observedCalls, 1);
    observer.release();
    expect(observer.active, false);
    expect(track.onEnded, same(original));
  });
  test('replacement stream detaches prior observation and local release cannot revive it', () {
    final observer = CompanionMicrophoneObservation();
    final a = _Track();
    final b = _Track();
    observer.bind([a], () {});
    observer.bind([b], () {});
    expect(a.onEnded, isNull);
    expect(observer.active, true);
    observer.release();
    expect(b.onEnded, isNull);
    expect(observer.active, false);
  });
}
