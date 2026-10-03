import 'package:flutter_webrtc/flutter_webrtc.dart';

/// Native MediaStreamTrack exposes no readyState. This presentation observer
/// uses an acquired stream's enabled audio tracks, observed onEnded, and local
/// release. It neither acquires nor changes a track or its transport policy.
class CompanionMicrophoneObservation {
  final _tracks = <MediaStreamTrack>[];
  final _ended = <MediaStreamTrack>{};
  final _restore = <void Function()>[];
  bool get active =>
      _tracks.any((track) => track.enabled && !_ended.contains(track));

  void bind(Iterable<MediaStreamTrack> tracks, void Function() onChanged) {
    release();
    for (final track in tracks.where((track) => track.kind == 'audio')) {
      _tracks.add(track);
      final previous = track.onEnded;
      void ended() {
        _ended.add(track);
        previous?.call();
        onChanged();
      }

      track.onEnded = ended;
      _restore.add(() {
        if (identical(track.onEnded, ended)) track.onEnded = previous;
      });
    }
  }

  void release() {
    for (final restore in _restore) {
      restore();
    }
    _restore.clear();
    _tracks.clear();
    _ended.clear();
  }
}
