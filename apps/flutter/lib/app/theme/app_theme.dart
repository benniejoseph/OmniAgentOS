import 'package:flutter/material.dart';

abstract final class AppTheme {
  static const cobalt = Color(0xFF3157D5);
  static const cobaltDark = Color(0xFF9BB0FF);
  static const ink = Color(0xFF0C0F16);
  static const paper = Color(0xFFF5F6F9);

  static ThemeData light({bool highContrast = false}) =>
      _build(Brightness.light, highContrast);
  static ThemeData dark({bool highContrast = false}) =>
      _build(Brightness.dark, highContrast);

  static ThemeData _build(Brightness brightness, bool highContrast) {
    final dark = brightness == Brightness.dark;
    final scheme = ColorScheme.fromSeed(
      seedColor: dark ? cobaltDark : cobalt,
      brightness: brightness,
      contrastLevel: highContrast ? 1 : .35,
      surface: dark ? const Color(0xFF11151D) : const Color(0xFFFCFCFE),
      surfaceContainerLowest: dark ? ink : const Color(0xFFFFFFFF),
      surfaceContainerLow: dark
          ? const Color(0xFF10141B)
          : const Color(0xFFF7F8FB),
      surfaceContainer: dark
          ? const Color(0xFF171C26)
          : const Color(0xFFF0F2F7),
      surfaceContainerHigh: dark
          ? const Color(0xFF202634)
          : const Color(0xFFE8EBF2),
      error: dark ? const Color(0xFFFF8B96) : const Color(0xFFB42335),
    );
    final border = scheme.outlineVariant.withValues(alpha: dark ? .42 : .58);
    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: dark ? ink : paper,
      splashFactory: InkRipple.splashFactory,
      visualDensity: VisualDensity.standard,
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: _OmniPageTransitionsBuilder(),
          TargetPlatform.iOS: _OmniPageTransitionsBuilder(),
          TargetPlatform.macOS: _OmniPageTransitionsBuilder(),
          TargetPlatform.windows: _OmniPageTransitionsBuilder(),
          TargetPlatform.linux: _OmniPageTransitionsBuilder(),
        },
      ),
      textTheme: const TextTheme(
        displayLarge: TextStyle(
          fontWeight: FontWeight.w800,
          letterSpacing: -2.4,
          height: 1.02,
        ),
        displaySmall: TextStyle(
          fontWeight: FontWeight.w800,
          letterSpacing: -1.5,
          height: 1.04,
        ),
        headlineMedium: TextStyle(
          fontWeight: FontWeight.w800,
          letterSpacing: -.8,
          height: 1.08,
        ),
        headlineSmall: TextStyle(
          fontWeight: FontWeight.w700,
          letterSpacing: -.5,
        ),
        titleLarge: TextStyle(fontWeight: FontWeight.w700, letterSpacing: -.4),
        titleMedium: TextStyle(
          fontWeight: FontWeight.w600,
          letterSpacing: -.15,
        ),
        labelLarge: TextStyle(fontWeight: FontWeight.w700, letterSpacing: .05),
        labelMedium: TextStyle(fontWeight: FontWeight.w700, letterSpacing: .2),
        bodyLarge: TextStyle(fontSize: 16, height: 1.5),
        bodyMedium: TextStyle(fontSize: 14, height: 1.5),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: scheme.surfaceContainerLow,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
        margin: const EdgeInsets.symmetric(vertical: 6),
      ),
      dividerTheme: DividerThemeData(color: border, thickness: 1),
      navigationBarTheme: NavigationBarThemeData(
        height: 72,
        elevation: 0,
        backgroundColor: dark ? const Color(0xFF11151D) : Colors.white,
        indicatorColor: scheme.primaryContainer,
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => TextStyle(
            color: states.contains(WidgetState.selected)
                ? scheme.primary
                : scheme.onSurfaceVariant,
            fontSize: 11,
            fontWeight: states.contains(WidgetState.selected)
                ? FontWeight.w800
                : FontWeight.w600,
          ),
        ),
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: dark ? const Color(0xFF10141B) : Colors.white,
        indicatorColor: scheme.primaryContainer,
        minWidth: 80,
        minExtendedWidth: 236,
        groupAlignment: -.72,
        selectedLabelTextStyle: TextStyle(
          color: scheme.primary,
          fontWeight: FontWeight.w800,
        ),
        unselectedLabelTextStyle: const TextStyle(fontWeight: FontWeight.w600),
      ),
      appBarTheme: AppBarTheme(
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        backgroundColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        titleTextStyle: TextStyle(
          color: scheme.onSurface,
          fontSize: 21,
          fontWeight: FontWeight.w800,
          letterSpacing: -.45,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainerLowest,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 18,
          vertical: 18,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(17),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(17),
          borderSide: BorderSide(color: border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(17),
          borderSide: BorderSide(color: scheme.primary, width: 2),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(17),
          borderSide: BorderSide(color: scheme.error),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(64, 54),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(17),
          ),
          textStyle: const TextStyle(fontWeight: FontWeight.w700),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(64, 52),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(17),
          ),
          side: BorderSide(color: border),
        ),
      ),
      chipTheme: ChipThemeData(
        side: BorderSide(color: border),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
        labelStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12),
      ),
      dialogTheme: DialogThemeData(
        elevation: 8,
        backgroundColor: scheme.surfaceContainerLow,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: scheme.surfaceContainerLow,
        modalBackgroundColor: scheme.surfaceContainerLow,
        showDragHandle: true,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(30)),
        ),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        elevation: 2,
        highlightElevation: 3,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        elevation: 3,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: scheme.primary,
        linearTrackColor: scheme.surfaceContainerHigh,
      ),
    );
  }
}

class _OmniPageTransitionsBuilder extends PageTransitionsBuilder {
  const _OmniPageTransitionsBuilder();

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    if (route.settings.name == Navigator.defaultRouteName) return child;
    final reducedMotion =
        MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (reducedMotion) return child;
    final curved = CurvedAnimation(
      parent: animation,
      curve: const Cubic(0.16, 1, 0.3, 1),
      reverseCurve: Curves.easeInCubic,
    );
    return FadeTransition(
      opacity: curved,
      child: SlideTransition(
        position: Tween<Offset>(
          begin: const Offset(.018, 0),
          end: Offset.zero,
        ).animate(curved),
        child: child,
      ),
    );
  }

  @override
  Duration get transitionDuration => const Duration(milliseconds: 220);

  @override
  Duration get reverseTransitionDuration => const Duration(milliseconds: 160);
}
