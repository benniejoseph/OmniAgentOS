import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'app_theme.dart';

/// Asael's desktop-native visual system.
///
/// This theme intentionally does not change [AppTheme]. Android and web keep
/// the Daybook presentation while macOS gets denser controls, system type,
/// visible keyboard focus, and a cooler workspace hierarchy.
abstract final class MacosAppTheme {
  static const _systemFont = '.AppleSystemUIFont';

  static bool shouldUse({TargetPlatform? platform, bool isWeb = kIsWeb}) =>
      !isWeb && (platform ?? defaultTargetPlatform) == TargetPlatform.macOS;

  static ThemeData light({bool highContrast = false}) =>
      _build(Brightness.light, highContrast);

  static ThemeData dark({bool highContrast = false}) =>
      _build(Brightness.dark, highContrast);

  static ThemeData _build(Brightness brightness, bool highContrast) {
    final colors = _MacosPalette.forBrightness(brightness, highContrast);
    final dark = brightness == Brightness.dark;
    final scheme =
        ColorScheme.fromSeed(
          seedColor: colors.primary,
          brightness: brightness,
          contrastLevel: highContrast ? 1 : .2,
        ).copyWith(
          primary: colors.primary,
          onPrimary: colors.onPrimary,
          primaryContainer: colors.selection,
          onPrimaryContainer: colors.foreground,
          secondary: colors.accent,
          onSecondary: dark ? const Color(0xFF211000) : Colors.white,
          secondaryContainer: dark
              ? const Color(0xFF392714)
              : const Color(0xFFFFEACD),
          onSecondaryContainer: colors.foreground,
          tertiary: colors.positive,
          onTertiary: dark ? const Color(0xFF02130C) : Colors.white,
          tertiaryContainer: dark
              ? const Color(0xFF163A2C)
              : const Color(0xFFD6EEE2),
          onTertiaryContainer: colors.foreground,
          error: colors.danger,
          onError: dark ? const Color(0xFF260200) : Colors.white,
          errorContainer: dark
              ? const Color(0xFF451E1B)
              : const Color(0xFFFFE2DF),
          onErrorContainer: colors.foreground,
          surface: colors.surface,
          onSurface: colors.foreground,
          onSurfaceVariant: colors.muted,
          outline: colors.divider,
          outlineVariant: colors.divider,
          surfaceContainerLowest: colors.canvas,
          surfaceContainerLow: colors.surface,
          surfaceContainer: colors.raised,
          surfaceContainerHigh: colors.hover,
          surfaceContainerHighest: colors.selection,
          shadow: const Color(0xFF000000),
          scrim: const Color(0xFF000000),
        );

    final typography = Typography.material2021(
      platform: TargetPlatform.macOS,
      colorScheme: scheme,
    );
    final baseText = (dark ? typography.white : typography.black).apply(
      fontFamily: _systemFont,
      bodyColor: colors.foreground,
      displayColor: colors.foreground,
      decorationColor: colors.foreground,
    );
    final textTheme = baseText.copyWith(
      displayLarge: baseText.displayLarge?.copyWith(
        fontSize: 40,
        height: 1.05,
        fontWeight: FontWeight.w600,
        letterSpacing: -1.1,
      ),
      displayMedium: baseText.displayMedium?.copyWith(
        fontSize: 34,
        height: 1.08,
        fontWeight: FontWeight.w600,
        letterSpacing: -.8,
      ),
      displaySmall: baseText.displaySmall?.copyWith(
        fontSize: 29,
        height: 1.1,
        fontWeight: FontWeight.w600,
        letterSpacing: -.65,
      ),
      headlineLarge: baseText.headlineLarge?.copyWith(
        fontSize: 26,
        height: 1.15,
        fontWeight: FontWeight.w600,
        letterSpacing: -.45,
      ),
      headlineMedium: baseText.headlineMedium?.copyWith(
        fontSize: 22,
        height: 1.18,
        fontWeight: FontWeight.w600,
        letterSpacing: -.3,
      ),
      headlineSmall: baseText.headlineSmall?.copyWith(
        fontSize: 19,
        height: 1.2,
        fontWeight: FontWeight.w600,
        letterSpacing: -.2,
      ),
      titleLarge: baseText.titleLarge?.copyWith(
        fontSize: 18,
        height: 1.25,
        fontWeight: FontWeight.w600,
        letterSpacing: -.12,
      ),
      titleMedium: baseText.titleMedium?.copyWith(
        fontSize: 15,
        height: 1.3,
        fontWeight: FontWeight.w600,
      ),
      titleSmall: baseText.titleSmall?.copyWith(
        fontSize: 14,
        height: 1.3,
        fontWeight: FontWeight.w600,
      ),
      bodyLarge: baseText.bodyLarge?.copyWith(fontSize: 16, height: 1.45),
      bodyMedium: baseText.bodyMedium?.copyWith(fontSize: 14, height: 1.43),
      bodySmall: baseText.bodySmall?.copyWith(
        color: colors.muted,
        fontSize: 13,
        height: 1.4,
      ),
      labelLarge: baseText.labelLarge?.copyWith(
        fontSize: 13.5,
        height: 1.2,
        fontWeight: FontWeight.w600,
        letterSpacing: .05,
      ),
      labelMedium: baseText.labelMedium?.copyWith(
        fontSize: 12.5,
        height: 1.2,
        fontWeight: FontWeight.w600,
        letterSpacing: .08,
      ),
      labelSmall: baseText.labelSmall?.copyWith(
        color: colors.muted,
        fontSize: 11.5,
        height: 1.2,
        fontWeight: FontWeight.w600,
        letterSpacing: .12,
      ),
    );

    const radius = BorderRadius.all(Radius.circular(7));
    final fieldBorder = OutlineInputBorder(
      borderRadius: radius,
      borderSide: BorderSide(color: colors.divider),
    );
    final inputTheme = InputDecorationThemeData(
      isDense: true,
      filled: true,
      fillColor: colors.surface,
      hoverColor: colors.hover,
      contentPadding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      constraints: const BoxConstraints(minHeight: 36),
      border: fieldBorder,
      enabledBorder: fieldBorder,
      disabledBorder: fieldBorder.copyWith(
        borderSide: BorderSide(color: colors.divider.withValues(alpha: .55)),
      ),
      focusedBorder: fieldBorder.copyWith(
        borderSide: BorderSide(color: colors.focus, width: 1.8),
      ),
      errorBorder: fieldBorder.copyWith(
        borderSide: BorderSide(color: colors.danger),
      ),
      focusedErrorBorder: fieldBorder.copyWith(
        borderSide: BorderSide(color: colors.danger, width: 1.8),
      ),
      hintStyle: TextStyle(color: colors.muted, fontSize: 14),
      labelStyle: TextStyle(color: colors.muted, fontSize: 13),
      floatingLabelStyle: TextStyle(
        color: colors.primary,
        fontSize: 12,
        fontWeight: FontWeight.w600,
      ),
      prefixIconColor: colors.muted,
      suffixIconColor: colors.muted,
      prefixIconConstraints: const BoxConstraints(minWidth: 34, minHeight: 34),
      suffixIconConstraints: const BoxConstraints(minWidth: 34, minHeight: 34),
    );
    final menuStyle = MenuStyle(
      backgroundColor: WidgetStatePropertyAll(colors.surface),
      surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
      shadowColor: const WidgetStatePropertyAll(Colors.transparent),
      elevation: const WidgetStatePropertyAll(0),
      padding: const WidgetStatePropertyAll(EdgeInsets.all(4)),
      minimumSize: const WidgetStatePropertyAll(Size(176, 0)),
      side: WidgetStatePropertyAll(BorderSide(color: colors.divider)),
      shape: const WidgetStatePropertyAll(
        RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(8)),
        ),
      ),
      visualDensity: const VisualDensity(horizontal: -1, vertical: -1),
    );

    return ThemeData(
      useMaterial3: true,
      platform: TargetPlatform.macOS,
      brightness: brightness,
      colorScheme: scheme,
      fontFamily: _systemFont,
      typography: typography,
      textTheme: textTheme,
      primaryTextTheme: textTheme,
      scaffoldBackgroundColor: colors.canvas,
      canvasColor: colors.canvas,
      cardColor: colors.surface,
      dividerColor: colors.divider,
      focusColor: colors.focus.withValues(alpha: .2),
      hoverColor: colors.hover,
      highlightColor: colors.selection,
      splashColor: colors.selection,
      shadowColor: Colors.transparent,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: const VisualDensity(horizontal: -1, vertical: -1),
      splashFactory: InkRipple.splashFactory,
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {TargetPlatform.macOS: _MacosPageTransitionsBuilder()},
      ),
      scrollbarTheme: ScrollbarThemeData(
        interactive: true,
        radius: const Radius.circular(8),
        minThumbLength: 36,
        mainAxisMargin: 3,
        crossAxisMargin: 2,
        thumbVisibility: const WidgetStatePropertyAll(false),
        trackVisibility: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.hovered),
        ),
        thickness: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.hovered) ? 8 : 5,
        ),
        thumbColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.dragged)) return colors.primary;
          if (states.contains(WidgetState.hovered)) return colors.muted;
          return colors.muted.withValues(alpha: .55);
        }),
        trackColor: WidgetStatePropertyAll(colors.hover.withValues(alpha: .7)),
        trackBorderColor: const WidgetStatePropertyAll(Colors.transparent),
      ),
      iconTheme: IconThemeData(color: colors.muted, size: 18),
      primaryIconTheme: IconThemeData(color: colors.foreground, size: 18),
      appBarTheme: AppBarThemeData(
        elevation: 0,
        scrolledUnderElevation: 0,
        toolbarHeight: 46,
        centerTitle: false,
        backgroundColor: colors.toolbar,
        foregroundColor: colors.foreground,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        iconTheme: IconThemeData(color: colors.muted, size: 18),
        titleTextStyle: textTheme.titleMedium?.copyWith(
          color: colors.foreground,
          fontWeight: FontWeight.w600,
        ),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        color: colors.surface,
        margin: const EdgeInsets.symmetric(vertical: 4),
        shape: RoundedRectangleBorder(
          borderRadius: const BorderRadius.all(Radius.circular(8)),
          side: BorderSide(color: colors.divider),
        ),
      ),
      dividerTheme: DividerThemeData(
        color: colors.divider,
        thickness: 1,
        space: 1,
      ),
      listTileTheme: ListTileThemeData(
        dense: true,
        minTileHeight: 38,
        minVerticalPadding: 5,
        minLeadingWidth: 22,
        horizontalTitleGap: 9,
        contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
        shape: const RoundedRectangleBorder(borderRadius: radius),
        iconColor: colors.muted,
        textColor: colors.foreground,
        selectedColor: colors.primary,
        selectedTileColor: colors.selection,
        titleTextStyle: textTheme.bodyMedium?.copyWith(
          color: colors.foreground,
          fontWeight: FontWeight.w500,
        ),
        subtitleTextStyle: textTheme.bodySmall,
        leadingAndTrailingTextStyle: textTheme.labelMedium?.copyWith(
          color: colors.muted,
        ),
        visualDensity: const VisualDensity(horizontal: -1, vertical: -1),
      ),
      inputDecorationTheme: inputTheme,
      filledButtonTheme: FilledButtonThemeData(
        style: _filledButtonStyle(colors, textTheme),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: _filledButtonStyle(colors, textTheme),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: _outlinedButtonStyle(colors, textTheme),
      ),
      textButtonTheme: TextButtonThemeData(
        style: _textButtonStyle(colors, textTheme),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: ButtonStyle(
          minimumSize: const WidgetStatePropertyAll(Size.square(30)),
          maximumSize: const WidgetStatePropertyAll(Size.square(34)),
          padding: const WidgetStatePropertyAll(EdgeInsets.all(6)),
          iconSize: const WidgetStatePropertyAll(17),
          foregroundColor: _foregroundState(colors.muted, colors.primary),
          backgroundColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.focused)) return colors.selection;
            if (states.contains(WidgetState.hovered)) return colors.hover;
            return Colors.transparent;
          }),
          overlayColor: const WidgetStatePropertyAll(Colors.transparent),
          side: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.focused)
                ? BorderSide(color: colors.focus, width: 1.5)
                : BorderSide.none,
          ),
          shape: const WidgetStatePropertyAll(
            RoundedRectangleBorder(borderRadius: radius),
          ),
          visualDensity: const VisualDensity(horizontal: -1, vertical: -1),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      ),
      navigationRailTheme: NavigationRailThemeData(
        elevation: 0,
        backgroundColor: colors.sidebar,
        indicatorColor: colors.selection,
        indicatorShape: const RoundedRectangleBorder(borderRadius: radius),
        minWidth: 62,
        minExtendedWidth: 216,
        groupAlignment: -.82,
        useIndicator: true,
        selectedIconTheme: IconThemeData(color: colors.primary, size: 18),
        unselectedIconTheme: IconThemeData(color: colors.muted, size: 18),
        selectedLabelTextStyle: textTheme.labelMedium?.copyWith(
          color: colors.primary,
          fontWeight: FontWeight.w600,
        ),
        unselectedLabelTextStyle: textTheme.labelMedium?.copyWith(
          color: colors.muted,
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        height: 52,
        elevation: 0,
        backgroundColor: colors.toolbar,
        surfaceTintColor: Colors.transparent,
        indicatorColor: colors.selection,
        indicatorShape: const RoundedRectangleBorder(borderRadius: radius),
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => textTheme.labelSmall?.copyWith(
            color: states.contains(WidgetState.selected)
                ? colors.primary
                : colors.muted,
          ),
        ),
        iconTheme: WidgetStateProperty.resolveWith(
          (states) => IconThemeData(
            color: states.contains(WidgetState.selected)
                ? colors.primary
                : colors.muted,
            size: 18,
          ),
        ),
      ),
      tabBarTheme: TabBarThemeData(
        indicator: UnderlineTabIndicator(
          borderSide: BorderSide(color: colors.primary, width: 2),
          borderRadius: const BorderRadius.vertical(top: Radius.circular(2)),
        ),
        indicatorSize: TabBarIndicatorSize.tab,
        dividerColor: colors.divider,
        dividerHeight: 1,
        labelColor: colors.foreground,
        unselectedLabelColor: colors.muted,
        labelStyle: textTheme.labelLarge,
        unselectedLabelStyle: textTheme.labelLarge,
        labelPadding: const EdgeInsets.symmetric(horizontal: 14),
        overlayColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.hovered)
              ? colors.hover
              : Colors.transparent,
        ),
        splashFactory: NoSplash.splashFactory,
        splashBorderRadius: radius,
        tabAlignment: TabAlignment.start,
      ),
      segmentedButtonTheme: SegmentedButtonThemeData(
        selectedIcon: const Icon(Icons.check_rounded, size: 14),
        style: ButtonStyle(
          minimumSize: const WidgetStatePropertyAll(Size(0, 32)),
          padding: const WidgetStatePropertyAll(
            EdgeInsets.symmetric(horizontal: 11, vertical: 6),
          ),
          textStyle: WidgetStatePropertyAll(textTheme.labelMedium),
          foregroundColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.disabled)) {
              return colors.muted.withValues(alpha: .55);
            }
            return states.contains(WidgetState.selected)
                ? colors.foreground
                : colors.muted;
          }),
          backgroundColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.selected)) return colors.selection;
            if (states.contains(WidgetState.hovered)) return colors.hover;
            return colors.surface;
          }),
          overlayColor: const WidgetStatePropertyAll(Colors.transparent),
          side: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.focused)) {
              return BorderSide(color: colors.focus, width: 1.5);
            }
            return BorderSide(color: colors.divider);
          }),
          shape: const WidgetStatePropertyAll(
            RoundedRectangleBorder(borderRadius: radius),
          ),
          visualDensity: const VisualDensity(horizontal: -1, vertical: -1),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      ),
      menuTheme: MenuThemeData(style: menuStyle),
      menuButtonTheme: MenuButtonThemeData(
        style: ButtonStyle(
          minimumSize: const WidgetStatePropertyAll(Size(0, 30)),
          padding: const WidgetStatePropertyAll(
            EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          ),
          textStyle: WidgetStatePropertyAll(textTheme.bodyMedium),
          foregroundColor: WidgetStatePropertyAll(colors.foreground),
          backgroundColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.focused)) return colors.selection;
            if (states.contains(WidgetState.hovered)) return colors.hover;
            return Colors.transparent;
          }),
          overlayColor: const WidgetStatePropertyAll(Colors.transparent),
          shape: const WidgetStatePropertyAll(
            RoundedRectangleBorder(borderRadius: radius),
          ),
          visualDensity: const VisualDensity(horizontal: -1, vertical: -1),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: colors.surface,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        elevation: 0,
        menuPadding: const EdgeInsets.all(4),
        shape: RoundedRectangleBorder(
          borderRadius: const BorderRadius.all(Radius.circular(8)),
          side: BorderSide(color: colors.divider),
        ),
        textStyle: textTheme.bodyMedium,
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => textTheme.bodyMedium?.copyWith(
            color: states.contains(WidgetState.disabled)
                ? colors.muted.withValues(alpha: .55)
                : colors.foreground,
          ),
        ),
        iconColor: colors.muted,
        iconSize: 17,
        position: PopupMenuPosition.under,
      ),
      dropdownMenuTheme: DropdownMenuThemeData(
        textStyle: textTheme.bodyMedium,
        inputDecorationTheme: inputTheme,
        menuStyle: menuStyle,
        disabledColor: colors.muted.withValues(alpha: .55),
      ),
      searchBarTheme: SearchBarThemeData(
        elevation: const WidgetStatePropertyAll(0),
        backgroundColor: WidgetStatePropertyAll(colors.surface),
        surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        shadowColor: const WidgetStatePropertyAll(Colors.transparent),
        overlayColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.hovered)
              ? colors.hover
              : Colors.transparent,
        ),
        side: WidgetStateProperty.resolveWith(
          (states) => BorderSide(
            color: states.contains(WidgetState.focused)
                ? colors.focus
                : colors.divider,
            width: states.contains(WidgetState.focused) ? 1.8 : 1,
          ),
        ),
        shape: const WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: radius),
        ),
        padding: const WidgetStatePropertyAll(
          EdgeInsets.symmetric(horizontal: 10),
        ),
        constraints: const BoxConstraints(minHeight: 36, maxHeight: 38),
        textStyle: WidgetStatePropertyAll(textTheme.bodyMedium),
        hintStyle: WidgetStatePropertyAll(
          textTheme.bodyMedium?.copyWith(color: colors.muted),
        ),
      ),
      tooltipTheme: TooltipThemeData(
        waitDuration: const Duration(milliseconds: 450),
        showDuration: const Duration(seconds: 4),
        preferBelow: false,
        verticalOffset: 12,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
        margin: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: dark ? const Color(0xFFF2F5F2) : const Color(0xFF1D2824),
          borderRadius: const BorderRadius.all(Radius.circular(5)),
        ),
        textStyle: textTheme.labelSmall?.copyWith(
          color: dark ? const Color(0xFF15201C) : Colors.white,
          fontWeight: FontWeight.w500,
        ),
      ),
      dialogTheme: DialogThemeData(
        elevation: 0,
        backgroundColor: colors.raised,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: const BorderRadius.all(Radius.circular(10)),
          side: BorderSide(color: colors.divider),
        ),
        titleTextStyle: textTheme.titleLarge,
        contentTextStyle: textTheme.bodyMedium,
        actionsPadding: const EdgeInsets.fromLTRB(16, 6, 16, 14),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        elevation: 0,
        modalElevation: 0,
        backgroundColor: colors.raised,
        modalBackgroundColor: colors.raised,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        showDragHandle: false,
        shape: RoundedRectangleBorder(
          borderRadius: const BorderRadius.vertical(top: Radius.circular(10)),
          side: BorderSide(color: colors.divider),
        ),
      ),
      chipTheme: ChipThemeData(
        elevation: 0,
        pressElevation: 0,
        side: BorderSide(color: colors.divider),
        backgroundColor: colors.raised,
        selectedColor: colors.selection,
        disabledColor: colors.raised.withValues(alpha: .5),
        checkmarkColor: colors.primary,
        deleteIconColor: colors.muted,
        labelStyle: textTheme.labelMedium,
        secondaryLabelStyle: textTheme.labelMedium?.copyWith(
          color: colors.foreground,
        ),
        padding: const EdgeInsets.symmetric(horizontal: 7),
        shape: const RoundedRectangleBorder(borderRadius: radius),
      ),
      checkboxTheme: CheckboxThemeData(
        visualDensity: const VisualDensity(horizontal: -2, vertical: -2),
        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(4)),
        side: BorderSide(color: colors.divider, width: 1.2),
        fillColor: _selectionFill(colors),
        checkColor: WidgetStatePropertyAll(colors.onPrimary),
      ),
      radioTheme: RadioThemeData(
        visualDensity: const VisualDensity(horizontal: -2, vertical: -2),
        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
        fillColor: _selectionFill(colors),
      ),
      switchTheme: SwitchThemeData(
        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
        trackOutlineColor: WidgetStatePropertyAll(colors.divider),
        trackColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.disabled)) {
            return colors.divider.withValues(alpha: .4);
          }
          return states.contains(WidgetState.selected)
              ? colors.primary
              : colors.hover;
        }),
        thumbColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.disabled)) {
            return colors.muted.withValues(alpha: .5);
          }
          return states.contains(WidgetState.selected)
              ? colors.onPrimary
              : colors.muted;
        }),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        elevation: 0,
        backgroundColor: dark
            ? const Color(0xFFF1F4F1)
            : const Color(0xFF1B2722),
        contentTextStyle: textTheme.bodyMedium?.copyWith(
          color: dark ? const Color(0xFF14201B) : Colors.white,
        ),
        actionTextColor: dark ? const Color(0xFF075C47) : colors.primary,
        shape: RoundedRectangleBorder(
          borderRadius: const BorderRadius.all(Radius.circular(7)),
          side: BorderSide(color: colors.divider),
        ),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: colors.primary,
        linearTrackColor: colors.hover,
        circularTrackColor: colors.hover,
      ),
      extensions: [
        MacosThemeColors(
          sidebar: colors.sidebar,
          toolbar: colors.toolbar,
          canvas: colors.canvas,
          hover: colors.hover,
          selection: colors.selection,
          ambient: colors.ambient,
          divider: colors.divider,
          focus: colors.focus,
          positive: colors.positive,
          warning: colors.accent,
        ),
        AsaelThemeColors(
          background: colors.canvas,
          raised: colors.raised,
          overlay: colors.hover,
          muted: colors.muted,
          line: colors.divider,
          accent: colors.accent,
          success: colors.positive,
          warning: colors.accent,
        ),
      ],
    );
  }

  static ButtonStyle _filledButtonStyle(
    _MacosPalette colors,
    TextTheme textTheme,
  ) => ButtonStyle(
    minimumSize: const WidgetStatePropertyAll(Size(64, 32)),
    padding: const WidgetStatePropertyAll(
      EdgeInsets.symmetric(horizontal: 12, vertical: 7),
    ),
    textStyle: WidgetStatePropertyAll(textTheme.labelLarge),
    foregroundColor: WidgetStateProperty.resolveWith(
      (states) => states.contains(WidgetState.disabled)
          ? colors.onPrimary.withValues(alpha: .55)
          : colors.onPrimary,
    ),
    backgroundColor: WidgetStateProperty.resolveWith((states) {
      if (states.contains(WidgetState.disabled)) {
        return colors.primary.withValues(alpha: .42);
      }
      if (states.contains(WidgetState.pressed)) {
        return Color.alphaBlend(
          colors.foreground.withValues(alpha: .16),
          colors.primary,
        );
      }
      if (states.contains(WidgetState.hovered)) {
        return Color.alphaBlend(
          Colors.white.withValues(alpha: .08),
          colors.primary,
        );
      }
      return colors.primary;
    }),
    overlayColor: const WidgetStatePropertyAll(Colors.transparent),
    elevation: const WidgetStatePropertyAll(0),
    shadowColor: const WidgetStatePropertyAll(Colors.transparent),
    side: WidgetStateProperty.resolveWith(
      (states) => states.contains(WidgetState.focused)
          ? BorderSide(color: colors.focus, width: 2)
          : BorderSide.none,
    ),
    shape: const WidgetStatePropertyAll(
      RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(7)),
      ),
    ),
    visualDensity: const VisualDensity(horizontal: -1, vertical: -1),
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
  );

  static ButtonStyle _outlinedButtonStyle(
    _MacosPalette colors,
    TextTheme textTheme,
  ) => ButtonStyle(
    minimumSize: const WidgetStatePropertyAll(Size(64, 32)),
    padding: const WidgetStatePropertyAll(
      EdgeInsets.symmetric(horizontal: 12, vertical: 7),
    ),
    textStyle: WidgetStatePropertyAll(textTheme.labelLarge),
    foregroundColor: _foregroundState(colors.foreground, colors.primary),
    backgroundColor: WidgetStateProperty.resolveWith((states) {
      if (states.contains(WidgetState.hovered)) return colors.hover;
      if (states.contains(WidgetState.focused)) return colors.selection;
      return Colors.transparent;
    }),
    overlayColor: const WidgetStatePropertyAll(Colors.transparent),
    elevation: const WidgetStatePropertyAll(0),
    side: WidgetStateProperty.resolveWith((states) {
      if (states.contains(WidgetState.focused)) {
        return BorderSide(color: colors.focus, width: 1.8);
      }
      return BorderSide(color: colors.divider);
    }),
    shape: const WidgetStatePropertyAll(
      RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(7)),
      ),
    ),
    visualDensity: const VisualDensity(horizontal: -1, vertical: -1),
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
  );

  static ButtonStyle _textButtonStyle(
    _MacosPalette colors,
    TextTheme textTheme,
  ) => ButtonStyle(
    minimumSize: const WidgetStatePropertyAll(Size(40, 30)),
    padding: const WidgetStatePropertyAll(
      EdgeInsets.symmetric(horizontal: 9, vertical: 6),
    ),
    textStyle: WidgetStatePropertyAll(textTheme.labelLarge),
    foregroundColor: _foregroundState(colors.primary, colors.primary),
    backgroundColor: WidgetStateProperty.resolveWith((states) {
      if (states.contains(WidgetState.focused)) return colors.selection;
      if (states.contains(WidgetState.hovered)) return colors.hover;
      return Colors.transparent;
    }),
    overlayColor: const WidgetStatePropertyAll(Colors.transparent),
    shape: const WidgetStatePropertyAll(
      RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(7)),
      ),
    ),
    visualDensity: const VisualDensity(horizontal: -1, vertical: -1),
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
  );

  static WidgetStateProperty<Color?> _foregroundState(
    Color enabled,
    Color emphasized,
  ) => WidgetStateProperty.resolveWith((states) {
    if (states.contains(WidgetState.disabled)) {
      return enabled.withValues(alpha: .45);
    }
    if (states.contains(WidgetState.focused) ||
        states.contains(WidgetState.hovered) ||
        states.contains(WidgetState.selected)) {
      return emphasized;
    }
    return enabled;
  });

  static WidgetStateProperty<Color?> _selectionFill(_MacosPalette colors) =>
      WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.disabled)) {
          return colors.muted.withValues(alpha: .35);
        }
        return states.contains(WidgetState.selected)
            ? colors.primary
            : Colors.transparent;
      });
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
      hover: scheme.surfaceContainerHigh,
      selection: scheme.primaryContainer,
      ambient: scheme.tertiaryContainer,
      divider: scheme.outlineVariant,
      focus: scheme.primary,
      positive: scheme.tertiary,
      warning: scheme.secondary,
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

@immutable
class _MacosPalette {
  const _MacosPalette({
    required this.canvas,
    required this.surface,
    required this.raised,
    required this.sidebar,
    required this.toolbar,
    required this.foreground,
    required this.muted,
    required this.divider,
    required this.hover,
    required this.selection,
    required this.ambient,
    required this.primary,
    required this.onPrimary,
    required this.accent,
    required this.positive,
    required this.danger,
    required this.focus,
  });

  factory _MacosPalette.forBrightness(
    Brightness brightness,
    bool highContrast,
  ) {
    if (brightness == Brightness.dark) {
      return _MacosPalette(
        canvas: highContrast
            ? const Color(0xFF080B0A)
            : const Color(0xFF111513),
        surface: highContrast
            ? const Color(0xFF101512)
            : const Color(0xFF171C19),
        raised: highContrast
            ? const Color(0xFF171D1A)
            : const Color(0xFF1D2320),
        sidebar: highContrast
            ? const Color(0xFF0B0F0D)
            : const Color(0xFF131816),
        toolbar: highContrast
            ? const Color(0xFF121714)
            : const Color(0xFF1A201D),
        foreground: const Color(0xFFF2F5F2),
        muted: highContrast ? const Color(0xFFC8D1CB) : const Color(0xFFA9B3AD),
        divider: highContrast
            ? const Color(0xFF77827C)
            : const Color(0xFF35403B),
        hover: highContrast ? const Color(0xFF26312C) : const Color(0xFF252D29),
        selection: highContrast
            ? const Color(0xFF205443)
            : const Color(0xFF1C4438),
        ambient: const Color(0xFF243B33),
        primary: highContrast
            ? const Color(0xFF83EABD)
            : const Color(0xFF71D4AC),
        onPrimary: const Color(0xFF04140D),
        accent: highContrast
            ? const Color(0xFFFFC77C)
            : const Color(0xFFE8B46E),
        positive: const Color(0xFF76D3A7),
        danger: highContrast
            ? const Color(0xFFFFAAA2)
            : const Color(0xFFFF8A80),
        focus: const Color(0xFF8DEAC2),
      );
    }
    return _MacosPalette(
      canvas: highContrast ? const Color(0xFFF7F9F7) : const Color(0xFFF2F5F3),
      surface: highContrast ? const Color(0xFFFFFFFF) : const Color(0xFFFAFCFA),
      raised: const Color(0xFFFFFFFF),
      sidebar: highContrast ? const Color(0xFFE7ECE9) : const Color(0xFFE9EEEB),
      toolbar: highContrast ? const Color(0xFFF3F6F4) : const Color(0xFFF7F9F7),
      foreground: highContrast
          ? const Color(0xFF07110D)
          : const Color(0xFF14211D),
      muted: highContrast ? const Color(0xFF36433E) : const Color(0xFF53625C),
      divider: highContrast ? const Color(0xFF69756F) : const Color(0xFFCBD4CF),
      hover: highContrast ? const Color(0xFFDCE5E0) : const Color(0xFFE2E9E5),
      selection: highContrast
          ? const Color(0xFFC8E4D8)
          : const Color(0xFFD5E9E0),
      ambient: const Color(0xFFC5D9D1),
      primary: highContrast ? const Color(0xFF005A43) : const Color(0xFF08785D),
      onPrimary: const Color(0xFFFFFFFF),
      accent: highContrast ? const Color(0xFF794200) : const Color(0xFF9B5A05),
      positive: const Color(0xFF18714F),
      danger: highContrast ? const Color(0xFF8E201B) : const Color(0xFFB13732),
      focus: const Color(0xFF08785D),
    );
  }

  final Color canvas;
  final Color surface;
  final Color raised;
  final Color sidebar;
  final Color toolbar;
  final Color foreground;
  final Color muted;
  final Color divider;
  final Color hover;
  final Color selection;
  final Color ambient;
  final Color primary;
  final Color onPrimary;
  final Color accent;
  final Color positive;
  final Color danger;
  final Color focus;
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
    if (route.settings.name == Navigator.defaultRouteName ||
        (MediaQuery.maybeOf(context)?.disableAnimations ?? false)) {
      return child;
    }
    return FadeTransition(
      opacity: CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
      child: child,
    );
  }

  @override
  Duration get transitionDuration => const Duration(milliseconds: 150);

  @override
  Duration get reverseTransitionDuration => const Duration(milliseconds: 110);
}
