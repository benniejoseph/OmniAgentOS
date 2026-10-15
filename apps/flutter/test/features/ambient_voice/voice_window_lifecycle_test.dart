import 'dart:async';

import 'package:asael/core/platform/desktop_host_bridge.dart';
import 'package:asael/features/ambient_voice/voice_conversation_controller.dart';
import 'package:asael/features/ambient_voice/voice_conversation_view.dart';
import 'package:asael/features/companion/voice_appearance.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _Voice extends ChangeNotifier implements VoiceConversationController {
  @override
  bool active = true;
  @override
  VoiceConversationPhase phase = VoiceConversationPhase.listening;
  @override
  bool get ready => active;
  @override
  bool get muted => false;
  @override
  bool get microphoneActive => active;
  @override
  bool get userSpeaking => false;
  @override
  bool get waitingForApproval => false;
  @override
  String get agentName => 'ATLAS';
  @override
  String get caption => '';
  @override
  String? get errorMessage => null;
  @override
  String? get historyNotice => null;
  @override
  String? get workNotice => null;
  @override
  Map<String, dynamic>? get commandContext => null;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void macTestWidgets(String description, WidgetTesterCallback callback) {
  testWidgets(
    description,
    callback,
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('test.asael.voice-window-lifecycle');
  late DesktopHostBridge host;
  late List<MethodCall> calls;
  late _Voice voice;

  setUp(() {
    host = DesktopHostBridge(channel: channel, enabled: true);
    calls = [];
    voice = _Voice();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return null;
        });
  });
  tearDown(() {
    voice.dispose();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  Widget surface({
    Key? key,
    VoidCallback? onEnd,
    String? error,
    Future<void> Function()? editContext,
  }) => ProviderScope(
    overrides: [
      voiceAppearanceProvider.overrideWith(
        (_) => VoiceAppearanceController(null),
      ),
    ],
    child: MaterialApp(
      home: VoiceConversationSurface(
        key: key,
        controller: voice,
        desktopHost: host,
        consentRequired: false,
        startError: error,
        onStart: () {},
        onEnd: onEnd ?? () {},
        onEditContext: editContext,
        contextSummary: () => 'This conversation · Asael and this Mac',
      ),
    ),
  );

  macTestWidgets('End restores before an outgoing voice surface rebuilds', (
    tester,
  ) async {
    await tester.pumpWidget(
      surface(
        onEnd: () {
          voice.active = false;
          voice.phase = VoiceConversationPhase.ended;
        },
      ),
    );
    await tester.pumpAndSettle();
    expect(calls.last.method, 'showAmbientVoicePresentation');

    await tester.tap(find.text('End'));
    // A Navigator exit animation retains its old surface. Ending the call
    // changes its dimensions from the listening dock to the ready/error view.
    await tester.pumpWidget(surface());
    await tester.pumpAndSettle();
    expect(find.text('Close'), findsOneWidget);
    expect(calls.map((call) => call.method), [
      'showAmbientVoicePresentation',
      'showMainPresentation',
    ]);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    expect(calls.last.method, 'showMainPresentation');
    expect(calls, hasLength(2));
  });

  macTestWidgets(
    'route disposal restores even after a failed start without End',
    (tester) async {
      voice.active = false;
      voice.phase = VoiceConversationPhase.error;
      await tester.pumpWidget(surface(error: 'Microphone unavailable'));
      await tester.pumpAndSettle();
      expect(find.text('Close'), findsOneWidget);
      await tester.pumpWidget(const MaterialApp(home: Text('Signed out')));
      await tester.pumpAndSettle();
      expect(calls.last.method, 'showMainPresentation');
      expect(
        calls.where((call) => call.method == 'showMainPresentation'),
        hasLength(1),
      );
      expect(tester.takeException(), isNull);
    },
  );

  macTestWidgets(
    'replacing an owner surface does not restore over its successor',
    (tester) async {
      await tester.pumpWidget(surface(key: const ValueKey('owner-a')));
      await tester.pumpAndSettle();
      await tester.pumpWidget(surface(key: const ValueKey('owner-b')));
      await tester.pumpAndSettle();
      expect(calls.map((call) => call.method), [
        'showAmbientVoicePresentation',
        'showAmbientVoicePresentation',
      ]);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      expect(calls.last.method, 'showMainPresentation');
    },
  );

  macTestWidgets(
    'context editor expands and restores only its current voice lease',
    (tester) async {
      voice.active = false;
      voice.phase = VoiceConversationPhase.idle;
      final editing = Completer<void>();
      var opened = 0;
      await tester.pumpWidget(
        surface(
          editContext: () {
            opened++;
            return editing.future;
          },
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Control and context'), findsOneWidget);
      await tester.tap(find.text('Control and context'));
      await tester.pumpAndSettle();
      expect(opened, 1);
      expect(calls.last.arguments, containsPair('width', 760.0));
      expect(calls.last.arguments, containsPair('height', 640.0));
      await host.showMainPresentation();
      editing.complete();
      await tester.pumpAndSettle();
      expect(calls.last.method, 'showMainPresentation');
      expect(tester.takeException(), isNull);
    },
  );

  macTestWidgets(
    'active calls expose current context without an edit control',
    (tester) async {
      await tester.pumpWidget(surface(editContext: () async {}));
      await tester.pumpAndSettle();
      expect(find.text('Control and context'), findsNothing);
      await tester.tap(find.byTooltip('Show captions'));
      await tester.pumpAndSettle();
      expect(
        find.text('This conversation · Asael and this Mac'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  macTestWidgets('closing context restores the current appearance', (
    tester,
  ) async {
    voice.active = false;
    voice.phase = VoiceConversationPhase.idle;
    final editing = Completer<void>();
    await tester.pumpWidget(surface(editContext: () => editing.future));
    await tester.pumpAndSettle();
    final initial = calls.last.arguments;
    await tester.tap(find.text('Control and context'));
    await tester.pumpAndSettle();
    expect(calls.last.arguments, containsPair('width', 760.0));
    editing.complete();
    await tester.pumpAndSettle();
    expect(calls.last.arguments, initial);
    expect(
      calls.where((call) => call.method == 'showMainPresentation'),
      isEmpty,
    );
  });

  test(
    'stale layouts and disposals cannot overwrite a new presentation',
    () async {
      final old = host.beginVoiceWindowPresentation();
      Future<void> show(DesktopVoiceWindowPresentation lease) => lease.show(
        appearance: 'companion',
        width: 400,
        height: 280,
        reduceMotion: true,
      );
      await show(old);
      await host.showQuickEntryPresentation();
      await show(old);
      await old.close();
      expect(calls.map((call) => call.method), [
        'showAmbientVoicePresentation',
        'showQuickEntryPresentation',
      ]);
      final current = host.beginVoiceWindowPresentation();
      await show(current);
      await old.close();
      expect(current.current, isTrue);
      await current.close();
      await show(current);
      expect(calls.last.method, 'showMainPresentation');
      expect(calls, hasLength(4));
    },
  );

  test(
    'Dock recovery invalidates pending layout callbacks without navigation',
    () async {
      final old = host.beginVoiceWindowPresentation();
      await host.handleNativeCall(const MethodCall('mainPresentationRestored'));
      await old.show(
        appearance: 'companion',
        width: 400,
        height: 280,
        reduceMotion: true,
      );
      expect(old.current, isFalse);
      expect(calls, isEmpty);
      await expectLater(
        host.handleNativeCall(
          const MethodCall('mainPresentationRestored', {'route': '/talk'}),
        ),
        throwsA(isA<PlatformException>()),
      );
    },
  );
}
