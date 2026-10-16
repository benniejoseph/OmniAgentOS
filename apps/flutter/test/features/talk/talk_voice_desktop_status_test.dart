import 'package:asael/features/ambient_voice/voice_conversation_controller.dart';
import 'package:asael/features/companion/voice_appearance.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _Repository extends Fake implements TalkRepository {}

class _Recorder extends Fake implements VoiceDraftRecorder {
  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {}
}

class _Voice extends ChangeNotifier implements VoiceConversationController {
  @override
  Map<String, dynamic>? get voiceApprovalReview => null;
  @override
  String? get approvalRequest => null;
  @override
  String? get verbalApprovalNotice =>
      waitingForApproval ? 'Preparing the exact action for review.' : null;
  @override
  bool get canRefreshSpokenApprovalReview => false;
  @override
  String? get spokenReviewUnavailableReason =>
      waitingForApproval ? 'The current review is being prepared.' : null;
  @override
  VoiceConversationPhase phase = VoiceConversationPhase.working;
  @override
  bool waitingForApproval = false;
  @override
  bool muted = false;
  @override
  String? errorMessage;
  int endCalls = 0;

  @override
  bool get active => switch (phase) {
    VoiceConversationPhase.connecting ||
    VoiceConversationPhase.listening ||
    VoiceConversationPhase.speaking ||
    VoiceConversationPhase.working => true,
    _ => false,
  };
  @override
  bool get ready => active && phase != VoiceConversationPhase.connecting;
  @override
  bool get microphoneActive => ready && !muted;
  @override
  bool get userSpeaking => false;
  @override
  String get agentName => 'ATLAS';
  @override
  String get caption => '';
  @override
  String? get historyNotice => null;
  @override
  String? get workNotice => null;
  @override
  Map<String, dynamic>? get commandContext => null;

  @override
  Future<void> end() async => endCalls++;

  void changed() => notifyListeners();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('app.omniagent.omniagent/desktop');
  final macOS = TargetPlatformVariant.only(TargetPlatform.macOS);
  late _Voice voice;
  late TalkController talk;
  late List<String> published;

  setUp(() {
    voice = _Voice();
    talk = TalkController(_Repository());
    published = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'updateAmbientVoiceState') {
            final state = (call.arguments as Map)['state'] as String;
            published.add(state);
            return {'available': true, 'state': state};
          }
          return null;
        });
  });
  tearDown(() {
    voice.dispose();
    talk.dispose();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  Future<void> show(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    published.clear();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          voiceAppearanceProvider.overrideWith(
            (_) => VoiceAppearanceController(null),
          ),
        ],
        child: MaterialApp(
          home: TalkView(
            controller: talk,
            voiceRecorder: _Recorder(),
            ambientVoice: true,
            backgroundVoiceController: voice,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'Mac menu follows approval and resumed work without ending voice',
    (tester) async {
      await show(tester);
      expect(published.last, 'running');

      voice.waitingForApproval = true;
      voice.changed();
      await tester.pumpAndSettle();
      expect(find.text('ATLAS · Needs your review'), findsOneWidget);
      expect(published, ['running', 'approval']);
      expect(voice.active, isTrue);
      expect(voice.microphoneActive, isTrue);
      expect(voice.endCalls, 0);

      voice.waitingForApproval = false;
      voice.changed();
      await tester.pumpAndSettle();
      expect(find.text('ATLAS · Working'), findsOneWidget);
      expect(published, ['running', 'approval', 'running']);
      expect(voice.endCalls, 0);
      expect(tester.takeException(), isNull);
    },
    variant: macOS,
  );

  testWidgets('pending approval stays visible during listening or speech', (
    tester,
  ) async {
    voice.waitingForApproval = true;
    voice.phase = VoiceConversationPhase.listening;
    await show(tester);
    expect(published, ['approval']);

    voice.muted = true;
    voice.phase = VoiceConversationPhase.speaking;
    voice.changed();
    await tester.pumpAndSettle();
    expect(find.text('ATLAS · Needs your review'), findsOneWidget);
    expect(published, ['approval']);
    expect(voice.phase, VoiceConversationPhase.speaking);
    expect(voice.muted, isTrue);
    expect(voice.endCalls, 0);

    voice.waitingForApproval = false;
    voice.changed();
    await tester.pumpAndSettle();
    expect(published, ['approval', 'speaking']);
    expect(find.text('ATLAS · Speaking'), findsOneWidget);
    expect(tester.takeException(), isNull);
  }, variant: macOS);

  testWidgets('closed or failed calls do not publish a stale approval status', (
    tester,
  ) async {
    voice.waitingForApproval = true;
    voice.phase = VoiceConversationPhase.error;
    voice.errorMessage = 'The connection ended.';
    await show(tester);
    expect(published.last, 'error');

    voice.phase = VoiceConversationPhase.ended;
    voice.errorMessage = null;
    voice.changed();
    await tester.pumpAndSettle();
    expect(published.last, 'asleep');
    expect(voice.active, isFalse);
    expect(voice.endCalls, 0);
    expect(tester.takeException(), isNull);
  }, variant: macOS);
}
