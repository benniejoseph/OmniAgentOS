import 'dart:convert';
import 'dart:typed_data';

import 'portable_archive_canonical.dart';

const portableArchiveMaxBytes = 16 * 1024 * 1024;
const portableArchiveSectionNames = <String>[
  'knowledge',
  'memories',
  'threads',
  'today',
  'projects',
  'connections',
  'skills',
  'agents',
  'assets',
];

/// Only content-free evidence crosses the verification isolate boundary.
class PortableArchiveReceipt {
  PortableArchiveReceipt({
    required this.exportedAt,
    required this.byteCount,
    required this.archiveSha256,
    required this.manifestSha256,
    required this.includedCount,
    required this.excludedCount,
    required List<PortableArchiveSectionReceipt> sections,
    required List<PortableArchiveExclusion> exclusions,
  }) : sections = List.unmodifiable(sections),
       exclusions = List.unmodifiable(exclusions);

  final DateTime exportedAt;
  final int byteCount;
  final String archiveSha256;
  final String manifestSha256;
  final int includedCount;
  final int? excludedCount;
  final List<PortableArchiveSectionReceipt> sections;
  final List<PortableArchiveExclusion> exclusions;
}

class PortableArchiveSectionReceipt {
  const PortableArchiveSectionReceipt({
    required this.name,
    required this.includedCount,
    required this.excludedCount,
    required this.restoreDisposition,
  });
  final String name;
  final int includedCount;
  final int? excludedCount;
  final String restoreDisposition;
}

class PortableArchiveExclusion {
  const PortableArchiveExclusion({
    required this.category,
    required this.reason,
    required this.count,
  });
  final String category;
  final String reason;
  final int? count;
}

class PortableArchiveVerificationException implements Exception {
  const PortableArchiveVerificationException(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => message;
}

/// Verifies the complete asset-free v2 contract without rewriting parsed fields.
/// Call in an owned isolate. It never saves bytes, publishes archive content or
/// grants restore authority; the caller must still admit the exact scoped write.
Future<PortableArchiveReceipt> verifyPortableArchive(
  Uint8List bytes, {
  required String tenantId,
  required String actorId,
  String? expectedArchiveSha256,
}) async {
  if (bytes.length > portableArchiveMaxBytes) {
    throw const PortableArchiveVerificationException(
      'archive_too_large',
      'This archive exceeds the 16 MiB native limit. Use Personal Data in the browser.',
    );
  }
  try {
    if (bytes.isEmpty || tenantId.isEmpty || actorId.isEmpty) _invalid();
    if (expectedArchiveSha256 != null) _sha(expectedArchiveSha256);
    final decoded = decodePortableJson(
      utf8.decode(bytes, allowMalformed: false),
    );
    return _verify(
      decoded,
      bytes.length,
      tenantId,
      actorId,
      expectedArchiveSha256,
    );
  } on PortableArchiveVerificationException {
    rethrow;
  } on FormatException {
    throw const PortableArchiveVerificationException(
      'invalid_archive',
      'The archive could not be verified. No file was saved.',
    );
  }
}

PortableArchiveReceipt _verify(
  Object? value,
  int byteCount,
  String tenantId,
  String actorId,
  String? expectedArchiveSha256,
) {
  final archive = _object(value, {
    'format',
    'version',
    'exportedAt',
    'provenance',
    'assetEncryption',
    'data',
    'manifest',
    'archiveSha256',
  });
  if (archive['format'] != 'asael-portable-archive' ||
      archive['version'] != 2) {
    throw const PortableArchiveVerificationException(
      'unsupported_archive',
      'Only portable archive v2 is supported by native Settings.',
    );
  }
  if (archive['assetEncryption'] != null) {
    throw const PortableArchiveVerificationException(
      'unsupported_assets',
      'Encrypted assets must be managed in Personal Data in the browser.',
    );
  }
  final exportedAt = _timestamp(archive['exportedAt']);
  final provenance = _object(archive['provenance'], {
    'sourceOwnerActorIdSha256',
    'sourceTenantIdSha256',
    'exporterId',
  });
  if (provenance['exporterId'] != 'asael') _invalid();
  if (_sha(provenance['sourceOwnerActorIdSha256']) !=
          portableTextSha256(actorId) ||
      _sha(provenance['sourceTenantIdSha256']) !=
          portableTextSha256(tenantId)) {
    throw const PortableArchiveVerificationException(
      'archive_owner_mismatch',
      'The archive does not match the current account and workspace.',
    );
  }
  final data = _object(archive['data'], portableArchiveSectionNames.toSet());
  final sections = <String, List<Object?>>{};
  const ceilings = [5000, 20000, 100, 250, 100, 100, 250, 100, 0];
  for (var i = 0; i < portableArchiveSectionNames.length; i++) {
    final name = portableArchiveSectionNames[i];
    if (name == 'assets' &&
        data[name] is List &&
        (data[name] as List).isNotEmpty) {
      throw const PortableArchiveVerificationException(
        'unsupported_assets',
        'Encrypted assets must be managed in Personal Data in the browser.',
      );
    }
    sections[name] = _array(data[name], ceilings[i]);
  }
  for (final entry in sections['knowledge']!) {
    _knowledge(entry);
  }
  for (final entry in sections['memories']!) {
    _memory(entry);
  }
  for (final entry in sections['threads']!) {
    _thread(entry);
  }
  for (final entry in sections['today']!) {
    _today(entry);
  }
  for (final entry in sections['projects']!) {
    _project(entry);
  }
  for (final entry in sections['connections']!) {
    _connection(entry);
  }
  for (final entry in sections['skills']!) {
    _skill(entry);
  }
  for (final entry in sections['agents']!) {
    _agent(entry);
  }
  for (final name in ['knowledge', 'memories', 'skills', 'agents']) {
    _unique(sections[name]!, 'sourceId');
  }
  for (final name in ['threads', 'today', 'projects']) {
    _unique(sections[name]!, 'sourceIdSha256');
  }
  _unique(sections['connections']!, 'provider');
  _unique(sections['skills']!, 'name');
  _unique(sections['agents']!, 'name');

  final manifest = _object(archive['manifest'], {
    'schemaVersion',
    'contractId',
    'sections',
    'exclusions',
    'totals',
    'secretsExcluded',
    'connectorCredentialsExcluded',
    'connectorsRequireReauthorization',
    'manifestSha256',
  });
  if (manifest['schemaVersion'] != 1 ||
      manifest['contractId'] != 'asael.portable.archive.v2' ||
      manifest['secretsExcluded'] != true ||
      manifest['connectorCredentialsExcluded'] != true ||
      manifest['connectorsRequireReauthorization'] != true) {
    _invalid();
  }
  final declaredSections = _object(
    manifest['sections'],
    portableArchiveSectionNames.toSet(),
  );
  final receipts = <PortableArchiveSectionReceipt>[];
  var includedTotal = 0;
  int? excludedTotal = 0;
  for (final name in portableArchiveSectionNames) {
    final declaration = _object(declaredSections[name], {
      'includedCount',
      'excludedCount',
      'contentSha256',
      'restoreDisposition',
    });
    final included = _integer(declaration['includedCount']);
    final excluded = _nullableInteger(declaration['excludedCount']);
    final disposition = name == 'connections'
        ? 'reauthorization_required'
        : name == 'assets'
        ? 'not_included'
        : 'restore';
    if (included != sections[name]!.length ||
        declaration['restoreDisposition'] != disposition ||
        _sha(declaration['contentSha256']) !=
            portableCanonicalSha256(sections[name])) {
      _invalid();
    }
    includedTotal += included;
    excludedTotal = excludedTotal == null || excluded == null
        ? null
        : excludedTotal + excluded;
    receipts.add(
      PortableArchiveSectionReceipt(
        name: name,
        includedCount: included,
        excludedCount: excluded,
        restoreDisposition: disposition,
      ),
    );
  }
  final totals = _object(manifest['totals'], {
    'includedCount',
    'excludedCount',
  });
  if (_integer(totals['includedCount']) != includedTotal ||
      _nullableInteger(totals['excludedCount']) != excludedTotal) {
    _invalid();
  }
  final exclusions = <PortableArchiveExclusion>[];
  for (final value in _array(manifest['exclusions'], 100)) {
    final exclusion = _object(value, {'category', 'reason', 'count'});
    exclusions.add(
      PortableArchiveExclusion(
        category: _exclusionCode(exclusion['category']),
        reason: _exclusionCode(exclusion['reason']),
        count: _nullableInteger(exclusion['count']),
      ),
    );
  }
  final manifestSha = _sha(manifest['manifestSha256']);
  final manifestBody = Map<String, Object?>.of(manifest)
    ..remove('manifestSha256');
  if (portableCanonicalSha256(manifestBody) != manifestSha) _invalid();
  final archiveSha = _sha(archive['archiveSha256']);
  final archiveBody = Map<String, Object?>.of(archive)..remove('archiveSha256');
  if (portableCanonicalSha256(archiveBody) != archiveSha ||
      (expectedArchiveSha256 != null && archiveSha != expectedArchiveSha256)) {
    _invalid();
  }
  return PortableArchiveReceipt(
    exportedAt: exportedAt,
    byteCount: byteCount,
    archiveSha256: archiveSha,
    manifestSha256: manifestSha,
    includedCount: includedTotal,
    excludedCount: excludedTotal,
    sections: receipts,
    exclusions: exclusions,
  );
}

void _knowledge(Object? value) {
  final item = _object(value, {
    'sourceId',
    'title',
    'content',
    'contentSha256',
    'source',
    'sourceType',
    'tags',
    'sourceContentSha256',
    'sourceRevisionIdSha256',
    'updatedAt',
  });
  _text(item['sourceId'], 200, min: 1, trimmed: true);
  _text(item['title'], 240, min: 1, trimmed: true);
  _content(item, 900000);
  _text(item['source'], 2000);
  _enum(item['sourceType'], {'manual', 'text', 'file', 'url', 'api'});
  _strings(item['tags'], 50, 100);
  _nullableSha(item['sourceContentSha256']);
  _nullableSha(item['sourceRevisionIdSha256']);
  _nullableTimestamp(item['updatedAt']);
}

const _tiers = {
  'working',
  'episodic',
  'semantic',
  'procedural',
  'preference',
  'decision',
  'commitment',
  'summary',
};

void _memory(Object? value) {
  final item = _object(
    value,
    {
      'sourceId',
      'title',
      'content',
      'contentSha256',
      'type',
      'tags',
      'scope',
      'source',
      'importance',
      'confidence',
      'claimStatus',
      'assertedBy',
      'evidenceRefs',
      'validFrom',
      'validTo',
      'supersedesId',
      'contradictionOfId',
      'createdAt',
      'updatedAt',
    },
    optional: {
      'tier',
      'tierPolicyVersion',
      'formationReason',
      'retentionExpiresAt',
      'lastUsedAt',
      'useCount',
      'promotedFromTier',
      'promotedAt',
    },
  );
  _text(item['sourceId'], 200, min: 1, trimmed: true);
  _text(item['title'], 240, min: 1, trimmed: true);
  _content(item, 200000);
  _enum(item['type'], {
    'preference',
    'fact',
    'episode',
    'procedure',
    'knowledge',
    'decision',
    'task',
  });
  if (item.containsKey('tier')) _enum(item['tier'], _tiers);
  if (item.containsKey('tierPolicyVersion') && item['tierPolicyVersion'] != 1) {
    _invalid();
  }
  if (item.containsKey('formationReason')) {
    _enum(item['formationReason'], {
      'manual_user_entry',
      'explicit_user_request',
      'canonical_source_observation',
      'verified_effect',
      'agent_shared_artifact',
      'assistant_inference_candidate',
      'correction',
      'project_reflection',
      'project_artifact',
      'workflow_output',
      'maintenance_promotion',
      'source_cognition',
      'portable_restore',
      'legacy_record',
    });
  }
  _strings(item['tags'], 50, 100);
  _enum(item['scope'], {'user', 'workspace', 'project'});
  _text(item['source'], 2000);
  _unitNumber(item['importance']);
  _unitNumber(item['confidence']);
  _enum(item['claimStatus'], {
    'active',
    'candidate',
    'superseded',
    'contradicted',
  });
  _enum(item['assertedBy'], {'user', 'agent', 'system', 'import'});
  _strings(item['evidenceRefs'], 100, 500);
  for (final key in ['validFrom', 'validTo', 'createdAt', 'updatedAt']) {
    _nullableTimestamp(item[key]);
  }
  for (final key in ['retentionExpiresAt', 'lastUsedAt', 'promotedAt']) {
    if (item.containsKey(key)) _nullableTimestamp(item[key]);
  }
  if (item.containsKey('useCount')) _integer(item['useCount']);
  if (item.containsKey('promotedFromTier') &&
      item['promotedFromTier'] != null) {
    _enum(item['promotedFromTier'], _tiers);
  }
  for (final key in ['supersedesId', 'contradictionOfId']) {
    if (item[key] != null) _text(item[key], 200, min: 1, trimmed: true);
  }
}

void _thread(Object? value) {
  final item = _object(value, {'sourceIdSha256', 'title', 'mode', 'turns'});
  _sha(item['sourceIdSha256']);
  _text(item['title'], 90, min: 1, trimmed: true);
  _enum(item['mode'], {'orchestrate', 'research', 'execute', 'learn'});
  final turns = _array(item['turns'], 100);
  for (var index = 0; index < turns.length; index++) {
    final turn = _object(turns[index], {
      'index',
      'role',
      'content',
      'contentSha256',
      'createdAt',
    });
    if (_integer(turn['index'], max: 99) != index) _invalid();
    _enum(turn['role'], {'user', 'assistant'});
    _content(turn, 40000, trimmed: true);
    _nullableTimestamp(turn['createdAt']);
  }
}

void _today(Object? value) {
  final item = _object(value, {
    'sourceIdSha256',
    'title',
    'kind',
    'priority',
    'status',
    'dueAt',
  });
  _sha(item['sourceIdSha256']);
  _text(item['title'], 280, min: 1, trimmed: true);
  _enum(item['kind'], {'task', 'reminder'});
  _enum(item['priority'], {'low', 'medium', 'high'});
  _enum(item['status'], {'open', 'done'});
  _nullableTimestamp(item['dueAt']);
}

void _project(Object? value) {
  final item = _object(value, {
    'sourceIdSha256',
    'title',
    'objective',
    'status',
    'targetDate',
    'tasks',
  });
  _sha(item['sourceIdSha256']);
  _text(item['title'], 180, min: 1, trimmed: true);
  _text(item['objective'], 2000, min: 1, trimmed: true);
  _enum(item['status'], {'draft', 'active', 'completed', 'archived'});
  _nullableTimestamp(item['targetDate']);
  final tasks = _array(item['tasks'], 20);
  for (final taskValue in tasks) {
    final task = _object(taskValue, {
      'sourceIdSha256',
      'title',
      'detail',
      'priority',
      'agentId',
      'origin',
      'dueAt',
    });
    _sha(task['sourceIdSha256']);
    _text(task['title'], 240, min: 1, trimmed: true);
    _text(task['detail'], 1000);
    _enum(task['priority'], {'low', 'medium', 'high'});
    _enum(task['agentId'], {
      'atlas',
      'scout',
      'forge',
      'sentinel',
      'mnemosyne',
    });
    _enum(task['origin'], {'manual', 'agent'});
    _nullableTimestamp(task['dueAt']);
  }
  _unique(tasks, 'sourceIdSha256');
}

void _connection(Object? value) {
  final item = _object(value, {
    'provider',
    'scopes',
    'configurationSha256',
    'reauthorizationRequired',
  });
  _text(item['provider'], 80, min: 1, trimmed: true);
  _strings(item['scopes'], 100, 240);
  _sha(item['configurationSha256']);
  if (item['reauthorizationRequired'] != true) _invalid();
}

void _skill(Object? value) {
  final item = _object(value, {
    'sourceId',
    'name',
    'description',
    'instructions',
    'category',
    'status',
    'toolIds',
    'tags',
    'knowledgeTags',
  });
  _text(item['sourceId'], 120, min: 1, trimmed: true);
  _text(item['name'], 120, min: 1, trimmed: true);
  _text(item['description'], 500, min: 1, trimmed: true);
  _text(item['instructions'], 12000, min: 10, trimmed: true);
  _enum(item['category'], {
    'research',
    'creation',
    'analysis',
    'memory',
    'automation',
    'personal',
  });
  _enum(item['status'], {'active', 'disabled'});
  _strings(item['toolIds'], 50, 120);
  _strings(item['tags'], 30, 120);
  _strings(item['knowledgeTags'], 30, 120);
}

void _agent(Object? value) {
  final item = _object(value, {
    'sourceId',
    'name',
    'role',
    'description',
    'instructions',
    'status',
    'accent',
    'modelPolicy',
    'autonomy',
    'approvalPolicy',
    'memoryScope',
    'skillIds',
    'toolIds',
  });
  _text(item['sourceId'], 120, min: 1, trimmed: true);
  _text(item['name'], 120, min: 1, trimmed: true);
  _text(item['role'], 120, min: 1, trimmed: true);
  _text(item['description'], 700, min: 1, trimmed: true);
  _text(item['instructions'], 12000, min: 10, trimmed: true);
  _enum(item['status'], {'ready', 'learning', 'paused'});
  _enum(item['accent'], {'emerald', 'blue', 'amber', 'violet', 'rose'});
  _enum(item['modelPolicy'], {
    'auto',
    'openai_fast',
    'openai_reasoning',
    'gemini_fast',
    'anthropic_fast',
    'anthropic_reasoning',
  });
  _enum(item['autonomy'], {'assist', 'governed', 'execute'});
  _enum(item['approvalPolicy'], {'always', 'risk_based', 'read_only'});
  _enum(item['memoryScope'], {'session', 'project', 'all'});
  _strings(item['skillIds'], 30, 120);
  _strings(item['toolIds'], 50, 120);
}

Never _invalid() =>
    throw const FormatException('Archive contract verification failed.');

Map<String, Object?> _object(
  Object? value,
  Set<String> required, {
  Set<String> optional = const {},
}) {
  if (value is! Map<String, Object?> ||
      !required.every(value.containsKey) ||
      value.keys.any(
        (key) => !required.contains(key) && !optional.contains(key),
      )) {
    _invalid();
  }
  return value;
}

List<Object?> _array(Object? value, int max) {
  if (value is! List<Object?> || value.length > max) _invalid();
  return value;
}

String _text(Object? value, int max, {int min = 0, bool trimmed = false}) {
  if (value is! String || value.length < min || value.length > max) _invalid();
  if (trimmed &&
      value.isNotEmpty &&
      (_jsWhitespace(value.codeUnitAt(0)) ||
          _jsWhitespace(value.codeUnitAt(value.length - 1)))) {
    _invalid();
  }
  return value;
}

bool _jsWhitespace(int unit) =>
    (unit >= 0x09 && unit <= 0x0d) ||
    unit == 0x20 ||
    unit == 0xa0 ||
    unit == 0x1680 ||
    (unit >= 0x2000 && unit <= 0x200a) ||
    unit == 0x2028 ||
    unit == 0x2029 ||
    unit == 0x202f ||
    unit == 0x205f ||
    unit == 0x3000 ||
    unit == 0xfeff;

void _strings(Object? value, int count, int length) {
  for (final entry in _array(value, count)) {
    _text(entry, length, min: 1, trimmed: true);
  }
}

void _enum(Object? value, Set<String> options) {
  if (value is! String || !options.contains(value)) _invalid();
}

final _shaPattern = RegExp(r'^[a-f0-9]{64}$');
String _sha(Object? value) {
  if (value is! String || value.length != 64 || !_shaPattern.hasMatch(value)) {
    _invalid();
  }
  return value;
}

void _nullableSha(Object? value) {
  if (value != null) _sha(value);
}

int _integer(Object? value, {int max = 9007199254740991}) {
  if (value is! num ||
      !value.isFinite ||
      value < 0 ||
      value > max ||
      value != value.truncateToDouble()) {
    _invalid();
  }
  return value.toInt();
}

int? _nullableInteger(Object? value) => value == null ? null : _integer(value);

void _unitNumber(Object? value) {
  if (value is! num || !value.isFinite || value < 0 || value > 1) _invalid();
}

final _timestampPattern = RegExp(
  r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?Z$',
);
DateTime _timestamp(Object? value) {
  if (value is! String) _invalid();
  final match = _timestampPattern.firstMatch(value);
  if (match == null || match.end != value.length) _invalid();
  final year = int.parse(match.group(1)!);
  final month = int.parse(match.group(2)!);
  final day = int.parse(match.group(3)!);
  final hour = int.parse(match.group(4)!);
  final minute = int.parse(match.group(5)!);
  final second = int.parse(match.group(6) ?? '0');
  final fraction = (match.group(7) ?? '').padRight(6, '0');
  final micros = int.parse(fraction.substring(0, 6));
  final date = DateTime.utc(
    year,
    month,
    day,
    hour,
    minute,
    second,
    micros ~/ 1000,
    micros % 1000,
  );
  if (date.year != year ||
      date.month != month ||
      date.day != day ||
      date.hour != hour ||
      date.minute != minute ||
      date.second != second) {
    _invalid();
  }
  return date;
}

void _nullableTimestamp(Object? value) {
  if (value != null) _timestamp(value);
}

final _exclusionPattern = RegExp(r'^[a-z0-9_]{1,80}$');
String _exclusionCode(Object? value) {
  if (value is! String ||
      value.isEmpty ||
      value.length > 80 ||
      !_exclusionPattern.hasMatch(value) ||
      value.codeUnits.any(
        (unit) =>
            !((unit >= 0x61 && unit <= 0x7a) ||
                (unit >= 0x30 && unit <= 0x39) ||
                unit == 0x5f),
      )) {
    _invalid();
  }
  return value;
}

void _content(Map<String, Object?> item, int max, {bool trimmed = false}) {
  final text = _text(
    item['content'],
    max,
    min: trimmed ? 1 : 0,
    trimmed: trimmed,
  );
  if (_sha(item['contentSha256']) != portableTextSha256(text)) _invalid();
}

void _unique(List<Object?> values, String field) {
  final seen = <String>{};
  for (final value in values) {
    final identifier = (value as Map<String, Object?>)[field] as String;
    if (!seen.add(identifier)) _invalid();
  }
}
