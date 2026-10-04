import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/quality/quality_contracts.dart';
import 'package:asael/features/quality/quality_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'quality_test_fixtures.dart';

const qualityUser = '11111111-1111-4111-8111-111111111111';
QualityEvaluationsSnapshot qualitySnapshot({String tenantId = 'tenant-a'}) =>
    QualityEvaluationsSnapshot.parse(
      qualityEvaluationsJson(tenantId: tenantId),
      tenantId: tenantId,
    );
QualityReleaseReport qualityReport({String tenantId = 'tenant-a'}) =>
    QualityReleaseReport.parse(
      qualityReleaseJson(tenantId: tenantId),
      tenantId: tenantId,
    );

class QualityRequest<T> {
  QualityRequest(this.cancel);
  final CancelToken cancel;
  final Completer<T> result = Completer<T>();
}

class QualityTestRepository implements QualityRepository {
  bool active = true;
  bool releaseAllowed = true;
  void Function()? probe;
  Object? synchronousFailure;
  final evaluationsRequests = <QualityRequest<QualityEvaluationsSnapshot>>[];
  final releaseRequests = <QualityRequest<QualityReleaseReport>>[];
  @override
  bool get current {
    probe?.call();
    return active;
  }

  @override
  bool get canReadRelease => releaseAllowed;
  @override
  Future<QualityEvaluationsSnapshot> evaluations(CancelToken cancel) {
    if (synchronousFailure case final failure?) throw failure;
    final read = QualityRequest<QualityEvaluationsSnapshot>(cancel);
    evaluationsRequests.add(read);
    return read.result.future;
  }

  @override
  Future<QualityReleaseReport> release(CancelToken cancel) {
    if (synchronousFailure case final failure?) throw failure;
    final read = QualityRequest<QualityReleaseReport>(cancel);
    releaseRequests.add(read);
    return read.result.future;
  }
}

class QualityTestApi extends ApiClient {
  QualityTestApi()
    : super(
        Dio(BaseOptions(baseUrl: 'https://workspace.example.test')),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  final paths = <String>[];
  final tokens = <CancelToken>[];
  final authorities = <NativeRequestAuthority>[];
  Future<Map<String, dynamic>> Function(String)? reader;
  @override
  Future<Map<String, dynamic>> getJsonAuthorized(
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

NativeWorkspaceAccess qualityAccess(
  QualityTestApi api, {
  bool Function()? current,
  String role = 'admin',
}) => NativeWorkspaceAccess(
  api,
  NativeRequestAuthority(
    tenantId: 'tenant-a',
    actorId: 'owner@example.test',
    canonicalUserId: qualityUser,
    role: role,
    apiBaseUrl: api.apiBaseUrl,
    isCurrent: current ?? () => true,
  ),
  {'operator', 'admin', 'system'}.contains(role),
);
