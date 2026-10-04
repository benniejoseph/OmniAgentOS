import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'content_search_contracts.dart';
import 'content_search_repository.dart';

String contentSearchError(Object error) =>
    error is ApiException && {401, 403}.contains(error.statusCode)
    ? 'Search access could not be authorized. Check your account and try again.'
    : error is ApiException && error.statusCode == 409
    ? 'These live results changed. Restart this source to continue.'
    : error is FormatException
    ? 'Search returned an incomplete response. Retry the live read.'
    : 'Search could not connect. Retry when the connection is available.';

class ContentSearchLane {
  ContentSearchLane(this.group);
  ContentSearchGroup group;
  bool loading = false, restartRequired = false;
  String? error;
  final Set<String> cursors = {};
  bool get atLimit => group.items.length >= 100;
}

/// Private, memory-only projection. Every query and source has its own read fence.
class ContentSearchController extends ChangeNotifier {
  ContentSearchController(this.repository);
  final ContentSearchRepository repository;
  bool _disposed = false, _invalidated = false, _visible = true;
  bool denied = false, loading = false;
  String query = '';
  String? error;
  DateTime? generatedAt;
  int _generation = 0;
  final Map<String, CancelToken> _tokens = {};
  final Map<ContentSearchProvider, ContentSearchLane> groups = {};
  bool get available =>
      !_disposed &&
      !_invalidated &&
      _visible &&
      !denied &&
      repository.current &&
      !_disposed &&
      !_invalidated;
  void _publish() {
    if (!_disposed) notifyListeners();
  }

  CancelToken _begin(String lane) {
    _tokens.remove(lane)?.cancel('A newer search replaced this request.');
    return _tokens[lane] = CancelToken();
  }

  bool _current(String lane, CancelToken token, int generation) =>
      available &&
      generation == _generation &&
      identical(_tokens[lane], token) &&
      !token.isCancelled;
  void _clear() {
    _generation++;
    for (final token in _tokens.values) {
      token.cancel('The search or account changed.');
    }
    _tokens.clear();
    groups.clear();
    generatedAt = null;
    loading = false;
    error = null;
  }

  void invalidate({bool notify = true}) {
    _invalidated = true;
    _clear();
    query = '';
    if (notify) _publish();
  }

  void setVisible(bool value) {
    if (_disposed || _invalidated || _visible == value) return;
    _visible = value;
    if (!value) {
      _clear();
      query = '';
      _publish();
    }
  }

  /// Editing immediately fences the previous query, even before Enter is pressed.
  void edit() {
    if (_disposed || _invalidated) return;
    denied = false;
    _clear();
    query = '';
    _publish();
  }

  bool _denied(Object failure) {
    if (failure is! ApiException || !{401, 403}.contains(failure.statusCode)) {
      return false;
    }
    _clear();
    query = '';
    denied = true;
    error = contentSearchError(failure);
    _publish();
    return true;
  }

  Future<void> submit(String value) async {
    if (_disposed ||
        _invalidated ||
        !_visible ||
        !repository.current ||
        _disposed ||
        _invalidated ||
        !_visible) {
      return;
    }
    final next = contentSearchQuery(value);
    denied = false;
    _clear();
    query = next;
    final token = _begin('all'), generation = _generation;
    loading = true;
    _publish();
    try {
      final response = await repository.search(next, token);
      if (!_current('all', token, generation)) return;
      searchRequire(response.query == next);
      for (final group in response.groups) {
        groups[group.provider] = ContentSearchLane(group);
      }
      generatedAt = response.generatedAt;
    } catch (failure) {
      if (!_current('all', token, generation) || _denied(failure)) return;
      error = contentSearchError(failure);
    } finally {
      if (_current('all', token, generation)) {
        loading = false;
        _publish();
      }
    }
  }

  Future<void> loadProvider(
    ContentSearchProvider provider, {
    bool restart = false,
  }) async {
    if (!available || loading || query.isEmpty) return;
    final lane = groups[provider];
    if (lane == null ||
        lane.loading ||
        (!restart && (lane.restartRequired || lane.atLimit))) {
      return;
    }
    final cursor = restart ? null : lane.group.nextCursor;
    if (!restart && cursor == null && lane.group.ready) return;
    final token = _begin(provider.name),
        generation = _generation,
        submitted = query;
    lane.loading = true;
    lane.error = null;
    if (restart) {
      lane.cursors.clear();
      lane.restartRequired = false;
      lane.group = ContentSearchGroup(
        provider: provider,
        coverage: lane.group.coverage,
        ready: false,
        items: const [],
      );
    }
    _publish();
    try {
      final response = await repository.search(
        submitted,
        token,
        provider: provider,
        cursor: cursor,
      );
      if (!_current(provider.name, token, generation)) return;
      searchRequire(
        response.query == submitted &&
            response.groups.length == 1 &&
            response.groups.single.provider == provider,
      );
      final next = response.groups.single;
      if (!next.ready) {
        lane.error = 'This source is unavailable. Retry its live read.';
        if (cursor == null) lane.group = next;
        return;
      }
      searchRequire(
        next.nextCursor == null ||
            next.nextCursor != cursor &&
                !lane.cursors.contains(next.nextCursor),
      );
      final items = {
        if (cursor != null)
          for (final item in lane.group.items) item.id: item,
        for (final item in next.items) item.id: item,
      };
      lane.group = ContentSearchGroup(
        provider: provider,
        coverage: next.coverage,
        ready: true,
        items: List.unmodifiable(items.values.take(100)),
        nextCursor: next.nextCursor,
        message: next.message,
      );
      if (cursor != null) lane.cursors.add(cursor);
      generatedAt = response.generatedAt;
    } catch (failure) {
      if (!_current(provider.name, token, generation) || _denied(failure)) {
        return;
      }
      lane.error = contentSearchError(failure);
      lane.restartRequired =
          failure is FormatException ||
          failure is ApiException && failure.statusCode == 409;
    } finally {
      if (_current(provider.name, token, generation)) {
        lane.loading = false;
        _publish();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _clear();
    query = '';
    super.dispose();
  }
}
