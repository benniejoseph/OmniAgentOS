import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../auth/application/session_controller.dart';
import 'listen_bridge.dart';
import 'listen_repository.dart';

class ListenController extends ChangeNotifier {
  ListenController(this.access);
  final NativeWorkspaceAccess? access;
  ListenJson? status;
  List<ListenJson> conversations = const [];
  bool loading = false, busy = false;
  String? error;
  bool _disposed = false;
  int _generation = 0;
  StreamSubscription<ListenJson>? _subscription;
  CancelToken? _read;
  Future<void>? _grantInFlight;
  bool get current => !_disposed && (access?.current ?? false);
  bool get canManage => current && access!.canManage;
  ListenRepository get _repository => ListenRepository(access!);
  bool get supported => appListenBridge.supported;
  ListenJson? get activeSession => status?['activeSession'] is Map
      ? listenMap(status!['activeSession'])
      : null;

  bool _belongsHere(ListenJson value) {
    final scope = listenMap(value['scope']);
    if (scope.isEmpty) return listenRows(value['sessions']).isEmpty;
    return scope['ownerId'] == access?.authority.actorId &&
        scope['canonicalUserId'] == access?.authority.canonicalUserId &&
        scope['tenantId'] == access?.authority.tenantId &&
        scope['actorId'] == access?.authority.actorId &&
        scope['role'] == access?.authority.role &&
        scope['deploymentId'] == Uri.parse(access!.authority.apiBaseUrl).origin;
  }

  Future<void> initialize() async {
    if (!current) return;
    if (supported) {
      _subscription = appListenBridge.events.listen(
        (value) {
          if (!current || !_belongsHere(value)) return;
          status = value;
          notifyListeners();
        },
        onError: (_) {
          if (!current) return;
          error =
              'Listening status is unavailable. Reopen Listen to reconnect.';
          notifyListeners();
        },
      );
    }
    await refresh();
  }

  Future<void> refresh() async {
    if (!current || loading) return;
    final generation = ++_generation;
    final cancel = _read = CancelToken();
    loading = true;
    error = null;
    notifyListeners();
    try {
      if (supported) {
        var native = await appListenBridge.invoke('getStatus');
        if (!current || generation != _generation) return;
        if (!_belongsHere(native)) {
          await appListenBridge.clearOwner();
          if (!current) return;
          native = await appListenBridge.invoke('getStatus');
        }
        if (!current || generation != _generation) return;
        status = native;
        final expiry = DateTime.tryParse(listenText(native['accessExpiresAt']));
        final configured =
            native['callsEnabled'] == true ||
            native['accessReady'] == true ||
            listenRows(native['sessions']).isNotEmpty;
        if (canManage &&
            configured &&
            (expiry == null ||
                expiry.isBefore(DateTime.now().add(const Duration(days: 3))))) {
          await _grant();
        }
      }
      final rows = await _repository.conversations(cancel);
      if (!current || generation != _generation) return;
      conversations = rows;
    } catch (value) {
      if (current && generation == _generation) {
        if (value is ApiException && {401, 403}.contains(value.statusCode)) {
          conversations = const [];
          status = null;
          unawaited(appListenBridge.clearOwner().catchError((_) {}));
        }
        error = listenError(value);
      }
    } finally {
      if (current && generation == _generation) {
        loading = false;
        notifyListeners();
      }
    }
  }

  Future<void> _grant() async {
    final pending = _grantInFlight;
    if (pending != null) return pending;
    final operation = _issueGrant();
    _grantInFlight = operation;
    try {
      await operation;
    } finally {
      if (identical(_grantInFlight, operation)) _grantInFlight = null;
    }
  }

  Future<void> _issueGrant() async {
    if (!canManage || !supported) return;
    final grant = await _repository.issueGrant();
    if (!canManage) return;
    final result = await appListenBridge.invoke('configureAccessGrant', grant);
    if (current && _belongsHere(result)) status = result;
  }

  Future<void> action(
    String method, {
    ListenJson? arguments,
    bool grant = false,
  }) async {
    if (!canManage || busy || !supported) return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      if (grant) await _grant();
      if (!canManage) return;
      final result = await appListenBridge.invoke(method, arguments);
      if (current && _belongsHere(result)) status = result;
    } catch (value) {
      if (current) {
        if (value is ApiException && {401, 403}.contains(value.statusCode)) {
          conversations = const [];
          status = null;
          unawaited(appListenBridge.clearOwner().catchError((_) {}));
        }
        error = listenError(value);
      }
    } finally {
      if (current) {
        busy = false;
        notifyListeners();
      }
    }
  }

  void invalidate() {
    _generation++;
    _read?.cancel('Listening workspace changed.');
    status = null;
    conversations = const [];
    error = null;
  }

  @override
  void dispose() {
    _disposed = true;
    invalidate();
    unawaited(_subscription?.cancel());
    super.dispose();
  }
}

String listenError(Object value) {
  if (value is ApiException && value.statusCode == 401) {
    return 'Sign in again to reconnect your conversation notes.';
  }
  if (value is ApiException && value.statusCode == 403) {
    return 'This account does not currently have access to listening.';
  }
  if (value is PlatformException &&
      value.message != null &&
      value.message!.length < 300) {
    return value.message!;
  }
  return 'Could not complete that step. Your saved audio is kept for another attempt.';
}

final listenControllerProvider = ChangeNotifierProvider<ListenController>((
  ref,
) {
  final access = ref.watch(nativeWorkspaceAccessProvider);
  final controller = ListenController(access);
  ref.onDispose(controller.invalidate);
  if (access != null) unawaited(controller.initialize());
  return controller;
});

/// Biometric locking discards Flutter's private state, while explicitly enabled
/// recording/import keeps its narrow native grant. Account and server changes
/// stop that separate authority; they are not treated as ordinary screen locks.
final listenLifecycleProvider = Provider<void>((ref) {
  // Keep the foreground controller active without rebuilding this lifecycle
  // observer on each recording tick or temporary UI-authority replacement.
  ref.listen(listenControllerProvider, (_, _) {});
  final initial = ref.read(sessionControllerProvider);
  var confirmedOwner = initial.isLoading || initial.hasError
      ? null
      : initial.value;
  var deployment = NativeRequestAuthority.normalizeApiBaseUrl(
    ref.read(apiClientProvider).apiBaseUrl,
  );
  if (!initial.isLoading && !initial.hasError && initial.value == null) {
    unawaited(appListenBridge.clearOwner().catchError((_) {}));
  }
  ref.listen(sessionControllerProvider, (_, next) {
    // Retry, migration and temporary restore failure are not sign-out. Retain
    // the last confirmed owner across them; the narrow grant remains subject
    // to live server membership and session revocation checks.
    if (next.isLoading || next.hasError) return;
    final before = confirmedOwner;
    final after = next.value;
    confirmedOwner = after;
    if (after == null ||
        (before != null &&
            (before.tenantId != after.tenantId ||
                before.actorId != after.actorId ||
                before.userId != after.userId ||
                before.role != after.role))) {
      unawaited(appListenBridge.clearOwner().catchError((_) {}));
    }
  });
  ref.listen(apiClientProvider, (_, next) {
    final nextDeployment = NativeRequestAuthority.normalizeApiBaseUrl(
      next.apiBaseUrl,
    );
    if (nextDeployment != deployment) {
      unawaited(appListenBridge.clearOwner().catchError((_) {}));
    }
    deployment = nextDeployment;
  });
});
