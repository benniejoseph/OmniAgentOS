import 'package:dio/dio.dart';

import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import '../knowledge/knowledge.dart' show MemoryRecord;
import '../projects/projects.dart' show Project;
import 'content_search_contracts.dart';

abstract interface class ContentSearchRepository {
  bool get current;
  Future<ContentSearchResponse> search(
    String query,
    CancelToken cancel, {
    ContentSearchProvider? provider,
    String? cursor,
  });
}

class ApiContentSearchRepository implements ContentSearchRepository {
  ApiContentSearchRepository(this.access);
  final NativeWorkspaceAccess access;
  bool _disposed = false;
  final Set<CancelToken> _reads = {};
  final Set<void Function()> _invalidationListeners = {};
  @override
  bool get current => !_disposed && access.current && !_disposed;

  void Function() observeInvalidation(void Function() listener) {
    if (_disposed) {
      listener();
      return () {};
    }
    _invalidationListeners.add(listener);
    return () => _invalidationListeners.remove(listener);
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    for (final listener in _invalidationListeners.toList(growable: false)) {
      listener();
    }
    _invalidationListeners.clear();
    for (final token in _reads) {
      token.cancel('Search access changed.');
    }
    _reads.clear();
  }

  Future<SearchJson> _read(
    String operation,
    String path,
    CancelToken cancel,
  ) async {
    if (!current || cancel.isCancelled) {
      throw StateError('Search access changed.');
    }
    if (!NativeContract.supportsOperation(operation)) {
      throw StateError('Search is unavailable in this app version.');
    }
    _reads.add(cancel);
    try {
      final response = await access.api.getJsonAuthorized(
        path,
        authority: access.authority,
        cancelToken: cancel,
      );
      if (!current || cancel.isCancelled) {
        throw StateError('Search access changed.');
      }
      return response;
    } finally {
      _reads.remove(cancel);
    }
  }

  @override
  Future<ContentSearchResponse> search(
    String query,
    CancelToken cancel, {
    ContentSearchProvider? provider,
    String? cursor,
  }) async {
    searchRequire(
      contentSearchQuery(query) == query &&
          (cursor == null ||
              provider != null && cursor.isNotEmpty && cursor.length <= 1800),
    );
    final path = NativePaths.contentSearch(
      q: query,
      limit: 8,
      provider: provider?.name,
      cursor: cursor,
    );
    return ContentSearchResponse.parse(
      await _read('content.search', path, cancel),
      query: query,
      provider: provider,
    );
  }

  Future<Project> work(String id, String? taskId, CancelToken cancel) async {
    searchRequire(
      ContentSearchTarget.validId(id) &&
          (taskId == null || ContentSearchTarget.validId(taskId)),
    );
    final path = NativePaths.contentSearchWorkGet(id, task: taskId);
    final response = searchObject(
      await _read('content.search.work.get', path, cancel),
      {'project'},
    );
    searchRequire(response['project'] is SearchJson);
    final project = Project.fromJson(
      response['project'] as SearchJson,
      requireCollections: true,
    );
    searchRequire(
      project.id == id &&
          project.tenantId == access.authority.tenantId &&
          project.status != 'archived' &&
          project.tasks.length <= (taskId == null ? 200 : 201) &&
          project.artifacts.length <= 200 &&
          (taskId == null ||
              project.tasks.isNotEmpty && project.tasks.first.id == taskId),
    );
    return project;
  }

  Future<MemoryRecord> memory(String id, CancelToken cancel) async {
    searchRequire(ContentSearchTarget.validId(id, maximum: 240));
    final response = searchObject(
      await _read(
        'content.search.memory.get',
        NativePaths.contentSearchMemoryGet(id),
        cancel,
      ),
      {'memory'},
    );
    final raw = response['memory'];
    searchRequire(raw is SearchJson);
    final row = raw as SearchJson;
    searchRequire(
      row['id'] == id &&
          row['tenantId'] == access.authority.tenantId &&
          row['content'] is String &&
          row['title'] is String &&
          row['access'] is SearchJson &&
          row['explainability'] is SearchJson,
    );
    for (final field in ['importance', 'confidence']) {
      final value = row[field];
      searchRequire(value is num && value.isFinite && value >= 0 && value <= 1);
    }
    final memory = MemoryRecord.fromJson(row);
    searchRequire(
      memory.metadata.visibility == 'user_private' &&
          memory.claimStatus == 'active' &&
          memory.metadata.archived != true &&
          memory.tier != 'working',
    );
    return memory;
  }
}
