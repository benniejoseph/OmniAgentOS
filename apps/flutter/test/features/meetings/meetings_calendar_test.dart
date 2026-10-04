import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/meetings/meetings_access.dart';
import 'package:asael/features/meetings/meetings_api_repository.dart';
import 'package:asael/features/meetings/meetings_calendar_contracts.dart';
import 'package:asael/features/meetings/meetings_calendar_controller.dart';
import 'package:asael/features/meetings/meetings_calendar_view.dart';
import 'package:asael/features/meetings/meetings_draft_store.dart';
import 'package:asael/features/meetings/meetings_mutations.dart';
import 'package:asael/features/meetings/meetings_validation.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_test_support.dart';

const _time = '2026-10-05T10:00:00.000Z';
const _connectionId = '11111111-1111-4111-8111-111111111111';
const _operations = {
  'meetings.calendar.get',
  'meetings.calendar.sync',
  'meetings.calendar.sync.get',
};
MeetingJson _connection() => {
  'id': _connectionId,
  'tenantId': meetingOwner.tenantId,
  'ownerActorId': meetingOwner.actorId,
  'accountEmail': 'calendar@example.test',
  'authorizationGeneration': 3,
  'status': 'active',
  'calendarReadAllowed': true,
  'coverage': null,
  'lastSyncedAt': null,
  'retryAfter': null,
  'updatedAt': _time,
};
MeetingCalendarSubmission _submission({String key = 'calendar-key'}) =>
    MeetingCalendarSubmission.freeze(
      meetingOwner,
      MeetingCalendarConnection.parse(_connection(), meetingOwner),
      key: key,
    );
Future<MeetingJson> _seal(
  MeetingJson body,
  String operation, {
  MeetingCalendarSubmission? sent,
  int count = 1,
}) async {
  final mutation = operation == 'meetings.calendar.sync';
  MeetingJson? scope;
  if (mutation) {
    scope = {
      'version': 1,
      'tenantId': meetingOwner.tenantId,
      'initiatingActorId': meetingOwner.actorId,
      'executingPrincipalType': 'user',
      'executingPrincipalId': meetingOwner.actorId,
      'workspaceId': null,
      'projectId': null,
      'missionId': null,
      'delegationId': null,
      'correlationId': sent!.key,
      'causationId': _connectionId,
      'contextGrantIds': <String>[],
      'capabilityGrantIds': <String>[],
      'purpose': 'api.meetings.calendar.sync',
    };
  }
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': operation,
    'action': mutation ? 'write.memory' : 'read',
    'resourceType': 'meeting_calendar',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? 'meeting-calendar-sync-events.v1'
        : 'read_only:no_domain_mutation',
    'authoritySha256': await meetingSha({
      'boundaryVersion': 'p9.1-app-service-boundary:1',
      'tenantId': meetingOwner.tenantId,
      'actorId': meetingOwner.actorId,
      'role': meetingOwner.role,
      'executionScope': scope,
    }),
    'idempotencyKeySha256': mutation
        ? await meetingShaText('${meetingOwner.tenantId}\u0000${sent!.key}')
        : null,
    'outcomeSha256': await meetingSha(body),
    'resourceCount': count,
    'occurredAt': _time,
  };
  return {
    ...body,
    'serviceReceipt': {...receipt, 'receiptSha256': await meetingSha(receipt)},
  };
}

Future<MeetingJson> _sync(
  MeetingCalendarSubmission sent, {
  String state = 'settled',
  String status = 'healthy',
}) async => {
  'acceptance': {
    'contract': meetingCalendarAcceptanceContract,
    'id': await sent.id,
    'scope': sent.scope,
    'connectionId': sent.body['connectionId'],
    'authorizationGeneration': sent.body['expectedAuthorizationGeneration'],
    'idempotencyKeySha256': await sent.keySha256,
    'requestSha256': await meetingSha({
      'contract': meetingCalendarAcceptanceContract,
      'scope': sent.scope,
      'request': sent.body,
    }),
    'acceptedAt': _time,
  },
  'state': state,
  'updatedAt': _time,
  'settlement': state == 'settled'
      ? {
          'status': status,
          'imported': 2,
          'removed': 1,
          'cursorAdvanced': status == 'healthy',
          'coverage': {
            'status': status == 'partial' ? 'syncing' : status,
            'backfillState': status == 'healthy' ? 'complete' : 'in_progress',
            'lastAttemptedAt': _time,
            'lastSuccessfulAt': status == 'healthy' ? _time : null,
            'failureCode': status == 'error' ? 'processing_failed' : 'none',
          },
          'settledAt': _time,
        }
      : null,
};
Future<MeetingJson> _status({MeetingJson? blocked}) => _seal({
  'contract': meetingCalendarReadContract,
  'scope': meetingCalendarScope(meetingOwner),
  'connection': _connection(),
  'blockedSync': blocked,
}, 'meetings.calendar.get');
Future<MeetingJson> _result(
  MeetingCalendarSubmission sent, {
  bool mutation = true,
  String state = 'settled',
  String status = 'healthy',
}) async => _seal(
  {
    'contract': mutation
        ? meetingCalendarSyncContract
        : meetingCalendarReadContract,
    'scope': sent.scope,
    'sync': await _sync(sent, state: state, status: status),
    if (mutation) 'replayed': false,
  },
  mutation ? 'meetings.calendar.sync' : 'meetings.calendar.sync.get',
  sent: sent,
);

class _Repository extends FakeMeetingsRepository
    implements CalendarMeetingsRepository {
  _Repository() {
    access.operations.addAll(_operations);
  }
  int posts = 0, exactReads = 0;
  MeetingCalendarSubmission? last;
  Future<MeetingJson> Function()? statusRead;
  Future<MeetingJson> Function(MeetingCalendarSubmission)? syncWrite;
  Future<MeetingJson> Function(String, String)? exactRead;
  @override
  Future<MeetingJson> calendarStatus(CancelToken cancel) =>
      statusRead?.call() ?? _status();
  @override
  Future<MeetingJson> calendarSyncRead(
    String id,
    String keySha256,
    CancelToken cancel,
  ) {
    exactReads++;
    return exactRead?.call(id, keySha256) ??
        Future.error(
          const ApiException('Missing exact receipt', statusCode: 404),
        );
  }

  @override
  Future<MeetingJson> calendarSync(
    MeetingCalendarSubmission submitted, {
    required bool Function() isCurrent,
  }) {
    if (!isCurrent()) {
      throw StateError('Stale pretransport authority');
    }
    posts++;
    last = submitted;
    return syncWrite?.call(submitted) ?? _result(submitted);
  }
}

class _Store extends MemoryMeetingDraftStore {
  bool fail = false;
  bool loseSettlementAcknowledgement = false;
  Completer<void>? hold;
  void Function()? beforeWrite;
  @override
  Future<void> write(
    MeetingsOwner owner,
    String route,
    MeetingJson payload, {
    required bool Function() isCurrent,
  }) async {
    beforeWrite?.call();
    if (hold != null) {
      await hold!.future;
    }
    if (fail) {
      throw StateError('Protected storage unavailable');
    }
    await super.write(owner, route, payload, isCurrent: isCurrent);
    if (loseSettlementAcknowledgement && payload['recorded'] != null) {
      loseSettlementAcknowledgement = false;
      throw StateError('Settlement committed; storage acknowledgement lost');
    }
  }
}

Future<void> _ready(MeetingCalendarController controller) async {
  controller.setActive(true);
  await pumpEventQueue(times: 20);
  expect(controller.initialized, isTrue);
  expect(controller.loading, isFalse);
}

class _Api extends ApiClient {
  _Api()
    : super(
        Dio(BaseOptions(baseUrl: meetingOwner.apiScope)),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  String? path;
  NativeRequestAuthority? authority;
  MeetingJson? headers, body;
  Future<MeetingJson> Function()? reply;
  @override
  Future<MeetingJson> getJsonFreshCancelable(
    String path, {
    MeetingJson? query,
    MeetingJson? headers,
    required CancelToken cancelToken,
  }) {
    this.path = path;
    return reply!();
  }

  @override
  Future<MeetingJson> postJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    MeetingJson? data,
    MeetingJson? headers,
  }) async {
    this.path = path;
    this.authority = authority;
    body = data;
    this.headers = headers;
    return reply!();
  }
}

void main() {
  test('strict Calendar evidence binds account scope, both request digests and honest partial settlement', () async {
    final sent = _submission(),
        raw = await _result(_submission(), status: 'partial');
    final result = await MeetingCalendarResult.parse(
      raw,
      meetingOwner,
      sent: sent,
      mutation: true,
    );
    expect(result.sync.settlement!['status'], 'partial');
    expect(result.sync.settlement!['imported'], 2);
    expect(result.sync.acceptance['scope'], meetingCalendarScope(meetingOwner));
    final forged = {
      ...raw,
      'scope': {...sent.scope, 'workspaceId': 'workspace:shared'},
    };
    await expectLater(
      MeetingCalendarResult.parse(
        forged,
        meetingOwner,
        sent: sent,
        mutation: true,
      ),
      throwsFormatException,
    );
    await expectLater(
      MeetingCalendarResult.parse(
        raw,
        meetingOwner,
        sent: _submission(key: 'another-key'),
        mutation: true,
      ),
      throwsFormatException,
    );
    final changed = {
      ...raw,
      'sync': {
        ...meetingMap(raw['sync']),
        'settlement': {...result.sync.settlement!, 'status': 'healthy'},
      },
    };
    await expectLater(
      MeetingCalendarResult.parse(
        changed,
        meetingOwner,
        sent: sent,
        mutation: true,
      ),
      throwsFormatException,
    );
  });

  test('a settled sync is saved after exact protected admission and requires a fresh status before another request', () async {
    final repository = _Repository(), store = _Store();
    final subject = MeetingCalendarController(repository, store);
    await _ready(subject);
    repository.syncWrite = (sent) async {
      final saved = await store.read(
        meetingOwner,
        MeetingCalendarController.route,
      );
      expect(saved!['pending'], sent.json);
      return _result(sent);
    };
    expect(await subject.submit(subject.status!), isTrue);
    expect(repository.posts, 1);
    expect(subject.uncertain, isFalse);
    expect(subject.canSync, isFalse);
    expect(
      (await store.read(
        meetingOwner,
        MeetingCalendarController.route,
      ))!['pending'],
      isNull,
    );
    await subject.refresh();
    expect(subject.canSync, isTrue);
    subject.dispose();
    repository.access.dispose();
  });

  test('reload adopts the exact durable settlement after its storage acknowledgement is lost without another POST', () async {
    final repository = _Repository(),
        store = _Store(),
        controller = MeetingCalendarController(repository, store);
    await _ready(controller);
    store.loseSettlementAcknowledgement = true;
    await controller.submit(controller.status!);
    final pending = repository.last!;
    expect(controller.pending!.json, pending.json);
    expect(controller.recoveryBlocked, isTrue);
    final saved = await store.read(
      meetingOwner,
      MeetingCalendarController.route,
    );
    expect(saved!['pending'], isNull);
    expect(saved['recorded'], isNotNull);
    await controller.reloadRecovery();
    expect(controller.pending, isNull);
    expect(controller.uncertain, isFalse);
    expect(controller.recoveryBlocked, isFalse);
    expect(controller.storageError, isNull);
    expect(controller.result!.sync.id, await pending.id);
    expect(controller.canSync, isFalse);
    expect(repository.posts, 1);
    expect(repository.exactReads, 0);
    await controller.refresh();
    expect(controller.canSync, isTrue);
    controller.dispose();
    repository.access.dispose();
  });

  test('reload holds the original request when its durable record changes key, body, owner or terminal receipt', () async {
    for (final changed in ['key', 'body', 'owner', 'receipt']) {
      final repository = _Repository(),
          store = _Store(),
          controller = MeetingCalendarController(repository, store);
      await _ready(controller);
      store.loseSettlementAcknowledgement = true;
      await controller.submit(controller.status!);
      final original = repository.last!;
      var alternate = original;
      if (changed == 'key') {
        alternate = _submission(key: 'another-calendar-key');
      } else if (changed == 'body') {
        alternate = MeetingCalendarSubmission.freeze(
          meetingOwner,
          MeetingCalendarConnection.parse({
            ..._connection(),
            'authorizationGeneration': 4,
          }, meetingOwner),
          key: original.key,
        );
      }
      final request = changed == 'owner'
          ? {...alternate.json, 'ownerKey': 'foreign-owner'}
          : alternate.json;
      await store.write(meetingOwner, MeetingCalendarController.route, {
        'pending': null,
        'recorded': {
          'request': request,
          'response': await _result(
            alternate,
            status: changed == 'receipt' ? 'error' : 'healthy',
          ),
        },
      }, isCurrent: () => true);
      await controller.reloadRecovery();
      expect(controller.pending!.json, original.json, reason: changed);
      expect(controller.recoveryBlocked, isTrue, reason: changed);
      expect(controller.canSync, isFalse, reason: changed);
      expect(controller.storageError, isNotNull, reason: changed);
      expect(repository.posts, 1, reason: changed);
      expect(repository.exactReads, 0, reason: changed);
      controller.dispose();
      repository.access.dispose();
    }
  });

  test('lost response and missing exact GET remain held across restart without another POST', () async {
    final repository = _Repository(),
        store = _Store(),
        first = MeetingCalendarController(repository, store);
    repository.syncWrite = (_) =>
        Future.error(const ApiException('Response lost', statusCode: 503));
    await _ready(first);
    await first.submit(first.status!);
    final saved = repository.last!;
    expect(first.uncertain, isTrue);
    expect(repository.posts, 1);
    await first.recover();
    expect(first.uncertain, isTrue);
    expect(repository.posts, 1);
    first.dispose();
    final next = MeetingCalendarController(repository, store);
    await _ready(next);
    expect(next.pending!.json, saved.json);
    expect(next.canSync, isFalse);
    repository.exactRead = (id, keyHash) async {
      expect(id, await saved.id);
      expect(keyHash, await saved.keySha256);
      return _result(saved, mutation: false, status: 'error');
    };
    await next.recover();
    expect(next.uncertain, isFalse);
    expect(next.result!.sync.settlement!['status'], 'error');
    expect(repository.posts, 1);
    expect(repository.exactReads, 2);
    next.dispose();
    repository.access.dispose();
  });

  test('accepted and unconfirmed receipts never enable a second key, including a server-discovered held request', () async {
    final repository = _Repository(),
        controller = MeetingCalendarController(repository, _Store()),
        sent = _submission();
    repository.statusRead = () async =>
        _status(blocked: await _sync(sent, state: 'accepted'));
    repository.exactRead = (_, _) =>
        _result(sent, mutation: false, state: 'unconfirmed');
    await _ready(controller);
    expect(controller.canSync, isFalse);
    expect(controller.canRecover, isTrue);
    await controller.recover();
    expect(controller.uncertain, isTrue);
    expect(controller.result!.sync.state, 'unconfirmed');
    expect(repository.posts, 0);
    controller.dispose();
    repository.access.dispose();
  });

  test('protected storage failure and foreground invalidation before transport send no Calendar request', () async {
    final repository = _Repository(),
        store = _Store(),
        controller = MeetingCalendarController(repository, store);
    await _ready(controller);
    store.fail = true;
    await controller.submit(controller.status!);
    expect(repository.posts, 0);
    expect(controller.recoveryBlocked, isTrue);
    store.fail = false;
    await controller.reloadRecovery();
    await controller.refresh();
    expect(controller.canSync, isTrue);
    store.hold = Completer<void>();
    final sending = controller.submit(controller.status!);
    controller.setActive(false);
    store.hold!.complete();
    await sending;
    expect(repository.posts, 0);
    expect(controller.pending, isNull);
    expect(controller.status, isNull);
    controller.dispose();
    repository.access.dispose();
  });

  test('scope replacement and current role revoke erase exposed status and ignore late read results', () async {
    final repository = _Repository(),
        controller = MeetingCalendarController(repository, _Store());
    await _ready(controller);
    final delayed = Completer<MeetingJson>();
    repository.statusRead = () => delayed.future;
    final reading = controller.refresh();
    repository.access.update(meetingOwner, available: false);
    delayed.complete(await _status());
    await reading;
    expect(controller.status, isNull);
    expect(controller.available, isFalse);
    expect(controller.canSync, isFalse);
    controller.dispose();
    repository.access.dispose();
  });

  test('Calendar transport uses published fresh exact GET and guarded POST with the original body and raw key', () async {
    final api = _Api(),
        access = MeetingsAccess(
          owner: meetingOwner,
          ready: true,
          operations: _operations,
        ),
        sent = _submission();
    var current = true;
    final repository = ApiMeetingsRepository(
      api,
      access: access,
      authorityProbe: () => true,
    );
    api.reply = () => _result(sent, mutation: false);
    await repository.calendarSyncRead(
      await sent.id,
      await sent.keySha256,
      CancelToken(),
    );
    expect(
      api.path,
      NativePaths.meetingsCalendarSyncGet(
        await sent.id,
        acceptanceKeySha256: await sent.keySha256,
      ),
    );
    api.reply = () => _result(sent);
    await repository.calendarSync(sent, isCurrent: () => current);
    expect(api.path, NativePaths.meetingsCalendarSync);
    expect(api.body, sent.body);
    expect(api.headers, {'Idempotency-Key': sent.key});
    expect(api.authority!.isCurrent(), isTrue);
    current = false;
    expect(api.authority!.isCurrent(), isFalse);
    await expectLater(
      repository.calendarSync(sent, isCurrent: () => current),
      throwsStateError,
    );
    repository.dispose();
    access.dispose();
  });

  testWidgets(
    'Calendar review names the account and personal destination and held requests expose only receipt recovery',
    (tester) async {
      final repository = _Repository(),
          controller = MeetingCalendarController(repository, _Store());
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: MeetingCalendarPanel(controller: controller),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Account: calendar@example.test'), findsOneWidget);
      expect(
        find.textContaining('independently of the selected Meeting workspace'),
        findsOneWidget,
      );
      await tester.tap(find.text('Sync Calendar'));
      await tester.pumpAndSettle();
      expect(find.text('Sync Google Calendar?'), findsOneWidget);
      expect(
        find.textContaining('Authorization generation: 3'),
        findsOneWidget,
      );
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(repository.posts, 0);
      repository.statusRead = () async =>
          _status(blocked: await _sync(_submission(), state: 'accepted'));
      await controller.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Check exact sync receipt'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Sync Calendar'),
            )
            .onPressed,
        isNull,
      );
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
      repository.access.dispose();
    },
  );
}
