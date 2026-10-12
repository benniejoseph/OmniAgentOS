import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../companion/companion_repository.dart';

const personalProfileFields =
    <({String key, String label, String hint, int limit})>[
      (
        key: 'name',
        label: 'What should ATLAS call you?',
        hint: 'Your preferred name',
        limit: 120,
      ),
      (
        key: 'role',
        label: 'What you do',
        hint: 'Your role and responsibilities',
        limit: 600,
      ),
      (
        key: 'workingContext',
        label: 'How you work',
        hint: 'Your working context, tools and practical constraints',
        limit: 2400,
      ),
      (
        key: 'preferences',
        label: 'How you like to be helped',
        hint: 'How you like to communicate and get things done',
        limit: 2000,
      ),
      (
        key: 'goals',
        label: 'What you’re working towards',
        hint: 'Your current goals and priorities',
        limit: 1600,
      ),
      (
        key: 'interests',
        label: 'What interests you',
        hint: 'Topics you would like ATLAS to understand',
        limit: 1200,
      ),
    ];

class PersonalProfileSource {
  const PersonalProfileSource(this.label, this.updatedAt);
  final String label;
  final DateTime updatedAt;
}

class PersonalProfileSnapshot {
  const PersonalProfileSnapshot({
    required this.revision,
    required this.enabled,
    required this.profile,
    required this.sources,
    required this.updatedAt,
  });
  final int revision;
  final bool enabled;
  final Map<String, String> profile;
  final Map<String, PersonalProfileSource> sources;
  final DateTime? updatedAt;

  factory PersonalProfileSnapshot.parse(Map<String, dynamic> data) {
    final profile = data['profile'], sources = data['fieldSources'];
    final revision = data['revision'];
    if (data['schemaVersion'] != 1 ||
        data['contract'] != 'asael-personal-profile:1' ||
        revision is! int ||
        revision < 0 ||
        data['enabled'] is! bool ||
        profile is! Map ||
        sources is! Map) {
      throw const FormatException('Your saved profile could not be verified.');
    }
    final values = <String, String>{};
    final fieldSources = <String, PersonalProfileSource>{};
    for (final field in personalProfileFields) {
      final value = profile[field.key];
      if (value is! String || value.length > field.limit) {
        throw const FormatException('A saved profile detail is invalid.');
      }
      values[field.key] = value;
      final source = sources[field.key];
      if (source != null) {
        if (source is! Map ||
            !const ['you', 'conversation'].contains(source['source']) ||
            source['updatedAt'] is! String) {
          throw const FormatException(
            'A profile source could not be verified.',
          );
        }
        final updated = DateTime.tryParse(source['updatedAt'] as String);
        if (updated == null) {
          throw const FormatException('A profile source date is invalid.');
        }
        fieldSources[field.key] = PersonalProfileSource(
          source['source'] == 'you'
              ? 'Provided by you'
              : 'Added from our conversation',
          updated,
        );
      }
    }
    final rawDate = data['updatedAt'];
    final updatedAt = rawDate is String ? DateTime.tryParse(rawDate) : null;
    if (rawDate != null && updatedAt == null) {
      throw const FormatException('The saved profile date is invalid.');
    }
    return PersonalProfileSnapshot(
      revision: revision,
      enabled: data['enabled'] as bool,
      profile: Map.unmodifiable(values),
      sources: Map.unmodifiable(fieldSources),
      updatedAt: updatedAt,
    );
  }
}

/// One live, owner-bound profile. No general offline cache or saved credentials.
class PersonalProfileRepository {
  PersonalProfileRepository(this.access);
  final NativeWorkspaceAccess access;
  final _reads = <CancelToken>{};
  final _listeners = <void Function()>{};
  bool _disposed = false;
  static const path = '/api/personal-context/profile';

  bool get current {
    if (_disposed) return false;
    try {
      final admitted = access.current;
      if (_disposed ||
          !admitted ||
          NativeRequestAuthority.normalizeApiBaseUrl(access.api.apiBaseUrl) !=
              NativeRequestAuthority.normalizeApiBaseUrl(
                access.authority.apiBaseUrl,
              )) {
        dispose();
      }
    } catch (_) {
      dispose();
    }
    return !_disposed;
  }

  void _check() {
    if (!current) throw const NativeAuthorityVerificationException();
  }

  NativeRequestAuthority get _authority => NativeRequestAuthority(
    tenantId: access.authority.tenantId,
    actorId: access.authority.actorId,
    canonicalUserId: access.authority.canonicalUserId,
    role: access.authority.role,
    apiBaseUrl: access.authority.apiBaseUrl,
    isCurrent: () => current,
  );

  Future<Map<String, dynamic>> _headers() async {
    _check();
    final digest = await companionOwnerDigest(
      access.authority.tenantId,
      access.authority.actorId,
    );
    _check();
    return {'x-asael-companion-owner-sha256': digest};
  }

  void Function() observeInvalidation(void Function() listener) {
    if (_disposed) {
      listener();
      return () {};
    }
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }

  Future<PersonalProfileSnapshot> read() async {
    _check();
    final cancel = CancelToken();
    _reads.add(cancel);
    try {
      final headers = await _headers();
      _check();
      final value = await access.api
          .getJsonAuthorized(
            path,
            authority: _authority,
            headers: headers,
            cancelToken: cancel,
          )
          .timeout(
            const Duration(seconds: 20),
            onTimeout: () {
              cancel.cancel('Profile read timed out.');
              throw const ApiException(
                'Your profile could not be loaded in time.',
              );
            },
          );
      _check();
      return PersonalProfileSnapshot.parse(value);
    } finally {
      _reads.remove(cancel);
    }
  }

  Future<PersonalProfileSnapshot> save({
    required int expectedRevision,
    required bool enabled,
    required Map<String, String> profile,
    required String key,
  }) async {
    _check();
    final headers = await _headers();
    _check();
    headers['Idempotency-Key'] = key;
    final value = await access.api
        .putJsonAuthorized(
          path,
          authority: _authority,
          data: {
            'expectedRevision': expectedRevision,
            'enabled': enabled,
            'profile': profile,
            'source': 'you',
          },
          headers: headers,
        )
        .timeout(const Duration(seconds: 30));
    _check();
    final saved = PersonalProfileSnapshot.parse(value);
    if (saved.revision != expectedRevision + 1 ||
        saved.enabled != enabled ||
        personalProfileFields.any(
          (field) => saved.profile[field.key] != profile[field.key],
        )) {
      throw const FormatException(
        'The saved profile did not match your changes.',
      );
    }
    return saved;
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    for (final listener in _listeners.toList(growable: false)) {
      listener();
    }
    _listeners.clear();
    for (final read in _reads) {
      read.cancel('Profile account changed.');
    }
    _reads.clear();
  }
}
