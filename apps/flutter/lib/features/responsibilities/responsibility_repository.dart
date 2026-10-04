import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'responsibility_contracts.dart';

class ResponsibilityAccess extends ChangeNotifier {
  ResponsibilityAccess({this.owner, this.ready = false});
  ResponsibilityOwner? owner;
  bool ready, closed = false;
  int generation = 0;
  final Set<VoidCallback> _silentCloseListeners = {};
  void addSilentCloseListener(VoidCallback listener) =>
      _silentCloseListeners.add(listener);
  void removeSilentCloseListener(VoidCallback listener) =>
      _silentCloseListeners.remove(listener);
  bool get readable => !closed && ready && owner != null;
  bool get writable => readable && owner!.canManage;
  void update(ResponsibilityOwner? next, {required bool available}) {
    if (closed || owner?.key == next?.key && ready == available) return;
    owner = next;
    ready = available;
    generation++;
    notifyListeners();
  }

  void close({bool notify = true}) {
    if (closed) return;
    closed = true;
    ready = false;
    generation++;
    if (notify) {
      notifyListeners();
    } else {
      for (final listener in _silentCloseListeners.toList()) {
        listener();
      }
    }
  }

  @override
  void dispose() {
    _silentCloseListeners.clear();
    super.dispose();
  }
}

abstract interface class ResponsibilityRepository {
  ResponsibilityAccess get access;
  bool authorityCurrent();
  bool supportsMutation(ResponsibilityLane lane);
  Future<ResponsibilityJson> read(
    ResponsibilityRead kind,
    CancelToken cancel, {
    String? id,
    bool preview = false,
  });
  Future<ResponsibilityJson> mutate(
    ResponsibilityLane lane,
    ResponsibilityJson input,
    String key, {
    String? id,
    bool Function()? isCurrent,
  });
}

class ApiResponsibilityRepository implements ResponsibilityRepository {
  ApiResponsibilityRepository(
    this.api, {
    required this.access,
    required bool Function() authorityProbe,
  }) : _probe = authorityProbe {
    access.addListener(_changed);
  }
  final ApiClient api;
  @override
  final ResponsibilityAccess access;
  final bool Function() _probe;
  final Set<CancelToken> _reads = {};
  bool _disposed = false;
  @override
  bool authorityCurrent() =>
      !_disposed &&
      access.readable &&
      _probe() &&
      !_disposed &&
      access.readable;
  @override
  bool supportsMutation(ResponsibilityLane lane) =>
      NativeContract.supportsOperation(switch (lane) {
        ResponsibilityLane.draft => 'responsibilities.change',
        ResponsibilityLane.runtime => 'responsibilities.lifecycle.change',
        ResponsibilityLane.notifications =>
          'responsibilities.notifications.change',
      }) &&
      (lane != ResponsibilityLane.draft ||
          NativeContract.supportsOperation('responsibilities.create'));
  void _require({ResponsibilityLane? lane}) {
    responsibilityRequire(
      authorityCurrent() &&
          (lane == null || access.writable && supportsMutation(lane)),
      'Current Responsibility access is required. Reload after unlocking or changing accounts.',
    );
  }

  void _changed() {
    for (final token in _reads.toList()) {
      token.cancel('Responsibility account changed.');
    }
  }

  @override
  Future<ResponsibilityJson> read(
    ResponsibilityRead kind,
    CancelToken cancel, {
    String? id,
    bool preview = false,
  }) async {
    _require();
    if (id != null) responsibilityId(id);
    responsibilityRequire(!preview || access.writable);
    final operation = switch (kind) {
      ResponsibilityRead.list => 'responsibilities.list',
      ResponsibilityRead.detail => 'responsibilities.get',
      ResponsibilityRead.references => 'responsibilities.references',
      ResponsibilityRead.runtime => 'responsibilities.lifecycle.get',
      ResponsibilityRead.observations => 'responsibilities.observations.list',
      ResponsibilityRead.notifications => 'responsibilities.notifications.get',
    };
    responsibilityRequire(
      NativeContract.supportsOperation(operation),
      'This app does not support the current Responsibility operation.',
    );
    final path = switch (kind) {
      ResponsibilityRead.list => NativePaths.responsibilitiesList(limit: 40),
      ResponsibilityRead.detail => NativePaths.responsibilitiesGet(
        id!,
        view: preview ? 'review' : null,
      ),
      ResponsibilityRead.references => NativePaths.responsibilitiesReferences,
      ResponsibilityRead.runtime => NativePaths.responsibilitiesLifecycleGet(
        id!,
        view: preview ? 'activation' : null,
      ),
      ResponsibilityRead.observations =>
        NativePaths.responsibilitiesObservationsList(id!, limit: 25),
      ResponsibilityRead.notifications =>
        NativePaths.responsibilitiesNotificationsGet(
          id!,
          view: preview ? 'enable' : null,
        ),
    };
    final generation = access.generation, owner = access.owner!;
    _reads.add(cancel);
    try {
      final raw = await api.getJsonFreshCancelable(path, cancelToken: cancel);
      _require();
      responsibilityRequire(
        generation == access.generation && !cancel.isCancelled,
      );
      final value = await ResponsibilityVerifier(owner).read(
        raw,
        kind,
        id: id,
        preview: preview,
        limit: kind == ResponsibilityRead.observations ? 25 : 40,
      );
      _require();
      responsibilityRequire(
        generation == access.generation && !cancel.isCancelled,
      );
      return value;
    } finally {
      _reads.remove(cancel);
    }
  }

  @override
  Future<ResponsibilityJson> mutate(
    ResponsibilityLane lane,
    ResponsibilityJson input,
    String key, {
    String? id,
    bool Function()? isCurrent,
  }) async {
    _require(lane: lane);
    validateResponsibilityMutation(lane, input);
    responsibilityRequire(
      isCurrent?.call() ?? true,
      'The originating Responsibility view changed.',
    );
    responsibilityRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    responsibilityRequire(
      (lane == ResponsibilityLane.draft && input['action'] == 'create') ==
          (id == null),
    );
    if (id != null) responsibilityId(id);
    final generation = access.generation,
        owner = access.owner!,
        submitted = freezeResponsibility(input) as ResponsibilityJson;
    final authority = NativeRequestAuthority(
      tenantId: owner.tenantId,
      actorId: owner.requestActorId,
      canonicalUserId: owner.userId,
      role: owner.role,
      apiBaseUrl: owner.apiBaseUrl,
      isCurrent: () =>
          authorityCurrent() &&
          access.writable &&
          access.generation == generation &&
          access.owner?.key == owner.key &&
          (isCurrent?.call() ?? true),
    );
    final headers = <String, dynamic>{'idempotency-key': key};
    final raw = lane == ResponsibilityLane.draft && id != null
        ? await api.patchJsonAuthorized(
            NativePaths.responsibilitiesChange(id),
            authority: authority,
            data: submitted,
            headers: headers,
          )
        : await api.postJsonAuthorized(
            switch (lane) {
              ResponsibilityLane.draft => NativePaths.responsibilitiesCreate,
              ResponsibilityLane.runtime =>
                NativePaths.responsibilitiesLifecycleChange(id!),
              ResponsibilityLane.notifications =>
                NativePaths.responsibilitiesNotificationsChange(id!),
            },
            authority: authority,
            data: submitted,
            headers: headers,
          );
    _require(lane: lane);
    responsibilityRequire(
      generation == access.generation && (isCurrent?.call() ?? true),
      'The account or originating view changed after submission. Its outcome is unconfirmed.',
    );
    final result = await ResponsibilityVerifier(owner)
        .mutation(raw, lane, submitted, key, id);
    _require(lane: lane);
    responsibilityRequire(
      generation == access.generation && (isCurrent?.call() ?? true),
    );
    return result;
  }

  void dispose() {
    _disposed = true;
    _changed();
    access.removeListener(_changed);
  }
}
