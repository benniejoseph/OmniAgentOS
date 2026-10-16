import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'watch_models.dart';
import 'watch_repository.dart';

class WatchController extends ChangeNotifier {
  WatchController(this.repository);
  final WatchRepository repository;
  List<AvailabilityWatch> watches = [];
  AvailabilityWatch? selected;
  List<WatchJson> checks = [];
  WatchJson? readiness;
  bool loading = false, busy = false, loaded = false, hasMore = false;
  String? error;
  String? focusId;
  int _generation = 0;
  bool _closed = false;
  bool get current => !_closed && repository.current;
  Future<void> load([String? id]) async {
    if (!current || loading) return;
    focusId = id;
    loading = true;
    error = null;
    final generation = ++_generation;
    notifyListeners();
    try {
      if (id == null) {
        final result = await repository.list();
        if (!current || generation != _generation) return;
        watches = result.watches;
        hasMore = result.hasMore;
      } else {
        final result = await repository.get(id);
        if (!current || generation != _generation) return;
        selected = result.watch;
        checks = result.checks;
        hasMore = result.hasMore;
        readiness = null;
        final currentReadiness = await repository.readiness(id);
        if (!current || generation != _generation) return;
        readiness = currentReadiness;
      }
      loaded = true;
    } catch (value) {
      if (current && generation == _generation) error = _message(value);
    } finally {
      if (current && generation == _generation) {
        loading = false;
        notifyListeners();
      }
    }
  }

  Future<AvailabilityWatch?> mutate(
    Future<AvailabilityWatch> Function() action,
  ) async {
    if (!current || busy) return null;
    busy = true;
    error = null;
    notifyListeners();
    try {
      final result = await action();
      if (!current) return null;
      selected = result;
      return result;
    } catch (value) {
      if (current) error = _message(value);
      return null;
    } finally {
      if (current) {
        busy = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _closed = true;
    _generation++;
    repository.dispose();
    super.dispose();
  }

  String _message(Object value) => value is ApiException
      ? value.message
      : value is FormatException
      ? value.message
      : 'Watches could not be loaded. Retry when online.';
}
