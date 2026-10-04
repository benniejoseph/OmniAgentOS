import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/capture/library_contracts.dart';
import 'package:asael/features/capture/library_controller.dart';
import 'package:asael/features/capture/library_repository.dart';

const owner = LibraryOwner(
  'tenant-a',
  'reader@example.test',
  '00000000-0000-4000-8000-000000000001',
);
const time = '2026-10-04T10:00:00.000Z';
final hash = 'a' * 64;
LibraryJson item(String id) => {
  'schemaVersion': 1,
  'id': 'library:capture_asset:$id',
  'tenantId': owner.tenantId,
  'kind': 'document',
  'sourceAuthority': 'capture_asset',
  'sourceId': id,
  'title': 'Exact source $id',
  'summary': 'Saved source context',
  'sourceLabel': 'Capture',
  'status': 'ready',
  'tags': <String>[],
  'scope': <String, dynamic>{
    'visibility': 'user_private',
    'ownerActorId': 'actor:${owner.userId}',
    'workspaceId': null,
    'projectId': null,
    'missionId': null,
    'workItemId': null,
    'permissionBasis': 'owner',
  },
  'currentVersion': <String, dynamic>{
    'versionId': 'version:capture_asset:$id:current',
    'versionNumber': 1,
    'contentSha256': hash,
    'byteCount': 42,
    'mediaType': 'text/plain',
    'sourceRevisionId': null,
    'createdAt': time,
  },
  'versionCount': 1,
  'citationRefs': ['capture:$id'],
  'links': <Object?>[],
  'openHref': '/api/capture/assets/$id?content=1&download=1',
  'createdAt': time,
  'updatedAt': time,
};
Future<LibraryJson> receipt(
  String operation,
  LibraryJson data,
  int count,
) async {
  final result = <String, dynamic>{
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': operation,
    'action': 'read',
    'resourceType': operation == 'app.library.list'
        ? 'workspace_library'
        : 'workspace_library_item',
    'accessMode': 'read',
    'eventContract': 'read_only:no_domain_mutation',
    'authoritySha256': hash,
    'idempotencyKeySha256': null,
    'outcomeSha256': await librarySha(data),
    'resourceCount': count,
    'occurredAt': time,
  };
  return {...result, 'receiptSha256': await librarySha(result)};
}

Future<LibraryJson> pageResponse() async {
  final data = <String, dynamic>{
    'items': [item('a')],
    'total': 1,
    'totalIsLowerBound': false,
    'nextOffset': null,
    'countsByKind': {'document': 1},
    'countsAreLowerBound': false,
  };
  return {
    ...data,
    'generatedAt': time,
    'serviceReceipt': await receipt('app.library.list', data, 1),
  };
}

Future<LibraryJson> historyResponse() async {
  final data = <String, dynamic>{
    'schemaVersion': 1,
    'contract': 'asael-library-history:1',
    'libraryItemId': 'library:capture_asset:a',
    'tenantId': owner.tenantId,
    'sourceAuthority': 'capture_asset',
    'sourceId': 'a',
    'currentVersionId': 'version:capture_asset:a:current',
    'coverageBasis': 'current_known_version_only',
    'authorityEffect': 'none',
    'commandAttachmentPolicy': 'current_library_resolution_required',
    'versions': [
      <String, dynamic>{
        'versionId': 'version:capture_asset:a:current',
        'sourceRevisionId': null,
        'sourceRevisionSha256': null,
        'contentSha256': hash,
        'byteCount': 42,
        'mediaType': 'text/plain',
        'capturedAt': time,
        'ordinal': null,
        'current': true,
        'citationRefs': ['capture:a'],
        'contentAvailability': 'metadata_only',
        'historicalAttachmentAuthority': 'none',
      },
    ],
    'coverage': {
      'limit': 40,
      'returned': 1,
      'hasMore': false,
      'nextBefore': null,
      'total': null,
    },
  };
  return {
    ...data,
    'serviceReceipt': await receipt('app.library.versions.list', data, 1),
  };
}

void main() {
  test('current source binds exact source target and private owner without rewriting identity', () {
    expect(LibraryItem.parse(item('a'), owner).id, 'library:capture_asset:a');
    expect(
      () => LibraryItem.parse({
        ...item('a'),
        'openHref': '/api/capture/assets/b?content=1',
      }, owner),
      throwsFormatException,
    );
    expect(
      () => LibraryItem.parse({...item('a'), 'tenantId': 'other'}, owner),
      throwsFormatException,
    );
    final foreign = item('a');
    foreign['scope'] = {
      ...libraryMap(foreign['scope']),
      'ownerActorId': 'actor:other',
    };
    expect(() => LibraryItem.parse(foreign, owner), throwsFormatException);
  });
  test('Command selection carries only the ready current source and exact version pins', () {
    final current = LibraryItem.parse(item('a'), owner);
    expect(current.commandReference(), {
      'kind': 'file',
      'id': 'library:capture_asset:a',
      'expectedVersion': 1,
      'versionId': 'version:capture_asset:a:current',
      'bindingSha256': hash,
    });
    expect(
      () => current.version['contentSha256'] = 'b' * 64,
      throwsUnsupportedError,
    );
    final processing = LibraryItem.parse({
      ...item('a'),
      'status': 'processing',
    }, owner);
    expect(processing.commandAvailable, isFalse);
    expect(processing.commandReference, throwsFormatException);
  });
  test('list validates digest and exact requested page rather than inferring counts', () async {
    final value = await pageResponse();
    expect(
      (await LibraryPage.parse(value, owner, offset: 0, limit: 40)).total,
      1,
    );
    await expectLater(
      LibraryPage.parse(value, owner, offset: 40, limit: 40),
      throwsFormatException,
    );
    final altered = {
      ...value,
      'total': 2,
      'totalIsLowerBound': true,
      'nextOffset': 1,
    };
    await expectLater(
      LibraryPage.parse(altered, owner, offset: 0, limit: 40),
      throwsFormatException,
    );
  });
  test(
    'history remains metadata-only and rejects a changed or unrelated head',
    () async {
      final value = await historyResponse();
      final read = await LibraryHistory.parse(
        value,
        owner,
        'library:capture_asset:a',
        limit: 40,
      );
      expect(read.versions.single.raw['historicalAttachmentAuthority'], 'none');
      await expectLater(
        LibraryHistory.parse(
          value,
          owner,
          'library:capture_asset:a',
          limit: 40,
          head: 'version:capture_asset:a:old',
        ),
        throwsFormatException,
      );
      await expectLater(
        LibraryHistory.parse(
          value,
          owner,
          'library:capture_asset:b',
          limit: 40,
        ),
        throwsFormatException,
      );
    },
  );
  test('entity choices bind canonical owner, full label and exact ordered continuation', () {
    final value = <String, dynamic>{
      'schemaVersion': 1,
      'contract': 'asael-entity-options:1',
      'scope': {
        'tenantId': owner.tenantId,
        'ownerActorId': 'actor:${owner.userId}',
        'accessScopeSha256': hash,
        'purposeId': 'entity.read.v1',
      },
      'items': [
        {
          'entityId': 'entity:a',
          'entityTypeId': 'project',
          'canonicalLabel': 'A full registry project label',
          'state': 'active',
        },
      ],
      'hasMore': false,
      'nextAfter': null,
      'coverage': {
        'kind': 'bounded_current',
        'limit': 40,
        'returned': 1,
        'after': null,
        'total': null,
      },
      'authorityEffect': 'none',
    };
    expect(
      EntityOptionsPage.parse(value, owner, limit: 40).items.single.id,
      'entity:a',
    );
    expect(
      () => EntityOptionsPage.parse(value, owner, limit: 40, after: 'entity:z'),
      throwsFormatException,
    );
    expect(
      () => EntityOptionsPage.parse(
        {
          ...value,
          'scope': {
            ...libraryMap(value['scope']),
            'ownerActorId': owner.actorId,
          },
        },
        owner,
        limit: 40,
      ),
      throwsFormatException,
    );
  });
  test('A to B to A uses request identity; authorization loss fences a held exact read', () async {
    final repository = _HeldRepository();
    final c = LibraryController(repository);
    final first = c.select('library:capture_asset:a');
    final second = c.select('library:capture_asset:b');
    final third = c.select('library:capture_asset:a');
    repository.details[2].complete(LibraryItem.parse(item('a'), owner));
    await third;
    repository.details[0].complete(LibraryItem.parse(item('a'), owner));
    repository.details[1].complete(LibraryItem.parse(item('b'), owner));
    await Future.wait([first, second]);
    expect(c.detail?.id, 'library:capture_asset:a');
    final held = c.select('library:capture_asset:b'), list = c.load();
    repository.listRead.completeError(
      const ApiException('Unauthorized', statusCode: 401),
    );
    await list;
    repository.details[3].complete(LibraryItem.parse(item('b'), owner));
    await held;
    expect(c.accessDenied, isTrue);
    expect(c.detail, isNull);
    expect(c.page, isNull);
    c.dispose();
  });
}

class _HeldRepository implements LibraryRepository {
  final details = <Completer<LibraryItem>>[];
  final listRead = Completer<LibraryPage>();
  @override
  bool current = true;
  @override
  bool supports(String operation) => true;
  @override
  Future<LibraryItem> item(String id, CancelToken cancel) {
    final completer = Completer<LibraryItem>();
    details.add(completer);
    return completer.future;
  }

  @override
  Future<LibraryPage> list({
    required String query,
    required String? kind,
    required int offset,
    required CancelToken cancel,
  }) => listRead.future;
  @override
  Future<LibraryHistory> history(
    String id,
    CancelToken cancel, {
    String? before,
    String? head,
  }) => throw UnimplementedError();
  @override
  Future<LibraryHistory> version(
    String id,
    String versionId,
    String head,
    CancelToken cancel,
  ) => throw UnimplementedError();
  @override
  Future<EntityOptionsPage> entities(CancelToken cancel, {String? after}) =>
      throw UnimplementedError();
}
