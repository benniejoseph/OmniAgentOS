import 'package:flutter/material.dart';

/// The native expression of the web workspace's Daybook color system.
///
/// These colors are the sRGB equivalents of the OKLCH tokens in the web app's
/// app shell. Keeping the values explicit prevents Material's seed generation
/// from drifting Asael toward a separate native brand.
abstract final class AppTheme {
  static const lightBackground = Color(0xFFFEF9EC);
  static const lightForeground = Color(0xFF02282C);
  static const lightSurface = Color(0xFFFFFEF8);
  static const lightRaised = Color(0xFFF8F0DE);
  static const lightOverlay = Color(0xFFF3E5C9);
  static const lightMuted = Color(0xFF415E63);
  static const lightLine = Color(0xFFD4CAB1);
  static const lightPrimary = Color(0xFF007850);
  static const lightAccent = Color(0xFFD28425);
  static const lightSuccess = Color(0xFF03703D);
  static const lightWarning = Color(0xFFB77100);
  static const lightDanger = Color(0xFFBE3029);

  static const darkBackground = Color(0xFF030C0F);
  static const darkForeground = Color(0xFFECE7DD);
  static const darkSurface = Color(0xFF071417);
  static const darkRaised = Color(0xFF0E1F21);
  static const darkOverlay = Color(0xFF172D2F);
  static const darkMuted = Color(0xFF93A9AC);
  static const darkLine = Color(0xFF233739);
  static const darkPrimary = Color(0xFF66B98D);
  static const darkAccent = Color(0xFFDCA057);
  static const darkSuccess = Color(0xFF6BB582);
  static const darkWarning = Color(0xFFE3A857);
  static const darkDanger = Color(0xFFED7668);

  static ThemeData light({bool highContrast = false}) =>
      _build(Brightness.light, highContrast);
  static ThemeData dark({bool highContrast = false}) =>
      _build(Brightness.dark, highContrast);

  static ThemeData _build(Brightness brightness, bool highContrast) {
    final dark = brightness == Brightness.dark;
    final background = dark ? darkBackground : lightBackground;
    final foreground = dark ? darkForeground : lightForeground;
    final surface = dark ? darkSurface : lightSurface;
    final raised = dark ? darkRaised : lightRaised;
    final overlay = dark ? darkOverlay : lightOverlay;
    final muted = dark ? darkMuted : lightMuted;
    final line = dark ? darkLine : lightLine;
    final primary = dark ? darkPrimary : lightPrimary;
    final accent = dark ? darkAccent : lightAccent;
    final success = dark ? darkSuccess : lightSuccess;
    final warning = dark ? darkWarning : lightWarning;
    final danger = dark ? darkDanger : lightDanger;
    final primaryInk = dark ? const Color(0xFF000C08) : const Color(0xFFFDFCF6);

    final scheme =
        ColorScheme.fromSeed(
          seedColor: primary,
          brightness: brightness,
          surface: surface,
          contrastLevel: highContrast ? 1 : 0,
        ).copyWith(
          primary: primary,
          onPrimary: primaryInk,
          primaryContainer: dark
              ? const Color(0xFF0D1E14)
              : const Color(0xFFDFF7E8),
          onPrimaryContainer: foreground,
          secondary: accent,
          onSecondary: dark ? const Color(0xFF140B00) : Colors.white,
          secondaryContainer: dark
              ? const Color(0xFF291B0B)
              : const Color(0xFFFFF1DB),
          onSecondaryContainer: foreground,
          tertiary: success,
          onTertiary: dark ? const Color(0xFF001208) : Colors.white,
          tertiaryContainer: dark
              ? const Color(0xFF0D1E14)
              : const Color(0xFFDFF7E8),
          onTertiaryContainer: foreground,
          error: danger,
          onError: dark ? const Color(0xFF1B0000) : Colors.white,
          errorContainer: dark
              ? const Color(0xFF32120F)
              : const Color(0xFFFFE4DF),
          onErrorContainer: foreground,
          surface: surface,
          onSurface: foreground,
          onSurfaceVariant: muted,
          outline: highContrast
              ? (dark ? const Color(0xFF67807F) : const Color(0xFF756B55))
              : line,
          outlineVariant: line,
          surfaceContainerLowest: dark ? darkBackground : Colors.white,
          surfaceContainerLow: surface,
          surfaceContainer: raised,
          surfaceContainerHigh: overlay,
          surfaceContainerHighest: dark
              ? const Color(0xFF233739)
              : const Color(0xFFE9DDBF),
          shadow: const Color(0xFF001011),
          scrim: const Color(0xFF000000),
        );

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: background,
      canvasColor: background,
      splashFactory: InkRipple.splashFactory,
      visualDensity: VisualDensity.compact,
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: _AsaelPageTransitionsBuilder(),
          TargetPlatform.iOS: _AsaelPageTransitionsBuilder(),
          TargetPlatform.macOS: _AsaelPageTransitionsBuilder(),
          TargetPlatform.windows: _AsaelPageTransitionsBuilder(),
          TargetPlatform.linux: _AsaelPageTransitionsBuilder(),
        },
      ),
      textTheme: const TextTheme(
        displayLarge: TextStyle(
          fontWeight: FontWeight.w600,
          letterSpacing: -2.1,
          height: .96,
        ),
        displaySmall: TextStyle(
          fontWeight: FontWeight.w600,
          letterSpacing: -1.25,
          height: 1,
        ),
        headlineMedium: TextStyle(
          fontWeight: FontWeight.w600,
          letterSpacing: -.65,
          height: 1.08,
        ),
        headlineSmall: TextStyle(
          fontWeight: FontWeight.w600,
          letterSpacing: -.4,
        ),
        titleLarge: TextStyle(fontWeight: FontWeight.w600, letterSpacing: -.3),
        titleMedium: TextStyle(fontWeight: FontWeight.w600, letterSpacing: -.1),
        labelLarge: TextStyle(fontWeight: FontWeight.w600, letterSpacing: .05),
        labelMedium: TextStyle(fontWeight: FontWeight.w600, letterSpacing: .2),
        bodyLarge: TextStyle(fontSize: 16, height: 1.48),
        bodyMedium: TextStyle(fontSize: 14, height: 1.46),
      ).apply(bodyColor: foreground, displayColor: foreground),
      cardTheme: CardThemeData(
        elevation: 0,
        color: surface.withValues(alpha: dark ? .82 : .88),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: line.withValues(alpha: .76)),
        ),
        margin: const EdgeInsets.symmetric(vertical: 5),
      ),
      dividerTheme: DividerThemeData(color: line, thickness: 1),
      navigationBarTheme: NavigationBarThemeData(
        height: 66,
        elevation: 0,
        backgroundColor: surface.withValues(alpha: .96),
        indicatorColor: Colors.transparent,
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => TextStyle(
            color: states.contains(WidgetState.selected) ? primary : muted,
            fontSize: 10.5,
            fontWeight: FontWeight.w600,
          ),
        ),
        iconTheme: WidgetStateProperty.resolveWith(
          (states) => IconThemeData(
            color: states.contains(WidgetState.selected) ? primary : muted,
            size: 20,
          ),
        ),
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: surface.withValues(alpha: .94),
        indicatorColor: primary,
        indicatorShape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(999),
        ),
        minWidth: 80,
        minExtendedWidth: 236,
        groupAlignment: -.72,
        selectedIconTheme: IconThemeData(color: primaryInk),
        selectedLabelTextStyle: TextStyle(
          color: primary,
          fontWeight: FontWeight.w600,
        ),
        unselectedIconTheme: IconThemeData(color: muted),
        unselectedLabelTextStyle: TextStyle(
          color: muted,
          fontWeight: FontWeight.w600,
        ),
      ),
      appBarTheme: AppBarTheme(
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        backgroundColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        titleTextStyle: TextStyle(
          color: foreground,
          fontSize: 20,
          fontWeight: FontWeight.w600,
          letterSpacing: -.35,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surface,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 14,
        ),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide(color: line),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide(color: primary, width: 1.5),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide(color: danger),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(64, 48),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          textStyle: const TextStyle(fontWeight: FontWeight.w600),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(64, 48),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          side: BorderSide(color: line),
        ),
      ),
      chipTheme: ChipThemeData(
        side: BorderSide(color: line),
        backgroundColor: raised,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
        labelStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 11),
      ),
      dialogTheme: DialogThemeData(
        elevation: 8,
        backgroundColor: surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: surface,
        modalBackgroundColor: surface,
        showDragHandle: true,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
        ),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        elevation: 1,
        highlightElevation: 2,
        backgroundColor: primary,
        foregroundColor: primaryInk,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: dark ? raised : foreground,
        contentTextStyle: TextStyle(color: dark ? foreground : background),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: primary,
        linearTrackColor: raised,
      ),
      extensions: [
        AsaelThemeColors(
          background: background,
          raised: raised,
          overlay: overlay,
          muted: muted,
          line: line,
          accent: accent,
          success: success,
          warning: warning,
        ),
      ],
    );
  }
}

@immutable
class AsaelThemeColors extends ThemeExtension<AsaelThemeColors> {
  const AsaelThemeColors({
    required this.background,
    required this.raised,
    required this.overlay,
    required this.muted,
    required this.line,
    required this.accent,
    required this.success,
    required this.warning,
  });

  final Color background;
  final Color raised;
  final Color overlay;
  final Color muted;
  final Color line;
  final Color accent;
  final Color success;
  final Color warning;

  @override
  AsaelThemeColors copyWith({
    Color? background,
    Color? raised,
    Color? overlay,
    Color? muted,
    Color? line,
    Color? accent,
    Color? success,
    Color? warning,
  }) => AsaelThemeColors(
    background: background ?? this.background,
    raised: raised ?? this.raised,
    overlay: overlay ?? this.overlay,
    muted: muted ?? this.muted,
    line: line ?? this.line,
    accent: accent ?? this.accent,
    success: success ?? this.success,
    warning: warning ?? this.warning,
  );

  @override
  AsaelThemeColors lerp(AsaelThemeColors? other, double t) {
    if (other == null) return this;
    return AsaelThemeColors(
      background: Color.lerp(background, other.background, t)!,
      raised: Color.lerp(raised, other.raised, t)!,
      overlay: Color.lerp(overlay, other.overlay, t)!,
      muted: Color.lerp(muted, other.muted, t)!,
      line: Color.lerp(line, other.line, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      success: Color.lerp(success, other.success, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
    );
  }
}

extension AsaelThemeContext on BuildContext {
  AsaelThemeColors get asaelColors =>
      Theme.of(this).extension<AsaelThemeColors>()!;
}

class _AsaelPageTransitionsBuilder extends PageTransitionsBuilder {
  const _AsaelPageTransitionsBuilder();

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    if (route.settings.name == Navigator.defaultRouteName ||
        (MediaQuery.maybeOf(context)?.disableAnimations ?? false)) {
      return child;
    }
    final curved = CurvedAnimation(
      parent: animation,
      curve: const Cubic(.2, .8, .2, 1),
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
