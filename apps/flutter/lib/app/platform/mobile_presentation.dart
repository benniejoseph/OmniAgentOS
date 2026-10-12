import 'package:flutter/foundation.dart';

/// Phone and tablet presentation for installed Android and iOS clients.
/// Screen width controls composition inside this boundary, never authority.
bool usesMobilePresentation({bool? isWeb, TargetPlatform? platform}) {
  final target = platform ?? defaultTargetPlatform;
  return !(isWeb ?? kIsWeb) &&
      (target == TargetPlatform.android || target == TargetPlatform.iOS);
}
