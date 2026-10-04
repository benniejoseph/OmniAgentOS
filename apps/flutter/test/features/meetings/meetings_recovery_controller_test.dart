import 'dart:async';
import 'dart:io';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:asael/features/meetings/meetings_action_controller.dart';
import 'package:asael/features/meetings/meetings_draft_store.dart';
import 'package:asael/features/meetings/meetings_mutations.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_recovery_test_support.dart';
import 'meetings_test_support.dart';

void main() {
  late Directory directory;
  MeetingTestRecoveryBroker createBroker() => MeetingTestRecoveryBroker(
    LocalCiphertextRecoveryBroker.forTesting(() async => directory),
  );
  EncryptedMeetingDraftStore createStore(CiphertextRecoveryBroker broker) =>
      EncryptedMeetingDraftStore(
        () async => meetingRecoverySecret,
        broker: broker,
      );
  setUp(() async {
    directory = await Directory.systemTemp.createTemp(
      'asael-meeting-recovery-',
    );
  });
  tearDown(() async {
    await directory.delete(recursive: true);
  });

  test('two initialized windows cannot replace the first pending request or dispatch a second key', () async {
    final firstRepository = FakeMeetingsRepository(),
        secondRepository = FakeMeetingsRepository(),
        first = MeetingActionController(
          firstRepository,
          createStore(createBroker()),
          'new',
        ),
        second = MeetingActionController(
          secondRepository,
          createStore(createBroker()),
          'new',
        );
    addTearDown(first.dispose);
    addTearDown(second.dispose);
    await first.initialize();
    await second.initialize();
    final entered = Completer<void>(),
        response = Completer<Map<String, dynamic>>(),
        exact = createSubmission();
    firstRepository.writer = (_) {
      entered.complete();
      return response.future;
    };
    final writing = first.submit(exact, refresh: () async => true);
    await entered.future;
    expect(
      await second.submit(createSubmission(), refresh: () async => true),
      isFalse,
    );
    expect(secondRepository.writes, 0);
    expect(second.recoveryBlocked, isTrue);
    expect(second.error, contains('not sent'));
    expect(
      (await createStore(createBroker()).read(meetingOwner, 'new'))!['pending'],
      exact.json,
    );
    response.complete(await createMeetingReceipt(exact));
    expect(await writing, isTrue);
    await second.reloadRecovery();
    expect(second.recoveryBlocked, isFalse);
    expect(second.uncertain, isFalse);
    expect(second.recorded!['key'], exact.key);
    expect(secondRepository.writes, 0);
  });

  test('a committed intent with lost storage acknowledgement never dispatches until fresh read and explicit same-key retry', () async {
    final broker = createBroker()
      ..afterWrite = (attempt) async {
        if (attempt == 1) {
          throw const RecoveryStorageUnknown();
        }
      };
    final repository = FakeMeetingsRepository()..writer = createMeetingReceipt,
        actions = MeetingActionController(
          repository,
          createStore(broker),
          'new',
        ),
        exact = createSubmission();
    addTearDown(actions.dispose);
    await actions.initialize();
    expect(await actions.submit(exact, refresh: () async => true), isFalse);
    expect(repository.writes, 0);
    expect(actions.recoveryBlocked, isTrue);
    actions.updateDraft({'title': 'Still visible, not saved'});
    await actions.flushDraft();
    expect(broker.writes, 1);
    expect(await actions.retry(refresh: () async => true), isFalse);
    await actions.reloadRecovery();
    expect(actions.recoveryBlocked, isFalse);
    expect(actions.uncertain, isTrue);
    expect(actions.submitted!.json, exact.json);
    expect(repository.writes, 0);
    expect(await actions.retry(refresh: () async => true), isTrue);
    expect(repository.submissions.single.json, exact.json);
  });

  test('accepted receipt with an uncommitted local settlement survives failed reload then settles the exact request without HTTP replay', () async {
    final broker = createBroker()
      ..beforeWrite = (attempt) async {
        if (attempt == 2) {
          throw const RecoveryStorageUnavailable();
        }
      };
    final repository = FakeMeetingsRepository()..writer = createMeetingReceipt,
        actions = MeetingActionController(
          repository,
          createStore(broker),
          'new',
        ),
        exact = createSubmission();
    addTearDown(actions.dispose);
    await actions.initialize();
    expect(await actions.submit(exact, refresh: () async => false), isTrue);
    final receipt = actions.accepted;
    expect(actions.busy, isFalse);
    expect(actions.recoveryBlocked, isTrue);
    expect(
      await actions.submit(createSubmission(), refresh: () async => true),
      isFalse,
    );
    broker.beforeRead = () async => throw const RecoveryStorageUnavailable();
    await actions.reloadRecovery();
    expect(identical(actions.accepted, receipt), isTrue);
    expect(actions.recoveryBlocked, isTrue);
    broker.beforeRead = null;
    await actions.reloadRecovery();
    expect(identical(actions.accepted, receipt), isTrue);
    expect(actions.recoveryBlocked, isFalse);
    expect(actions.uncertain, isFalse);
    expect(repository.writes, 1);
    final saved = await createStore(createBroker()).read(meetingOwner, 'new');
    expect(saved!['pending'], isNull);
    expect(saved['recorded']['receiptSha256'], receipt!.receiptSha256);
    expect(saved['draft']['savedReceipt'], receipt.receiptSha256);
    expect(broker.writes, 3);
  });

  test('accepted receipt whose local commit acknowledgement is lost restores the committed record without another write', () async {
    final broker = createBroker()
      ..afterWrite = (attempt) async {
        if (attempt == 2) {
          throw const RecoveryStorageUnknown();
        }
      };
    final repository = FakeMeetingsRepository()..writer = createMeetingReceipt,
        actions = MeetingActionController(
          repository,
          createStore(broker),
          'new',
        );
    addTearDown(actions.dispose);
    await actions.initialize();
    expect(
      await actions.submit(createSubmission(), refresh: () async => true),
      isTrue,
    );
    final accepted = actions.accepted;
    expect(actions.recoveryBlocked, isTrue);
    await actions.reloadRecovery();
    expect(actions.recoveryBlocked, isFalse);
    expect(actions.recorded!['receiptSha256'], accepted!.receiptSha256);
    expect(identical(actions.accepted, accepted), isTrue);
    expect(broker.writes, 2);
    expect(repository.writes, 1);
  });

  test('matching target and key cannot settle a different frozen body after an accepted receipt', () async {
    final broker = createBroker()
      ..beforeWrite = (attempt) async {
        if (attempt == 2) {
          throw const RecoveryStorageUnavailable();
        }
      };
    final repository = FakeMeetingsRepository()..writer = createMeetingReceipt,
        actions = MeetingActionController(
          repository,
          createStore(broker),
          'new',
        ),
        exact = createSubmission();
    addTearDown(actions.dispose);
    await actions.initialize();
    await actions.submit(exact, refresh: () async => true);
    final accepted = actions.accepted, otherStore = createStore(createBroker());
    await otherStore.read(meetingOwner, 'new');
    final changed = MeetingSubmission.freeze(
      action: exact.action,
      id: exact.id,
      key: exact.key,
      owner: meetingOwner,
      body: {...exact.body, 'title': 'A different reviewed body'},
      evidence: exact.evidence,
    );
    await otherStore.write(meetingOwner, 'new', {
      'draft': {},
      'pending': changed.json,
      'recorded': null,
    }, isCurrent: () => true);
    await actions.reloadRecovery();
    expect(actions.uncertain, isTrue);
    expect(actions.submitted!.json, changed.json);
    expect(actions.recorded, isNull);
    expect(identical(actions.accepted, accepted), isTrue);
    expect(broker.writes, 2);
    expect(repository.writes, 1);
  });

  test('an unresolved local request is retained when a fresh record has another pending identity', () async {
    final repository = FakeMeetingsRepository()
          ..writer = (_) => Future.error(const ApiException('Lost response')),
        actions = MeetingActionController(
          repository,
          createStore(createBroker()),
          'new',
        ),
        exact = createSubmission();
    addTearDown(actions.dispose);
    await actions.initialize();
    await actions.submit(exact, refresh: () async => true);
    expect(actions.uncertain, isTrue);
    final otherStore = createStore(createBroker()),
        changed = createSubmission();
    await otherStore.read(meetingOwner, 'new');
    await otherStore.write(meetingOwner, 'new', {
      'draft': {},
      'pending': changed.json,
      'recorded': null,
    }, isCurrent: () => true);
    await actions.reloadRecovery();
    expect(actions.recoveryBlocked, isTrue);
    expect(actions.submitted!.json, exact.json);
    expect(await actions.retry(refresh: () async => true), isFalse);
    expect(repository.writes, 1);
    expect(
      (await otherStore.read(meetingOwner, 'new'))!['pending'],
      changed.json,
    );
  });

  test('the exclusive action slot remains held while the accepted receipt is being stored', () async {
    final entered = Completer<void>(),
        release = Completer<void>(),
        broker = createBroker()
          ..beforeWrite = (attempt) async {
            if (attempt == 2) {
              entered.complete();
              await release.future;
            }
          };
    final repository = FakeMeetingsRepository()..writer = createMeetingReceipt,
        actions = MeetingActionController(
          repository,
          createStore(broker),
          'new',
        );
    addTearDown(actions.dispose);
    await actions.initialize();
    final sending = actions.submit(
      createSubmission(),
      refresh: () async => true,
    );
    await entered.future;
    expect(actions.accepted, isNotNull);
    expect(actions.busy, isFalse);
    expect(actions.blocked, isTrue);
    expect(
      await actions.submit(createSubmission(), refresh: () async => true),
      isFalse,
    );
    release.complete();
    expect(await sending, isTrue);
    expect(actions.blocked, isFalse);
    expect(repository.writes, 1);
  });

  test('access invalidation during protected intent write cannot dispatch or restore private state', () async {
    final entered = Completer<void>(),
        release = Completer<void>(),
        broker = createBroker()
          ..afterWrite = (_) async {
            entered.complete();
            await release.future;
          };
    final repository = FakeMeetingsRepository()..writer = createMeetingReceipt,
        actions = MeetingActionController(
          repository,
          createStore(broker),
          'new',
        );
    addTearDown(actions.dispose);
    await actions.initialize();
    final sending = actions.submit(
      createSubmission(),
      refresh: () async => true,
    );
    await entered.future;
    repository.access.update(meetingOwner, available: false);
    release.complete();
    expect(await sending, isFalse);
    expect(repository.writes, 0);
    expect(actions.draft, isEmpty);
    expect(actions.submitted, isNull);
    expect(actions.accepted, isNull);
  });

  test('a held recovery read cannot repaint a dependency generation that was invalidated', () async {
    final repository = FakeMeetingsRepository()..writer = createMeetingReceipt,
        broker = createBroker(),
        actions = MeetingActionController(
          repository,
          createStore(broker),
          'new',
        );
    addTearDown(actions.dispose);
    await actions.initialize();
    await actions.submit(createSubmission(), refresh: () async => true);
    final entered = Completer<void>(), release = Completer<void>();
    broker.afterRead = () async {
      entered.complete();
      await release.future;
    };
    final reading = actions.reloadRecovery();
    await entered.future;
    expect(actions.recovering, isTrue);
    repository.access.update(meetingOwner, available: false);
    release.complete();
    await reading;
    expect(actions.initialized, isFalse);
    expect(actions.recorded, isNull);
    expect(actions.accepted, isNull);
    expect(actions.submitted, isNull);
    expect(repository.writes, 1);
  });
}
