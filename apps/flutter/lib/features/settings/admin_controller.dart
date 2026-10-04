import 'package:flutter/foundation.dart';

import 'admin_models.dart';
import 'admin_repository.dart';

class AdminController extends ChangeNotifier {
  AdminController(this._repository, this.module);
  final AdminRepository _repository;
  final AdminModule module;
  AdminSnapshot? snapshot;
  Object? error;
  bool loading = false;
  String? runningAction;
  String? notice;
  bool _disposed = false;
  Future<void>? _refreshInFlight;

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    snapshot = null;
    super.dispose();
  }

  Future<void> refresh() {
    if (_disposed) return Future.value();
    final current = _refreshInFlight;
    if (current != null) return current;
    final next = _refresh();
    _refreshInFlight = next;
    return next.whenComplete(() {
      if (identical(_refreshInFlight, next)) _refreshInFlight = null;
    });
  }

  Future<void> _refresh() async {
    loading = true;
    error = null;
    _changed();
    try {
      final result = await _repository.load(module);
      if (_disposed) return;
      snapshot = result;
    } catch (value) {
      if (!_disposed) error = value;
    } finally {
      loading = false;
      _changed();
    }
  }

  Future<void> run(AdminAction action) async {
    if (_disposed ||
        runningAction != null ||
        !module.actions.contains(action)) {
      return;
    }
    runningAction = action.path;
    notice = null;
    _changed();
    try {
      await _repository.run(action);
      if (_disposed) return;
      notice = '${action.label} completed.';
      await refresh();
    } catch (value) {
      if (!_disposed) notice = 'The action could not be confirmed. Refresh its current state before another submission.';
    } finally {
      runningAction = null;
      _changed();
    }
  }
}
