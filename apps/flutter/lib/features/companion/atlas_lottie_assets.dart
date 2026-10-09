import 'package:flutter/services.dart';
import 'package:lottie/lottie.dart';

import 'atlas_assets.dart' show atlasStates;

/// Original bundled shape-only artwork; state names never become remote URLs.
class AtlasLottieAssets {
  static const creativeRevision = 'atlas-scout-20261009-voice';
  static const directory = 'assets/companion/atlas-lottie';
  static final _compositions =
      Expando<Map<String, Future<LottieComposition>>>();

  static Future<LottieComposition> load(
    AssetBundle bundle,
    String state, {
    required bool dark,
  }) {
    final safeState = atlasStates.contains(state) ? state : 'available';
    final asset = '$directory/$safeState-${dark ? 'dark' : 'light'}.json';
    final entries = _compositions[bundle] ??= {};
    return entries.putIfAbsent(
      '$creativeRevision:$asset',
      () => AssetLottie(asset, bundle: bundle).load(),
    );
  }
}
