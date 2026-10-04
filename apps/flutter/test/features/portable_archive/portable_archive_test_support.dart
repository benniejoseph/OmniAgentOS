import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/results/created_file_export.dart';
import 'package:asael/features/settings/portable_archive_contracts.dart';
import 'package:asael/features/settings/portable_archive_controller.dart';
import 'package:asael/features/settings/portable_archive_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

const portableArchiveUser = '11111111-1111-4111-8111-111111111111';
const portableArchiveTenant = 'tenant-portable-fixture';
const portableArchiveActor = 'archive@example.test';
final portableArchiveTestBytes = Uint8List.fromList(
  utf8.encode('PRIVATE_ARCHIVE_CONTENT\nOriginal exact bytes'),
);
String portableArchiveTestHash(String character) =>
    List.filled(64, character).join();
AuthorizedByteResponse portableArchiveResponse() =>
    AuthorizedByteResponse(portableArchiveTestBytes, {
      'content-type': 'application/json',
      'x-asael-archive-sha256': portableArchiveTestHash('a'),
      'content-disposition':
          'attachment; filename="ignored-server-filename.json"',
    });
PortableArchiveReceipt portableArchiveReceipt() => PortableArchiveReceipt(
  exportedAt: DateTime.utc(2026, 10, 5),
  byteCount: portableArchiveTestBytes.length,
  archiveSha256: portableArchiveTestHash('a'),
  manifestSha256: portableArchiveTestHash('b'),
  includedCount: 1,
  excludedCount: null,
  sections: [
    for (final name in portableArchiveSectionNames)
      PortableArchiveSectionReceipt(
        name: name,
        includedCount: name == 'knowledge' ? 1 : 0,
        excludedCount: name == 'assets' ? null : 0,
        restoreDisposition: name == 'assets'
            ? 'not_included'
            : name == 'connections'
            ? 'reauthorization_required'
            : 'restore',
      ),
  ],
  exclusions: const [
    PortableArchiveExclusion(
      category: 'assets',
      reason: 'Original attachments were not requested.',
      count: null,
    ),
  ],
);

class PortableArchiveRequest {
  PortableArchiveRequest(this.cancel);
  final CancelToken cancel;
  final result = Completer<AuthorizedByteResponse>();
}

class PortableArchiveTestRepository implements PortableArchiveRepository {
  bool active = true;
  AuthorizedByteResponse? immediateResponse;
  final requests = <PortableArchiveRequest>[];
  final Set<void Function()> listeners = {};
  @override
  String get tenantId => portableArchiveTenant;
  @override
  String get actorId => portableArchiveActor;
  @override
  bool get current => active;
  @override
  void Function() observeInvalidation(void Function() listener) {
    if (!active) {
      listener();
      return () {};
    }
    listeners.add(listener);
    return () => listeners.remove(listener);
  }

  void invalidate() {
    if (!active) return;
    active = false;
    for (final listener in listeners.toList(growable: false)) {
      listener();
    }
    listeners.clear();
    for (final request in requests) {
      request.cancel.cancel('Archive test authority changed.');
    }
  }

  @override
  Future<AuthorizedByteResponse> download(CancelToken cancel) {
    if (!active || cancel.isCancelled) {
      throw const CreatedFileExportScopeChanged();
    }
    final request = PortableArchiveRequest(cancel);
    requests.add(request);
    if (immediateResponse != null) {
      request.result.complete(immediateResponse);
    }
    return request.result.future;
  }
}

class PortableArchiveVerificationCall {
  PortableArchiveVerificationCall(
    this.bytes,
    this.tenantId,
    this.actorId,
    this.expectedHash,
  );
  final Uint8List bytes;
  final String tenantId, actorId;
  final String? expectedHash;
  final result = Completer<PortableArchiveReceipt>();
}

class PortableArchiveTestVerifier implements PortableArchiveVerifier {
  bool disposed = false, honorCancellation = true;
  int cancellations = 0;
  PortableArchiveReceipt? immediateReceipt;
  final calls = <PortableArchiveVerificationCall>[];
  @override
  Future<PortableArchiveReceipt> verify(
    Uint8List bytes, {
    required String tenantId,
    required String actorId,
    String? expectedArchiveSha256,
  }) {
    final call = PortableArchiveVerificationCall(
      bytes,
      tenantId,
      actorId,
      expectedArchiveSha256,
    );
    calls.add(call);
    if (immediateReceipt != null) {
      call.result.complete(immediateReceipt);
    }
    return call.result.future;
  }

  @override
  void cancel() {
    cancellations++;
    if (honorCancellation) {
      for (final call in calls.where((call) => !call.result.isCompleted)) {
        call.result.completeError(const CreatedFileExportScopeChanged());
      }
    }
  }

  @override
  void dispose() {
    disposed = true;
    cancel();
  }
}

class PortableArchiveTestAdapter implements CreatedFileExportAdapter {
  PortableArchiveTestAdapter({this.available = true});
  @override
  final bool available;
  String? automaticDestination;
  final destinations = <Completer<String?>>[];
  final filenames = <String>[];
  final writes = <({String destination, List<int> bytes})>[];
  Completer<void>? beforeWrite, afterAdmission;
  Object? writeFailure;
  int writeCalls = 0;
  @override
  Future<String?> selectDestination({required String filename}) {
    filenames.add(filename);
    final destination = Completer<String?>();
    destinations.add(destination);
    if (automaticDestination != null) {
      destination.complete(automaticDestination);
    }
    return destination.future;
  }

  @override
  Future<void> writeBytes(
    String destination,
    Uint8List bytes, {
    required bool Function() isCurrent,
  }) async {
    writeCalls++;
    if (beforeWrite != null) {
      await beforeWrite!.future;
    }
    if (!isCurrent()) {
      throw const CreatedFileExportScopeChanged();
    }
    writes.add((destination: destination, bytes: List.of(bytes)));
    if (afterAdmission != null) {
      await afterAdmission!.future;
    }
    if (writeFailure != null) {
      throw writeFailure!;
    }
  }
}

class PortableArchiveTestApi extends ApiClient {
  PortableArchiveTestApi()
    : super(
        Dio(BaseOptions(baseUrl: 'https://archive.example.test')),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  String origin = 'https://archive.example.test';
  @override
  String get apiBaseUrl => origin;
  final paths = <String>[];
  final authorities = <NativeRequestAuthority>[];
  final tokens = <CancelToken>[];
  final limits = <int>[];
  final timeouts = <Duration>[];
  Future<AuthorizedByteResponse> Function() reader = () async =>
      portableArchiveResponse();
  @override
  Future<AuthorizedByteResponse> getBytesAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    required CancelToken cancelToken,
    int maximumBytes = 16 * 1024 * 1024,
    Duration timeout = const Duration(seconds: 150),
  }) {
    paths.add(path);
    authorities.add(authority);
    tokens.add(cancelToken);
    limits.add(maximumBytes);
    timeouts.add(timeout);
    return reader();
  }
}

NativeWorkspaceAccess portableArchiveAccess(
  PortableArchiveTestApi api, {
  String role = 'viewer',
  bool Function()? current,
}) => NativeWorkspaceAccess(
  api,
  NativeRequestAuthority(
    tenantId: portableArchiveTenant,
    actorId: portableArchiveActor,
    canonicalUserId: portableArchiveUser,
    role: role,
    apiBaseUrl: api.apiBaseUrl,
    isCurrent: current ?? () => true,
  ),
  role != 'viewer',
);
Future<void> portableArchiveFlush() => Future<void>.delayed(Duration.zero);

AppSession portableArchiveSession({
  String tenant = portableArchiveTenant,
  String actor = portableArchiveActor,
  String user = portableArchiveUser,
  String role = 'viewer',
}) => AppSession(
  tenantId: tenant,
  actorId: actor,
  userId: user,
  email: actor,
  displayName: 'Archive owner',
  workspaceName: 'Asael',
  role: role,
);

class PortableArchiveTestSessions extends SessionController {
  @override
  Future<AppSession?> build() async => portableArchiveSession();
  void replace(AppSession value) => state = AsyncData(value);
}

class _NoSessionEffects extends Fake implements SessionRepository {}

class PortableArchiveTestLock extends BiometricSessionLockController {
  PortableArchiveTestLock() : super(_NoSessionEffects());
  bool locked = false;
  @override
  BiometricSessionLockState get state => BiometricSessionLockState(
    phase: locked
        ? BiometricSessionLockPhase.locked
        : BiometricSessionLockPhase.unlocked,
  );
  void protect() {
    locked = true;
    notifyListeners();
  }
}
