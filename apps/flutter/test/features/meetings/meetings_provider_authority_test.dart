import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/meetings/meetings.dart';
import 'package:asael/features/meetings/meetings_access.dart';
import 'package:asael/features/meetings/meetings_api_repository.dart';
import 'package:asael/features/meetings/meetings_providers.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_test_support.dart';

void main() {
  setUp(() {
    final previous = FlutterError.onError;
    final errors = <FlutterErrorDetails>[];
    FlutterError.onError = errors.add;
    addTearDown(() {
      FlutterError.onError = previous;
      expect(
        errors,
        isEmpty,
        reason: 'Meeting dependency replacement/disposal must not publish through a disposed Ref.',
      );
    });
  });

  for (final disposeRepository in [false, true]) {
    test(
      'a successful probe cannot admit Meeting data after ${disposeRepository ? 'repository disposal' : 'access closure'}',
      () async {
        final api = _Api(),
            access = MeetingsAccess(owner: meetingOwner, ready: true);
        late final ApiMeetingsRepository repository;
        repository = ApiMeetingsRepository(
          api,
          access: access,
          authorityProbe: () {
            if (disposeRepository) {
              repository.dispose();
            } else {
              access.close(notify: false);
            }
            return true;
          },
        );
        addTearDown(() {
          repository.dispose();
          access.dispose();
        });
        expect(repository.authorityCurrent(), isFalse);
        await expectLater(
          repository.listSnapshot(CancelToken()),
          throwsStateError,
        );
        expect(api.tokens, isEmpty);
        expect(api.writes, 0);
      },
    );
  }

  test('real API dependency replacement cancels an outgoing read before a provider pump', () async {
    final harness = await _Harness.create();
    addTearDown(harness.dispose);
    final old = harness.controller;
    final repository = harness.repository;
    final outgoing = harness.api;
    final held = Completer<Json>(), started = Completer<void>();
    outgoing.read = () {
      if (!started.isCompleted) started.complete();
      return held.future;
    };
    final refresh = old.refresh();
    await started.future;
    harness.api = _Api(origin: 'https://replacement.example.test');
    harness.container.invalidate(apiClientProvider);
    expect(old.readable, isFalse);
    expect(repository.access.closed, isTrue);
    expect(outgoing.tokens.last.isCancelled, isTrue);
    held.complete(
      await outgoing.response(title: 'Late outgoing private Meeting'),
    );
    await refresh;
    expect(
      old.meetings.map((meeting) => meeting.title),
      isNot(contains('Late outgoing private Meeting')),
    );
    final current = harness.container.read(meetingsControllerProvider);
    expect(current, isNot(same(old)));
    expect(
      harness.repository.access.owner?.apiScope,
      'https://replacement.example.test',
    );
    current.setActive(true);
    await current.refresh();
    expect(current.meetings.single.title, 'Current verified Meeting');
    expect(harness.api.writes + outgoing.writes, 0);
  });

  test('outgoing authority probe stops when scope inspection invalidates access before rebuilding its Ref', () async {
    final harness = await _Harness.create();
    addTearDown(harness.dispose);
    final repository = harness.repository;
    final reads = harness.api.tokens.length;
    // Riverpod calls onDispose immediately on invalidation, but does not
    // replace the mounted Ref until rebuild. Closed access must win already.
    harness.api.onScopeRead = () =>
        harness.container.invalidate(meetingsRepositoryProvider);
    expect(repository.authorityCurrent(), isFalse);
    expect(repository.access.closed, isTrue);
    await expectLater(repository.listSnapshot(CancelToken()), throwsStateError);
    expect(harness.api.tokens.length, reads);
    expect(harness.repository, isNot(same(repository)));
    expect(harness.api.writes, 0);
  });

  test('loading, error, role, canonical-user and sign-out transitions revoke prior read state', () async {
    final harness = await _Harness.create();
    addTearDown(harness.dispose);
    final controller = harness.controller;
    expect(controller.meetings, isNotEmpty);
    harness.sessions.loading();
    expect(controller.readable, isFalse);
    expect(controller.meetings, isEmpty);
    harness.sessions.failed();
    expect(controller.readable, isFalse);
    expect(controller.meetings, isEmpty);
    final replacement = _session(user: _otherUser, role: 'viewer');
    harness.api.session = replacement;
    harness.sessions.replace(replacement);
    expect(controller.meetings, isEmpty);
    expect(harness.repository.access.owner?.userId, _otherUser);
    expect(harness.repository.access.owner?.canManage, isFalse);
    await controller.refresh();
    expect(controller.meetings.single.ownerActorId, 'actor:$_otherUser');
    harness.sessions.replace(null);
    expect(controller.readable, isFalse);
    expect(controller.meetings, isEmpty);
    expect(harness.api.writes, 0);
  });

  test('replacing the actual session provider fences its previous in-flight result', () async {
    final harness = await _Harness.create();
    addTearDown(harness.dispose);
    final controller = harness.controller;
    final held = Completer<Json>(), started = Completer<void>();
    final oldResponse = await harness.api.response(
      title: 'Previous session result',
    );
    harness.api.read = () {
      if (!started.isCompleted) started.complete();
      return held.future;
    };
    final refresh = controller.refresh();
    await started.future;
    final outgoingToken = harness.api.tokens.last;
    harness.initialSession = _session(user: _otherUser);
    harness.api.session = harness.initialSession;
    harness.api.read = null;
    harness.container.invalidate(sessionControllerProvider);
    expect(controller.readable, isFalse);
    expect(controller.meetings, isEmpty);
    expect(outgoingToken.isCancelled, isTrue);
    held.complete(oldResponse);
    await refresh;
    await harness.container.read(sessionControllerProvider.future);
    await controller.refresh();
    expect(harness.repository.access.owner?.userId, _otherUser);
    expect(controller.meetings.single.ownerActorId, 'actor:$_otherUser');
    expect(
      controller.meetings.map((meeting) => meeting.title),
      isNot(contains('Previous session result')),
    );
    expect(harness.api.writes, 0);
  });

  test('container disposal silently revokes and cancels before a late result settles', () async {
    final harness = await _Harness.create();
    addTearDown(harness.dispose);
    final controller = harness.controller, repository = harness.repository;
    final held = Completer<Json>(), started = Completer<void>();
    harness.api.read = () {
      if (!started.isCompleted) started.complete();
      return held.future;
    };
    final refresh = controller.refresh();
    await started.future;
    harness.dispose();
    expect(repository.access.closed, isTrue);
    expect(controller.readable, isFalse);
    expect(harness.api.tokens.last.isCancelled, isTrue);
    held.complete(await harness.api.response(title: 'Late disposed result'));
    await refresh;
    expect(
      controller.meetings.map((meeting) => meeting.title),
      isNot(contains('Late disposed result')),
    );
    final reads = harness.api.tokens.length;
    await controller.refresh();
    expect(harness.api.tokens.length, reads);
    expect(harness.api.writes, 0);
  });
}

const _otherUser = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
AppSession _session({String user = meetingUserId, String role = 'operator'}) =>
    AppSession(
      tenantId: meetingOwner.tenantId,
      actorId: meetingOwner.actorId,
      userId: user,
      email: meetingOwner.actorId,
      displayName: 'Meeting owner',
      workspaceName: 'Meetings',
      role: role,
    );

class _Sessions extends SessionController {
  _Sessions(this.restore);
  final AppSession Function() restore;
  @override
  // AsyncNotifier keeps this instance when invalidated. Like the real session
  // repository restore, each build must read the current external identity.
  Future<AppSession?> build() async => restore();
  void replace(AppSession? value) => state = AsyncData(value);
  void loading() => state = const AsyncLoading();
  void failed() =>
      state = AsyncError(StateError('Session unavailable'), StackTrace.current);
}

class _NoSessionEffects extends Fake implements SessionRepository {}

class _Api extends ApiClient {
  _Api({String origin = 'https://api.example.test'})
    : super(
        Dio(BaseOptions(baseUrl: origin)),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  AppSession session = _session();
  Future<Json> Function()? read;
  VoidCallback? onScopeRead;
  final tokens = <CancelToken>[];
  int writes = 0;
  @override
  String get apiBaseUrl {
    final callback = onScopeRead;
    onScopeRead = null;
    callback?.call();
    return super.apiBaseUrl;
  }

  Future<Json> response({String title = 'Current verified Meeting'}) async {
    final row = meetingJson(title: title);
    row['ownerActorId'] = 'actor:${session.userId}';
    row['revisedByActorId'] = 'actor:${session.userId}';
    final context = meetingContextJson();
    if (session.role == 'viewer') {
      context['accessLevel'] = 'reader';
      context['canWrite'] = false;
    }
    return sealMeetingRead({
      'context': context,
      'meetings': [row],
    }, 'app.meetings.list');
  }

  @override
  Future<Json> getJsonFreshCancelable(
    String path, {
    Json? query,
    Json? headers,
    required CancelToken cancelToken,
  }) {
    if (path != NativePaths.meetingsList()) {
      throw StateError('Unexpected Meeting read $path');
    }
    tokens.add(cancelToken);
    return read?.call() ?? response();
  }

  @override
  Future<Json> getJson(String path, {Json? query}) =>
      throw StateError('Meeting provider reads must be fresh.');
  @override
  Future<Json> postJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Json? data,
    Json? headers,
  }) async {
    writes++;
    throw StateError('Provider lifecycle checks must not submit a mutation.');
  }

  @override
  Future<Json> patchJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Json? data,
    Json? headers,
  }) async {
    writes++;
    throw StateError('Provider lifecycle checks must not submit a mutation.');
  }
}

class _Harness {
  _Api api = _Api();
  AppSession initialSession = _session();
  late _Sessions sessions;
  late ProviderContainer container;
  late MeetingsController controller;
  final reconnect = ReconnectCoordinator(
    () async => const [],
    const Stream.empty(),
  );
  bool _disposed = false;
  ApiMeetingsRepository get repository =>
      container.read(meetingsRepositoryProvider) as ApiMeetingsRepository;
  static Future<_Harness> create() async {
    final value = _Harness();
    value.container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWith((ref) => value.api),
        sessionControllerProvider.overrideWith(
          () => value.sessions = _Sessions(() => value.initialSession),
        ),
        biometricSessionLockControllerProvider.overrideWith(
          (ref) => BiometricSessionLockController(_NoSessionEffects()),
        ),
        reconnectCoordinatorProvider.overrideWithValue(value.reconnect),
      ],
    );
    await value.container.read(sessionControllerProvider.future);
    value.container.listen(meetingsControllerProvider, (_, _) {});
    value.controller = value.container.read(meetingsControllerProvider);
    value.controller.setActive(true);
    await value.controller.refresh();
    return value;
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    container.dispose();
    reconnect.dispose();
  }
}
