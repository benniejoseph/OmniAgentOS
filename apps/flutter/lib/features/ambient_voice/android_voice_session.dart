import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/platform/android_device_bridge.dart';
import '../auth/application/session_controller.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import '../companion/companion_personality.dart';
import '../talk/talk.dart';
import '../talk/talk_providers.dart';
import 'voice_conversation_controller.dart';

/// The active Android call belongs to the authenticated app, not its screen.
/// UI disposal cannot orphan the microphone or recreate accepted work.
final androidVoiceSessionProvider =
    ChangeNotifierProvider<VoiceConversationController>((ref) {
      final owner = ref.watch(sessionOwnerKeyProvider);
      final talk = ref.watch(talkControllerProvider.notifier);
      final voice = VoiceConversationController(
        api: ref.watch(apiClientProvider),
        androidHost: appAndroidDeviceBridge.supported
            ? appAndroidDeviceBridge
            : null,
        readCompanionPersonality: ref
            .read(companionPersonalityProvider.notifier)
            .readSelection,
      );
      String selection() => jsonEncode({
        'agentId': talk.assignedAgent?.id ?? 'atlas',
        ...talk.voiceConversationContext,
      });
      void changed() {
        if (!voice.active || voice.commandContext == null) return;
        if (owner == null ||
            voice.conversationId != talk.threadId ||
            jsonEncode(voice.commandContext) != selection()) {
          // Compare normalized fields below: the server can omit optional values.
          final pinned = voice.commandContext!;
          final current = jsonDecode(selection()) as Map;
          if (owner == null ||
              voice.conversationId != talk.threadId ||
              [
                'agentId',
                'mode',
                'projectId',
                'contextScope',
                'computerUseTarget',
              ].any((key) => pinned[key] != current[key]) ||
              jsonEncode(pinned['contextReferences']) !=
                  jsonEncode(current['contextReferences'])) {
            unawaited(voice.end());
          }
        }
      }

      talk.addListener(changed);
      ref.onDispose(() => talk.removeListener(changed));
      ref.listen(biometricSessionLockControllerProvider, (_, next) {
        if (next.state.blocksInteraction) {
          unawaited(voice.end());
          if (appAndroidDeviceBridge.supported) unawaited(_stopPhone());
        }
      });
      return voice;
    });

Future<void> _stopPhone() async {
  try {
    await appAndroidDeviceBridge.stop();
  } catch (_) {}
}

final androidVoiceDelegateProvider = Provider<VoiceConversationDelegate>(
  (ref) => androidVoiceDelegate(
    ref,
    ref.watch(talkControllerProvider.notifier),
    ref.watch(androidVoiceSessionProvider.notifier),
  ),
);

/// No widget, BuildContext or mounted state is captured by the task delegate.
VoiceConversationDelegate androidVoiceDelegate(
  Ref ref,
  TalkController talk,
  VoiceConversationController voice,
) {
  final owner = ref.read(sessionOwnerKeyProvider);
  return (request, turnId, sessionId, conversationId, pinnedContext) async {
    if (!ref.mounted ||
        owner == null ||
        ref.read(sessionOwnerKeyProvider) != owner ||
        !identical(ref.read(talkControllerProvider), talk) ||
        ref
            .read(biometricSessionLockControllerProvider)
            .state
            .blocksInteraction ||
        voice.sessionId != sessionId ||
        voice.conversationId != conversationId ||
        talk.threadId != conversationId) {
      return {
        'status': 'context_changed',
        'message': 'The signed-in workspace or conversation changed. Start a new voice call.',
      };
    }
    return talk.sendVoiceConversationTurn(
      request,
      turnId,
      sessionId,
      conversationId,
      pinnedContext,
      companionPersonality: voice.companionPersonality,
    );
  };
}
