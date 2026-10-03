import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'app_theme.dart';

/// macOS ergonomics over the shared canonical native theme.
/// The palette, 44px controls and system typography come from AppTheme.
abstract final class MacosAppTheme {
  static bool shouldUse({TargetPlatform? platform, bool isWeb = kIsWeb}) =>
      !isWeb && (platform ?? defaultTargetPlatform) == TargetPlatform.macOS;

  static ThemeData light({bool highContrast = false}) =>
      _build(Brightness.light, highContrast);
  static ThemeData dark({bool highContrast = false}) =>
      _build(Brightness.dark, highContrast);

  static ThemeData _build(Brightness brightness, bool highContrast) {
    final base = brightness == Brightness.dark
        ? AppTheme.dark(
            highContrast: highContrast,
            platform: TargetPlatform.macOS,
          )
        : AppTheme.light(
            highContrast: highContrast,
            platform: TargetPlatform.macOS,
          );
    final scheme = base.colorScheme;
    final shared = base.extension<AsaelThemeColors>()!;
    return base.copyWith(
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {TargetPlatform.macOS: _MacosPageTransitionsBuilder()},
      ),
      scrollbarTheme: ScrollbarThemeData(
        interactive: true,
        radius: const Radius.circular(8),
        minThumbLength: 44,
        mainAxisMargin: 3,
        crossAxisMargin: 2,
        thumbVisibility: const WidgetStatePropertyAll(false),
        trackVisibility: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.hovered),
        ),
        thickness: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.hovered) ? 8 : 5,
        ),
        thumbColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.dragged)
              ? scheme.primary
              : shared.muted,
        ),
        trackColor: WidgetStatePropertyAll(shared.raised),
        trackBorderColor: const WidgetStatePropertyAll(Colors.transparent),
      ),
      appBarTheme: base.appBarTheme.copyWith(
        toolbarHeight: 56,
        backgroundColor: scheme.surface,
        titleTextStyle: base.textTheme.titleMedium,
      ),
      tooltipTheme: base.tooltipTheme.copyWith(
        waitDuration: const Duration(milliseconds: 450),
        showDuration: const Duration(seconds: 4),
        preferBelow: false,
      ),
      extensions: [
        ...base.extensions.values,
        MacosThemeColors(
          sidebar: scheme.surface,
          toolbar: scheme.surface,
          canvas: shared.background,
          hover: shared.raised,
          selection: shared.overlay,
          ambient: shared.background,
          divider: shared.line,
          focus: shared.focus,
          positive: shared.success,
          warning: shared.warning,
        ),
      ],
    );
  }
}

@immutable
class MacosThemeColors extends ThemeExtension<MacosThemeColors> {
  const MacosThemeColors({
    required this.sidebar,
    required this.toolbar,
    required this.canvas,
    required this.hover,
    required this.selection,
    required this.ambient,
    required this.divider,
    required this.focus,
    required this.positive,
    required this.warning,
  });

  final Color sidebar;
  final Color toolbar;
  final Color canvas;
  final Color hover;
  final Color selection;
  final Color ambient;
  final Color divider;
  final Color focus;
  final Color positive;
  final Color warning;

  /// Returns desktop tokens when present and a safe scheme-derived fallback
  /// when a shared mobile/web theme renders a portable widget.
  static MacosThemeColors of(BuildContext context) {
    final theme = Theme.of(context);
    final extension = theme.extension<MacosThemeColors>();
    if (extension != null) return extension;
    final scheme = theme.colorScheme;
    return MacosThemeColors(
      sidebar: scheme.surfaceContainerLow,
      toolbar: scheme.surface,
      canvas: theme.scaffoldBackgroundColor,
      hover: scheme.surfaceContainer,
      selection: scheme.primaryContainer,
      ambient: scheme.surfaceContainerLowest,
      divider: scheme.outlineVariant,
      focus: theme.extension<AsaelThemeColors>()?.focus ?? theme.focusColor,
      positive: scheme.tertiary,
      warning: theme.extension<AsaelThemeColors>()?.warning ?? scheme.secondary,
    );
  }

  @override
  MacosThemeColors copyWith({
    Color? sidebar,
    Color? toolbar,
    Color? canvas,
    Color? hover,
    Color? selection,
    Color? ambient,
    Color? divider,
    Color? focus,
    Color? positive,
    Color? warning,
  }) => MacosThemeColors(
    sidebar: sidebar ?? this.sidebar,
    toolbar: toolbar ?? this.toolbar,
    canvas: canvas ?? this.canvas,
    hover: hover ?? this.hover,
    selection: selection ?? this.selection,
    ambient: ambient ?? this.ambient,
    divider: divider ?? this.divider,
    focus: focus ?? this.focus,
    positive: positive ?? this.positive,
    warning: warning ?? this.warning,
  );

  @override
  MacosThemeColors lerp(MacosThemeColors? other, double t) {
    if (other == null) return this;
    return MacosThemeColors(
      sidebar: Color.lerp(sidebar, other.sidebar, t)!,
      toolbar: Color.lerp(toolbar, other.toolbar, t)!,
      canvas: Color.lerp(canvas, other.canvas, t)!,
      hover: Color.lerp(hover, other.hover, t)!,
      selection: Color.lerp(selection, other.selection, t)!,
      ambient: Color.lerp(ambient, other.ambient, t)!,
      divider: Color.lerp(divider, other.divider, t)!,
      focus: Color.lerp(focus, other.focus, t)!,
      positive: Color.lerp(positive, other.positive, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
    );
  }
}

class _MacosPageTransitionsBuilder extends PageTransitionsBuilder {
  const _MacosPageTransitionsBuilder();

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    final media = MediaQuery.maybeOf(context);
    if (route.settings.name == Navigator.defaultRouteName ||
        (media?.disableAnimations ?? false) ||
        (media?.accessibleNavigation ?? false)) {
      return child;
    }
    return FadeTransition(
      opacity: animation.drive(CurveTween(curve: Curves.easeOutCubic)),
      child: child,
    );
  }

  @override
  Duration get transitionDuration => const Duration(milliseconds: 150);
  @override
  Duration get reverseTransitionDuration => const Duration(milliseconds: 110);
}
