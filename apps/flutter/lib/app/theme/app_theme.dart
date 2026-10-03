import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

/// Shared native sRGB tokens from SYSTEM_SPEC and the web semantic palette.
/// Platform adapters change typography and ergonomics, never these colors.
abstract final class AppTheme {
  static const lightBackground = Color(0xFFFAF9F6);
  static const lightForeground = Color(0xFF242321);
  static const lightSurface = Color(0xFFFFFFFF);
  static const lightRaised = Color(0xFFF0EEEA);
  static const lightOverlay = Color(0xFFE8E4DE);
  static const lightMuted = Color(0xFF69645E);
  static const lightLine = Color(0xFFDDD8D0);
  static const lightLineStrong = Color(0xFF827A70);
  static const lightPrimary = Color(0xFF272521);
  static const lightPrimaryInk = Color(0xFFFAF9F6);
  static const lightPrimaryHover = Color(0xFF3A3731);
  static const lightPrimaryPressed = Color(0xFF171613);
  static const lightAccent = Color(0xFF806019);
  static const lightAccentSurface = Color(0xFFF5EBD3);
  static const lightSuccess = Color(0xFF286243);
  static const lightSuccessSurface = Color(0xFFE8F2EB);
  static const lightWarning = Color(0xFF805814);
  static const lightWarningSurface = Color(0xFFFAF0D6);
  static const lightDanger = Color(0xFFAC3530);
  static const lightDangerSurface = Color(0xFFFBECEA);
  static const lightInfo = Color(0xFF2E627C);
  static const lightInfoSurface = Color(0xFFEAF1F5);
  static const lightFocus = Color(0xFF8D611A);

  static const darkBackground = Color(0xFF191A1B);
  static const darkForeground = Color(0xFFF4F1EA);
  static const darkSurface = Color(0xFF222325);
  static const darkRaised = Color(0xFF2B2C2F);
  static const darkOverlay = Color(0xFF34363A);
  static const darkMuted = Color(0xFFB8B3AA);
  static const darkLine = Color(0xFF3E4146);
  static const darkLineStrong = Color(0xFF888980);
  static const darkPrimary = Color(0xFFF0EDE7);
  static const darkPrimaryInk = Color(0xFF242321);
  static const darkPrimaryHover = Color(0xFFFFFFFF);
  static const darkPrimaryPressed = Color(0xFFD9D4CB);
  static const darkAccent = Color(0xFFE2BD74);
  static const darkAccentSurface = Color(0xFF3C3222);
  static const darkSuccess = Color(0xFF91CFAC);
  static const darkSuccessSurface = Color(0xFF203A2B);
  static const darkWarning = Color(0xFFE7C37C);
  static const darkWarningSurface = Color(0xFF41351F);
  static const darkDanger = Color(0xFFF1A09A);
  static const darkDangerSurface = Color(0xFF422728);
  static const darkInfo = Color(0xFF9CCAE0);
  static const darkInfoSurface = Color(0xFF263944);
  static const darkFocus = Color(0xFFF0C77B);

  static ThemeData light({
    bool highContrast = false,
    TargetPlatform? platform,
  }) =>
      _build(Brightness.light, highContrast, platform ?? defaultTargetPlatform);
  static ThemeData dark({
    bool highContrast = false,
    TargetPlatform? platform,
  }) =>
      _build(Brightness.dark, highContrast, platform ?? defaultTargetPlatform);

  static ThemeData _build(
    Brightness brightness,
    bool highContrast,
    TargetPlatform platform,
  ) {
    final dark = brightness == Brightness.dark;
    final desktop = switch (platform) {
      TargetPlatform.macOS ||
      TargetPlatform.windows ||
      TargetPlatform.linux => true,
      _ => false,
    };
    final target = desktop ? 44.0 : 48.0;
    final background = dark ? darkBackground : lightBackground;
    final foreground = dark ? darkForeground : lightForeground;
    final surface = dark ? darkSurface : lightSurface;
    final raised = dark ? darkRaised : lightRaised;
    final overlay = dark ? darkOverlay : lightOverlay;
    final muted = highContrast ? foreground : (dark ? darkMuted : lightMuted);
    final lineStrong = dark ? darkLineStrong : lightLineStrong;
    final line = highContrast ? lineStrong : (dark ? darkLine : lightLine);
    final primary = dark ? darkPrimary : lightPrimary;
    final primaryInk = dark ? darkPrimaryInk : lightPrimaryInk;
    final accent = dark ? darkAccent : lightAccent;
    final accentSurface = dark ? darkAccentSurface : lightAccentSurface;
    final success = dark ? darkSuccess : lightSuccess;
    final danger = dark ? darkDanger : lightDanger;
    final focus = dark ? darkFocus : lightFocus;
    final tokens = AsaelThemeColors(
      background: background,
      raised: raised,
      overlay: overlay,
      muted: muted,
      line: line,
      lineStrong: lineStrong,
      accent: accent,
      success: success,
      warning: dark ? darkWarning : lightWarning,
      warningSurface: dark ? darkWarningSurface : lightWarningSurface,
      info: dark ? darkInfo : lightInfo,
      infoSurface: dark ? darkInfoSurface : lightInfoSurface,
      focus: focus,
    );
    final scheme = ColorScheme(
      brightness: brightness,
      primary: primary,
      onPrimary: primaryInk,
      primaryContainer: overlay,
      onPrimaryContainer: foreground,
      secondary: accent,
      onSecondary: dark ? primaryInk : lightSurface,
      secondaryContainer: accentSurface,
      onSecondaryContainer: foreground,
      tertiary: success,
      onTertiary: dark ? primaryInk : lightSurface,
      tertiaryContainer: dark ? darkSuccessSurface : lightSuccessSurface,
      onTertiaryContainer: foreground,
      error: danger,
      onError: dark ? primaryInk : lightSurface,
      errorContainer: dark ? darkDangerSurface : lightDangerSurface,
      onErrorContainer: foreground,
      surface: surface,
      onSurface: foreground,
      onSurfaceVariant: muted,
      surfaceDim: raised,
      surfaceBright: surface,
      surfaceContainerLowest: background,
      surfaceContainerLow: surface,
      surfaceContainer: raised,
      surfaceContainerHigh: overlay,
      surfaceContainerHighest: overlay,
      outline: lineStrong,
      outlineVariant: line,
      inverseSurface: foreground,
      onInverseSurface: background,
      inversePrimary: dark ? lightPrimary : darkPrimary,
      surfaceTint: Colors.transparent,
      shadow: const Color(0xFF181715),
      scrim: const Color(0xFF0C0C0C),
    );
    final typography = Typography.material2021(
      platform: platform,
      colorScheme: scheme,
    );
    final baseText = (dark ? typography.white : typography.black).apply(
      fontFamily: platform == TargetPlatform.macOS
          ? '.AppleSystemUIFont'
          : null,
      bodyColor: foreground,
      displayColor: foreground,
    );
    final titleSize = desktop ? 28.0 : 24.0;
    final title = TextStyle(
      fontSize: titleSize,
      height: desktop ? 36 / 28 : 32 / 24,
      fontWeight: FontWeight.w600,
      letterSpacing: -.4,
    );
    final textTheme = baseText.copyWith(
      displayLarge: baseText.displayLarge?.merge(title),
      displayMedium: baseText.displayMedium?.merge(title),
      displaySmall: baseText.displaySmall?.merge(title),
      headlineLarge: baseText.headlineLarge?.merge(title),
      headlineMedium: baseText.headlineMedium?.merge(title),
      headlineSmall: baseText.headlineSmall?.copyWith(
        fontSize: 20,
        height: 1.4,
        fontWeight: FontWeight.w600,
        letterSpacing: 0,
      ),
      titleLarge: baseText.titleLarge?.copyWith(
        fontSize: 20,
        height: 1.4,
        fontWeight: FontWeight.w600,
        letterSpacing: 0,
      ),
      titleMedium: baseText.titleMedium?.copyWith(
        fontSize: 16,
        height: 1.5,
        fontWeight: FontWeight.w600,
        letterSpacing: 0,
      ),
      titleSmall: baseText.titleSmall?.copyWith(
        fontSize: 14,
        height: 20 / 14,
        fontWeight: FontWeight.w600,
        letterSpacing: 0,
      ),
      bodyLarge: baseText.bodyLarge?.copyWith(
        fontSize: 16,
        height: 1.5,
        letterSpacing: 0,
      ),
      bodyMedium: baseText.bodyMedium?.copyWith(
        fontSize: 14,
        height: 20 / 14,
        letterSpacing: 0,
      ),
      bodySmall: baseText.bodySmall?.copyWith(
        fontSize: 13,
        height: 20 / 13,
        color: muted,
        letterSpacing: 0,
      ),
      labelLarge: baseText.labelLarge?.copyWith(
        fontSize: 14,
        height: 20 / 14,
        fontWeight: FontWeight.w600,
        letterSpacing: 0,
      ),
      labelMedium: baseText.labelMedium?.copyWith(
        fontSize: 13,
        height: 20 / 13,
        fontWeight: FontWeight.w500,
        letterSpacing: 0,
      ),
      labelSmall: baseText.labelSmall?.copyWith(
        fontSize: 13,
        height: 20 / 13,
        color: muted,
        letterSpacing: 0,
      ),
    );
    const radius = BorderRadius.all(Radius.circular(10));
    final fieldBorder = OutlineInputBorder(
      borderRadius: radius,
      borderSide: BorderSide(color: lineStrong),
    );
    final inputTheme = InputDecorationThemeData(
      filled: true,
      fillColor: surface,
      hoverColor: raised,
      constraints: BoxConstraints(minHeight: target),
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      border: fieldBorder,
      enabledBorder: fieldBorder,
      disabledBorder: fieldBorder,
      focusedBorder: fieldBorder.copyWith(
        borderSide: BorderSide(color: focus, width: 3),
      ),
      errorBorder: fieldBorder.copyWith(borderSide: BorderSide(color: danger)),
      focusedErrorBorder: fieldBorder.copyWith(
        borderSide: BorderSide(color: danger, width: 3),
      ),
      hintStyle: TextStyle(color: muted),
      labelStyle: TextStyle(color: muted),
      helperStyle: textTheme.bodySmall,
      errorStyle: textTheme.bodySmall?.copyWith(color: danger),
      prefixIconColor: muted,
      suffixIconColor: muted,
      prefixIconConstraints: BoxConstraints(
        minWidth: target,
        minHeight: target,
      ),
      suffixIconConstraints: BoxConstraints(
        minWidth: target,
        minHeight: target,
      ),
    );
    ButtonStyle buttonStyle({
      bool filled = false,
      bool outlined = false,
    }) => ButtonStyle(
      minimumSize: WidgetStatePropertyAll(Size(target, target)),
      padding: const WidgetStatePropertyAll(
        EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      ),
      textStyle: WidgetStatePropertyAll(textTheme.labelLarge),
      foregroundColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.disabled)
            ? muted
            : (filled ? primaryInk : foreground),
      ),
      backgroundColor: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.disabled)) return raised;
        if (filled) {
          if (states.contains(WidgetState.pressed)) {
            return dark ? darkPrimaryPressed : lightPrimaryPressed;
          }
          if (states.contains(WidgetState.hovered)) {
            return dark ? darkPrimaryHover : lightPrimaryHover;
          }
          return primary;
        }
        if (states.contains(WidgetState.pressed) ||
            states.contains(WidgetState.selected)) {
          return overlay;
        }
        if (states.contains(WidgetState.hovered)) return raised;
        return surface;
      }),
      overlayColor: const WidgetStatePropertyAll(Colors.transparent),
      elevation: const WidgetStatePropertyAll(0),
      shadowColor: const WidgetStatePropertyAll(Colors.transparent),
      surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
      side: WidgetStatePropertyAll(
        outlined ? BorderSide(color: lineStrong) : BorderSide.none,
      ),
      shape: const WidgetStatePropertyAll(
        RoundedRectangleBorder(borderRadius: radius),
      ),
      // The ring stays inside the button bounds so clipping cannot hide it.
      // Its inner gap is opaque; it never touches the primary fill directly.
      backgroundBuilder: (context, states, child) =>
          states.contains(WidgetState.focused) &&
              !states.contains(WidgetState.disabled)
          ? CustomPaint(
              foregroundPainter: _FocusRingPainter(focus: focus, gap: surface),
              child: child,
            )
          : child ?? const SizedBox.shrink(),
      animationDuration: Duration.zero,
      visualDensity: VisualDensity.standard,
      tapTargetSize: desktop
          ? MaterialTapTargetSize.shrinkWrap
          : MaterialTapTargetSize.padded,
      splashFactory: NoSplash.splashFactory,
    );
    final neutralButton = buttonStyle(outlined: true);
    final menuStyle = MenuStyle(
      backgroundColor: WidgetStatePropertyAll(surface),
      surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
      padding: const WidgetStatePropertyAll(EdgeInsets.all(8)),
      side: WidgetStatePropertyAll(BorderSide(color: lineStrong)),
      shape: const WidgetStatePropertyAll(
        RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(12)),
        ),
      ),
      visualDensity: VisualDensity.standard,
    );
    return ThemeData(
      useMaterial3: true,
      platform: platform,
      brightness: brightness,
      colorScheme: scheme,
      typography: typography,
      textTheme: textTheme,
      primaryTextTheme: textTheme,
      scaffoldBackgroundColor: background,
      canvasColor: background,
      cardColor: surface,
      // Ink focus fills must keep text readable; control outlines use focus.
      dividerColor: line,
      disabledColor: muted,
      focusColor: accentSurface,
      hoverColor: raised,
      highlightColor: overlay,
      splashFactory: NoSplash.splashFactory,
      visualDensity: VisualDensity.standard,
      materialTapTargetSize: desktop
          ? MaterialTapTargetSize.shrinkWrap
          : MaterialTapTargetSize.padded,
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: _AsaelPageTransitionsBuilder(),
          TargetPlatform.iOS: _AsaelPageTransitionsBuilder(),
          TargetPlatform.macOS: _AsaelPageTransitionsBuilder(),
          TargetPlatform.windows: _AsaelPageTransitionsBuilder(),
          TargetPlatform.linux: _AsaelPageTransitionsBuilder(),
        },
      ),
      appBarTheme: AppBarThemeData(
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        backgroundColor: background,
        foregroundColor: foreground,
        surfaceTintColor: Colors.transparent,
        titleTextStyle: textTheme.titleLarge,
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: line),
        ),
        margin: const EdgeInsets.symmetric(vertical: 4),
      ),
      dividerTheme: DividerThemeData(color: line, thickness: 1),
      inputDecorationTheme: inputTheme,
      filledButtonTheme: FilledButtonThemeData(
        style: buttonStyle(filled: true),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: buttonStyle(filled: true),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(style: neutralButton),
      textButtonTheme: TextButtonThemeData(style: buttonStyle()),
      iconButtonTheme: IconButtonThemeData(
        style: buttonStyle().copyWith(
          padding: const WidgetStatePropertyAll(EdgeInsets.all(12)),
          iconSize: const WidgetStatePropertyAll(20),
        ),
      ),
      segmentedButtonTheme: SegmentedButtonThemeData(style: neutralButton),
      menuButtonTheme: MenuButtonThemeData(style: buttonStyle()),
      menuTheme: MenuThemeData(style: menuStyle),
      popupMenuTheme: PopupMenuThemeData(
        color: surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: lineStrong),
        ),
        textStyle: textTheme.bodyMedium,
        menuPadding: const EdgeInsets.all(8),
      ),
      dropdownMenuTheme: DropdownMenuThemeData(
        textStyle: textTheme.bodyLarge,
        inputDecorationTheme: inputTheme,
        menuStyle: menuStyle,
        disabledColor: muted,
      ),
      searchBarTheme: SearchBarThemeData(
        elevation: const WidgetStatePropertyAll(0),
        backgroundColor: WidgetStatePropertyAll(surface),
        surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        constraints: BoxConstraints(minHeight: target),
        padding: const WidgetStatePropertyAll(
          EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        ),
        textStyle: WidgetStatePropertyAll(textTheme.bodyLarge),
        hintStyle: WidgetStatePropertyAll(
          textTheme.bodyLarge?.copyWith(color: muted),
        ),
        side: WidgetStateProperty.resolveWith(
          (states) => BorderSide(
            color: states.contains(WidgetState.focused) ? focus : lineStrong,
            width: states.contains(WidgetState.focused) ? 3 : 1,
          ),
        ),
        shape: const WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: radius),
        ),
      ),
      listTileTheme: ListTileThemeData(
        minTileHeight: target,
        minVerticalPadding: 8,
        visualDensity: VisualDensity.standard,
        textColor: foreground,
        iconColor: muted,
        selectedColor: foreground,
        selectedTileColor: overlay,
        titleTextStyle: textTheme.bodyMedium,
        subtitleTextStyle: textTheme.bodySmall,
      ),
      navigationBarTheme: NavigationBarThemeData(
        height: desktop ? 64 : 80,
        elevation: 0,
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        indicatorColor: accentSurface,
        indicatorShape: const RoundedRectangleBorder(borderRadius: radius),
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => textTheme.labelMedium?.copyWith(
            color: states.contains(WidgetState.selected) ? foreground : muted,
            fontWeight: states.contains(WidgetState.selected)
                ? FontWeight.w600
                : FontWeight.w400,
          ),
        ),
        iconTheme: WidgetStateProperty.resolveWith(
          (states) => IconThemeData(
            color: states.contains(WidgetState.selected) ? accent : muted,
            size: 20,
          ),
        ),
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: surface,
        indicatorColor: accentSurface,
        indicatorShape: const RoundedRectangleBorder(borderRadius: radius),
        minWidth: 80,
        minExtendedWidth: 236,
        useIndicator: true,
        selectedIconTheme: IconThemeData(color: accent, size: 20),
        unselectedIconTheme: IconThemeData(color: muted, size: 20),
        selectedLabelTextStyle: textTheme.labelMedium?.copyWith(
          color: foreground,
          fontWeight: FontWeight.w600,
        ),
        unselectedLabelTextStyle: textTheme.labelMedium?.copyWith(color: muted),
      ),
      tabBarTheme: TabBarThemeData(
        labelColor: foreground,
        unselectedLabelColor: muted,
        labelStyle: textTheme.labelLarge,
        unselectedLabelStyle: textTheme.labelLarge,
        dividerColor: line,
        indicator: UnderlineTabIndicator(
          borderSide: BorderSide(color: accent, width: 3),
        ),
        splashFactory: NoSplash.splashFactory,
      ),
      chipTheme: ChipThemeData(
        backgroundColor: raised,
        selectedColor: accentSurface,
        disabledColor: raised,
        side: BorderSide(color: lineStrong),
        labelStyle: textTheme.labelMedium,
        checkmarkColor: foreground,
        deleteIconColor: muted,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
        shape: const RoundedRectangleBorder(borderRadius: radius),
      ),
      checkboxTheme: CheckboxThemeData(
        materialTapTargetSize: MaterialTapTargetSize.padded,
        visualDensity: VisualDensity.standard,
        side: BorderSide(color: lineStrong, width: 2),
        fillColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.disabled)
              ? raised
              : states.contains(WidgetState.selected)
              ? primary
              : surface,
        ),
        checkColor: WidgetStatePropertyAll(primaryInk),
      ),
      radioTheme: RadioThemeData(
        materialTapTargetSize: MaterialTapTargetSize.padded,
        visualDensity: VisualDensity.standard,
        fillColor: WidgetStateProperty.resolveWith(
          (states) =>
              states.contains(WidgetState.selected) ? primary : lineStrong,
        ),
      ),
      switchTheme: SwitchThemeData(
        materialTapTargetSize: MaterialTapTargetSize.padded,
        trackOutlineColor: WidgetStatePropertyAll(lineStrong),
        trackColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? primary : raised,
        ),
        thumbColor: WidgetStateProperty.resolveWith(
          (states) =>
              states.contains(WidgetState.selected) ? primaryInk : muted,
        ),
      ),
      dialogTheme: DialogThemeData(
        elevation: 0,
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: lineStrong),
        ),
        titleTextStyle: textTheme.titleLarge,
        contentTextStyle: textTheme.bodyMedium,
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: surface,
        modalBackgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        showDragHandle: true,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        elevation: 0,
        backgroundColor: primary,
        foregroundColor: primaryInk,
        shape: const RoundedRectangleBorder(borderRadius: radius),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: foreground,
        contentTextStyle: textTheme.bodyMedium?.copyWith(color: background),
        actionTextColor: background,
      ),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: foreground,
          borderRadius: BorderRadius.circular(10),
        ),
        textStyle: textTheme.bodySmall?.copyWith(color: background),
        padding: const EdgeInsets.all(8),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: primary,
        linearTrackColor: raised,
      ),
      extensions: [tokens],
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
    required this.lineStrong,
    required this.accent,
    required this.success,
    required this.warning,
    required this.warningSurface,
    required this.info,
    required this.infoSurface,
    required this.focus,
  });

  final Color background;
  final Color raised;
  final Color overlay;
  final Color muted;
  final Color line;
  final Color lineStrong;
  final Color accent;
  final Color success;
  final Color warning;
  final Color warningSurface;
  final Color info;
  final Color infoSurface;
  final Color focus;

  @override
  AsaelThemeColors copyWith({
    Color? background,
    Color? raised,
    Color? overlay,
    Color? muted,
    Color? line,
    Color? lineStrong,
    Color? accent,
    Color? success,
    Color? warning,
    Color? warningSurface,
    Color? info,
    Color? infoSurface,
    Color? focus,
  }) => AsaelThemeColors(
    background: background ?? this.background,
    raised: raised ?? this.raised,
    overlay: overlay ?? this.overlay,
    muted: muted ?? this.muted,
    line: line ?? this.line,
    lineStrong: lineStrong ?? this.lineStrong,
    accent: accent ?? this.accent,
    success: success ?? this.success,
    warning: warning ?? this.warning,
    warningSurface: warningSurface ?? this.warningSurface,
    info: info ?? this.info,
    infoSurface: infoSurface ?? this.infoSurface,
    focus: focus ?? this.focus,
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
      lineStrong: Color.lerp(lineStrong, other.lineStrong, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      success: Color.lerp(success, other.success, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      warningSurface: Color.lerp(warningSurface, other.warningSurface, t)!,
      info: Color.lerp(info, other.info, t)!,
      infoSurface: Color.lerp(infoSurface, other.infoSurface, t)!,
      focus: Color.lerp(focus, other.focus, t)!,
    );
  }
}

extension AsaelThemeContext on BuildContext {
  AsaelThemeColors get asaelColors =>
      Theme.of(this).extension<AsaelThemeColors>()!;
}

class _FocusRingPainter extends CustomPainter {
  const _FocusRingPainter({required this.focus, required this.gap});
  final Color focus;
  final Color gap;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.shortestSide < 12) return;
    final rect = Offset.zero & size;
    canvas.drawRRect(
      RRect.fromRectAndRadius(rect.deflate(1.5), const Radius.circular(8.5)),
      Paint()
        ..color = focus
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(rect.deflate(4.5), const Radius.circular(5.5)),
      Paint()
        ..color = gap
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3,
    );
  }

  @override
  bool shouldRepaint(_FocusRingPainter oldDelegate) =>
      oldDelegate.focus != focus || oldDelegate.gap != gap;
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
    final media = MediaQuery.maybeOf(context);
    if (route.settings.name == Navigator.defaultRouteName ||
        (media?.disableAnimations ?? false) ||
        (media?.accessibleNavigation ?? false)) {
      return child;
    }
    return FadeTransition(
      opacity: animation.drive(CurveTween(curve: const Cubic(.2, 0, 0, 1))),
      child: child,
    );
  }

  @override
  Duration get transitionDuration => const Duration(milliseconds: 180);
  @override
  Duration get reverseTransitionDuration => const Duration(milliseconds: 120);
}
