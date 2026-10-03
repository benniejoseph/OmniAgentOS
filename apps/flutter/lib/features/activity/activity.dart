import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';

const activityPageLimit = 25;
const activitySourceLimit = 100;
const activitySources = ['runs', 'approvals', 'notifications'];

enum ActivityGroup {
  all('all', 'All activity'),
  working('working', 'Working'),
  needsYou('needs_you', 'Needs you'),
  updates('updates', 'Updates'),
  history('history', 'History');

  const ActivityGroup(this.wire, this.label);
  final String wire;
  final String label;
}

class ActivityReference {
  ActivityReference.fromJson(Object? raw) {
    final json = _record(raw);
    kind = _member(json['kind'], [
      'run',
      'approval',
      'notification',
      'today_item',
    ]);
    id = _text(json['id']);
    approvalKind = json['approvalKind'] == null
        ? null
        : _member(json['approvalKind'], ['tool', 'workflow', 'slo_policy']);
  }
  late final String kind, id;
  late final String? approvalKind;
}

class ActivityCoverage {
  ActivityCoverage.fromJson(Object? raw) {
    final json = _record(raw);
    state = _member(json['state'], [
      'ready',
      'partial',
      'restricted',
      'unavailable',
    ]);
    _require(
      json['limit'] == activitySourceLimit && json.containsKey('visibleCount'),
    );
    visibleCount = json['visibleCount'] == null
        ? null
        : _count(json['visibleCount'], maximum: activitySourceLimit);
    _require(
      (state == 'ready' || state == 'partial') == (visibleCount != null),
    );
    reason = json['reason'] == null
        ? null
        : _member(json['reason'], [
            'permission_required',
            'read_failed',
            'records_omitted',
          ]);
  }
  late final String state;
  late final int? visibleCount;
  late final String? reason;
  String get label => switch (state) {
    'ready' => 'Source checked',
    'partial' => 'Some records could not be included',
    'restricted' => 'Access is restricted',
    _ => 'Source could not be checked',
  };
}

class ActivityItem {
  ActivityItem.fromJson(Object? raw, ActivityGroup expectedGroup) {
    final json = _record(raw);
    id = _text(json['id']);
    workKey = _text(json['workKey']);
    title = _text(json['title']);
    summary = _text(json['summary']);
    status = _text(json['status']);
    source = _member(json['source'], activitySources);
    final groupValue = _member(
      json['group'],
      ActivityGroup.values.skip(1).map((group) => group.wire),
    );
    group = ActivityGroup.values.firstWhere(
      (group) => group.wire == groupValue,
    );
    _require(expectedGroup == ActivityGroup.all || expectedGroup == group);
    sourceRef = ActivityReference.fromJson(json['sourceRef']);
    _require(
      sourceRef.kind ==
          switch (source) {
            'runs' => 'run',
            'approvals' => 'approval',
            _ => 'notification',
          },
    );
    references = List.unmodifiable(
      _list(json['references']).map(ActivityReference.fromJson),
    );
    _require(
      references.any(
        (ref) =>
            ref.kind == sourceRef.kind &&
            ref.id == sourceRef.id &&
            ref.approvalKind == sourceRef.approvalKind,
      ),
    );
    final timestamp = _record(json['timestamp']);
    at = _date(timestamp['at']);
    timeBasis = _member(timestamp['basis'], [
      'started',
      'completed',
      'created',
      'updated',
    ]);
    href = _text(json['href']);
    final uri = _appUri(href);
    if (source == 'runs') {
      _require(
        uri.path == '/app/command' &&
            uri.queryParameters['run'] == sourceRef.id,
      );
    } else if (source == 'approvals') {
      _require(
        sourceRef.approvalKind != null &&
            uri.path == '/app/approvals' &&
            uri.queryParameters['id'] == sourceRef.id &&
            uri.queryParameters['kind'] == sourceRef.approvalKind,
      );
    } else {
      _require(uri.path == '/app');
    }
    final rawOrigin = json['origin'];
    if (rawOrigin != null) {
      final origin = _record(rawOrigin);
      originRunId = _text(origin['runId']);
      originThreadId = origin['threadId'] == null
          ? null
          : _text(origin['threadId']);
      originHref = _text(origin['href']);
      final originUri = _appUri(originHref!);
      _require(
        originUri.path == '/app/command' &&
            originUri.queryParameters['run'] == originRunId,
      );
      if (originThreadId != null) {
        _require(originUri.queryParameters['thread'] == originThreadId);
      }
    }
    if (json['canonicalStatus'] != null) {
      final canonical = _record(json['canonicalStatus']);
      _require(
        source != 'notifications' &&
            canonical['schemaVersion'] == 1 &&
            canonical['domain'] ==
                (source == 'runs' ? 'agent_run' : 'approval'),
      );
      canonicalStatus = _member(canonical['status'], [
        'preview',
        'running',
        'waiting',
        'blocked',
        'partial',
        'unverified',
        'failed',
        'canceled',
        'succeeded',
      ]);
      final basis = _member(canonical['basis'], [
        'legacy_status',
        'terminal_receipt',
      ]);
      final projectedSource = _member(canonical['source'], [
        'legacy_adapter',
        'outcome_evaluator',
        'unknown',
      ]);
      final sourceStatus = _text(canonical['sourceStatus']);
      final verification = _member(canonical['verificationState'], [
        'verified',
        'partially_verified',
        'unverified',
        'not_applicable',
        'unassessed',
      ]);
      if (basis == 'legacy_status') {
        _require(
          projectedSource == 'legacy_adapter' && verification == 'unassessed',
        );
      }
      if (canonicalStatus == 'succeeded') {
        _require(
          source == 'runs' &&
              basis == 'terminal_receipt' &&
              projectedSource == 'outcome_evaluator' &&
              verification == 'verified' &&
              sourceStatus == 'succeeded',
        );
      }
    }
  }
  late final String id,
      workKey,
      title,
      summary,
      status,
      source,
      href,
      timeBasis;
  late final ActivityGroup group;
  late final ActivityReference sourceRef;
  late final List<ActivityReference> references;
  late final DateTime at;
  String? canonicalStatus, originRunId, originThreadId, originHref;

  String get outcomeLabel => switch (canonicalStatus) {
    'succeeded' => 'Verified outcome',
    'unverified' => 'Unverified outcome',
    'partial' => 'Partial outcome',
    'blocked' => 'Blocked outcome',
    _ => '',
  };
  String get sourceLabel => source == 'runs'
      ? 'Inspect run'
      : source == 'approvals'
      ? 'Open approval'
      : 'Open in Today';
  String? get conversationId =>
      originThreadId ?? Uri.parse(href).queryParameters['thread'];
  String get nativeLocation => switch (source) {
    'runs' => runLocation(sourceRef.id),
    'approvals' =>
      '/inbox/approvals/${Uri.encodeComponent(sourceRef.id)}?kind=${Uri.encodeQueryComponent(sourceRef.approvalKind!)}',
    _ => Uri(
      path: '/today',
      queryParameters: {
        if (references.any((ref) => ref.kind == 'today_item'))
          'workItemId': references
              .firstWhere((ref) => ref.kind == 'today_item')
              .id,
      },
    ).toString(),
  };
  static String runLocation(String id) =>
      '/results/${Uri.encodeComponent('agent:$id')}';
}

class ActivitySnapshot {
  ActivitySnapshot.fromJson(
    Map<String, dynamic> json,
    ActivityGroup expectedGroup,
  ) {
    _require(
      json['schemaVersion'] == 1 &&
          json['contract'] == 'asael-activity:1' &&
          json['group'] == expectedGroup.wire,
    );
    group = expectedGroup;
    state = _member(json['state'], ['ready', 'partial', 'unavailable']);
    generatedAt = _date(json['generatedAt']);
    final rawCounts = _record(json['counts']);
    counts = Map.unmodifiable({
      for (final group in ActivityGroup.values.skip(1))
        group: _count(rawCounts[group.wire], maximum: 300),
    });
    _require(total <= 300);
    final rawCoverage = _record(json['coverage']);
    coverage = Map.unmodifiable({
      for (final source in activitySources)
        source: ActivityCoverage.fromJson(rawCoverage[source]),
    });
    final window = _record(json['window']);
    _require(
      window['bounded'] == true &&
          window['limitPerSource'] == activitySourceLimit,
    );
    final page = _record(json['page']);
    _require(
      page['limit'] == activityPageLimit &&
          page['hasMore'] is bool &&
          page.containsKey('nextCursor'),
    );
    hasMore = page['hasMore'] as bool;
    nextCursor = page['nextCursor'] == null ? null : _text(page['nextCursor']);
    _require(
      hasMore == (nextCursor != null) && (nextCursor?.length ?? 0) <= 2000,
    );
    final rawItems = _list(json['items']);
    _require(rawItems.length <= activityPageLimit);
    items = List.unmodifiable(
      rawItems.map((raw) => ActivityItem.fromJson(raw, group)),
    );
    _require(
      items.map((item) => item.id).toSet().length == items.length &&
          items.length <= countFor(group),
    );
    if (state == 'unavailable') {
      _require(items.isEmpty && total == 0 && !hasMore);
    }
  }
  late final ActivityGroup group;
  late final String state;
  late final DateTime generatedAt;
  late final Map<ActivityGroup, int> counts;
  late final Map<String, ActivityCoverage> coverage;
  late final List<ActivityItem> items;
  late final bool hasMore;
  late final String? nextCursor;
  bool get known => state != 'unavailable';
  int get total => counts.values.fold(0, (sum, value) => sum + value);
  int countFor(ActivityGroup group) =>
      group == ActivityGroup.all ? total : counts[group]!;
}

abstract interface class ActivityRepository {
  Future<ActivitySnapshot> load({
    required ActivityGroup group,
    String? cursor,
    required CancelToken cancelToken,
  });
}

/// Each controller belongs to one authenticated owner; it never stores a cache.
class ActivityController extends ChangeNotifier {
  ActivityController(this.repository);
  final ActivityRepository repository;
  ActivitySnapshot? snapshot;
  ActivityGroup? pendingGroup;
  String? error, notice;
  int pageIndex = 0;
  List<String?> _cursors = [null];
  CancelToken? _request;
  int _generation = 0;
  bool _disposed = false;
  bool get loading => pendingGroup != null;
  bool get stale => snapshot != null && (loading || error != null);
  bool get canPrevious => !loading && pageIndex > 0;
  bool get canNext => !loading && (snapshot?.hasMore ?? false);

  Future<void> refresh() =>
      _load(snapshot?.group ?? ActivityGroup.all, 0, [null]);
  Future<void> select(ActivityGroup group) => _load(group, 0, [null]);
  Future<void> next() async {
    if (!canNext) return;
    await _load(snapshot!.group, pageIndex + 1, [
      ..._cursors.take(pageIndex + 1),
      snapshot!.nextCursor,
    ]);
  }

  Future<void> previous() async {
    if (!canPrevious) return;
    await _load(snapshot!.group, pageIndex - 1, _cursors);
  }

  Future<void> _load(
    ActivityGroup group,
    int index,
    List<String?> cursors,
  ) async {
    if (_disposed) return;
    final generation = ++_generation;
    _request?.cancel('Activity read replaced');
    final cancel = CancelToken();
    _request = cancel;
    pendingGroup = group;
    error = notice = null;
    notifyListeners();
    bool current() =>
        !_disposed && generation == _generation && !cancel.isCancelled;
    var reset = false;
    try {
      ActivitySnapshot result;
      try {
        result = await repository.load(
          group: group,
          cursor: cursors[index],
          cancelToken: cancel,
        );
      } on ApiConflictException {
        if (!current() || cursors[index] == null) rethrow;
        reset = true;
        index = 0;
        cursors = [null];
        notice =
            'Activity changed while you were paging. Checking a new window.';
        notifyListeners();
        result = await repository.load(group: group, cancelToken: cancel);
      }
      if (!current()) return;
      if (!result.known && (snapshot?.known ?? false)) {
        throw const ApiException(
          'Activity sources are unavailable. Last loaded records are retained.',
        );
      }
      snapshot = result;
      pageIndex = index;
      _cursors = index == 0 ? [null] : List.of(cursors);
      notice = reset
          ? 'Activity changed while you were paging. A new window is shown from its first page.'
          : null;
    } catch (failure) {
      if (!current()) return;
      if (failure is ApiException &&
          (failure.statusCode == 401 || failure.statusCode == 403)) {
        snapshot = null;
        pageIndex = 0;
        _cursors = [null];
        error = 'Your access to Activity could not be verified. Check your session and try again.';
      } else {
        error = failure is FormatException
            ? 'Activity returned an incomplete response. Refresh to try again.'
            : failure is ApiException
            ? failure.message
            : 'Activity could not be checked. Try again.';
      }
      if (reset) {
        error =
            'The previous window expired and its replacement could not be loaded. $error';
      }
      notice = null;
    } finally {
      if (current()) {
        _request = null;
        pendingGroup = null;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _generation += 1;
    _request?.cancel('Activity closed');
    super.dispose();
  }
}

void _require(bool condition) {
  if (!condition) throw const FormatException('Invalid Activity response.');
}

Map<String, dynamic> _record(Object? value) {
  _require(value is Map<String, dynamic>);
  return value as Map<String, dynamic>;
}

List<dynamic> _list(Object? value) {
  _require(value is List);
  return value as List<dynamic>;
}

String _text(Object? value) {
  _require(
    value is String &&
        value.isNotEmpty &&
        !RegExp(r'[\x00-\x1f\x7f]').hasMatch(value),
  );
  return value as String;
}

String _member(Object? value, Iterable<String> values) {
  _require(value is String && values.contains(value));
  return value as String;
}

int _count(Object? value, {required int maximum}) {
  _require(value is int && value >= 0 && value <= maximum);
  return value as int;
}

DateTime _date(Object? value) {
  final parsed = DateTime.tryParse(_text(value));
  _require(parsed != null);
  return parsed!.toUtc();
}

Uri _appUri(String href) {
  _require(
    href.startsWith('/') &&
        !href.startsWith('//') &&
        !RegExp(r'[\\\s]').hasMatch(href),
  );
  final uri = Uri.parse(href);
  _require(
    !uri.hasScheme &&
        !uri.hasAuthority &&
        (uri.path == '/app' || uri.path.startsWith('/app/')) &&
        uri.queryParametersAll.values.every((values) => values.length == 1),
  );
  return uri;
}
