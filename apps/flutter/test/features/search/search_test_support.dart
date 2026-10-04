import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/search/content_search_contracts.dart';
import 'package:asael/features/search/content_search_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const searchTime = '2026-10-05T10:00:00.000Z';
const searchThread = '11111111-1111-4111-8111-111111111111';
SearchJson searchItemJson(
  ContentSearchProvider provider, {
  String id = 'one',
}) => {
  'id': provider == ContentSearchProvider.conversations
      ? searchThread
      : provider == ContentSearchProvider.library
      ? 'library:capture_asset:$id'
      : id,
  'title': 'Result $id',
  'detail': provider.label,
  'updatedAt': searchTime,
  'href': switch (provider) {
    ContentSearchProvider.conversations => '/app/command?thread=$searchThread',
    ContentSearchProvider.work =>
      '/app/projects?project=${Uri.encodeQueryComponent('project:$id')}&task=${Uri.encodeQueryComponent('task:$id')}&fromSearch=1',
    ContentSearchProvider.memory =>
      '/app/memory?memory=${Uri.encodeQueryComponent(id)}',
    ContentSearchProvider.library =>
      '/app/capture?libraryItem=${Uri.encodeQueryComponent('library:capture_asset:$id')}',
  },
};
SearchJson searchGroupJson(
  ContentSearchProvider provider, {
  bool ready = true,
  String? cursor,
  List<SearchJson>? items,
}) => {
  'provider': provider.name,
  'label': provider.label,
  'coverage': 'Current ${provider.label.toLowerCase()} only.',
  'status': ready ? 'ready' : 'unavailable',
  'items': ready ? items ?? [searchItemJson(provider)] : <SearchJson>[],
  'nextCursor': ready ? cursor : null,
  'message': ready ? null : 'Source unavailable.',
};
SearchJson searchResponseJson({
  String query = 'topic',
  ContentSearchProvider? provider,
  String? cursor,
  List<SearchJson>? items,
  bool ready = true,
}) => {
  'query': query,
  'generatedAt': searchTime,
  'consistency': 'live',
  'groups': [
    for (final value
        in provider == null ? ContentSearchProvider.values : [provider])
      searchGroupJson(value, cursor: cursor, items: items, ready: ready),
  ],
};
ContentSearchResponse searchResponse({
  String query = 'topic',
  ContentSearchProvider? provider,
  String? cursor,
  List<SearchJson>? items,
  bool ready = true,
}) => ContentSearchResponse.parse(
  searchResponseJson(
    query: query,
    provider: provider,
    cursor: cursor,
    items: items,
    ready: ready,
  ),
  query: query,
  provider: provider,
);

class SearchRequest {
  SearchRequest(this.query, this.cancel, this.provider, this.cursor);
  final String query;
  final CancelToken cancel;
  final ContentSearchProvider? provider;
  final String? cursor;
  final Completer<ContentSearchResponse> result = Completer();
}

class SearchTestRepository implements ContentSearchRepository {
  bool enabled = true;
  void Function()? probe;
  final List<SearchRequest> requests = [];
  @override
  bool get current {
    probe?.call();
    return enabled;
  }

  @override
  Future<ContentSearchResponse> search(
    String query,
    CancelToken cancel, {
    ContentSearchProvider? provider,
    String? cursor,
  }) {
    final request = SearchRequest(query, cancel, provider, cursor);
    requests.add(request);
    return request.result.future;
  }
}

class SearchTestApi extends ApiClient {
  SearchTestApi()
    : super(
        Dio(BaseOptions(baseUrl: 'https://workspace.example.test')),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  final List<String> paths = [];
  final List<CancelToken> tokens = [];
  final List<NativeRequestAuthority> authorities = [];
  Future<SearchJson> Function(String)? reader;
  @override
  Future<SearchJson> getJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Map<String, dynamic>? query,
    CancelToken? cancelToken,
  }) {
    paths.add(path);
    authorities.add(authority);
    tokens.add(cancelToken!);
    return reader!(path);
  }
}

NativeWorkspaceAccess searchAccess(
  SearchTestApi api, {
  bool Function()? current,
}) => NativeWorkspaceAccess(
  api,
  NativeRequestAuthority(
    tenantId: 'tenant-one',
    actorId: 'actor-one',
    canonicalUserId: searchThread,
    role: 'admin',
    apiBaseUrl: api.apiBaseUrl,
    isCurrent: current ?? () => true,
  ),
  true,
);
