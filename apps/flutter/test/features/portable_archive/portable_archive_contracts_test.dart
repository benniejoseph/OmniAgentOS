import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:asael/features/settings/portable_archive_canonical.dart';
import 'package:asael/features/settings/portable_archive_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

const _tenant = 'tenant-portable-fixture';
const _actor = 'archive@example.test';

Map<String, dynamic> _fixture([String name = 'populated']) => jsonDecode(
  File('test/fixtures/portable_archive/$name.json').readAsStringSync(),
) as Map<String, dynamic>;
Uint8List _bytes(Object? value) =>
    Uint8List.fromList(utf8.encode(jsonEncode(value)));
Future<PortableArchiveReceipt> _verify(
  Object? value, {
  String tenant = _tenant,
  String actor = _actor,
  String? header,
}) => verifyPortableArchive(
  _bytes(value),
  tenantId: tenant,
  actorId: actor,
  expectedArchiveSha256: header,
);

/// Mutations are rehashed so schema failures cannot pass merely because a stale
/// outer digest happened to reject them first. This is not a fixture producer.
void _rehash(Map<String, dynamic> archive) {
  final data = archive['data'] as Map<String, dynamic>;
  final manifest = archive['manifest'] as Map<String, dynamic>;
  var included = 0;
  int? excluded = 0;
  for (final name in portableArchiveSectionNames) {
    final section = manifest['sections'][name] as Map<String, dynamic>;
    section['includedCount'] = (data[name] as List).length;
    section['contentSha256'] = portableCanonicalSha256(data[name]);
    included += (data[name] as List).length;
    excluded = excluded == null || section['excludedCount'] == null
        ? null
        : excluded + (section['excludedCount'] as num).toInt();
  }
  manifest['totals'] = {'includedCount': included, 'excludedCount': excluded};
  final body = Map<String, dynamic>.of(manifest)..remove('manifestSha256');
  manifest['manifestSha256'] = portableCanonicalSha256(body);
  final archiveBody = Map<String, dynamic>.of(archive)..remove('archiveSha256');
  archive['archiveSha256'] = portableCanonicalSha256(archiveBody);
}

Matcher _failure([String? code]) => throwsA(
  isA<PortableArchiveVerificationException>().having(
    (error) => error.code,
    'code',
    code ?? isNotEmpty,
  ),
);

void main() {
  test(
    'accepts untouched server-built empty archive and immutable receipt',
    () async {
      final file = File('test/fixtures/portable_archive/minimal.json');
      final originalBytes = file.readAsBytesSync();
      final receipt = await verifyPortableArchive(
        originalBytes,
        tenantId: _tenant,
        actorId: _actor,
      );
      final fixture = _fixture('minimal');
      expect(receipt.exportedAt, DateTime.utc(2026, 10, 5));
      expect(receipt.byteCount, originalBytes.length);
      expect(receipt.archiveSha256, fixture['archiveSha256']);
      expect(receipt.manifestSha256, fixture['manifest']['manifestSha256']);
      expect(receipt.includedCount, 0);
      expect(receipt.excludedCount, 0);
      expect(
        receipt.sections.map((section) => section.name),
        portableArchiveSectionNames,
      );
      expect(() => receipt.sections.clear(), throwsUnsupportedError);
      expect(() => receipt.exclusions.clear(), throwsUnsupportedError);
      expect(originalBytes, file.readAsBytesSync());
    },
  );

  test(
    'valid populated archive preserves unknown exclusions and dispositions',
    () async {
      final fixture = _fixture();
      final receipt = await _verify(
        fixture,
        header: fixture['archiveSha256'] as String,
      );
      expect(receipt.includedCount, 9);
      expect(receipt.excludedCount, isNull);
      expect(
        receipt.sections
            .singleWhere((section) => section.name == 'memories')
            .excludedCount,
        isNull,
      );
      expect(
        receipt.sections
            .singleWhere((section) => section.name == 'knowledge')
            .excludedCount,
        3,
      );
      expect(
        receipt.sections
            .singleWhere((section) => section.name == 'connections')
            .restoreDisposition,
        'reauthorization_required',
      );
      expect(
        receipt.sections
            .singleWhere((section) => section.name == 'assets')
            .restoreDisposition,
        'not_included',
      );
      expect(receipt.exclusions.first.count, isNull);
      expect(receipt.exclusions[1].count, 2);
    },
  );

  test(
    'digest is canonical content digest, not the downloaded byte digest',
    () async {
      final archive = _fixture();
      final reordered = Map<String, dynamic>.fromEntries(
        archive.entries.toList().reversed,
      );
      final bytes = Uint8List.fromList(
        utf8.encode(
          ' \n${const JsonEncoder.withIndent('  ').convert(reordered)}\n',
        ),
      );
      final receipt = await verifyPortableArchive(
        bytes,
        tenantId: _tenant,
        actorId: _actor,
      );
      expect(receipt.archiveSha256, archive['archiveSha256']);
      expect(portableBytesSha256(bytes), isNot(receipt.archiveSha256));
    },
  );

  test(
    'literal actor and tenant binding reject substituted or normalized owners',
    () async {
      final archive = _fixture();
      for (final actor in [
        'Archive@example.test',
        '$_actor ',
        'actor:$_actor',
        'other@example.test',
      ]) {
        await expectLater(
          _verify(archive, actor: actor),
          _failure('archive_owner_mismatch'),
        );
      }
      await expectLater(
        _verify(archive, tenant: '$_tenant '),
        _failure('archive_owner_mismatch'),
      );
      archive['provenance']['sourceOwnerActorIdSha256'] = portableTextSha256(
        'other@example.test',
      );
      _rehash(archive);
      await expectLater(_verify(archive), _failure('archive_owner_mismatch'));
    },
  );

  test('literal case and spaces pass only when the server binds those exact strings', () async {
    final archive = _fixture('minimal');
    archive['provenance']['sourceOwnerActorIdSha256'] = portableTextSha256(
      ' Archive@example.test ',
    );
    archive['provenance']['sourceTenantIdSha256'] = portableTextSha256(
      ' Tenant ',
    );
    _rehash(archive);
    final receipt = await _verify(
      archive,
      actor: ' Archive@example.test ',
      tenant: ' Tenant ',
    );
    expect(receipt.includedCount, 0);
  });

  for (final header in ['a' * 64, 'A' * 64, 'abc', ' ${'a' * 64}', '']) {
    test(
      'rejects malformed/mismatched response digest ${header.length}',
      () async {
        await expectLater(
          _verify(_fixture(), header: header),
          _failure('invalid_archive'),
        );
      },
    );
  }

  for (final layer in ['content', 'section', 'manifest', 'archive']) {
    test('rejects corruption at $layer layer', () async {
      final archive = _fixture();
      switch (layer) {
        case 'content':
          archive['data']['knowledge'][0]['content'] =
              'Private sentinel must never be echoed';
          _rehash(archive);
        case 'section':
          archive['manifest']['sections']['knowledge']['contentSha256'] =
              '0' * 64;
        case 'manifest':
          archive['manifest']['manifestSha256'] = '0' * 64;
        case 'archive':
          archive['archiveSha256'] = '0' * 64;
      }
      try {
        await _verify(archive);
        fail('corrupt archive was accepted');
      } on PortableArchiveVerificationException catch (error) {
        expect(error.code, 'invalid_archive');
        expect(error.message, isNot(contains('Private sentinel')));
        expect(error.toString(), isNot(contains('Private sentinel')));
      }
    });
  }

  final schemaCases = <String, void Function(Map<String, dynamic>)>{
    'unknown envelope field': (a) => a['unknown'] = true,
    'unknown data section': (a) => a['data']['unknown'] = [],
    'unknown record field': (a) =>
        a['data']['knowledge'][0]['privateUnknown'] = 'sentinel',
    'unknown manifest field': (a) => a['manifest']['unknown'] = true,
    'unknown section field': (a) =>
        a['manifest']['sections']['knowledge']['unknown'] = true,
    'unknown exclusion field': (a) =>
        a['manifest']['exclusions'][0]['unknown'] = true,
    'unknown provenance field': (a) => a['provenance']['unknown'] = true,
    'missing required nullable field': (a) =>
        (a['data']['memories'][0] as Map).remove('validTo'),
    'null optional nonnullable': (a) => a['data']['memories'][0]['tier'] = null,
    'unknown enum': (a) => a['data']['memories'][0]['type'] = 'unknown',
    'unknown tier': (a) => a['data']['memories'][0]['tier'] = 'unknown',
    'unknown formation reason': (a) =>
        a['data']['memories'][0]['formationReason'] = 'unknown',
    'unsupported tier policy': (a) =>
        a['data']['memories'][0]['tierPolicyVersion'] = 2,
    'out of range importance': (a) =>
        a['data']['memories'][0]['importance'] = 1.01,
    'negative confidence': (a) => a['data']['memories'][0]['confidence'] = -0.1,
    'fractional use count': (a) => a['data']['memories'][0]['useCount'] = 0.5,
    'unsafe integer': (a) =>
        a['data']['memories'][0]['useCount'] = 9007199254740992,
    'padded title is not normalized': (a) =>
        a['data']['knowledge'][0]['title'] = ' title ',
    'ECMAScript BOM trim': (a) =>
        a['data']['knowledge'][0]['title'] = '\ufefftitle',
    'invalid source type': (a) =>
        a['data']['knowledge'][0]['sourceType'] = 'unknown',
    'overlong title': (a) => a['data']['knowledge'][0]['title'] = 'x' * 241,
    'too many tags': (a) =>
        a['data']['knowledge'][0]['tags'] = List.filled(51, 'tag'),
    'empty tag': (a) => a['data']['knowledge'][0]['tags'] = [''],
    'uppercase SHA': (a) =>
        a['data']['knowledge'][0]['sourceRevisionIdSha256'] = 'A' * 64,
    'turn order': (a) => a['data']['threads'][0]['turns'][0]['index'] = 1,
    'turn unknown role': (a) =>
        a['data']['threads'][0]['turns'][0]['role'] = 'system',
    'project task unknown agent': (a) =>
        a['data']['projects'][0]['tasks'][0]['agentId'] = 'other',
    'connection permission claim': (a) =>
        a['data']['connections'][0]['reauthorizationRequired'] = false,
    'connection credential field': (a) =>
        a['data']['connections'][0]['accessToken'] =
            'synthetic-invalid-secret-field',
    'skill short instructions': (a) =>
        a['data']['skills'][0]['instructions'] = 'short',
    'Agent unknown policy': (a) =>
        a['data']['agents'][0]['approvalPolicy'] = 'none',
    'Agent too many skills': (a) =>
        a['data']['agents'][0]['skillIds'] = List.filled(31, 'x'),
    'exclusion noncode': (a) =>
        a['manifest']['exclusions'][0]['reason'] = 'unsafe text',
    'negative exclusion': (a) => a['manifest']['exclusions'][0]['count'] = -1,
    'secrets flag': (a) => a['manifest']['secretsExcluded'] = false,
    'credentials flag': (a) =>
        a['manifest']['connectorCredentialsExcluded'] = false,
    'reauthorization flag': (a) =>
        a['manifest']['connectorsRequireReauthorization'] = false,
    'unsupported manifest': (a) => a['manifest']['schemaVersion'] = 2,
    'wrong contract': (a) => a['manifest']['contractId'] = 'other',
    'wrong exporter': (a) => a['provenance']['exporterId'] = 'other',
    'changed disposition': (a) =>
        a['manifest']['sections']['connections']['restoreDisposition'] =
            'restore',
  };
  for (final entry in schemaCases.entries) {
    test(
      'strict schema rejects ${entry.key} even with matching outer digests',
      () async {
        final archive = _fixture();
        entry.value(archive);
        _rehash(archive);
        await expectLater(_verify(archive), _failure('invalid_archive'));
      },
    );
  }

  for (final name in [
    'knowledge',
    'memories',
    'threads',
    'today',
    'projects',
    'connections',
    'skills',
    'agents',
  ]) {
    test(
      'rejects duplicate $name identity with recomputed counts and digests',
      () async {
        final archive = _fixture();
        final rows = archive['data'][name] as List;
        rows.add(rows.first);
        _rehash(archive);
        await expectLater(_verify(archive), _failure('invalid_archive'));
      },
    );
  }

  for (final name in ['skills', 'agents']) {
    test('rejects duplicate $name names independently of source IDs', () async {
      final archive = _fixture();
      final rows = archive['data'][name] as List;
      rows.add({
        ...rows.first as Map<String, dynamic>,
        'sourceId': 'distinct-id',
      });
      _rehash(archive);
      await expectLater(_verify(archive), _failure('invalid_archive'));
    });
  }

  test('rejects duplicate project task hashes', () async {
    final archive = _fixture();
    final tasks = archive['data']['projects'][0]['tasks'] as List;
    tasks.add(tasks.first);
    _rehash(archive);
    await expectLater(_verify(archive), _failure('invalid_archive'));
  });

  for (final timestamp in [
    '2026-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-10-05T24:00:00Z',
    '2026-10-05T00:60:00Z',
    '2026-10-05T00:00:60Z',
    '2026-10-05T00:00:00+00:00',
    '2026-10-05',
    'private-date-sentinel',
  ]) {
    test('rejects malformed UTC timestamp $timestamp', () async {
      final archive = _fixture();
      archive['exportedAt'] = timestamp;
      _rehash(archive);
      await expectLater(_verify(archive), _failure('invalid_archive'));
    });
  }

  test('accepts Zod UTC minute precision and leap year', () async {
    final archive = _fixture('minimal');
    archive['exportedAt'] = '2024-02-29T12:34Z';
    _rehash(archive);
    expect(
      (await _verify(archive)).exportedAt,
      DateTime.utc(2024, 2, 29, 12, 34),
    );
  });

  test('rejects count, total and unknown-count substitution', () async {
    for (final mutation in <void Function(Map<String, dynamic>)>[
      (a) => a['manifest']['sections']['knowledge']['includedCount'] = 2,
      (a) => a['manifest']['totals']['includedCount'] = 8,
      (a) => a['manifest']['totals']['excludedCount'] = 5,
    ]) {
      final archive = _fixture();
      mutation(archive);
      final manifest = Map<String, dynamic>.of(
        archive['manifest'] as Map<String, dynamic>,
      )..remove('manifestSha256');
      archive['manifest']['manifestSha256'] = portableCanonicalSha256(manifest);
      final body = Map<String, dynamic>.of(archive)..remove('archiveSha256');
      archive['archiveSha256'] = portableCanonicalSha256(body);
      await expectLater(_verify(archive), _failure('invalid_archive'));
    }
  });

  test('rejects omitted section and unsupported version or assets', () async {
    final missing = _fixture();
    (missing['data'] as Map).remove('skills');
    await expectLater(_verify(missing), _failure('invalid_archive'));
    final version = _fixture()..['version'] = 1;
    await expectLater(_verify(version), _failure('unsupported_archive'));
    final encryption = _fixture()..['assetEncryption'] = <String, dynamic>{};
    await expectLater(_verify(encryption), _failure('unsupported_assets'));
    final assets = _fixture();
    assets['data']['assets'] = [{}];
    await expectLater(_verify(assets), _failure('unsupported_assets'));
  });

  test('transport size, invalid UTF-8, truncation and depth reject without content errors', () async {
    for (final bytes in [
      Uint8List(0),
      Uint8List.fromList([0xff]),
      Uint8List.fromList(utf8.encode('{"private-sentinel":')),
      Uint8List.fromList(utf8.encode('${'[' * 34}0${']' * 34}')),
    ]) {
      await expectLater(
        verifyPortableArchive(bytes, tenantId: _tenant, actorId: _actor),
        _failure('invalid_archive'),
      );
    }
    await expectLater(
      verifyPortableArchive(
        Uint8List(portableArchiveMaxBytes + 1),
        tenantId: _tenant,
        actorId: _actor,
      ),
      _failure('archive_too_large'),
    );
  });

  test(
    'section and nested record ceilings are enforced before hashes',
    () async {
      final cases = <String, int>{
        'knowledge': 5001,
        'memories': 20001,
        'threads': 101,
        'today': 251,
        'projects': 101,
        'connections': 101,
        'skills': 251,
        'agents': 101,
      };
      for (final entry in cases.entries) {
        final archive = _fixture('minimal');
        archive['data'][entry.key] = List.filled(entry.value, null);
        await expectLater(_verify(archive), _failure('invalid_archive'));
      }
      for (final mutate in <void Function(Map<String, dynamic>)>[
        (a) => a['data']['threads'][0]['turns'] = List.filled(101, null),
        (a) => a['data']['projects'][0]['tasks'] = List.filled(21, null),
        (a) =>
            a['data']['connections'][0]['scopes'] = List.filled(101, 'scope'),
        (a) => a['data']['memories'][0]['evidenceRefs'] = List.filled(
          101,
          'evidence',
        ),
        (a) => a['manifest']['exclusions'] = List.filled(101, null),
      ]) {
        final archive = _fixture();
        mutate(archive);
        await expectLater(_verify(archive), _failure('invalid_archive'));
      }
    },
  );
}
