import 'dart:async';

import 'package:flutter/material.dart';

import '../config/app_config.dart';
import '../platform/desktop_host_bridge.dart';
import '../../features/self_improvement/self_improvement_view.dart';
import 'native_update_protocol.dart';
import 'native_update_startup_gate.dart';

class NativeUpdateRuntime {
  const NativeUpdateRuntime({
    required this.tenantId,
    required this.userId,
    required this.route,
    required this.unlocked,
    required this.busyReasons,
  });
  final String? tenantId, userId;
  final String route;
  final bool unlocked;
  final Set<String> busyReasons;
}

/// Main-engine-only, content-free handshake. Early flutterReady remains a
/// transport signal; this acknowledges the actual authenticated rendered route.
class NativeUpdateHandshake extends StatefulWidget {
  const NativeUpdateHandshake({
    super.key,
    required this.child,
    required this.runtime,
    required this.enabled,
    required this.bridge,
  });
  final Widget child;
  final NativeUpdateRuntime Function() runtime;
  final bool enabled;
  final DesktopHostBridge bridge;
  @override
  State<NativeUpdateHandshake> createState() => _NativeUpdateHandshakeState();
}

class _NativeUpdateHandshakeState extends State<NativeUpdateHandshake> {
  static const _snapshot = String.fromEnvironment(
    'ASAEL_SOURCE_SNAPSHOT_SHA256',
  );
  String? _leaseNonce, _notice;
  DateTime? _leaseEnd;
  Timer? _leaseTimer;
  Stopwatch? _leaseClock;
  Duration _leaseDuration = const Duration(seconds: 30);
  bool _checking = false;
  bool get _frozen =>
      _leaseEnd != null &&
      _leaseClock != null &&
      _leaseClock!.elapsed < _leaseDuration;

  @override
  void initState() {
    super.initState();
    nativeUpdateStartupGate.addListener(_startupChanged);
    _attach();
  }

  void _startupChanged() {
    if (mounted) {
      setState(() {
        if (nativeUpdateStartupGate.decision == 'expired') {
          _notice = 'Update verification timed out. Your workspace is available; publication remains on hold.';
        }
      });
    }
  }

  @override
  void didUpdateWidget(covariant NativeUpdateHandshake oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.bridge, widget.bridge)) {
      oldWidget.bridge.attachUpdateReadinessHandler(null);
    }
    _attach();
  }

  void _attach() {
    widget.bridge.attachUpdateReadinessHandler(
      widget.enabled ? _readiness : null,
      quiesced: widget.enabled
          ? () => _frozen || nativeUpdateStartupGate.active
          : null,
    );
  }

  @override
  void dispose() {
    _leaseTimer?.cancel();
    if (_leaseNonce case final nonce?) nativeUpdateHandoffGate.release(nonce);
    nativeUpdateStartupGate.removeListener(_startupChanged);
    widget.bridge.attachUpdateReadinessHandler(null);
    super.dispose();
  }

  Future<Map<String, Object?>> _readiness(Object? raw) async {
    final request = NativeUpdateRequest.parse(raw);
    if (_checking) {
      throw StateError('The update inspection is already running.');
    }
    _checking = true;
    if (request.action == 'quiesce' && !_frozen) {
      nativeUpdateHandoffGate.begin(request.nonce, const Duration(seconds: 6));
    }
    try {
      WidgetsBinding.instance.scheduleFrame();
      await WidgetsBinding.instance.endOfFrame;
      if (!mounted || !widget.enabled) {
        throw StateError('The primary workspace is unavailable.');
      }
      final runtime = widget.runtime();
      final owner = runtime.tenantId != null && runtime.userId != null
          ? await nativeUpdateOwnerDigest(runtime.tenantId!, runtime.userId!)
          : null;
      if (!mounted) throw StateError('The workspace closed.');
      final after = widget.runtime();
      final sameOwner =
          after.tenantId == runtime.tenantId && after.userId == runtime.userId;
      final authenticated = sameOwner && owner != null && after.unlocked;
      var rendered = false, workspaceReady = false, inspected = 0;
      void inspect(Element element) {
        if (++inspected > 30000) return;
        final view = element.widget;
        if (view is SelfImprovementView &&
            nativeUpdateImprovementRoute(after.route) &&
            TickerMode.valuesOf(element).enabled &&
            element.renderObject?.attached == true) {
          rendered = true;
          workspaceReady =
              view.controller.current &&
              view.controller.snapshot != null &&
              !view.controller.refreshRequired &&
              !view.controller.loading &&
              !view.controller.acting &&
              view.controller.error == null;
        }
        element.visitChildElements(inspect);
      }

      (context as Element).visitChildElements(inspect);
      final reasons = <String>{
        if (inspected > 30000) 'inspection_incomplete',
        ...request.nativeBusy,
        ...after.busyReasons,
        ...inspectNativeUpdateActivity(context as Element),
      };
      final buildMatches =
          RegExp(r'^[a-f0-9]{64}$').hasMatch(_snapshot) &&
          request.expected['sourceSnapshotSha256'] == _snapshot &&
          request.expected['version'] == AppConfig.appVersion &&
          request.expected['build'] == AppConfig.appBuildNumber;
      if (!buildMatches) reasons.add('build_mismatch');
      if (owner == null || !sameOwner) reasons.add('session_unavailable');
      if (!after.unlocked) reasons.add('workspace_locked');
      if (owner != request.expected['ownerSha256']) {
        reasons.add('owner_mismatch');
      }
      if (!rendered) reasons.add('route_not_rendered');
      if (!workspaceReady) reasons.add('workspace_not_ready');
      final startup = nativeUpdateStartupGate.active;
      final startupOwned =
          startup && nativeUpdateStartupGate.nonce == request.nonce;
      if (startup && !startupOwned) reasons.add('request_in_progress');
      // No editing has been admitted in this new process. Prefilled fields are
      // restored/saved state, not a new draft created during the canary.
      if (startupOwned) reasons.remove('unsaved_draft');
      final ready =
          buildMatches &&
          authenticated &&
          rendered &&
          workspaceReady &&
          owner == request.expected['ownerSha256'];
      if (_frozen && _leaseNonce != request.nonce) {
        reasons.add('request_in_progress');
      }
      final startupSafe =
          startupOwned &&
          buildMatches &&
          reasons.difference({
            'owner_mismatch',
            'session_unavailable',
            'workspace_locked',
            'workspace_not_ready',
            'route_not_rendered',
          }).isEmpty;
      if (request.action == 'commit') {
        if (!startupOwned ||
            _frozen ||
            !ready ||
            reasons.isNotEmpty ||
            !nativeUpdateStartupGate.commit(request.nonce)) {
          reasons.add('request_in_progress');
        }
      }
      if (request.action == 'quiesce' &&
          !_frozen &&
          (reasons.isEmpty || startupSafe)) {
        setState(() {
          _leaseNonce = request.nonce;
          _leaseClock = Stopwatch()..start();
          final ordinaryExpiry = DateTime.now().toUtc().add(
            const Duration(seconds: 30),
          );
          _leaseEnd =
              startupSafe &&
                  nativeUpdateStartupGate.expiresAt!.isBefore(ordinaryExpiry)
              ? nativeUpdateStartupGate.expiresAt
              : ordinaryExpiry;
          _leaseDuration = _leaseEnd!.difference(DateTime.now().toUtc());
          nativeUpdateHandoffGate.begin(request.nonce, _leaseDuration);
          _notice = 'Installing the approved update. Your workspace will reopen shortly.';
        });
        _leaseTimer?.cancel();
        _leaseTimer = Timer(_leaseDuration, () {
          if (mounted) {
            setState(() {
              nativeUpdateHandoffGate.release(request.nonce);
              _leaseEnd = null;
              _leaseNonce = null;
              _notice = 'The update handoff expired. Your workspace is available; no action was replayed.';
            });
          }
        });
        WidgetsBinding.instance.scheduleFrame();
        await WidgetsBinding.instance.endOfFrame;
        // A change between inspection and the input-freeze frame must hold.
        if (!mounted) {
          throw StateError('The workspace closed during update inspection.');
        }
        final latest = widget.runtime();
        final lateReasons = {
          if (!startupSafe &&
              (latest.tenantId != runtime.tenantId ||
                  latest.userId != runtime.userId))
            'session_unavailable',
          if (!startupSafe && !latest.unlocked) 'workspace_locked',
          if (!startupSafe && latest.route != after.route) 'route_not_rendered',
          ...latest.busyReasons,
          ...inspectNativeUpdateActivity(context as Element),
        };
        if (startupSafe) lateReasons.remove('unsaved_draft');
        if (lateReasons.isNotEmpty) {
          reasons.addAll(lateReasons);
          _leaseTimer?.cancel();
          setState(() {
            nativeUpdateHandoffGate.release(request.nonce);
            _leaseEnd = null;
            _leaseNonce = null;
          });
        }
      }
      if (request.action == 'quiesce' && reasons.isNotEmpty && !_frozen) {
        setState(() => _notice = nativeUpdateHoldMessage(reasons));
      }
      return {
        'protocol': 1,
        'action': request.action,
        'nonce': request.nonce,
        'sourceSnapshotSha256': _snapshot,
        'version': AppConfig.appVersion,
        'build': AppConfig.appBuildNumber,
        'ownerSha256': sameOwner ? owner : null,
        'status':
            _frozen &&
                _leaseNonce == request.nonce &&
                (reasons.isEmpty || startupSafe)
            ? 'quiesced'
            : ready &&
                  {'status', 'commit'}.contains(request.action) &&
                  !reasons.contains('request_in_progress')
            ? 'ready'
            : 'held',
        'startupQuarantined': nativeUpdateStartupGate.active,
        'startupDecision': nativeUpdateStartupGate.decision,
        'flutterReady': true,
        'authenticatedWorkspaceReady':
            authenticated &&
            workspaceReady &&
            !reasons.contains('session_unavailable') &&
            !reasons.contains('workspace_locked'),
        'improvementRendered': rendered,
        'busyReasons': reasons.toList()..sort(),
        'quiescenceExpiresAt': _frozen && _leaseNonce == request.nonce
            ? _leaseEnd?.toIso8601String()
            : null,
      };
    } finally {
      if (!_frozen) nativeUpdateHandoffGate.release(request.nonce);
      _checking = false;
    }
  }

  @override
  Widget build(BuildContext context) => Stack(
    children: [
      Positioned.fill(
        child: AbsorbPointer(
          absorbing: _frozen || nativeUpdateStartupGate.active,
          child: ExcludeFocus(
            excluding: _frozen || nativeUpdateStartupGate.active,
            child: widget.child,
          ),
        ),
      ),
      if (_notice != null || nativeUpdateStartupGate.active)
        Positioned(
          left: 24,
          right: 24,
          bottom: 24,
          child: Material(
            elevation: 6,
            borderRadius: BorderRadius.circular(12),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  const Icon(Icons.system_update_alt),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      _notice ?? 'Verifying the approved app update. Editing is temporarily paused.',
                    ),
                  ),
                  if (!_frozen && !nativeUpdateStartupGate.active)
                    TextButton(
                      onPressed: () => setState(() => _notice = null),
                      child: const Text('Dismiss'),
                    ),
                ],
              ),
            ),
          ),
        ),
    ],
  );
}

String nativeUpdateHoldMessage(Set<String> reasons) {
  if (reasons.contains('voice_active')) {
    return 'Update waiting: finish the voice conversation or recording first.';
  }
  if (reasons.contains('desktop_busy') || reasons.contains('desktop_enabled')) {
    return 'Update waiting: stop This Mac control before installing.';
  }
  if (reasons.contains('unsaved_draft')) {
    return 'Update waiting: send or save your draft, or finish and close the open editor.';
  }
  if (reasons.contains('auxiliary_window')) {
    return 'Update waiting: finish work and close the extra Asael windows.';
  }
  if (reasons.contains('conversation_busy') ||
      reasons.contains('capture_busy')) {
    return 'Update waiting: let the current conversation or file capture finish.';
  }
  return 'Update waiting: unlock Asael and open Self-improvement with a fresh connection.';
}
