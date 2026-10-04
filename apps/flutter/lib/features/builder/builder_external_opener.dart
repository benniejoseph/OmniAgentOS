import 'package:url_launcher/url_launcher.dart';

import 'builder_contracts.dart';
import 'builder_widgets.dart';

/// Explicit host capability; only the workspace's Open buttons invoke this.
/// URLs are never embedded, logged or written to local recovery.
class UrlLauncherBuilderOpener implements NativeBuilderExternalOpener {
  UrlLauncherBuilderOpener({
    Future<bool> Function(Uri)? canOpen,
    Future<bool> Function(Uri)? launch,
  }) : _canOpen = canOpen ?? canLaunchUrl,
       _launch = launch ?? _launchExternal;

  final Future<bool> Function(Uri) _canOpen, _launch;
  static Future<bool> _launchExternal(Uri uri) =>
      launchUrl(uri, mode: LaunchMode.externalApplication);

  @override
  Future<bool> open(Uri uri, {required bool Function() isCurrent}) async {
    final safe = builderExternalUri(uri.toString());
    if (safe == null || !isCurrent()) return false;
    if (!await _canOpen(safe)) return false;
    // Capability discovery is asynchronous. Recheck the exact current account,
    // API and reviewed target immediately before the OS receives this URL.
    if (!isCurrent()) return false;
    return _launch(safe);
  }
}
