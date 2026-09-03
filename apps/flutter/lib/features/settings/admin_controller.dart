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

  Future<void> refresh() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      snapshot = await _repository.load(module);
    } catch (value) {
      error = value;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> run(AdminAction action) async {
    runningAction = action.path;
    notice = null;
    notifyListeners();
    try {
      await _repository.run(action);
      notice = '${action.label} completed.';
      await refresh();
    } catch (value) {
      notice = value.toString();
    } finally {
      runningAction = null;
      notifyListeners();
    }
  }
}
