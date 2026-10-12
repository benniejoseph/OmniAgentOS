import 'package:dio/dio.dart';

import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'listen_bridge.dart';

class ListenRepository {
  const ListenRepository(this.access);
  final NativeWorkspaceAccess access;

  Future<ListenJson> issueGrant() async {
    access.authority.requireCurrent(access.api.apiBaseUrl);
    final result = await access.api.postJsonAuthorizedOnce(
      NativePaths.listenGrant,
      authority: access.authority,
      data: {'action': 'issue', 'timeZone': 'Asia/Kolkata'},
    );
    access.authority.requireCurrent(access.api.apiBaseUrl);
    final grant = listenMap(result['grant']);
    final expiry = DateTime.tryParse(listenText(grant['expiresAt']));
    final origin = Uri.parse(access.authority.apiBaseUrl).origin;
    final ingest = Uri.tryParse(listenText(grant['ingestUrl']));
    if (grant['tenantId'] != access.authority.tenantId ||
        grant['ownerId'] != access.authority.actorId ||
        grant['canonicalUserId'] != access.authority.canonicalUserId ||
        grant['role'] != access.authority.role ||
        grant['deploymentId'] != origin ||
        listenText(grant['deviceId']).isEmpty ||
        listenText(grant['token']).isEmpty ||
        expiry == null ||
        !expiry.isAfter(DateTime.now()) ||
        ingest == null ||
        ingest.origin != origin ||
        ingest.path != '/api/mobile/listen/ingest') {
      throw const FormatException('Listening access could not be confirmed.');
    }
    return {...grant, 'actorId': access.authority.actorId};
  }

  Future<List<ListenJson>> conversations(CancelToken cancel) async {
    final result = await access.api.getJsonAuthorized(
      NativePaths.listenConversationsList,
      authority: access.authority,
      cancelToken: cancel,
    );
    access.authority.requireCurrent(access.api.apiBaseUrl);
    if (result['conversations'] is! List) {
      throw const FormatException('Your conversations could not be read.');
    }
    return listenRows(result['conversations']);
  }

  Future<ListenJson> conversation(String id, CancelToken cancel) async {
    final result = await access.api.getJsonAuthorized(
      NativePaths.listenConversationsGet(id),
      authority: access.authority,
      cancelToken: cancel,
    );
    access.authority.requireCurrent(access.api.apiBaseUrl);
    final conversation = listenMap(result['conversation']);
    if (conversation['id'] != id) {
      throw const FormatException('This conversation could not be confirmed.');
    }
    return conversation;
  }
}
