import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/features/capture/entity_options.dart';
import 'package:asael/features/capture/library_contracts.dart';
import 'package:asael/features/capture/library_controller.dart';
import 'package:asael/features/capture/library_repository.dart';
import 'package:asael/features/capture/library_view.dart';
import 'package:asael/features/meetings/meetings.dart';
import 'package:asael/features/meetings/meetings_action_controller.dart';
import 'package:asael/features/meetings/meetings_action_widgets.dart';
import 'package:asael/features/meetings/meetings_draft_store.dart';
import 'package:asael/features/meetings/meetings_form_model.dart';
import 'package:asael/features/meetings/meetings_mutations.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_test_support.dart';

LibraryItem _source({
  String authority = 'capture_asset',
  String kind = 'document',
  String status = 'ready',
  int revision = 1,
}) => LibraryItem.parse({
  'schemaVersion': 1,
  'id': 'library:$authority:source:one',
  'tenantId': meetingOwner.tenantId,
  'kind': kind,
  'sourceAuthority': authority,
  'sourceId': 'source:one',
  'title': 'Full $authority label',
  'summary': 'Reviewed source',
  'sourceLabel': 'Governed source',
  'status': status,
  'tags': <String>[],
  'scope': <String, dynamic>{
    'visibility': 'user_private',
    'ownerActorId': 'actor:$meetingUserId',
    'workspaceId': null,
    'projectId': null,
    'missionId': null,
    'workItemId': null,
    'permissionBasis': 'owner',
  },
  'currentVersion': <String, dynamic>{
    'versionId': 'version:$authority:$revision',
    'versionNumber': revision,
    'contentSha256': meetingDigest,
    'byteCount': 42,
    'mediaType': 'text/plain',
    'sourceRevisionId': authority == 'source_item'
        ? 'source-revision:$revision'
        : null,
    'createdAt': '2026-10-04T10:00:00.000Z',
  },
  'versionCount': revision,
  'citationRefs': ['capture:source:one'],
  'links': <Object?>[],
  'openHref': null,
  'createdAt': '2026-10-04T10:00:00.000Z',
  'updatedAt': '2026-10-04T10:00:00.000Z',
}, LibraryOwner(meetingOwner.tenantId, meetingOwner.actorId, meetingUserId));

class _Library extends Fake implements LibraryRepository {
  _Library(this.value);
  LibraryItem value;
  Future<LibraryItem> Function()? read;
  int reads = 0;
  @override
  bool current = true;
  @override
  bool supports(String operation) => false;
  @override
  Future<LibraryItem> item(String id, CancelToken cancel) async {
    reads++;
    return await (read?.call() ?? Future.value(value));
  }

  @override
  Future<LibraryPage> list({
    required String query,
    required String? kind,
    required int offset,
    required CancelToken cancel,
  }) async => LibraryPage(
    [
      value,
      _source(authority: 'project_artifact', kind: 'generated_artifact'),
      _source(authority: 'mission_artifact', kind: 'generated_artifact'),
    ],
    0,
    3,
    false,
    null,
    const {'document': 1, 'generated_artifact': 2},
    false,
    '2026-10-04T10:00:00.000Z',
  );
}

class _UnusedApi extends Fake implements ApiClient {}

NativeWorkspaceAccess _access() => NativeWorkspaceAccess(
  _UnusedApi(),
  NativeRequestAuthority(
    tenantId: meetingOwner.tenantId,
    actorId: meetingOwner.actorId,
    canonicalUserId: meetingUserId,
    role: meetingOwner.role,
    apiBaseUrl: meetingOwner.apiScope,
    isCurrent: () => true,
  ),
  true,
);

Future<void> _tap(WidgetTester tester, Finder target) async {
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

void main() {
  test('Capture selection preserves source identity without fabricating a revision', () {
    for (final authority in [
      'capture_asset',
      'capture_recording',
      'capture_transcript',
    ]) {
      final source = _source(authority: authority);
      final request = meetingSourceLinkFromLibrary(source);
      expect(request['sourceId'], source.sourceId);
      expect(request['label'], source.title);
      expect(request.containsKey('sourceRevisionId'), false);
      expect(
        request['kind'],
        authority == 'capture_asset' ? 'capture_asset' : 'capture_recording',
      );
      expect(request['mediaRole'], switch (authority) {
        'capture_asset' => 'attachment',
        'capture_transcript' => 'transcript',
        _ => 'recording',
      });
    }
  });

  test('connected sources retain exact revisions and Calendar uses its required role', () {
    for (final kind in ['meeting', 'document']) {
      final request = meetingSourceLinkFromLibrary(
        _source(authority: 'source_item', kind: kind),
      );
      expect(request['sourceRevisionId'], 'source-revision:1');
      expect(
        request['kind'],
        kind == 'meeting' ? 'calendar_event' : 'source_revision',
      );
      expect(
        request['mediaRole'],
        kind == 'meeting' ? 'calendar' : 'reference',
      );
    }
  });

  test('artifact and non-ready candidates cannot become Meeting sources while Command rules stay intact', () {
    final project = _source(
      authority: 'project_artifact',
      kind: 'generated_artifact',
    );
    expect(project.commandAvailable, true);
    for (final source in [
      project,
      _source(authority: 'mission_artifact'),
      _source(status: 'processing'),
    ]) {
      expect(libraryMeetingSourceAvailable(source), false);
      expect(() => meetingSourceLinkFromLibrary(source), throwsFormatException);
    }
  });

  test('duplicates, capacity, and a second Calendar event are refused before journalling', () {
    final link = meetingSourceLinkFromLibrary(
      _source(authority: 'source_item', kind: 'meeting'),
    );
    expect(
      () => appendMeetingRelationship(
        {
          'sourceLinks': [link],
        },
        'sourceLinks',
        link,
      ),
      throwsFormatException,
    );
    expect(
      () => appendMeetingRelationship(
        {
          'sourceLinks': [link],
        },
        'sourceLinks',
        {...link, 'sourceId': 'source:other', 'linkId': 'meeting-link:other'},
      ),
      throwsFormatException,
    );
    expect(
      () => appendMeetingRelationship(
        {'sourceLinks': List.filled(100, link)},
        'sourceLinks',
        {...link, 'kind': 'source_revision', 'sourceId': 'source:other'},
      ),
      throwsFormatException,
    );
    final entity = meetingEntityLinkFromOption(
      const EntityOption('entity:one', 'account', 'Account'),
    );
    expect(
      () => appendMeetingRelationship(
        {
          'entityLinks': [entity],
        },
        'entityLinks',
        entity,
      ),
      throwsFormatException,
    );
  });

  test('entity labels are never silently truncated and transcript linking does not infer consent', () {
    expect(
      meetingEntityLinkFromOption(
        const EntityOption('entity:project', 'project', 'Project context'),
      )['relationship'],
      'related',
    );
    final label = 'x' * 300;
    final entity = meetingEntityLinkFromOption(
      EntityOption('entity:one', 'organization', label),
    );
    expect(entity['label'], label);
    final body = meetingEditableDefinition(Meeting.fromJson(meetingJson()));
    expect(
      () => normalizeMeetingEditorDefinition({
        ...body,
        'entityLinks': [entity],
      }),
      throwsFormatException,
    );
    expect(
      () => normalizeMeetingEditorDefinition({
        ...body,
        'sourceLinks': [
          meetingSourceLinkFromLibrary(
            _source(authority: 'capture_transcript'),
          ),
        ],
      }),
      throwsFormatException,
    );
    expect(
      (body['participants'] as List).single['recordingConsent'],
      'unknown',
    );
  });

  testWidgets(
    'Meeting Library picker filters artifacts and re-reads the exact current version before returning',
    (tester) async {
      final repository = _Library(_source());
      final c = LibraryController(repository);
      addTearDown(c.dispose);
      final selected = <LibraryItem>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LibraryView(
              controller: c,
              initialLibraryItemId: repository.value.id,
              selectForMeeting: true,
              onSelectedCurrent: selected.add,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Full project_artifact label'), findsNothing);
      expect(find.text('Full mission_artifact label'), findsNothing);
      final pending = Completer<LibraryItem>();
      repository.read = () => pending.future;
      await _tap(tester, find.byKey(const Key('library-select-current')));
      expect(repository.reads, 2);
      expect(selected, isEmpty);
      repository.value = _source(revision: 2);
      pending.complete(repository.value);
      await tester.pumpAndSettle();
      expect(selected, isEmpty);
      expect(find.textContaining('This source changed.'), findsOneWidget);
      repository.read = null;
      await _tap(tester, find.byKey(const Key('library-select-current')));
      expect(repository.reads, 3);
      expect(selected.single.versionId, repository.value.versionId);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a held exact source read cannot return after Library access is lost',
    (tester) async {
      final repository = _Library(_source());
      final c = LibraryController(repository);
      addTearDown(c.dispose);
      final selected = <LibraryItem>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LibraryView(
              controller: c,
              initialLibraryItemId: repository.value.id,
              selectForMeeting: true,
              onSelectedCurrent: selected.add,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final pending = Completer<LibraryItem>();
      repository.read = () => pending.future;
      await _tap(tester, find.byKey(const Key('library-select-current')));
      repository.current = false;
      pending.complete(repository.value);
      await tester.pumpAndSettle();
      expect(selected, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  for (final replacement in ['none', 'workspace', 'meeting']) {
    testWidgets(
      'Meeting entity selection rechecks mounted $replacement identity and generation',
      (tester) async {
        final repository = FakeMeetingsRepository();
        final actions = MeetingActionController(
          repository,
          MemoryMeetingDraftStore(),
          'new',
        );
        await actions.initialize();
        final access = _access();
        final container = ProviderContainer(
          overrides: [nativeWorkspaceAccessProvider.overrideWithValue(access)],
        );
        addTearDown(container.dispose);
        addTearDown(actions.dispose);
        final pending = Completer<AuthorizedEntitySelection?>();
        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: MaterialApp(
              home: Scaffold(
                body: MeetingEditor(
                  actions: actions,
                  workspaceId: 'workspace:native',
                  stillCurrent: () => actions.available,
                  refresh: () async => true,
                  projectLoader: (_) async => [],
                  entityPicker: (context) =>
                      Navigator.of(context).push<AuthorizedEntitySelection>(
                        MaterialPageRoute(
                          builder: (context) => Scaffold(
                            body: FilledButton(
                              onPressed: () async {
                                final value = await pending.future;
                                if (context.mounted) {
                                  Navigator.of(context).pop(value);
                                }
                              },
                              child: const Text('Return selected entity'),
                            ),
                          ),
                        ),
                      ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await _tap(tester, find.byKey(const Key('meeting-add-entity')));
        await _tap(tester, find.text('Return selected entity'));
        if (replacement == 'workspace') {
          container.updateOverrides([
            nativeWorkspaceAccessProvider.overrideWithValue(_access()),
          ]);
        } else if (replacement == 'meeting') {
          repository.access.generation++;
        }
        pending.complete(
          AuthorizedEntitySelection(
            const EntityOption('entity:one', 'account', 'Current account'),
            meetingOwner.tenantId,
            'actor:$meetingUserId',
            meetingDigest,
            access.identity,
          ),
        );
        await tester.pumpAndSettle();
        if (replacement == 'none') {
          final linked = (actions.draft['body']['entityLinks'] as List).single;
          expect(linked['entityId'], 'entity:one');
          expect(linked['relationship'], 'account');
          expect(actions.submitted, isNull);
        } else {
          expect(actions.draft, isEmpty);
          expect(find.textContaining('Nothing was linked'), findsOneWidget);
        }
        expect(repository.submissions, isEmpty);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      },
    );
  }
}
