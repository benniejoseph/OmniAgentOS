import 'dart:convert';
import 'dart:io';

import 'package:asael/features/settings/portable_archive_canonical.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final corpus = jsonDecode(
    File('test/fixtures/portable_archive/canonical-corpus.json')
        .readAsStringSync(),
  ) as Map<String, dynamic>;
  group('authoritative Node canonical parity', () {
    for (final entry in corpus['cases'] as List) {
      final sample = entry as Map<String, dynamic>;
      test(sample['name'] as String, () {
        final value = decodePortableJson(sample['inputJson'] as String);
        expect(portableCanonicalJson(value), sample['canonicalJson']);
        expect(portableCanonicalSha256(value), sample['sha256']);
      });
    }
  });

  test('all parsed JSON numbers use server binary64 semantics', () {
    final value = decodePortableJson('[1,1.0,-0,9007199254740993]') as List;
    expect(value.every((number) => number is double), isTrue);
    expect((value[2] as double).isNegative, isTrue);
    expect(portableCanonicalJson(value), '[1,1,0,9007199254740992]');
  });

  test('text hashing matches server replacement of lone surrogates', () {
    final archive = jsonDecode(
      File('test/fixtures/portable_archive/populated.json').readAsStringSync(),
    ) as Map<String, dynamic>;
    final item =
        (archive['data']['knowledge'] as List).single as Map<String, dynamic>;
    expect(
      portableTextSha256(item['content'] as String),
      item['contentSha256'],
    );
  });

  test('rejects nesting before recursive decoding or hashing', () {
    expect(
      () => decodePortableJson('${'[' * 34}0${']' * 34}'),
      throwsFormatException,
    );
    expect(
      () => portableCanonicalJson(List.generate(1, (_) => _nested(34))),
      throwsFormatException,
    );
  });

  test('bounds node count during parsing', () {
    expect(
      () => decodePortableJson('[${'0,' * 1000000}0]'),
      throwsFormatException,
    );
  });

  for (final value in [
    '',
    ' ',
    '[',
    '{',
    '[0,]',
    '{"a":1,}',
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '01',
    '-01',
    '+1',
    '.1',
    '1.',
    '1e',
    'NaN',
    'Infinity',
    '1e400',
    '"\\x20"',
    '"\\u12xx"',
    '"\n"',
    'true false',
    'nullx',
    '${'1' * 129}e-128',
  ]) {
    test('rejects malformed or ambiguous JSON ${jsonEncode(value)}', () {
      expect(() => decodePortableJson(value), throwsFormatException);
    });
  }

  test('non-JSON and nonfinite values cannot be canonicalized', () {
    for (final value in [
      double.infinity,
      double.nan,
      DateTime.utc(2026),
      <int, Object?>{1: null},
    ]) {
      expect(() => portableCanonicalJson(value), throwsFormatException);
    }
  });
}

Object _nested(int depth) => depth == 0 ? 0 : [_nested(depth - 1)];
