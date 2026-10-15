import 'package:asael/features/ambient_voice/voice_provider_configuration.dart';
import 'package:flutter_test/flutter_test.dart';

import 'voice_provider_configuration_fixture.dart';

VoiceProviderConfiguration configuration() =>
    VoiceProviderConfiguration.fromJson(providerExpectationFixture());

void main() {
  test(
    'matches the independent Node hashes for Unicode and numeric schemas',
    () {
      final expected = providerExpectationFixture();
      expect(
        expected['instructionsSha256'],
        '625d591e26f4f6859c8e616c5d2cd7f260dbed0a702a10d4107a1fcf49226409',
      );
      expect(
        expected['toolsSha256'],
        'eec55346206b4d20933e0fe4aeeab3ff3cb5ec3b191bd3d01324cf39aa95f06b',
      );
      expect(
        configuration().sha256,
        '1d4d93f76d6f1e574ee156e365172bca55b92d5a4068ef7d026958237362f006',
      );
    },
  );

  test('pins the exact requested target, including Asael-only selection', () {
    for (final target in [null, 'local_macos', 'local_android']) {
      requireVoiceTargetMatch(target, target);
      for (final other in [null, 'local_macos', 'local_android', 'all']) {
        if (target == other) continue;
        expect(
          () => requireVoiceTargetMatch(target, other),
          throwsA(isA<VoiceProviderConfigurationException>()),
        );
      }
    }
  });

  test('rejects missing or malformed expectations before connection', () {
    final valid = providerExpectationFixture();
    for (final candidate in [
      null,
      <String, dynamic>{},
      {...valid, 'instructionsSha256': 'private prompt'},
      {...valid, 'toolsSha256': 'bad'},
      {...valid, 'model': ''},
      {...valid, 'toolChoice': 'none'},
      {...valid, 'createResponse': false},
      {...valid, 'interruptResponse': false},
      {...valid, 'voice': 'other'},
      {
        ...valid,
        'outputModalities': ['audio', 'text'],
      },
      {...valid, 'unknown': true},
    ]) {
      expect(
        () => VoiceProviderConfiguration.fromJson(candidate),
        throwsA(isA<VoiceProviderConfigurationException>()),
      );
    }
  });

  test(
    'compares effective configuration while tolerating provider defaults',
    () {
      final session = providerSessionFixture()
        ..['expires_at'] = 100
        ..['object'] = 'realtime.session';
      (session['tools'] as List).single['provider_added_default'] = false;
      expect(configuration().matchesSession(session), isTrue);
      session['model'] = 'gpt-realtime';
      expect(configuration().matchesSession(session), isTrue);
    },
  );

  test('model aliases cannot widen to another family or reverse dated pin', () {
    for (final actual in [
      'gpt-realtime-mini',
      'gpt-realtime-other-2025-08-28',
      'gpt-realtime-2025-08-28-extra',
    ]) {
      expect(
        configuration().matchesSession(
          providerSessionFixture()..['model'] = actual,
        ),
        isFalse,
      );
    }
    final dated = VoiceProviderConfiguration.fromJson(
      providerExpectationFixture()..['model'] = 'gpt-realtime-2025-08-28',
    );
    expect(dated.matchesSession(providerSessionFixture()), isTrue);
    expect(
      dated.matchesSession(
        providerSessionFixture()..['model'] = 'gpt-realtime',
      ),
      isFalse,
    );
  });

  test('all work, prompt, audio and turn-detection drift fails closed', () {
    final changes = <void Function(Map<String, dynamic>)>[
      (s) => s.remove('instructions'),
      (s) => s['instructions'] = 'Cannot use apps.',
      (s) => s['instructions'] = 'x' * 32769,
      (s) => s['type'] = 'transcription',
      (s) => s['tool_choice'] = 'none',
      (s) => s['output_modalities'] = ['text'],
      (s) => s['tools'] = [],
      (s) => (s['tools'] as List).add((s['tools'] as List).single),
      (s) => s['tools'][0]['name'] = 'other_tool',
      (s) => s['tools'][0]['description'] = 'Conversation only.',
      (s) => s['tools'][0]['parameters']['additionalProperties'] = true,
      (s) => s['tools'][0]['parameters']['properties']['request']['maxLength'] =
          8001,
      (s) => s['audio']['output']['voice'] = 'marin',
      (s) => s['audio']['input']['transcription']['model'] = 'other',
      (s) => s['audio']['input']['turn_detection']['type'] = 'semantic_vad',
      (s) => s['audio']['input']['turn_detection'].remove('create_response'),
      (s) =>
          s['audio']['input']['turn_detection']['interrupt_response'] = false,
    ];
    for (final change in changes) {
      final session = providerSessionFixture();
      change(session);
      expect(configuration().matchesSession(session), isFalse);
    }
  });

  test(
    'acknowledgement is latched before or after the waiter starts',
    () async {
      for (final early in [true, false]) {
        final guard = VoiceProviderSessionGuard(configuration());
        if (early) {
          expect(
            guard.observe('session.created', providerSessionFixture()),
            isTrue,
          );
        }
        final waiting = guard.wait(timeout: const Duration(seconds: 1));
        if (!early) {
          expect(guard.verified, isFalse);
          expect(guard.acknowledgement, isNull);
          expect(
            guard.observe('session.created', providerSessionFixture()),
            isTrue,
          );
        }
        expect(await waiting, isTrue);
        expect(guard.acknowledgement?['observedBy'], 'client');
        expect(
          guard.acknowledgement?['configurationSha256'],
          configuration().sha256,
        );
        expect(
          guard.observe('session.updated', providerSessionFixture()),
          isTrue,
        );
      }
    },
  );

  test('timeout, close, wrong order and drift cannot be revived', () async {
    for (final reason in [
      'timeout',
      'close',
      'updated_first',
      'drift',
      'duplicate',
    ]) {
      final guard = VoiceProviderSessionGuard(configuration());
      if (reason == 'drift' || reason == 'duplicate') {
        guard.observe('session.created', providerSessionFixture());
      }
      if (reason == 'timeout') {
        expect(await guard.wait(timeout: Duration.zero), isFalse);
      } else if (reason == 'close') {
        final waiting = guard.wait(timeout: const Duration(seconds: 1));
        guard.close();
        expect(await waiting, isFalse);
      } else {
        expect(
          guard.observe(
            reason == 'duplicate' ? 'session.created' : 'session.updated',
            providerSessionFixture()
              ..['tool_choice'] = reason == 'drift' ? 'none' : 'auto',
          ),
          isFalse,
        );
      }
      expect(guard.verified, isFalse);
      expect(guard.acknowledgement, isNull);
      expect(
        guard.observe('session.created', providerSessionFixture()),
        isFalse,
      );
      expect(await guard.wait(timeout: Duration.zero), isFalse);
    }
  });
}
