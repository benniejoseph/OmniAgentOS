import 'package:flutter/foundation.dart';

/// True only for the installed macOS product surface.
///
/// Keep presentation decisions behind this boundary so a wide Android tablet
/// never inherits desktop window chrome, pointer density, or keyboard behavior.
bool usesMacosPresentation({bool? isWeb, TargetPlatform? platform}) =>
    !(isWeb ?? kIsWeb) &&
    (platform ?? defaultTargetPlatform) == TargetPlatform.macOS;
