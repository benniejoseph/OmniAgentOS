import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import '../../core/network/native_workspace_access.dart';

typedef SpecialistJson = Map<String, dynamic>;
void specialistRequire(
  bool condition, [
  String message = 'The current specialist workspace is unavailable.',
]) {
  if (!condition) throw StateError(message);
}

SpecialistJson specialistMap(Object? value) {
  specialistRequire(value is Map && value.keys.every((key) => key is String));
  return Map<String, dynamic>.from(value as Map);
}

String specialistText(Object? value, [int maximum = 512]) {
  specialistRequire(
    value is String && value.isNotEmpty && value.length <= maximum,
  );
  return value as String;
}

SpecialistJson specialistFreeze(SpecialistJson value) {
  var nodes = 0;
  Object? freeze(Object? row, int depth) {
    specialistRequire(++nodes <= 150000 && depth < 24);
    if (row is Map) {
      return Map<String, dynamic>.unmodifiable(
        specialistMap(row)
            .map((key, value) => MapEntry(key, freeze(value, depth + 1))),
      );
    }
    if (row is List) {
      return List<Object?>.unmodifiable(
        row.map((value) => freeze(value, depth + 1)),
      );
    }
    specialistRequire(
      row == null ||
          row is String && row.length <= 200000 ||
          row is num && row.isFinite ||
          row is bool,
    );
    return row;
  }

  return freeze(value, 0) as SpecialistJson;
}

String specialistCanonical(Object? value) {
  if (value is Map) {
    final row = specialistMap(value), keys = row.keys.toList()..sort();
    return '{${keys.map((key) => '${jsonEncode(key)}:${specialistCanonical(row[key])}').join(',')}}';
  }
  if (value is List) return '[${value.map(specialistCanonical).join(',')}]';
  return jsonEncode(value);
}

Future<String> specialistSha(Object? value) async =>
    (await Sha256().hash(utf8.encode(specialistCanonical(value)))).bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();

class SpecialistOwner {
  SpecialistOwner(NativeWorkspaceAccess access)
    : key = jsonEncode([
        access.authority.apiBaseUrl,
        access.authority.tenantId,
        access.authority.canonicalUserId,
      ]);
  final String key;
}
