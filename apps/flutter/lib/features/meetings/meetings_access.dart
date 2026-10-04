import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../auth/domain/app_session.dart';
import 'meetings_validation.dart';

String meetingsApiScope(String value) {
  final uri = Uri.tryParse(value);
  meetingRequire(
    uri != null &&
        const ['http', 'https'].contains(uri.scheme) &&
        uri.host.isNotEmpty &&
        uri.userInfo.isEmpty &&
        !uri.hasQuery &&
        !uri.hasFragment,
  );
  return uri!
      .replace(
        host: uri.host.toLowerCase(),
        path: uri.path.replaceFirst(RegExp(r'/+$'), ''),
      )
      .toString();
}

@immutable
class MeetingsOwner {
  const MeetingsOwner({
    required this.userId,
    required this.tenantId,
    required this.actorId,
    required this.role,
    required this.apiScope,
  });
  final String userId, tenantId, actorId, role, apiScope;
  String get key => jsonEncode([userId, tenantId, actorId, role, apiScope]);
  bool get canManage => const ['operator', 'admin', 'system'].contains(role);
  static MeetingsOwner? fromSession(AppSession? session, String apiScope) {
    if (session == null ||
        !RegExp(
          r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
        ).hasMatch(session.userId) ||
        session.tenantId.isEmpty ||
        session.actorId.isEmpty ||
        !const [
          'viewer',
          'operator',
          'admin',
          'system',
        ].contains(session.role)) {
      return null;
    }
    return MeetingsOwner(
      userId: session.userId.toLowerCase(),
      tenantId: session.tenantId,
      actorId: session.actorId,
      role: session.role,
      apiScope: meetingsApiScope(apiScope),
    );
  }
}

class MeetingsAccess extends ChangeNotifier {
  MeetingsAccess({
    this.owner,
    this.ready = false,
    this.listAvailable = true,
    this.detailAvailable = true,
    this.commitmentsAvailable = false,
    this.operations = const {},
  });
  MeetingsOwner? owner;
  bool ready, closed = false;
  final bool listAvailable, detailAvailable, commitmentsAvailable;
  final Set<String> operations;
  bool supports(String operation) => readable && operations.contains(operation);
  int generation = 0;
  bool get readable => !closed && ready && owner != null;
  void update(MeetingsOwner? next, {required bool available}) {
    if (closed || next?.key == owner?.key && available == ready) {
      return;
    }
    owner = next;
    ready = available;
    generation++;
    notifyListeners();
  }

  void close({bool notify = true}) {
    if (!closed) {
      closed = true;
      ready = false;
      generation++;
      if (notify) {
        notifyListeners();
      }
    }
  }
}
