import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'meetings.dart';
import 'meetings_api_repository.dart';
import 'meetings_commitments.dart';
import 'meetings_snapshots.dart';

bool _revoked(Object value) =>
    value is ApiException && const [401, 403].contains(value.statusCode);

class MeetingsController extends ChangeNotifier {
  MeetingsController(this.repository, {this._active = true}) {
    _live?.access.addListener(_accessChanged);
  }
  final MeetingsRepository repository;
  LiveMeetingsRepository? get _live => repository is LiveMeetingsRepository
      ? repository as LiveMeetingsRepository
      : null;
  List<Meeting> meetings = const [];
  MeetingContext? context;
  Object? error;
  bool loading = false, hasLoaded = false;
  DateTime? refreshedAt;
  bool _disposed = false, _active;
  int _request = 0;
  CancelToken? _cancel;
  bool get readable => !_disposed && (_live?.authorityCurrent() ?? true);
  bool get showingStaleData =>
      error != null && (hasLoaded || meetings.isNotEmpty);
  bool get atBound => meetings.length == 100;
  void _accessChanged() {
    _request++;
    _cancel?.cancel('Meeting scope changed.');
    meetings = const [];
    context = null;
    error = null;
    loading = false;
    hasLoaded = false;
    refreshedAt = null;
    if (!_disposed) {
      notifyListeners();
      if (_active && readable) {
        unawaited(refresh());
      }
    }
  }

  void setActive(bool value) {
    if (_disposed || _active == value) {
      return;
    }
    _active = value;
    if (!value) {
      _request++;
      _cancel?.cancel('Meetings are not visible.');
      loading = false;
      notifyListeners();
    } else if (readable) {
      unawaited(refresh());
    }
  }

  Future<void> refresh() async {
    if (_disposed || !_active || !readable) {
      return;
    }
    final request = ++_request;
    _cancel?.cancel('A newer Meeting read started.');
    final cancel = _cancel = CancelToken();
    loading = true;
    notifyListeners();
    bool current() =>
        !_disposed &&
        _active &&
        readable &&
        request == _request &&
        !cancel.isCancelled;
    try {
      final live = _live;
      if (live != null) {
        final snapshot = await live.listSnapshot(cancel);
        if (!current()) {
          return;
        }
        meetings = snapshot.meetings;
        context = snapshot.context;
      } else {
        final rows = await repository.list();
        if (!current()) {
          return;
        }
        meetings = List.unmodifiable(rows);
      }
      hasLoaded = true;
      error = null;
      refreshedAt = DateTime.now().toUtc();
    } catch (value) {
      if (!current()) {
        return;
      }
      error = value;
      if (_revoked(value)) {
        meetings = const [];
        context = null;
        hasLoaded = false;
        refreshedAt = null;
      }
    } finally {
      if (current()) {
        loading = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _request++;
    _cancel?.cancel('Meetings disposed.');
    _live?.access.removeListener(_accessChanged);
    super.dispose();
  }
}

class MeetingDetailController extends ChangeNotifier {
  MeetingDetailController(
    this.repository, {
    required this._id,
    this._workspaceId,
    this._active = true,
    this.pollInterval = const Duration(seconds: 10),
  }) {
    _live?.access.addListener(_accessChanged);
  }
  final MeetingsRepository repository;
  final Duration pollInterval;
  LiveMeetingsRepository? get _live => repository is LiveMeetingsRepository
      ? repository as LiveMeetingsRepository
      : null;
  String _id;
  String? _workspaceId;
  String get id => _id;
  String? get workspaceId => _workspaceId;
  MeetingDetailSnapshot? detail;
  MeetingCommitmentsSnapshot? commitments;
  Object? detailError, commitmentsError;
  bool detailLoading = false, commitmentsLoading = false;
  DateTime? detailReadAt, commitmentsReadAt;
  bool _disposed = false, _active;
  int _epoch = 0, _detailRequest = 0, _commitmentsRequest = 0;
  CancelToken? _detailCancel, _commitmentsCancel;
  Timer? _poll;
  bool get readable => !_disposed && (_live?.authorityCurrent() ?? true);
  bool get commitmentsAvailable => _live?.access.commitmentsAvailable ?? false;
  bool get currentCommitments =>
      detail != null &&
      commitments != null &&
      detailError == null &&
      commitmentsError == null &&
      commitments!.matches(detail!.meeting);
  bool get sourcePending => detail?.processing ?? false;
  void _cancelReads() {
    _epoch++;
    _detailRequest++;
    _commitmentsRequest++;
    _detailCancel?.cancel('Meeting selection or access changed.');
    _commitmentsCancel?.cancel('Meeting selection or access changed.');
    _poll?.cancel();
    _poll = null;
    detailLoading = false;
    commitmentsLoading = false;
  }

  void _clear() {
    detail = null;
    commitments = null;
    detailError = null;
    commitmentsError = null;
    detailReadAt = null;
    commitmentsReadAt = null;
  }

  void _accessChanged() {
    _cancelReads();
    _clear();
    if (!_disposed) {
      notifyListeners();
      if (_active && readable) {
        unawaited(refresh());
      }
    }
  }

  void select(String id, {String? workspaceId}) {
    if (_disposed || id == _id && workspaceId == _workspaceId) {
      return;
    }
    _cancelReads();
    _clear();
    _id = id;
    _workspaceId = workspaceId;
    notifyListeners();
    if (_active && readable) {
      unawaited(refresh());
    }
  }

  void setActive(bool active) {
    if (_disposed || _active == active) {
      return;
    }
    _active = active;
    if (!active) {
      _cancelReads();
      notifyListeners();
    } else if (readable) {
      unawaited(refresh());
    }
  }

  Future<void> refresh() async {
    if (!readable || !_active) {
      return;
    }
    await Future.wait([
      refreshDetail(),
      if (commitmentsAvailable) refreshCommitments(),
    ]);
  }

  Future<void> refreshDetail() async {
    if (!readable || !_active) {
      return;
    }
    final epoch = _epoch,
        request = ++_detailRequest,
        selected = _id,
        workspace = _workspaceId;
    _detailCancel?.cancel('A newer Meeting detail read started.');
    final cancel = _detailCancel = CancelToken();
    _poll?.cancel();
    _poll = null;
    detailLoading = true;
    notifyListeners();
    bool current() =>
        !_disposed &&
        _active &&
        readable &&
        epoch == _epoch &&
        request == _detailRequest &&
        selected == _id &&
        workspace == _workspaceId &&
        !cancel.isCancelled;
    try {
      final live = _live;
      final value = live != null
          ? await live.detailSnapshot(selected, cancel, workspaceId: workspace)
          : MeetingDetailSnapshot(
              await repository.detail(selected),
              null,
              const [],
            );
      if (!current()) {
        return;
      }
      if (value.meeting.id != selected) {
        throw const FormatException('The selected Meeting identity changed.');
      }
      detail = value;
      detailError = null;
      detailReadAt = DateTime.now().toUtc();
    } catch (value) {
      if (!current()) {
        return;
      }
      detailError = value;
      if (_revoked(value) || value is ApiException && value.statusCode == 404) {
        detail = null;
        commitments = null;
        detailReadAt = null;
        commitmentsReadAt = null;
        _commitmentsRequest++;
        _commitmentsCancel?.cancel('Meeting no longer available.');
        commitmentsLoading = false;
      }
    } finally {
      if (current()) {
        detailLoading = false;
        notifyListeners();
        _schedulePoll();
      }
    }
  }

  Future<void> refreshCommitments() async {
    final live = _live;
    if (!readable || !_active || live == null || !commitmentsAvailable) {
      return;
    }
    final epoch = _epoch,
        request = ++_commitmentsRequest,
        selected = _id,
        workspace = _workspaceId;
    _commitmentsCancel?.cancel('A newer follow-up read started.');
    final cancel = _commitmentsCancel = CancelToken();
    commitmentsLoading = true;
    notifyListeners();
    bool current() =>
        !_disposed &&
        _active &&
        readable &&
        epoch == _epoch &&
        request == _commitmentsRequest &&
        selected == _id &&
        workspace == _workspaceId &&
        !cancel.isCancelled;
    try {
      final value = await live.commitmentsSnapshot(
        selected,
        cancel,
        workspaceId: workspace,
      );
      if (!current()) {
        return;
      }
      commitments = value;
      commitmentsError = null;
      commitmentsReadAt = DateTime.now().toUtc();
    } catch (value) {
      if (!current()) {
        return;
      }
      commitmentsError = value;
      if (_revoked(value) || value is ApiException && value.statusCode == 404) {
        commitments = null;
        commitmentsReadAt = null;
      }
    } finally {
      if (current()) {
        commitmentsLoading = false;
        notifyListeners();
      }
    }
  }

  void _schedulePoll() {
    _poll?.cancel();
    _poll = null;
    if (!_disposed && _active && readable && sourcePending) {
      // Continue unchanged pending states and failed reads. This is a GET only;
      // visibility, route and owner changes cancel it before another request.
      _poll = Timer(pollInterval, () {
        _poll = null;
        unawaited(refreshDetail());
      });
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _cancelReads();
    _live?.access.removeListener(_accessChanged);
    super.dispose();
  }
}
