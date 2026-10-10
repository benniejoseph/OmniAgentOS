import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

typedef ListenJson = Map<String, dynamic>;

ListenJson listenMap(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};
List<ListenJson> listenRows(Object? value) => value is List
    ? value.whereType<Map>().map(ListenJson.from).toList(growable: false)
    : const [];
String listenText(Object? value, [String fallback = '']) =>
    value is String && value.trim().isNotEmpty ? value : fallback;
int listenInt(Object? value) => value is num ? value.toInt() : 0;

/// Only the dedicated upload grant crosses this bridge. Native recording and
/// scheduling never receive the workspace access token or refresh token.
class ListenBridge {
  static const _channel = MethodChannel('app.omniagent.omniagent/listen');
  static const _events = EventChannel('app.omniagent.omniagent/listen/events');
  bool get supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
  Stream<ListenJson>? _stream;
  Stream<ListenJson> get events => _stream ??= _events
      .receiveBroadcastStream()
      .map(_parseStatus)
      .asBroadcastStream();

  static ListenJson _parseStatus(Object? value) {
    final result = listenMap(value);
    if (result['schemaVersion'] != 1 ||
        result['supported'] is! bool ||
        result['accessReady'] is! bool ||
        result['callsEnabled'] is! bool ||
        result['callFolderSelected'] is! bool ||
        result['sessions'] is! List) {
      throw const FormatException('The listening status could not be read.');
    }
    return result;
  }

  Future<ListenJson> invoke(String method, [ListenJson? arguments]) async {
    if (!supported) {
      throw UnsupportedError('Phone listening is available on Android.');
    }
    return _parseStatus(
      await _channel.invokeMethod<Object?>(method, arguments),
    );
  }

  Future<void> clearOwner() async {
    if (supported) await _channel.invokeMethod<Object?>('clearOwner');
  }
}

final appListenBridge = ListenBridge();
