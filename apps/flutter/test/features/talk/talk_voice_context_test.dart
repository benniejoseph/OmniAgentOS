import 'package:asael/features/talk/talk_command_context.dart';
import 'package:asael/features/talk/talk_voice_context_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _project = TalkCommandContextReference(
  kind: 'project',
  id: 'project-test',
  label: 'Client launch',
  description: 'A saved project',
  selectable: true,
  expectedVersion: 7,
);

void main() {
  for (final device in VoiceContextDevice.values) {
    testWidgets('editing sources preserves the selected ${device.label}', (
      tester,
    ) async {
      final guard = ValueNotifier(true);
      addTearDown(guard.dispose);
      VoiceContextSelection? saved;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async {
                  saved = await showDialog<VoiceContextSelection>(
                    context: context,
                    builder: (_) => VoiceContextEditor(
                      loadCatalog: () async =>
                          const TalkCommandContextCatalog(items: [_project]),
                      selected: const [_project],
                      computerUseTarget: device.apiValue,
                      device: device,
                      deviceReady: () => true,
                      deviceStatus: () => 'Device ready',
                      current: () => guard.value,
                      guard: guard,
                    ),
                  );
                },
                child: const Text('Edit voice context'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Edit voice context'));
      await tester.pumpAndSettle();
      expect(find.text('Asael + ${device.label}'), findsOneWidget);
      expect(
        find.text(
          device == VoiceContextDevice.mac
              ? 'Asael + This phone'
              : 'Asael + This Mac',
        ),
        findsNothing,
      );
      await tester.tap(find.text('Use this context'));
      await tester.pumpAndSettle();
      expect(saved?.computerUseTarget, device.apiValue);
      expect(
        saved?.references.single.toRequestJson(),
        _project.toRequestJson(),
      );
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('Mac control is an explicit choice and can be removed', (
    tester,
  ) async {
    final guard = ValueNotifier(true);
    addTearDown(guard.dispose);
    VoiceContextSelection? saved;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                saved = await showDialog<VoiceContextSelection>(
                  context: context,
                  builder: (_) => VoiceContextEditor(
                    loadCatalog: () async =>
                        const TalkCommandContextCatalog(items: []),
                    selected: const [],
                    computerUseTarget: saved?.computerUseTarget,
                    device: VoiceContextDevice.mac,
                    deviceReady: () => true,
                    deviceStatus: () => 'Device ready',
                    current: () => guard.value,
                    guard: guard,
                  ),
                );
              },
              child: const Text('Edit voice context'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Edit voice context'));
    await tester.pumpAndSettle();
    expect(
      tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value,
      isFalse,
    );
    await tester.tap(find.text('Asael + This Mac'));
    await tester.pumpAndSettle();
    expect(
      tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value,
      isTrue,
    );
    await tester.tap(find.text('Use this context'));
    await tester.pumpAndSettle();
    expect(saved?.computerUseTarget, 'local_macos');
    await tester.tap(find.text('Edit voice context'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Asael + This Mac'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Use this context'));
    await tester.pumpAndSettle();
    expect(saved?.computerUseTarget, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('unready Mac offers setup and owner invalidation fences it', (
    tester,
  ) async {
    final guard = ValueNotifier(true);
    addTearDown(guard.dispose);
    var setupCalls = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: VoiceContextEditor(
          loadCatalog: () async => const TalkCommandContextCatalog(items: []),
          selected: const [],
          computerUseTarget: null,
          device: VoiceContextDevice.mac,
          deviceReady: () => false,
          deviceStatus: () => 'Turn on Mac control in Settings.',
          onDeviceSettings: () => setupCalls++,
          current: () => guard.value,
          guard: guard,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      tester.widget<SwitchListTile>(find.byType(SwitchListTile)).onChanged,
      isNull,
    );
    await tester.tap(find.text('Set up This Mac'));
    expect(setupCalls, 1);
    guard.value = false;
    await tester.pumpAndSettle();
    expect(find.text('Set up This Mac'), findsNothing);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    expect(tester.takeException(), isNull);
  });
}
