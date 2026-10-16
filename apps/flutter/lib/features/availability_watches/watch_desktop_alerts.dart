import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/native_workspace_access.dart';
import '../../core/platform/desktop_host_bridge.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../../generated/native_contract.g.dart';
import '../settings/portable_archive_canonical.dart';
import 'watch_models.dart';
import 'watch_repository.dart';

/// An app-open fallback, never an APNs receipt or a background server worker.
/// The native host owns owner-scoped persistent dedupe and OS permission.
class WatchDesktopAlerts extends ChangeNotifier {
  WatchDesktopAlerts(this.access)
    : repository = WatchRepository(access),
      scope = portableCanonicalSha256([
        access.authority.apiBaseUrl,
        access.authority.tenantId,
        access.authority.canonicalUserId,
      ]);
  final NativeWorkspaceAccess access;
  final WatchRepository repository;
  final String scope;
  final _seen = <String>{};
  final _host = appDesktopHostBridge;
  Timer? _timer;
  bool _closed = false,
      _polling = false,
      ready = false,
      enabled = false,
      busy = false;
  String permission = 'not_determined';
  String? error;
  DateTime? lastCheckedAt, lastRequestedAt;
  GoRouter? router;
  bool get current => !_closed && access.current;
  Future<void> initialize() async {
    try {
      if (!current) return;
      final value = await _host.watchAlertSession(scope, active: true);
      if (!current) return;
      _settings(value);
      ready = true;
      _timer = Timer.periodic(
        const Duration(seconds: 30),
        (_) => unawaited(poll()),
      );
      notifyListeners();
      unawaited(poll());
    } catch (_) {
      if (current) {
        ready = true;
        error = 'App-open alerts could not connect to this Mac.';
        notifyListeners();
      }
    }
  }

  Future<void> setEnabled(bool value) async {
    if (!current || busy) return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      final settings = await _host.setWatchAlertsEnabled(scope, value);
      if (!current) return;
      _settings(settings);
      if (value && !enabled) error = 'Allow notifications for Asael in macOS System Settings to receive app-open alerts.';
    } catch (_) {
      if (current) error = 'The Mac notification setting could not be changed.';
    } finally {
      if (current) {
        busy = false;
        notifyListeners();
      }
    }
    if (enabled) unawaited(poll());
  }

  void _settings(WatchJson value) {
    if (value['enabled'] is! bool ||
        !const {
          'authorized',
          'provisional',
          'denied',
          'not_determined',
        }.contains(value['permission'])) {
      throw const FormatException('The Mac notification settings are invalid.');
    }
    permission = value['permission'] as String;
    enabled =
        value['enabled'] == true &&
        const {'authorized', 'provisional'}.contains(permission);
  }

  Future<void> poll() async {
    if (!current || !enabled || _polling) return;
    _polling = true;
    try {
      final center = await access.api.getJsonAuthorized(
        NativePaths.notificationsList,
        authority: access.authority,
      );
      if (!current || !enabled) return;
      final preferences = watchMap(center['preferences']);
      if (preferences['notificationsEnabled'] != true) return;
      final notices = center['notifications'];
      if (notices is! List || notices.length > 200) {
        throw const FormatException('The watch alert inbox is invalid.');
      }
      final candidates = notices
          .map(watchMap)
          .where(
            (notice) =>
                notice['kind'] == 'availability_watch' &&
                notice['sourceType'] == 'availability_watch' &&
                notice['status'] == 'unread' &&
                notice['id'] is String &&
                !_seen.contains(notice['id']),
          )
          .take(5);
      for (final notice in candidates) {
        if (!current || !enabled) return;
        final id = watchText(notice, 'id'),
            watchId = watchText(notice, 'sourceId');
        if (!RegExp(r'^notification_[a-f0-9]{48}$').hasMatch(id) ||
            !watchIdPattern.hasMatch(watchId)) {
          throw const FormatException('The watch alert identity is invalid.');
        }
        final result = await repository.get(watchId);
        if (!current || !enabled) return;
        final watch = result.watch;
        if (watch.state != 'fulfilled' ||
            watch.notification?['notificationId'] != id ||
            watch.notification?['state'] != 'recorded' ||
            watch.raw['openingId'] != notice['occurrenceKey'] ||
            !(watchTime(watch.config['expiresAt'])
                    ?.isAfter(DateTime.now().toUtc()) ??
                false)) {
          _seen.add(id);
          continue;
        }
        // Re-read live preferences immediately before the local presentation;
        // a stored opening or earlier preference is not present authority.
        final latest = await access.api.getJsonAuthorized(
          NativePaths.notificationsList,
          authority: access.authority,
        );
        if (!current ||
            !enabled ||
            watchMap(latest['preferences'])['notificationsEnabled'] != true) {
          return;
        }
        final state = await _host.presentWatchAlert(
          scope,
          notificationId: id,
          watchId: watchId,
        );
        if (!current) return;
        _seen.add(id);
        if (_seen.length > 500) _seen.remove(_seen.first);
        if (state == 'requested') lastRequestedAt = DateTime.now();
      }
      lastCheckedAt = DateTime.now();
      error = null;
    } catch (_) {
      if (current) error = 'App-open alert checks are temporarily unavailable. Saved server watches continue.';
    } finally {
      _polling = false;
      if (current) notifyListeners();
    }
  }

  Future<void> open(String ownerScope, String watchId) async {
    if (!current || ownerScope != scope || !watchIdPattern.hasMatch(watchId)) {
      return;
    }
    try {
      await repository.get(watchId);
      if (current && ownerScope == scope) {
        router?.go('/watches/${Uri.encodeComponent(watchId)}');
      }
    } catch (_) {
      if (current) router?.go('/watches');
    }
  }

  @override
  void dispose() {
    _closed = true;
    _timer?.cancel();
    repository.dispose();
    unawaited(
      _host
          .watchAlertSession(scope, active: false)
          .then<void>((_) {}, onError: (_) {}),
    );
    super.dispose();
  }
}

final watchDesktopAlertsProvider = Provider<WatchDesktopAlerts?>((ref) {
  if (!appDesktopHostBridge.supported ||
      !ref.watch(primaryNativeRuntimeProvider)) {
    return null;
  }
  final access = ref.watch(nativeWorkspaceAccessProvider);
  if (access == null || !access.current) return null;
  final alerts = WatchDesktopAlerts(access);
  ref.onDispose(alerts.dispose);
  unawaited(alerts.initialize());
  return alerts;
});

class WatchDesktopAlertSettings extends ConsumerWidget {
  const WatchDesktopAlertSettings({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final alerts = ref.watch(watchDesktopAlertsProvider);
    if (alerts == null) return const SizedBox.shrink();
    return ListenableBuilder(
      listenable: alerts,
      builder: (context, _) => Padding(
        padding: const EdgeInsets.only(bottom: 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              alerts.enabled
                  ? 'App-open Mac alerts are on'
                  : 'App-open Mac alerts are off',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 6),
            const Text(
              'While Asael is running and unlocked, it checks your saved opening alerts every 30 seconds and asks macOS to show each once. This does not work after quitting the app. Quiet hours and system notification settings apply.',
            ),
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: !alerts.ready || alerts.busy
                  ? null
                  : () => alerts.setEnabled(!alerts.enabled),
              child: Text(
                alerts.busy
                    ? 'Updating…'
                    : alerts.enabled
                    ? 'Turn off app-open alerts'
                    : 'Enable app-open alerts',
              ),
            ),
            if (alerts.lastRequestedAt != null)
              Text(
                'macOS last accepted a local alert request at ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(alerts.lastRequestedAt!))}. This is not a device receipt.',
              ),
            if (alerts.error != null)
              Text(
                alerts.error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
          ],
        ),
      ),
    );
  }
}
