import 'dart:convert';

import 'package:asael/features/settings/portable_archive_canonical.dart';

Map<String, dynamic> providerSessionFixture() => {
  'type': 'realtime',
  'id': 'sess_live_distinct_from_secret',
  'model': 'gpt-realtime-2025-08-28',
  'instructions': 'Use Asael’s governed tools. Preserve 2819 exactly. 🌿',
  'output_modalities': ['audio'],
  'tool_choice': 'auto',
  'audio': {
    'input': {
      'transcription': {'model': 'gpt-4o-mini-transcribe'},
      'turn_detection': {
        'type': 'server_vad',
        'create_response': true,
        'interrupt_response': true,
      },
    },
    'output': {'voice': 'cedar'},
  },
  'tools': [
    {
      'type': 'function',
      'name': 'ask_asael',
      'description': 'Delegate the user’s task to Asael.',
      'parameters': {
        'type': 'object',
        'properties': {
          'request': {'type': 'string', 'minLength': 1, 'maxLength': 8000},
        },
        'required': ['request'],
        'additionalProperties': false,
      },
    },
  ],
};

Map<String, dynamic> providerExpectationFixture() {
  final session = providerSessionFixture();
  return {
    'schemaVersion': 1,
    'instructionsSha256': portableTextSha256(session['instructions']),
    'toolsSha256': portableCanonicalSha256(session['tools']),
    'model': 'gpt-realtime',
    'voice': 'cedar',
    'transcriptionModel': 'gpt-4o-mini-transcribe',
    'turnDetection': 'server_vad',
    'createResponse': true,
    'interruptResponse': true,
    'toolChoice': 'auto',
    'outputModalities': ['audio'],
  };
}

Map<String, dynamic> cloneVoiceJson(Map<String, dynamic> value) =>
    jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
