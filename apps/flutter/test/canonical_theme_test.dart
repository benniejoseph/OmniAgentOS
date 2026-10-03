import 'dart:ui' as ui;

import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/app/theme/daybook_backdrop.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/app/theme/macos_workspace_backdrop.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final variants = [
    ('mobile light', AppTheme.light(platform: TargetPlatform.android), 48.0),
    ('mobile dark', AppTheme.dark(platform: TargetPlatform.android), 48.0),
    ('macOS light', MacosAppTheme.light(), 44.0),
    ('macOS dark', MacosAppTheme.dark(), 44.0),
  ];

  for (final (name, theme, target) in variants) {
    test('$name uses the canonical opaque palette and readable states', () {
      final dark = theme.brightness == Brightness.dark;
      final colors = theme.colorScheme;
      final tokens = theme.extension<AsaelThemeColors>()!;
      expect(tokens.background, Color(dark ? 0xFF191A1B : 0xFFFAF9F6));
      expect(colors.onSurface, Color(dark ? 0xFFF4F1EA : 0xFF242321));
      expect(colors.surface, Color(dark ? 0xFF222325 : 0xFFFFFFFF));
      expect(tokens.raised, Color(dark ? 0xFF2B2C2F : 0xFFF0EEEA));
      expect(tokens.overlay, Color(dark ? 0xFF34363A : 0xFFE8E4DE));
      expect(tokens.muted, Color(dark ? 0xFFB8B3AA : 0xFF69645E));
      expect(colors.primary, Color(dark ? 0xFFF0EDE7 : 0xFF272521));
      expect(tokens.accent, Color(dark ? 0xFFE2BD74 : 0xFF806019));
      expect(tokens.success, Color(dark ? 0xFF91CFAC : 0xFF286243));
      expect(tokens.warning, Color(dark ? 0xFFE7C37C : 0xFF805814));
      expect(colors.error, Color(dark ? 0xFFF1A09A : 0xFFAC3530));
      expect(tokens.info, Color(dark ? 0xFF9CCAE0 : 0xFF2E627C));
      expect(tokens.focus, Color(dark ? 0xFFF0C77B : 0xFF8D611A));
      expect(tokens.lineStrong, Color(dark ? 0xFF888980 : 0xFF827A70));
      expect(theme.cardTheme.color, colors.surface);

      for (final background in [
        tokens.background,
        colors.surface,
        tokens.raised,
        tokens.overlay,
      ]) {
        for (final foreground in [
          colors.onSurface,
          tokens.muted,
          tokens.accent,
          tokens.success,
          tokens.warning,
          colors.error,
          tokens.info,
        ]) {
          expect(
            _contrast(foreground, background),
            greaterThanOrEqualTo(4.5),
            reason: '$foreground on $background',
          );
        }
        expect(
          _contrast(tokens.lineStrong, background),
          greaterThanOrEqualTo(3),
        );
        expect(_contrast(tokens.focus, background), greaterThanOrEqualTo(3));
      }
      for (final state in <Set<WidgetState>>[
        {},
        {WidgetState.hovered},
        {WidgetState.pressed},
        {WidgetState.disabled},
      ]) {
        final style = theme.filledButtonTheme.style!;
        expect(
          _contrast(
            style.foregroundColor!.resolve(state)!,
            style.backgroundColor!.resolve(state)!,
          ),
          greaterThanOrEqualTo(4.5),
        );
      }
      expect(
        _contrast(colors.onSecondary, colors.secondary),
        greaterThanOrEqualTo(4.5),
      );
      expect(
        _contrast(colors.onTertiary, colors.tertiary),
        greaterThanOrEqualTo(4.5),
      );
      expect(
        _contrast(colors.onError, colors.error),
        greaterThanOrEqualTo(4.5),
      );
    });

    test('$name controls have a minimum target and can grow with text', () {
      for (final style in [
        theme.filledButtonTheme.style,
        theme.elevatedButtonTheme.style,
        theme.outlinedButtonTheme.style,
        theme.textButtonTheme.style,
        theme.iconButtonTheme.style,
        theme.segmentedButtonTheme.style,
        theme.menuButtonTheme.style,
      ]) {
        expect(
          style!.minimumSize!.resolve({})!.height,
          greaterThanOrEqualTo(target),
        );
        expect(style.visualDensity, VisualDensity.standard);
        expect(
          style.maximumSize?.resolve({})?.height ?? double.infinity,
          double.infinity,
        );
        expect(style.animationDuration, Duration.zero);
      }
      expect(
        theme.inputDecorationTheme.constraints!.minHeight,
        greaterThanOrEqualTo(target),
      );
      expect(
        theme.searchBarTheme.constraints!.minHeight,
        greaterThanOrEqualTo(target),
      );
      expect(theme.searchBarTheme.constraints!.maxHeight, double.infinity);
      expect(theme.textTheme.bodyLarge!.fontSize, 16);
      expect(theme.textTheme.bodyMedium!.fontSize, 14);
      expect(theme.textTheme.bodySmall!.fontSize, 13);
      expect(theme.textTheme.headlineMedium!.fontSize, target == 44 ? 28 : 24);
      final field = theme.inputDecorationTheme.enabledBorder!;
      expect(
        _contrast(
          field.borderSide.color,
          theme.inputDecorationTheme.fillColor!,
        ),
        greaterThanOrEqualTo(3),
      );
      expect(theme.inputDecorationTheme.focusedBorder!.borderSide.width, 3);
    });

    testWidgets('$name focus ring has an opaque three-pixel inner gap', (
      tester,
    ) async {
      late CustomPainter painter;
      await tester.pumpWidget(
        MaterialApp(
          theme: theme,
          home: Builder(
            builder: (context) {
              final layer = theme.filledButtonTheme.style!.backgroundBuilder!(
                context,
                {WidgetState.focused},
                const SizedBox(width: 80, height: 48),
              ) as CustomPaint;
              painter = layer.foregroundPainter!;
              return layer;
            },
          ),
        ),
      );
      await tester.runAsync(() async {
        final recorder = ui.PictureRecorder();
        final canvas = Canvas(recorder);
        canvas.drawRect(
          const Rect.fromLTWH(0, 0, 80, 48),
          Paint()..color = theme.colorScheme.primary,
        );
        painter.paint(canvas, const Size(80, 48));
        final picture = recorder.endRecording();
        final image = await picture.toImage(80, 48);
        final bytes = (await image.toByteData(
          format: ui.ImageByteFormat.rawRgba,
        ))!;
        Color pixel(int x, int y) {
          final index = (y * 80 + x) * 4;
          return Color.fromARGB(
            bytes.getUint8(index + 3),
            bytes.getUint8(index),
            bytes.getUint8(index + 1),
            bytes.getUint8(index + 2),
          );
        }

        expect(pixel(40, 1), theme.extension<AsaelThemeColors>()!.focus);
        expect(pixel(40, 4), theme.colorScheme.surface);
        expect(pixel(40, 10), theme.colorScheme.primary);
        image.dispose();
        picture.dispose();
      });
      expect(tester.takeException(), isNull);
    });

    for (final reduced in [true, false]) {
      testWidgets('$name transition respects reduced motion=$reduced', (
        tester,
      ) async {
        final route = MaterialPageRoute<void>(
          settings: const RouteSettings(name: '/next'),
          builder: (_) => const SizedBox(),
        );
        addTearDown(route.dispose);
        const child = SizedBox(key: ValueKey('transition-content'));
        Widget? result;
        await tester.pumpWidget(
          MaterialApp(
            theme: theme,
            home: MediaQuery(
              data: MediaQueryData(disableAnimations: reduced),
              child: Builder(
                builder: (context) {
                  result = theme.pageTransitionsTheme.builders[theme.platform]!
                      .buildTransitions<void>(
                        route,
                        context,
                        const AlwaysStoppedAnimation(0.5),
                        const AlwaysStoppedAnimation(0),
                        child,
                      );
                  return result!;
                },
              ),
            ),
          ),
        );
        expect(result, reduced ? same(child) : isA<FadeTransition>());
        expect(
          find.byKey(const ValueKey('transition-content')),
          findsOneWidget,
        );
      });
    }
  }

  test('high contrast changes secondary text and dividers without drifting the palette', () {
    for (final (normal, high) in [
      (AppTheme.light(), AppTheme.light(highContrast: true)),
      (AppTheme.dark(), AppTheme.dark(highContrast: true)),
      (MacosAppTheme.light(), MacosAppTheme.light(highContrast: true)),
      (MacosAppTheme.dark(), MacosAppTheme.dark(highContrast: true)),
    ]) {
      final tokens = high.extension<AsaelThemeColors>()!;
      expect(tokens.muted, high.colorScheme.onSurface);
      expect(tokens.line, tokens.lineStrong);
      expect(high.colorScheme.outlineVariant, high.colorScheme.outline);
      expect(high.scaffoldBackgroundColor, normal.scaffoldBackgroundColor);
      expect(high.colorScheme.primary, normal.colorScheme.primary);
    }
  });

  for (final (name, theme, backdrop) in [
    (
      'mobile',
      AppTheme.light(platform: TargetPlatform.android),
      (Widget child) => DaybookBackdrop(child: child),
    ),
    (
      'desktop',
      MacosAppTheme.dark(),
      (Widget child) => MacosWorkspaceBackdrop(child: child),
    ),
  ]) {
    testWidgets(
      '$name backdrop is opaque and preserves inherited accessibility',
      (tester) async {
        late ThemeData childTheme;
        late MediaQueryData media;
        var tapped = false;
        await tester.pumpWidget(
          MaterialApp(
            theme: theme,
            home: MediaQuery(
              data: const MediaQueryData(
                textScaler: TextScaler.linear(2),
                disableAnimations: true,
              ),
              child: backdrop(
                Builder(
                  builder: (context) {
                    childTheme = Theme.of(context);
                    media = MediaQuery.of(context);
                    return ListTile(
                      key: const ValueKey('backdrop-child'),
                      title: const Text('Workspace destination'),
                      onTap: () => tapped = true,
                    );
                  },
                ),
              ),
            ),
          ),
        );
        final root = name == 'mobile'
            ? find.byType(DaybookBackdrop)
            : find.byType(MacosWorkspaceBackdrop);
        final surfaces = tester.widgetList<Material>(
          find.descendant(of: root, matching: find.byType(Material)),
        );
        expect(surfaces.single.color, theme.scaffoldBackgroundColor);
        expect(
          childTheme.scaffoldBackgroundColor,
          theme.scaffoldBackgroundColor,
        );
        await tester.tap(find.byKey(const ValueKey('backdrop-child')));
        await tester.pump();
        expect(tapped, isTrue);
        expect(tester.takeException(), isNull);
        expect(media.textScaler.scale(16), 32);
        expect(media.disableAnimations, isTrue);
      },
    );
  }

  for (final (width, theme, target) in [
    (320.0, AppTheme.light(platform: TargetPlatform.android), 48.0),
    (390.0, AppTheme.dark(platform: TargetPlatform.android), 48.0),
    (900.0, MacosAppTheme.light(), 44.0),
  ]) {
    testWidgets(
      '${width.toInt()}px controls and reading text grow at 200 percent',
      (tester) async {
        final buttonFocus = FocusNode();
        addTearDown(buttonFocus.dispose);
        tester.view.physicalSize = Size(width, 900);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        await tester.pumpWidget(
          MaterialApp(
            theme: theme,
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: const TextScaler.linear(2)),
              child: child!,
            ),
            home: Scaffold(
              body: SingleChildScrollView(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'Reading text remains available.',
                      key: const ValueKey('reading'),
                      style: theme.textTheme.bodyLarge,
                    ),
                    FilledButton(
                      key: const ValueKey('filled'),
                      focusNode: buttonFocus,
                      onPressed: () {},
                      child: const Text('A complete action label that wraps'),
                    ),
                    OutlinedButton(
                      key: const ValueKey('outlined'),
                      onPressed: () {},
                      child: const Text('Inspect source'),
                    ),
                    const TextField(
                      key: ValueKey('field'),
                      decoration: InputDecoration(
                        labelText: 'Conversation title',
                      ),
                    ),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: IconButton(
                        key: const ValueKey('icon'),
                        onPressed: () {},
                        icon: const Icon(Icons.refresh),
                        tooltip: 'Refresh',
                      ),
                    ),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Checkbox(
                        key: const ValueKey('checkbox'),
                        value: false,
                        onChanged: (_) {},
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
        for (final key in ['filled', 'outlined', 'field', 'icon', 'checkbox']) {
          expect(
            tester.getSize(find.byKey(ValueKey(key))).height,
            greaterThanOrEqualTo(target),
          );
        }
        final paragraph = tester.renderObject<RenderParagraph>(
          find.byKey(const ValueKey('reading')),
        );
        expect(paragraph.textScaler.scale(16), 32);
        expect(
          tester.getSize(find.byKey(const ValueKey('filled'))).height,
          greaterThan(target),
        );
        buttonFocus.requestFocus();
        await tester.pump();
        expect(buttonFocus.hasFocus, isTrue);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('filled')),
            matching: find.byWidgetPredicate(
              (widget) =>
                  widget is CustomPaint && widget.foregroundPainter != null,
            ),
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      },
    );
  }
}

double _contrast(Color foreground, Color background) {
  final first = foreground.computeLuminance();
  final second = background.computeLuminance();
  return ((first > second ? first : second) + .05) /
      ((first > second ? second : first) + .05);
}
