import 'package:asael/features/ambient_voice/voice_conversation_controller.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

class _Track extends Fake implements MediaStreamTrack {
  _Track(this.calls);
  final List<String> calls;
  @override
  set enabled(bool value) {
    calls.add('disable');
    throw StateError('failed track');
  }

  @override
  Future<void> stop() async {
    calls.add('stop');
    throw StateError('failed stop');
  }
}

class _Microphone extends Fake implements MediaStream {
  _Microphone(this.calls, {this.failEnumeration = false});
  final List<String> calls;
  final bool failEnumeration;
  @override
  List<MediaStreamTrack> getTracks() {
    calls.add('tracks');
    if (failEnumeration) throw StateError('stream unavailable');
    return [_Track(calls), _Track(calls)];
  }

  @override
  Future<void> dispose() async {
    calls.add('stream.dispose');
    throw StateError('stream disposed');
  }
}

class _Channel extends Fake implements RTCDataChannel {
  _Channel(this.calls);
  final List<String> calls;
  @override
  Future<void> close() async {
    calls.add('channel.close');
    throw StateError('channel closed');
  }
}

class _Peer extends Fake implements RTCPeerConnection {
  _Peer(this.calls);
  final List<String> calls;
  @override
  Future<void> close() async {
    calls.add('peer.close');
    throw StateError('peer closed');
  }

  @override
  Future<void> dispose() async {
    calls.add('peer.dispose');
  }
}

void main() {
  for (final failEnumeration in [false, true]) {
    test(
      'cleanup releases all handles after platform failures (enumeration: $failEnumeration)',
      () async {
        final calls = <String>[];
        await closeVoiceTransportResources(
          microphone: _Microphone(calls, failEnumeration: failEnumeration),
          channel: _Channel(calls),
          peer: _Peer(calls),
        );
        expect(calls, [
          'tracks',
          if (!failEnumeration) ...['disable', 'stop', 'disable', 'stop'],
          'stream.dispose',
          'channel.close',
          'peer.close',
          'peer.dispose',
        ]);
      },
    );
  }
}
