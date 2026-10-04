import 'dart:convert';

import 'package:cryptography/cryptography.dart';

typedef LibraryJson = Map<String, dynamic>;

void libraryRequire(
  bool value, [
  String message =
      'The source response could not be verified. Refresh to read it again.',
]) {
  if (!value) throw FormatException(message);
}

LibraryJson libraryMap(Object? value) {
  libraryRequire(value is Map<String, dynamic>);
  return value as LibraryJson;
}

void libraryKeys(LibraryJson value, String fields) {
  final expected = fields.split(' ').toSet();
  libraryRequire(
    value.length == expected.length && value.keys.every(expected.contains),
  );
}

String libraryText(Object? value, {int max = 320, bool empty = false}) {
  libraryRequire(
    value is String &&
        value.length <= max &&
        (empty || value.isNotEmpty) &&
        value.trim() == value,
  );
  return value as String;
}

String? libraryOptionalId(Object? value) =>
    value == null ? null : libraryText(value);
int libraryCount(Object? value, {int min = 0, int max = 9007199254740991}) {
  libraryRequire(value is int && value >= min && value <= max);
  return value as int;
}

bool libraryBool(Object? value) {
  libraryRequire(value is bool);
  return value as bool;
}

String libraryHash(Object? value) {
  final text = libraryText(value, max: 64);
  libraryRequire(RegExp(r'^[a-f0-9]{64}$').hasMatch(text));
  return text;
}

String libraryTime(Object? value) {
  final text = libraryText(value, max: 64);
  libraryRequire(
    RegExp(r'^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$').hasMatch(text) &&
        DateTime.tryParse(text) != null,
  );
  return text;
}

List<T> libraryArray<T>(
  Object? value,
  int max,
  T Function(Object?) parse, {
  int min = 0,
}) {
  libraryRequire(value is List && value.length >= min && value.length <= max);
  return List<T>.unmodifiable((value as List).map(parse));
}

List<String> libraryCitations(Object? value) {
  final result = libraryArray(value, 64, (row) => libraryText(row), min: 1);
  libraryRequire(result.toSet().length == result.length);
  return result;
}

String libraryCanonical(Object? value) {
  if (value is Map<String, dynamic>) {
    final keys = value.keys.toList()..sort();
    return '{${keys.map((key) => '${jsonEncode(key)}:${libraryCanonical(value[key])}').join(',')}}';
  }
  if (value is List) return '[${value.map(libraryCanonical).join(',')}]';
  // These read contracts contain bounded integer counts, never floating metrics.
  libraryRequire(
    value == null || value is String || value is bool || value is int,
  );
  return jsonEncode(value);
}

Future<String> librarySha(Object? value) async =>
    (await Sha256().hash(utf8.encode(libraryCanonical(value)))).bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
Object? _freezeLibraryValue(Object? value) {
  if (value is Map<String, dynamic>) {
    return Map<String, dynamic>.unmodifiable(
      value.map((key, item) => MapEntry(key, _freezeLibraryValue(item))),
    );
  }
  if (value is List) {
    return List<Object?>.unmodifiable(value.map(_freezeLibraryValue));
  }
  return value;
}

LibraryJson libraryFreeze(LibraryJson value) =>
    _freezeLibraryValue(value) as LibraryJson;

Future<void> libraryReceipt(
  LibraryJson response,
  String operation,
  LibraryJson outcome,
  int count,
) async {
  final receipt = libraryMap(response['serviceReceipt']);
  libraryKeys(
    receipt,
    'schemaVersion receiptKind boundaryVersion operation action resourceType accessMode eventContract authoritySha256 idempotencyKeySha256 outcomeSha256 resourceCount occurredAt receiptSha256',
  );
  libraryRequire(
    receipt['schemaVersion'] == 1 &&
        receipt['receiptKind'] == 'app_service_receipt' &&
        receipt['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
        receipt['operation'] == operation &&
        receipt['action'] == 'read' &&
        receipt['accessMode'] == 'read' &&
        receipt['resourceType'] ==
            (operation == 'app.library.list'
                ? 'workspace_library'
                : 'workspace_library_item') &&
        receipt['eventContract'] == 'read_only:no_domain_mutation' &&
        receipt['idempotencyKeySha256'] == null &&
        receipt['resourceCount'] == count,
  );
  libraryHash(receipt['authoritySha256']);
  libraryTime(receipt['occurredAt']);
  final body = {...receipt}..remove('receiptSha256');
  libraryRequire(
    receipt['receiptSha256'] == await librarySha(body) &&
        receipt['outcomeSha256'] == await librarySha(outcome),
  );
}

const libraryKinds = [
  'document',
  'spreadsheet',
  'presentation',
  'file',
  'image',
  'audio',
  'video',
  'recording',
  'transcript',
  'email',
  'meeting',
  'message',
  'webpage',
  'record',
  'generated_artifact',
];
const libraryAuthorities = [
  'capture_asset',
  'capture_recording',
  'capture_transcript',
  'project_artifact',
  'mission_artifact',
  'source_item',
];

class LibraryOwner {
  const LibraryOwner(this.tenantId, this.actorId, this.userId);
  final String tenantId, actorId, userId;
  bool owns(String value) => value == actorId || value == 'actor:$userId';
}

class LibraryItem {
  LibraryItem._(this.raw);
  final LibraryJson raw;
  String get id => raw['id'] as String;
  String get title => raw['title'] as String;
  String get kind => raw['kind'] as String;
  String get sourceId => raw['sourceId'] as String;
  String get authority => raw['sourceAuthority'] as String;
  LibraryJson get scope => libraryMap(raw['scope']);
  LibraryJson get version => libraryMap(raw['currentVersion']);
  String get versionId => version['versionId'] as String;
  bool get exactAvailable => authority != 'mission_artifact';
  bool get commandAvailable =>
      exactAvailable &&
      raw['status'] == 'ready' &&
      RegExp(r'^[A-Za-z0-9_.:@/+~=-]+$').hasMatch(id);
  LibraryJson commandReference() {
    libraryRequire(
      commandAvailable,
      'This source is not ready for current-version Command context.',
    );
    return Map.unmodifiable({
      'kind': 'file',
      'id': id,
      'expectedVersion': version['versionNumber'],
      'versionId': versionId,
      'bindingSha256': version['contentSha256'],
    });
  }

  static LibraryItem parse(Object? input, LibraryOwner owner, {String? id}) {
    final value = libraryMap(input);
    libraryKeys(
      value,
      'schemaVersion id tenantId kind sourceAuthority sourceId title summary sourceLabel status tags scope currentVersion versionCount citationRefs links openHref createdAt updatedAt',
    );
    libraryRequire(
      value['schemaVersion'] == 1 &&
          value['tenantId'] == owner.tenantId &&
          libraryKinds.contains(value['kind']) &&
          libraryAuthorities.contains(value['sourceAuthority']) &&
          const [
            'processing',
            'ready',
            'failed',
            'unsupported',
          ].contains(value['status']),
    );
    final sourceId = libraryText(value['sourceId']);
    libraryRequire(
      libraryText(value['id']) ==
              'library:${value['sourceAuthority']}:$sourceId' &&
          (id == null || value['id'] == id),
    );
    libraryText(value['title'], max: 240);
    libraryText(value['summary'], max: 600, empty: true);
    libraryText(value['sourceLabel'], max: 120);
    libraryTime(value['createdAt']);
    libraryTime(value['updatedAt']);
    libraryArray(value['tags'], 50, (tag) => libraryText(tag, max: 80));
    libraryCitations(value['citationRefs']);
    final scope = libraryMap(value['scope']);
    libraryKeys(
      scope,
      'visibility ownerActorId workspaceId projectId missionId workItemId permissionBasis',
    );
    libraryRequire(
      const [
            'user_private',
            'mission_shared',
            'project_shared',
            'workspace_shared',
          ].contains(scope['visibility']) &&
          const [
            'owner',
            'workspace_member',
            'project_member',
          ].contains(scope['permissionBasis']),
    );
    libraryText(scope['ownerActorId']);
    for (final key in ['workspaceId', 'projectId', 'missionId', 'workItemId']) {
      libraryOptionalId(scope[key]);
    }
    if (scope['visibility'] == 'user_private') {
      libraryRequire(owner.owns(scope['ownerActorId'] as String));
    }
    for (final kind in ['workspace', 'project', 'mission']) {
      if (scope['visibility'] == '${kind}_shared') {
        libraryRequire(scope['${kind}Id'] != null);
      }
    }
    final version = libraryMap(value['currentVersion']);
    libraryKeys(
      version,
      'versionId versionNumber contentSha256 byteCount mediaType sourceRevisionId createdAt',
    );
    libraryText(version['versionId']);
    libraryCount(version['versionNumber'], min: 1);
    libraryHash(version['contentSha256']);
    libraryCount(version['byteCount']);
    libraryRequire(libraryText(version['mediaType'], max: 160).length >= 3);
    libraryOptionalId(version['sourceRevisionId']);
    libraryTime(version['createdAt']);
    libraryRequire(
      libraryCount(value['versionCount'], min: 1) >= version['versionNumber'],
    );
    if (value['sourceAuthority'] == 'source_item') {
      libraryRequire(version['sourceRevisionId'] != null);
    }
    final item = LibraryItem._(libraryFreeze(value));
    _sourceHref(item, value['openHref']);
    libraryArray(value['links'], 16, (raw) {
      final link = libraryMap(raw);
      libraryKeys(link, 'kind id label href');
      libraryText(link['id']);
      libraryText(link['label'], max: 240);
      _href(link['href']);
      final kind = link['kind'];
      libraryRequire(
        const [
          'source',
          'workspace',
          'project',
          'work_item',
          'mission',
          'knowledge_document',
        ].contains(kind),
      );
      if (kind == 'source') {
        libraryRequire(link['id'] == sourceId);
        _sourceHref(item, link['href'], sourceLink: true);
      } else if (kind != 'knowledge_document') {
        libraryRequire(
          link['id'] ==
              scope[{
                'workspace': 'workspaceId',
                'project': 'projectId',
                'work_item': 'workItemId',
                'mission': 'missionId',
              }[kind]],
        );
      }
      return link;
    });
    return item;
  }
}

Uri? _href(Object? value) {
  if (value == null) return null;
  final text = libraryText(value, max: 2048);
  libraryRequire(
    text.startsWith('/') &&
        !text.startsWith('//') &&
        !RegExp(r'[\\\x00-\x20\x7f]').hasMatch(text),
  );
  final uri = Uri.parse(text);
  libraryRequire(!uri.hasAuthority && !uri.hasScheme && !uri.hasFragment);
  return uri;
}

void _sourceHref(LibraryItem item, Object? value, {bool sourceLink = false}) {
  final uri = _href(value);
  if (uri == null) return;
  bool query(Map<String, String> expected) =>
      uri.queryParametersAll.length == expected.length &&
      expected.entries.every(
        (entry) =>
            uri.queryParametersAll[entry.key]?.length == 1 &&
            uri.queryParameters[entry.key] == entry.value,
      );
  if (sourceLink &&
      const [
        'capture_asset',
        'capture_recording',
        'capture_transcript',
        'source_item',
      ].contains(item.authority)) {
    libraryRequire(value == '/app/capture');
    return;
  }
  switch (item.authority) {
    case 'capture_asset':
      libraryRequire(
        value == '/app/capture' ||
            uri.pathSegments.length == 4 &&
                uri.pathSegments.take(3).join('/') == 'api/capture/assets' &&
                uri.pathSegments.last == item.sourceId &&
                (query({'content': '1'}) ||
                    query({'content': '1', 'download': '1'})),
      );
    case 'capture_recording':
    case 'capture_transcript':
      libraryRequire(
        uri.path == '/app/capture' && query({'recording': item.sourceId}),
      );
    case 'source_item':
      libraryRequire(value == '/app/capture');
    case 'project_artifact':
      final project = uri.queryParameters['project'];
      libraryRequire(
        uri.path == '/app/projects' &&
            project != null &&
            project.isNotEmpty &&
            query({'project': project, 'artifact': item.sourceId}),
      );
    case 'mission_artifact':
      libraryRequire(
        uri.pathSegments.length == 3 &&
            uri.pathSegments.take(2).join('/') == 'app/missions' &&
            uri.pathSegments.last == item.scope['missionId'] &&
            query(sourceLink ? {} : {'artifact': item.sourceId}),
      );
  }
}

class LibraryPage {
  const LibraryPage(
    this.items,
    this.offset,
    this.total,
    this.lowerBound,
    this.nextOffset,
    this.counts,
    this.countsLowerBound,
    this.generatedAt,
  );
  final List<LibraryItem> items;
  final int offset, total;
  final bool lowerBound, countsLowerBound;
  final int? nextOffset;
  final Map<String, int> counts;
  final String generatedAt;
  static Future<LibraryPage> parse(
    LibraryJson value,
    LibraryOwner owner, {
    required int offset,
    required int limit,
  }) async {
    libraryKeys(
      value,
      'items total totalIsLowerBound nextOffset countsByKind countsAreLowerBound serviceReceipt generatedAt',
    );
    final items = libraryArray(
      value['items'],
      limit,
      (raw) => LibraryItem.parse(raw, owner),
    );
    final total = libraryCount(value['total']),
        lower = libraryBool(value['totalIsLowerBound']);
    final next = value['nextOffset'] == null
        ? null
        : libraryCount(value['nextOffset'], min: 1, max: 10100);
    libraryRequire(
      items.map((row) => row.id).toSet().length == items.length &&
          total == offset + items.length + (lower ? 1 : 0) &&
          (next == null ||
              lower && items.isNotEmpty && next == offset + items.length) &&
          (!lower || items.isEmpty || next != null),
    );
    final counts = libraryMap(value['countsByKind']).map((key, count) {
      libraryRequire(libraryKinds.contains(key));
      return MapEntry(key, libraryCount(count));
    });
    for (final kind in items.map((row) => row.kind).toSet()) {
      libraryRequire(
        (counts[kind] ?? 0) >= items.where((row) => row.kind == kind).length,
      );
    }
    final outcome = {...value}
      ..remove('serviceReceipt')
      ..remove('generatedAt');
    await libraryReceipt(value, 'app.library.list', outcome, items.length);
    return LibraryPage(
      items,
      offset,
      total,
      lower,
      next,
      Map.unmodifiable(counts),
      libraryBool(value['countsAreLowerBound']),
      libraryTime(value['generatedAt']),
    );
  }
}

class LibraryVersion {
  const LibraryVersion(this.raw);
  final LibraryJson raw;
  String get id => raw['versionId'] as String;
  bool get current => raw['current'] as bool;
  static LibraryVersion parse(
    Object? raw, {
    required String prefix,
    required String head,
    required String basis,
  }) {
    final value = libraryMap(raw);
    libraryKeys(
      value,
      'versionId sourceRevisionId sourceRevisionSha256 contentSha256 byteCount mediaType capturedAt ordinal current citationRefs contentAvailability historicalAttachmentAuthority',
    );
    final id = libraryText(value['versionId']);
    libraryRequire(
      id.startsWith(prefix) &&
          id.length > prefix.length &&
          libraryBool(value['current']) == (id == head) &&
          value['ordinal'] == null &&
          value['contentAvailability'] == 'metadata_only' &&
          value['historicalAttachmentAuthority'] == 'none',
    );
    libraryOptionalId(value['sourceRevisionId']);
    if (value['sourceRevisionSha256'] != null) {
      libraryHash(value['sourceRevisionSha256']);
      libraryRequire(value['sourceRevisionId'] != null);
    }
    libraryHash(value['contentSha256']);
    libraryCount(value['byteCount']);
    libraryTime(value['capturedAt']);
    libraryRequire(libraryText(value['mediaType'], max: 160).length >= 3);
    libraryCitations(value['citationRefs']);
    if (basis == 'retained_compatible_revisions') {
      libraryRequire(
        value['sourceRevisionId'] != null &&
            value['sourceRevisionSha256'] != null &&
            id == '$prefix${value['sourceRevisionId']}',
      );
    }
    if (basis == 'current_known_version_only') {
      libraryRequire(value['current'] == true);
    }
    return LibraryVersion(libraryFreeze(value));
  }
}

class LibraryHistory {
  const LibraryHistory(
    this.itemId,
    this.head,
    this.basis,
    this.versions,
    this.nextBefore,
    this.before,
  );
  final String itemId, head, basis;
  final List<LibraryVersion> versions;
  final String? nextBefore, before;
  static Future<LibraryHistory> parse(
    LibraryJson value,
    LibraryOwner owner,
    String itemId, {
    required int limit,
    String? before,
    String? head,
    String? versionId,
  }) async {
    libraryKeys(
      value,
      'schemaVersion contract libraryItemId tenantId sourceAuthority sourceId currentVersionId coverageBasis authorityEffect commandAttachmentPolicy ${versionId == null ? 'versions coverage' : 'version'} serviceReceipt',
    );
    final sourceId = libraryText(value['sourceId']),
        authority = libraryText(value['sourceAuthority']);
    final prefix = 'version:$authority:$sourceId:',
        current = libraryText(value['currentVersionId']);
    libraryRequire(
      value['schemaVersion'] == 1 &&
          value['contract'] == 'asael-library-history:1' &&
          value['tenantId'] == owner.tenantId &&
          libraryAuthorities.contains(authority) &&
          authority != 'mission_artifact' &&
          itemId == 'library:$authority:$sourceId' &&
          value['libraryItemId'] == itemId &&
          current.startsWith(prefix) &&
          current.length > prefix.length &&
          (head == null || current == head) &&
          value['authorityEffect'] == 'none' &&
          value['commandAttachmentPolicy'] ==
              'current_library_resolution_required',
    );
    final basis = libraryText(value['coverageBasis']);
    libraryRequire(
      const [
        'retained_compatible_revisions',
        'current_known_version_only',
      ].contains(basis),
    );
    final versions = versionId == null
        ? libraryArray(
            value['versions'],
            limit,
            (row) => LibraryVersion.parse(
              row,
              prefix: prefix,
              head: current,
              basis: basis,
            ),
          )
        : [
            LibraryVersion.parse(
              value['version'],
              prefix: prefix,
              head: current,
              basis: basis,
            ),
          ];
    libraryRequire(
      versions.map((row) => row.id).toSet().length == versions.length &&
          (versionId == null || versions.single.id == versionId),
    );
    String? next;
    if (versionId == null) {
      final coverage = libraryMap(value['coverage']);
      libraryKeys(coverage, 'limit returned hasMore nextBefore total');
      final more = libraryBool(coverage['hasMore']);
      next = libraryOptionalId(coverage['nextBefore']);
      libraryRequire(
        coverage['limit'] == limit &&
            coverage['returned'] == versions.length &&
            coverage['total'] == null &&
            (!more || versions.length == limit) &&
            next == (more ? versions.last.id : null) &&
            (basis != 'current_known_version_only' ||
                versions.length <= 1 && !more),
      );
    }
    final outcome = {...value}..remove('serviceReceipt');
    await libraryReceipt(
      value,
      versionId == null
          ? 'app.library.versions.list'
          : 'app.library.versions.show',
      outcome,
      versions.length,
    );
    return LibraryHistory(
      itemId,
      current,
      basis,
      List.unmodifiable(versions),
      next,
      before,
    );
  }
}

class EntityOption {
  const EntityOption(this.id, this.type, this.label);
  final String id, type, label;
}

class EntityOptionsPage {
  const EntityOptionsPage(
    this.items,
    this.after,
    this.nextAfter,
    this.accessScope,
  );
  final List<EntityOption> items;
  final String? after, nextAfter;
  final String accessScope;
  static EntityOptionsPage parse(
    LibraryJson value,
    LibraryOwner owner, {
    required int limit,
    String? after,
  }) {
    libraryKeys(
      value,
      'schemaVersion contract scope items hasMore nextAfter coverage authorityEffect',
    );
    libraryRequire(
      value['schemaVersion'] == 1 &&
          value['contract'] == 'asael-entity-options:1' &&
          value['authorityEffect'] == 'none',
    );
    final scope = libraryMap(value['scope']);
    libraryKeys(scope, 'tenantId ownerActorId accessScopeSha256 purposeId');
    libraryRequire(
      scope['tenantId'] == owner.tenantId &&
          scope['ownerActorId'] == 'actor:${owner.userId}' &&
          scope['purposeId'] == 'entity.read.v1',
    );
    final hash = libraryHash(scope['accessScopeSha256']);
    String? previous = after;
    final items = libraryArray(value['items'], limit, (row) {
      final raw = libraryMap(row);
      libraryKeys(raw, 'entityId entityTypeId canonicalLabel state');
      final id = libraryText(raw['entityId'], max: 240),
          type = libraryText(raw['entityTypeId']);
      libraryRequire(
        RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$').hasMatch(id) &&
            (previous == null || id.compareTo(previous!) > 0) &&
            const [
              'person',
              'organization',
              'account',
              'project',
            ].contains(type) &&
            raw['state'] == 'active',
      );
      previous = id;
      return EntityOption(
        id,
        type,
        libraryText(raw['canonicalLabel'], max: 320),
      );
    });
    final coverage = libraryMap(value['coverage']);
    libraryKeys(coverage, 'kind limit returned after total');
    final more = libraryBool(value['hasMore']),
        next = libraryOptionalId(value['nextAfter']);
    libraryRequire(
      coverage['kind'] == 'bounded_current' &&
          coverage['limit'] == limit &&
          coverage['returned'] == items.length &&
          coverage['after'] == after &&
          coverage['total'] == null &&
          (!more || items.length == limit) &&
          next == (more ? items.last.id : null),
    );
    return EntityOptionsPage(items, after, next, hash);
  }
}
