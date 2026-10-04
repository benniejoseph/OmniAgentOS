import 'content_search_targets.dart';
export 'content_search_targets.dart';

typedef SearchJson = Map<String, dynamic>;

void searchRequire(bool valid) {
  if (!valid) {
    throw const FormatException('Search returned an invalid response.');
  }
}

SearchJson searchObject(Object? value, Set<String> keys) {
  searchRequire(value is Map<String, dynamic>);
  final row = value as SearchJson;
  searchRequire(row.length == keys.length && row.keys.every(keys.contains));
  return row;
}

String searchText(Object? value, int maximum, {bool empty = false}) {
  searchRequire(
    value is String && value.length <= maximum && (empty || value.isNotEmpty),
  );
  return value as String;
}

String contentSearchQuery(String value) {
  final query = value.trim();
  if (query.length < 2 ||
      query.length > 240 ||
      !RegExp(r'[\p{L}\p{N}]', unicode: true).hasMatch(query)) {
    throw const FormatException(
      'Enter 2–240 characters, including a word or number.',
    );
  }
  return query;
}

DateTime searchInstant(Object? value) {
  final text = searchText(value, 64);
  final date = DateTime.tryParse(text);
  searchRequire(date != null && RegExp(r'T.*Z$').hasMatch(text));
  return date!.toUtc();
}

class ContentSearchItem {
  const ContentSearchItem({
    required this.id,
    required this.title,
    required this.detail,
    required this.updatedAt,
    required this.target,
  });
  final String id, title, detail;
  final DateTime updatedAt;
  final ContentSearchTarget target;
  factory ContentSearchItem.parse(
    Object? value,
    ContentSearchProvider provider,
  ) {
    final row = searchObject(value, {
      'id',
      'title',
      'detail',
      'updatedAt',
      'href',
    });
    final target = ContentSearchTarget.parse(searchText(row['href'], 1600));
    searchRequire(target.provider == provider);
    searchRequire(
      provider == ContentSearchProvider.work || target.id == row['id'],
    );
    return ContentSearchItem(
      id: searchText(row['id'], 360),
      title: searchText(row['title'], 300),
      detail: searchText(row['detail'], 300, empty: true),
      updatedAt: searchInstant(row['updatedAt']),
      target: target,
    );
  }
}

class ContentSearchGroup {
  const ContentSearchGroup({
    required this.provider,
    required this.coverage,
    required this.ready,
    required this.items,
    this.nextCursor,
    this.message,
  });
  final ContentSearchProvider provider;
  final String coverage;
  final bool ready;
  final List<ContentSearchItem> items;
  final String? nextCursor, message;
  factory ContentSearchGroup.parse(Object? value) {
    final row = searchObject(value, {
      'provider',
      'label',
      'coverage',
      'status',
      'items',
      'nextCursor',
      'message',
    });
    final provider = ContentSearchProvider.values
        .where((value) => value.name == row['provider'])
        .firstOrNull;
    searchRequire(
      provider != null && {'ready', 'unavailable'}.contains(row['status']),
    );
    searchText(row['label'], 100);
    final values = row['items'];
    searchRequire(values is List && values.length <= 20);
    final items = (values as List)
        .map((value) => ContentSearchItem.parse(value, provider!))
        .toList(growable: false);
    searchRequire(
      items.map((value) => value.id).toSet().length == items.length,
    );
    final cursor = row['nextCursor'] == null
        ? null
        : searchText(row['nextCursor'], 1800);
    searchRequire(
      row['status'] == 'ready' || (items.isEmpty && cursor == null),
    );
    return ContentSearchGroup(
      provider: provider!,
      coverage: searchText(row['coverage'], 1000),
      ready: row['status'] == 'ready',
      items: List.unmodifiable(items),
      nextCursor: cursor,
      message: row['message'] == null
          ? null
          : searchText(row['message'], 300, empty: true),
    );
  }
}

class ContentSearchResponse {
  const ContentSearchResponse(this.query, this.generatedAt, this.groups);
  final String query;
  final DateTime generatedAt;
  final List<ContentSearchGroup> groups;
  factory ContentSearchResponse.parse(
    Object? value, {
    required String query,
    ContentSearchProvider? provider,
  }) {
    final row = searchObject(value, {
      'query',
      'generatedAt',
      'groups',
      'consistency',
    });
    searchRequire(row['query'] == query && row['consistency'] == 'live');
    final values = row['groups'];
    searchRequire(values is List && values.isNotEmpty && values.length <= 4);
    final groups = (values as List)
        .map(ContentSearchGroup.parse)
        .toList(growable: false);
    final found = groups.map((value) => value.provider).toSet();
    searchRequire(
      found.length == groups.length &&
          (provider == null
              ? found.length == ContentSearchProvider.values.length
              : groups.length == 1 && found.single == provider),
    );
    return ContentSearchResponse(
      query,
      searchInstant(row['generatedAt']),
      List.unmodifiable(groups),
    );
  }
}
