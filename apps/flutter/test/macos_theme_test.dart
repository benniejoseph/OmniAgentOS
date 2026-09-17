import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('macOS theme selection never changes mobile or web presentation', () {
    expect(
      MacosAppTheme.shouldUse(platform: TargetPlatform.macOS, isWeb: false),
      isTrue,
    );
    expect(
      MacosAppTheme.shouldUse(platform: TargetPlatform.android, isWeb: false),
      isFalse,
    );
    expect(
      MacosAppTheme.shouldUse(platform: TargetPlatform.macOS, isWeb: true),
      isFalse,
    );
  });

  for (final (name, theme) in [
    ('light', MacosAppTheme.light()),
    ('dark', MacosAppTheme.dark()),
  ]) {
    test('$name theme is readable, desktop-native, and fully tokenized', () {
      final scheme = theme.colorScheme;
      final tokens = theme.extension<MacosThemeColors>();

      expect(theme.platform, TargetPlatform.macOS);
      expect(theme.textTheme.bodyMedium?.fontFamily, '.AppleSystemUIFont');
      expect(theme.materialTapTargetSize, MaterialTapTargetSize.shrinkWrap);
      expect(theme.textTheme.bodyMedium?.fontSize, greaterThanOrEqualTo(14));
      expect(theme.textTheme.bodyLarge?.fontSize, greaterThanOrEqualTo(14));
      expect(
        theme.filledButtonTheme.style?.minimumSize?.resolve({})?.height,
        32,
      );
      expect(theme.iconButtonTheme.style?.minimumSize?.resolve({})?.height, 30);
      expect(
        theme.scrollbarTheme.thickness?.resolve({WidgetState.hovered}),
        greaterThan(theme.scrollbarTheme.thickness?.resolve({}) ?? 0),
      );
      expect(tokens, isNotNull);
      final desktop = tokens!;
      expect(desktop.sidebar, isNot(desktop.canvas));
      expect(desktop.toolbar, isNot(desktop.canvas));
      expect(desktop.hover, isNot(desktop.selection));

      expect(_contrast(scheme.onSurface, desktop.canvas), greaterThan(7));
      expect(
        _contrast(scheme.onSurfaceVariant, desktop.canvas),
        greaterThan(4.5),
      );
      expect(_contrast(scheme.onPrimary, scheme.primary), greaterThan(4.5));
      expect(_contrast(scheme.primary, scheme.surface), greaterThan(4.5));
    });
  }

  test('high contrast variants strengthen workspace boundaries', () {
    for (final (normal, highContrast) in [
      (MacosAppTheme.light(), MacosAppTheme.light(highContrast: true)),
      (MacosAppTheme.dark(), MacosAppTheme.dark(highContrast: true)),
    ]) {
      final normalTokens = normal.extension<MacosThemeColors>()!;
      final highContrastTokens = highContrast.extension<MacosThemeColors>()!;
      expect(
        _contrast(highContrastTokens.divider, highContrastTokens.canvas),
        greaterThan(_contrast(normalTokens.divider, normalTokens.canvas)),
      );
    }
  });

  testWidgets('desktop tokens have a safe fallback in shared themes', (
    tester,
  ) async {
    late MacosThemeColors fallback;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: Builder(
          builder: (context) {
            fallback = MacosThemeColors.of(context);
            return const SizedBox.shrink();
          },
        ),
      ),
    );

    expect(fallback.canvas, AppTheme.lightBackground);
    expect(fallback.focus, AppTheme.lightPrimary);
  });
}

double _contrast(Color foreground, Color background) {
  final lighter = foreground.computeLuminance() > background.computeLuminance()
      ? foreground.computeLuminance()
      : background.computeLuminance();
  final darker = foreground.computeLuminance() > background.computeLuminance()
      ? background.computeLuminance()
      : foreground.computeLuminance();
  return (lighter + .05) / (darker + .05);
}
