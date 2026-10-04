/// Compact read contracts for the published native memory catalogue. Index
/// metadata is never promoted to an exact record or an execution permission.
typedef KnowledgeJson = Map<String, dynamic>;

Object? freezeKnowledgeJson(Object? value) {
  if (value is Map) {
    return Map<String, dynamic>.unmodifiable(
      value.map(
        (key, child) => MapEntry(key.toString(), freezeKnowledgeJson(child)),
      ),
    );
  }
  if (value is List) {
    return List<Object?>.unmodifiable(value.map(freezeKnowledgeJson));
  }
  return value;
}

KnowledgeJson knowledgeMap(Object? value, String label) {
  if (value is! Map || value.keys.any((key) => key is! String)) {
    throw FormatException('$label is unavailable or malformed.');
  }
  return Map<String, dynamic>.from(value);
}

String knowledgeIdentity(Object? value, String label, {int maximum = 500}) {
  if (value is! String ||
      value.isEmpty ||
      value.trim() != value ||
      value.length > maximum ||
      RegExp(r'[\x00-\x1f\x7f]').hasMatch(value)) {
    throw FormatException('$label has no valid exact identity.');
  }
  return value;
}

int knowledgeCount(Object? value, String label) {
  if (value is! int || value < 0) {
    throw FormatException('$label is not a known count.');
  }
  return value;
}

class KnowledgeQuery {
  const KnowledgeQuery({
    this.query = '',
    this.category = 'all',
    this.tier = 'all',
    this.state = 'all',
  });
  final String query, category, tier, state;
  Map<String, dynamic> parameters(String view, {String? cursor}) => {
    'view': view,
    'limit': 40,
    if (query.isNotEmpty) 'q': query,
    'category': category,
    'tier': tier,
    'state': state,
    'cursor': ?cursor,
  };
  String get fingerprint => '$query\u0000$category\u0000$tier\u0000$state';
}

class KnowledgePage<T> {
  const KnowledgePage({
    required this.items,
    required this.catalogTotal,
    this.nextCursor,
  });
  final List<T> items;
  final int catalogTotal;
  final String? nextCursor;
}

KnowledgePage<T> parseKnowledgePage<T>(
  Object? value,
  T Function(KnowledgeJson) parse,
  String Function(T) id,
) {
  final page = knowledgeMap(value, 'Catalogue page');
  final rows = page['items'];
  if (rows is! List || rows.length > 40) {
    throw const FormatException('Catalogue page exceeds its requested bound.');
  }
  final items = rows
      .map((row) => parse(knowledgeMap(row, 'Catalogue item')))
      .toList();
  final identities = items.map(id).toSet();
  if (identities.length != items.length) {
    throw const FormatException(
      'Catalogue page contains duplicate identities.',
    );
  }
  final total = knowledgeCount(page['total'], 'Observed catalogue total');
  if (total < items.length) {
    throw const FormatException('Catalogue page counts disagree.');
  }
  final cursor = page['nextCursor'];
  if (cursor != null) {
    knowledgeIdentity(cursor, 'Next page cursor', maximum: 1000);
  }
  return KnowledgePage(
    items: List<T>.unmodifiable(items),
    catalogTotal: total,
    nextCursor: cursor as String?,
  );
}

/// A public projection retains its real classification, including legacy
/// attribution. Unknown provenance stays unknown instead of becoming private.
class MemoryReadMetadata {
  const MemoryReadMetadata({
    this.visibility = 'not_reported',
    this.sensitivity = 'not_reported',
    this.validity = 'not_reported',
    this.why = '',
    this.pinned,
    this.archived,
    this.pinnedAt,
    this.archivedAt,
    this.validFrom,
    this.validTo,
    this.retentionExpiresAt,
    this.lastUsedAt,
    this.useCount,
    this.raw = const {},
  });
  final String visibility, sensitivity, validity, why;
  final bool? pinned, archived;
  final String? pinnedAt,
      archivedAt,
      validFrom,
      validTo,
      retentionExpiresAt,
      lastUsedAt;
  final int? useCount;
  final KnowledgeJson raw;
  factory MemoryReadMetadata.fromJson(KnowledgeJson value) {
    final access = value['access'] is Map
        ? knowledgeMap(value['access'], 'Memory access')
        : <String, dynamic>{};
    final explanation = value['explainability'] is Map
        ? knowledgeMap(value['explainability'], 'Memory explainability')
        : <String, dynamic>{};
    final lifecycle = explanation['lifecycle'] is Map
        ? knowledgeMap(explanation['lifecycle'], 'Memory lifecycle')
        : <String, dynamic>{};
    String? time(Object? item) {
      if (item == null) return null;
      if (item is! String || DateTime.tryParse(item) == null) {
        throw const FormatException('Memory timestamp is malformed.');
      }
      return item;
    }

    final uses = explanation['useCount'] ?? value['useCount'];
    return MemoryReadMetadata(
      visibility:
          '${access['visibility'] ?? value['visibility'] ?? 'not_reported'}',
      sensitivity: '${access['sensitivity'] ?? 'not_reported'}',
      validity:
          '${explanation['validity'] ?? value['state'] ?? value['claimStatus'] ?? 'not_reported'}',
      why: '${explanation['why'] ?? value['formationReason'] ?? ''}',
      pinned: lifecycle['pinned'] is bool
          ? lifecycle['pinned'] as bool
          : value['pinned'] is bool
          ? value['pinned'] as bool
          : value['pinnedAt'] != null
          ? true
          : null,
      archived: lifecycle['archived'] is bool
          ? lifecycle['archived'] as bool
          : value['state'] == 'archived' || value['archivedAt'] != null
          ? true
          : null,
      pinnedAt: time(lifecycle['pinnedAt'] ?? value['pinnedAt']),
      archivedAt: time(lifecycle['archivedAt'] ?? value['archivedAt']),
      validFrom: time(explanation['validFrom'] ?? value['validFrom']),
      validTo: time(explanation['validTo'] ?? value['validTo']),
      retentionExpiresAt: time(
        explanation['retentionExpiresAt'] ?? value['retentionExpiresAt'],
      ),
      lastUsedAt: time(explanation['lastUsedAt'] ?? value['lastUsedAt']),
      useCount: uses == null ? null : knowledgeCount(uses, 'Memory usage'),
      raw: freezeKnowledgeJson({
        'access': access,
        'explainability': explanation,
      }) as KnowledgeJson,
    );
  }
}
