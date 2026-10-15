import 'dart:async';
import 'dart:convert';

import '../settings/portable_archive_canonical.dart';

/// Only fixed categories escape this boundary; provider instructions can contain
/// private workspace context and must never appear in an error or receipt.
class VoiceProviderConfigurationException implements Exception {
  const VoiceProviderConfigurationException(this.code);
  final String code;
  String get message =>
      'Asael could not verify this voice call’s controls. Start a new call to try again.';
  @override
  String toString() => message;
}

void requireVoiceTargetMatch(Object? requested, Object? returned) {
  const targets = {null, 'local_macos', 'local_android'};
  if (!targets.contains(requested) ||
      !targets.contains(returned) ||
      requested != returned) {
    throw const VoiceProviderConfigurationException('voice_target_mismatch');
  }
}

/// A nonsecret expectation issued beside the ephemeral credential. It commits
/// to the exact prompt and work tool, without copying either into native state.
class VoiceProviderConfiguration {
  VoiceProviderConfiguration._(this._value);

  factory VoiceProviderConfiguration.fromJson(Object? value) {
    const keys = {
      'schemaVersion',
      'instructionsSha256',
      'toolsSha256',
      'model',
      'voice',
      'transcriptionModel',
      'turnDetection',
      'createResponse',
      'interruptResponse',
      'toolChoice',
      'outputModalities',
    };
    if (value is! Map ||
        value.length != keys.length ||
        value.keys.any((key) => !keys.contains(key)) ||
        value['schemaVersion'] != 1 ||
        !_sha(value['instructionsSha256']) ||
        !_sha(value['toolsSha256']) ||
        value['model'] is! String ||
        !RegExp(r'^[A-Za-z0-9_.:-]{1,240}$').hasMatch(value['model']) ||
        value['voice'] != 'cedar' ||
        value['transcriptionModel'] != 'gpt-4o-mini-transcribe' ||
        value['turnDetection'] != 'server_vad' ||
        value['createResponse'] != true ||
        value['interruptResponse'] != true ||
        value['toolChoice'] != 'auto' ||
        !_audioOnly(value['outputModalities'])) {
      throw const VoiceProviderConfigurationException(
        'voice_provider_configuration_invalid',
      );
    }
    return VoiceProviderConfiguration._(
      Map<String, Object?>.unmodifiable({
        ...Map<String, Object?>.from(value),
        'outputModalities': const ['audio'],
      }),
    );
  }

  final Map<String, Object?> _value;
  String get sha256 => portableCanonicalSha256(_value);

  bool matchesSession(Object? value) {
    if (value is! Map || value['type'] != 'realtime') return false;
    final audio = value['audio'];
    if (audio is! Map) return false;
    final input = audio['input'], output = audio['output'];
    if (input is! Map || output is! Map) return false;
    final transcription = input['transcription'];
    final detection = input['turn_detection'];
    final instructions = value['instructions'];
    if (transcription is! Map ||
        detection is! Map ||
        instructions is! String ||
        utf8.encode(instructions).length > 32768 ||
        !_modelMatches(_value['model'] as String, value['model']) ||
        !_audioOnly(value['output_modalities']) ||
        value['tool_choice'] != _value['toolChoice'] ||
        output['voice'] != _value['voice'] ||
        transcription['model'] != _value['transcriptionModel'] ||
        detection['type'] != _value['turnDetection'] ||
        detection['create_response'] != _value['createResponse'] ||
        detection['interrupt_response'] != _value['interruptResponse'] ||
        portableTextSha256(instructions) != _value['instructionsSha256']) {
      return false;
    }
    final tools = value['tools'];
    if (tools is! List || tools.length != 1 || tools.single is! Map) {
      return false;
    }
    final tool = tools.single as Map;
    if (tool['type'] != 'function' ||
        tool['name'] != 'ask_asael' ||
        tool['description'] is! String ||
        tool['parameters'] is! Map) {
      return false;
    }
    try {
      final canonical = portableCanonicalJson([
        {
          for (final key in ['type', 'name', 'description', 'parameters'])
            key: tool[key],
        },
      ]);
      return utf8.encode(canonical).length <= 16384 &&
          portableTextSha256(canonical) == _value['toolsSha256'];
    } on FormatException {
      return false;
    }
  }

  static bool _sha(Object? value) =>
      value is String && RegExp(r'^[a-f0-9]{64}$').hasMatch(value);
  static bool _audioOnly(Object? value) =>
      value is List && value.length == 1 && value.single == 'audio';
  static bool _modelMatches(String expected, Object? actual) =>
      actual == expected ||
      (actual is String &&
          !RegExp(r'-\d{4}-\d{2}-\d{2}$').hasMatch(expected) &&
          RegExp('^${RegExp.escape(expected)}-\\d{4}-\\d{2}-\\d{2}\$')
              .hasMatch(actual));
}

/// One call's acknowledgement latch. Observations are synchronous so a function
/// or response event cannot overtake a pending digest check on the data channel.
class VoiceProviderSessionGuard {
  VoiceProviderSessionGuard(this.configuration);
  final VoiceProviderConfiguration configuration;
  final _acknowledged = Completer<bool>();
  bool _closed = false;
  bool _created = false;
  bool get verified => !_closed && _created;

  bool observe(String type, Object? session) {
    if (_closed) return false;
    if ((type != 'session.created' && type != 'session.updated') ||
        (type == 'session.updated' && !_created) ||
        (type == 'session.created' && _created) ||
        !configuration.matchesSession(session)) {
      close();
      return false;
    }
    _created = true;
    if (!_acknowledged.isCompleted) _acknowledged.complete(true);
    return true;
  }

  Future<bool> wait({required Duration timeout}) async {
    final acknowledged = await _acknowledged.future.timeout(
      timeout,
      onTimeout: () {
        close();
        return false;
      },
    );
    return acknowledged && verified;
  }

  Map<String, Object>? get acknowledgement => verified
      ? {
          'schemaVersion': 1,
          'verified': true,
          'configurationSha256': configuration.sha256,
          'observedBy': 'client',
        }
      : null;

  void close() {
    _closed = true;
    if (!_acknowledged.isCompleted) _acknowledged.complete(false);
  }
}
