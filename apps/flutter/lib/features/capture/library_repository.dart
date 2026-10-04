import 'package:dio/dio.dart';

import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'library_contracts.dart';

abstract class LibraryRepository {
  bool get current;
  bool supports(String operation);
  Future<LibraryPage> list({
    required String query,
    required String? kind,
    required int offset,
    required CancelToken cancel,
  });
  Future<LibraryItem> item(String id, CancelToken cancel);
  Future<LibraryHistory> history(
    String id,
    CancelToken cancel, {
    String? before,
    String? head,
  });
  Future<LibraryHistory> version(
    String id,
    String versionId,
    String head,
    CancelToken cancel,
  );
  Future<EntityOptionsPage> entities(CancelToken cancel, {String? after});
}

class ApiLibraryRepository implements LibraryRepository {
  ApiLibraryRepository(this.access)
    : owner = LibraryOwner(
        access.authority.tenantId,
        access.authority.actorId,
        access.authority.canonicalUserId,
      );
  final NativeWorkspaceAccess access;
  final LibraryOwner owner;
  @override
  bool get current => access.current;
  @override
  bool supports(String operation) =>
      NativeContract.supportsOperation(operation);
  Future<LibraryJson> _read(
    String operation,
    String path,
    CancelToken cancel,
  ) async {
    if (!current || cancel.isCancelled) {
      throw StateError('Library access changed.');
    }
    if (!supports(operation)) {
      throw StateError(
        'This read is not available in the current native contract.',
      );
    }
    final result = await access.api.getJsonAuthorized(
      path,
      authority: access.authority,
      cancelToken: cancel,
    );
    if (!current || cancel.isCancelled) {
      throw StateError('Library access changed.');
    }
    return result;
  }

  @override
  Future<LibraryPage> list({
    required String query,
    required String? kind,
    required int offset,
    required CancelToken cancel,
  }) async {
    libraryRequire(
      query.length <= 240 &&
          offset >= 0 &&
          offset <= 10000 &&
          (kind == null || libraryKinds.contains(kind)),
    );
    return LibraryPage.parse(
      await _read(
        'library.list',
        NativePaths.libraryList(
          q: query,
          kind: kind,
          limit: 40,
          offset: offset,
        ),
        cancel,
      ),
      owner,
      offset: offset,
      limit: 40,
    );
  }

  @override
  Future<LibraryItem> item(String id, CancelToken cancel) async {
    final result = await _read(
      'library.get',
      NativePaths.libraryGet(id),
      cancel,
    );
    libraryKeys(result, 'item serviceReceipt');
    final item = LibraryItem.parse(result['item'], owner, id: id);
    libraryRequire(item.exactAvailable);
    await libraryReceipt(result, 'app.library.show', {
      'item': result['item'],
    }, 1);
    return item;
  }

  @override
  Future<LibraryHistory> history(
    String id,
    CancelToken cancel, {
    String? before,
    String? head,
  }) async {
    libraryRequire((before == null) == (head == null));
    return LibraryHistory.parse(
      await _read(
        'library.versions.list',
        NativePaths.libraryVersionsList(
          id,
          limit: 40,
          before: before,
          currentVersionId: head,
        ),
        cancel,
      ),
      owner,
      id,
      limit: 40,
      before: before,
      head: head,
    );
  }

  @override
  Future<LibraryHistory> version(
    String id,
    String versionId,
    String head,
    CancelToken cancel,
  ) async => LibraryHistory.parse(
    await _read(
      'library.versions.get',
      NativePaths.libraryVersionsGet(id, versionId, currentVersionId: head),
      cancel,
    ),
    owner,
    id,
    limit: 1,
    head: head,
    versionId: versionId,
  );
  @override
  Future<EntityOptionsPage> entities(
    CancelToken cancel, {
    String? after,
  }) async => EntityOptionsPage.parse(
    await _read(
      'entities.options',
      NativePaths.entitiesOptions(limit: 40, after: after),
      cancel,
    ),
    owner,
    limit: 40,
    after: after,
  );
}
