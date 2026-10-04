import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'library_contracts.dart';
import 'library_repository.dart';

String libraryReadError(Object error) => error is FormatException
    ? 'This response did not match the requested source. Retry the read.'
    : error is ApiException && const [401, 403].contains(error.statusCode)
    ? 'The current account could not authorize this read. Refresh authorized access before continuing.'
    : error is ApiException && error.statusCode == 404
    ? 'This source is no longer available to this account.'
    : error is ApiException && error.statusCode == 409
    ? 'The current source changed. Restart history to read its current version.'
    : 'The live read did not finish. Retry when the connection is available.';

class LibraryController extends ChangeNotifier {
  LibraryController(this.repository);
  final LibraryRepository repository;
  bool _disposed = false, _invalidated = false, _visible = true;
  bool accessDenied = false;
  bool get available =>
      !_disposed &&
      !_invalidated &&
      _visible &&
      !accessDenied &&
      repository.current;
  String query = '';
  String? kind, selectedId, selectedVersionId;
  LibraryPage? page;
  LibraryItem? detail;
  LibraryHistory? historyPage, versionRead;
  String? listError, detailError, historyError, versionError;
  bool listLoading = false,
      detailLoading = false,
      historyLoading = false,
      versionLoading = false;
  bool historyChanged = false;
  final List<int> _offsets = [0];
  final List<String?> _befores = [null];
  bool get hasPrevious => _offsets.length > 1;
  bool get historyHasPrevious => _befores.length > 1;
  final Map<String, CancelToken> _tokens = {};
  CancelToken _begin(String lane) {
    _tokens.remove(lane)?.cancel('A newer read replaced this request.');
    return _tokens[lane] = CancelToken();
  }

  bool _current(String lane, CancelToken token) =>
      available && identical(_tokens[lane], token) && !token.isCancelled;
  void _publish() {
    if (!_disposed) notifyListeners();
  }

  void _cancel(String lane) {
    _tokens.remove(lane)?.cancel('The selection changed.');
  }

  void _clearReads() {
    for (final token in _tokens.values) {
      token.cancel('Library access changed.');
    }
    _tokens.clear();
    page = null;
    detail = null;
    historyPage = null;
    versionRead = null;
    listLoading = detailLoading = historyLoading = versionLoading = false;
    listError = detailError = historyError = versionError = null;
  }

  void invalidate({bool notify = true}) {
    _invalidated = true;
    _clearReads();
    selectedId = selectedVersionId = null;
    if (notify) _publish();
  }

  void setVisible(bool visible) {
    if (_visible == visible || _disposed || _invalidated) return;
    _visible = visible;
    if (!visible) {
      _clearReads();
      _publish();
    } else {
      load();
      if (selectedId != null) select(selectedId!);
    }
  }

  bool _denied(Object error) {
    if (error is ApiException && const [401, 403].contains(error.statusCode)) {
      accessDenied = true;
      _clearReads();
      _publish();
      return true;
    }
    return false;
  }

  Future<void> retryAccess() async {
    if (_disposed || _invalidated || !_visible || !repository.current) return;
    accessDenied = false;
    await load();
    if (available && selectedId != null) await select(selectedId!);
  }

  Future<void> search(String value, String? type) async {
    if (!available) return;
    final next = value.trim();
    libraryRequire(
      next.length <= 240 && (type == null || libraryKinds.contains(type)),
    );
    if (next != query || type != kind) {
      query = next;
      kind = type;
      _offsets
        ..clear()
        ..add(0);
      page = null;
    }
    await load();
  }

  Future<void> load({
    int? offset,
    bool advance = false,
    bool previous = false,
  }) async {
    if (!available) return;
    final token = _begin('list'), target = offset ?? _offsets.last;
    listLoading = true;
    listError = null;
    _publish();
    try {
      final result = await repository.list(
        query: query,
        kind: kind,
        offset: target,
        cancel: token,
      );
      if (!_current('list', token)) return;
      page = result;
      if (advance) _offsets.add(target);
      if (previous) _offsets.removeLast();
    } catch (error) {
      if (!_current('list', token) || _denied(error)) return;
      listError = libraryReadError(error);
    } finally {
      if (_current('list', token)) {
        listLoading = false;
        _publish();
      }
    }
  }

  Future<void> next() async {
    final offset = page?.nextOffset;
    if (offset != null && offset <= 10000 && !listLoading) {
      await load(offset: offset, advance: true);
    }
  }

  Future<void> previous() async {
    if (hasPrevious && !listLoading) {
      await load(offset: _offsets[_offsets.length - 2], previous: true);
    }
  }

  Future<void> select(String id) async {
    if (!available) return;
    libraryRequire(
      RegExp(
            r'^library:(capture_asset|capture_recording|capture_transcript|project_artifact|source_item):.+$',
          ).hasMatch(id) &&
          id.length <= 320,
    );
    if (selectedId != id) {
      selectedId = id;
      detail = null;
      _clearHistory();
    }
    final token = _begin('detail');
    detailLoading = true;
    detailError = null;
    _publish();
    try {
      final result = await repository.item(id, token);
      if (!_current('detail', token) || selectedId != id) return;
      if (detail?.versionId != result.versionId &&
          historyPage != null &&
          historyPage!.head != result.versionId) {
        _clearHistory();
      }
      detail = result;
    } catch (error) {
      if (!_current('detail', token) || _denied(error)) return;
      if (error is ApiException && error.statusCode == 404) {
        detail = null;
        _clearHistory();
      }
      detailError = libraryReadError(error);
    } finally {
      if (_current('detail', token)) {
        detailLoading = false;
        _publish();
      }
    }
  }

  void _clearHistory() {
    _cancel('history');
    _cancel('version');
    historyPage = versionRead = null;
    selectedVersionId = null;
    historyLoading = versionLoading = historyChanged = false;
    historyError = versionError = null;
    _befores
      ..clear()
      ..add(null);
  }

  void clearSelection() {
    _cancel('detail');
    selectedId = null;
    detail = null;
    detailError = null;
    detailLoading = false;
    _clearHistory();
    _publish();
  }

  Future<void> loadHistory({
    bool restart = false,
    String? before,
    bool advance = false,
    bool previous = false,
  }) async {
    final id = selectedId;
    if (!available || id == null || detail == null) return;
    if (restart) _clearHistory();
    final target = restart ? null : before ?? _befores.last;
    final head = target == null ? null : historyPage?.head;
    if (target != null && head == null) return;
    final token = _begin('history');
    historyLoading = true;
    historyError = null;
    _publish();
    try {
      final result = await repository.history(
        id,
        token,
        before: target,
        head: head,
      );
      if (!_current('history', token) || selectedId != id) return;
      historyPage = result;
      historyChanged = false;
      if (advance) _befores.add(target);
      if (previous) _befores.removeLast();
      _cancel('version');
      versionLoading = false;
      versionRead = null;
      versionError = null;
      selectedVersionId = null;
    } catch (error) {
      if (!_current('history', token) || _denied(error)) return;
      if (error is ApiException && error.statusCode == 404) {
        historyPage = versionRead = null;
      }
      if (error is ApiException && error.statusCode == 409) {
        historyChanged = true;
        _cancel('version');
        versionLoading = false;
      }
      historyError = libraryReadError(error);
    } finally {
      if (_current('history', token)) {
        historyLoading = false;
        _publish();
      }
    }
  }

  Future<void> nextHistory() async {
    final next = historyPage?.nextBefore;
    if (next != null && !historyLoading && !historyChanged) {
      await loadHistory(before: next, advance: true);
    }
  }

  Future<void> previousHistory() async {
    if (!historyHasPrevious || historyLoading || historyChanged) return;
    final before = _befores[_befores.length - 2];
    if (before == null) {
      await loadHistory(restart: true);
    } else {
      await loadHistory(before: before, previous: true);
    }
  }

  Future<void> selectVersion(String id) async {
    final itemId = selectedId, head = historyPage?.head;
    if (!available || itemId == null || head == null || historyChanged) return;
    selectedVersionId = id;
    versionRead = null;
    versionError = null;
    final token = _begin('version');
    versionLoading = true;
    _publish();
    try {
      final result = await repository.version(itemId, id, head, token);
      if (!_current('version', token) ||
          historyChanged ||
          selectedId != itemId ||
          selectedVersionId != id ||
          historyPage?.head != head) {
        return;
      }
      versionRead = result;
    } catch (error) {
      if (!_current('version', token) || _denied(error)) return;
      if (error is ApiException && error.statusCode == 409) {
        historyChanged = true;
      }
      versionError = libraryReadError(error);
    } finally {
      if (_current('version', token)) {
        versionLoading = false;
        _publish();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _clearReads();
    super.dispose();
  }
}
