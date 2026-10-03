import 'dart:async';

import 'package:asael/features/activity/activity.dart';
import 'package:dio/dio.dart';

Map<String, dynamic> runFixture({
  String id = 'run-one',
  ActivityGroup group = ActivityGroup.working,
}) => {
  'id': 'run:$id',
  'group': group.wire,
  'workKey': 'run:$id',
  'source': 'runs',
  'sourceRef': {'kind': 'run', 'id': id},
  'references': [
    {'kind': 'run', 'id': id},
  ],
  'title': 'Agent run',
  'summary': 'The owned run is in progress.',
  'status': 'running',
  'timestamp': {'at': '2026-10-03T12:00:00Z', 'basis': 'started'},
  'href': Uri(path: '/app/command', queryParameters: {'run': id}).toString(),
};

Map<String, dynamic> approvalFixture({
  String id = 'approval-one',
  String kind = 'workflow',
}) => {
  'id': 'approval:$kind:$id',
  'group': 'needs_you',
  'workKey': 'approval:$kind:$id',
  'source': 'approvals',
  'sourceRef': {'kind': 'approval', 'id': id, 'approvalKind': kind},
  'references': [
    {'kind': 'approval', 'id': id, 'approvalKind': kind},
  ],
  'title': 'Governed approval',
  'summary': 'Review the authorized source before deciding.',
  'status': 'waiting_approval',
  'timestamp': {'at': '2026-10-03T12:00:00Z', 'basis': 'created'},
  'href': Uri(
    path: '/app/approvals',
    queryParameters: {'id': id, 'kind': kind},
  ).toString(),
};

Map<String, dynamic> reminderFixture({String id = 'reminder-one'}) => {
  'id': 'notification:$id',
  'group': 'updates',
  'workKey': 'today_item:item/shared',
  'source': 'notifications',
  'sourceRef': {'kind': 'notification', 'id': id},
  'references': [
    {'kind': 'notification', 'id': id},
    {'kind': 'today_item', 'id': 'item/shared'},
  ],
  'title': 'Personal reminder',
  'summary': 'A reminder has an unread update.',
  'status': 'unread',
  'timestamp': {'at': '2026-10-03T12:00:00Z', 'basis': 'updated'},
  'href': '/app',
};

Map<String, dynamic> activityFixture({
  ActivityGroup group = ActivityGroup.all,
  List<Map<String, dynamic>>? items,
  String state = 'ready',
  String? cursor,
  int? workingCount,
}) {
  final rows = items ?? [runFixture()];
  final counts = {
    for (final value in ActivityGroup.values.skip(1))
      value.wire: rows.where((row) => row['group'] == value.wire).length,
  };
  if (workingCount != null) counts['working'] = workingCount;
  return {
    'schemaVersion': 1,
    'contract': 'asael-activity:1',
    'generatedAt': '2026-10-03T12:00:00Z',
    'state': state,
    'group': group.wire,
    'items': rows,
    'counts': counts,
    'coverage': {
      for (final source in activitySources)
        source: {
          'state': state == 'unavailable' ? 'unavailable' : 'ready',
          'limit': 100,
          'visibleCount': state == 'unavailable'
              ? null
              : rows.where((row) => row['source'] == source).length,
        },
    },
    'window': {'bounded': true, 'limitPerSource': 100},
    'page': {'limit': 25, 'hasMore': cursor != null, 'nextCursor': cursor},
  };
}

ActivitySnapshot snapshot({
  ActivityGroup group = ActivityGroup.all,
  List<Map<String, dynamic>>? items,
  String state = 'ready',
  String? cursor,
  int? workingCount,
}) => ActivitySnapshot.fromJson(
  activityFixture(
    group: group,
    items: items,
    state: state,
    cursor: cursor,
    workingCount: workingCount,
  ),
  group,
);

class ActivityRead {
  ActivityRead(this.group, this.cursor, this.cancelToken);
  final ActivityGroup group;
  final String? cursor;
  final CancelToken cancelToken;
  final result = Completer<ActivitySnapshot>();
}

/// Intentionally ignores cancellation so tests prove the generation fence too.
class ControlledActivityRepository implements ActivityRepository {
  final reads = <ActivityRead>[];
  @override
  Future<ActivitySnapshot> load({
    required ActivityGroup group,
    String? cursor,
    required CancelToken cancelToken,
  }) {
    final read = ActivityRead(group, cursor, cancelToken);
    reads.add(read);
    return read.result.future;
  }
}
