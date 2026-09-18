import 'package:asael/app/macos/macos_page_scaffold.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('inspector divider supports drag, keyboard, and semantics', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 760);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final semantics = tester.ensureSemantics();

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: const Scaffold(
          body: MacosResizableInspector(
            initialWidth: 330,
            minWidth: 270,
            maxWidth: 460,
            body: Center(child: Text('Workspace')),
            inspector: Center(child: Text('Inspector')),
          ),
        ),
      ),
    );

    const dividerKey = ValueKey('macos-inspector-resize-divider');
    const paneKey = ValueKey('macos-inspector-pane');
    final divider = find.byKey(dividerKey);
    double inspectorWidth() => tester.getSize(find.byKey(paneKey)).width;

    expect(inspectorWidth(), 330);
    var node = tester.getSemantics(divider);
    expect(node.label, 'Resize inspector');
    expect(node.value, '330 pixels wide');
    expect(node.getSemanticsData().hasAction(SemanticsAction.increase), isTrue);
    expect(node.getSemanticsData().hasAction(SemanticsAction.decrease), isTrue);

    await tester.tap(divider);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pump();
    expect(inspectorWidth(), 354);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump();
    expect(inspectorWidth(), 330);

    node = tester.getSemantics(divider);
    tester.binding.performSemanticsAction(
      SemanticsActionEvent(
        type: SemanticsAction.increase,
        nodeId: node.id,
        viewId: tester.view.viewId,
      ),
    );
    await tester.pump();
    expect(inspectorWidth(), 354);

    await tester.drag(divider, const Offset(-36, 0));
    await tester.pump();
    expect(inspectorWidth(), greaterThan(354));
    expect(tester.takeException(), isNull);
    semantics.dispose();
  });
}
