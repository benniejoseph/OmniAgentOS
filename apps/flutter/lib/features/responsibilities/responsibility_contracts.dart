import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import '../../core/network/api_client.dart';
import '../auth/domain/app_session.dart';

typedef ResponsibilityJson = Map<String, dynamic>;
typedef ResponsibilityCheck = void Function(Object?);

const responsibilityDraftContract = 'asael-responsibility-draft:1';
const responsibilityRuntimeContract = 'asael-responsibility-runtime:1';
const responsibilityNotificationContract =
    'asael-responsibility-notifications:1';
const responsibilityObservationContract = 'asael-responsibility-observation:1';
const responsibilityPilot = 'native_meeting_metadata_v1';
const responsibilityBudgetDimensions = [
  'modelTurns',
  'tokens',
  'costMicrousd',
  'wallTimeMs',
  'toolCalls',
  'browserActions',
  'agents',
  'fanOut',
  'retries',
  'replans',
];

void responsibilityRequire(
  bool condition, [
  String message =
      'The Responsibility response is invalid or does not match this account.',
]) {
  if (!condition) throw FormatException(message);
}

ResponsibilityJson responsibilityMap(Object? value) {
  responsibilityRequire(
    value is Map && value.keys.every((key) => key is String),
  );
  return Map<String, dynamic>.from(value as Map);
}

Object? freezeResponsibility(Object? value, [int depth = 0]) {
  responsibilityRequire(depth <= 24);
  if (value is Map) {
    return Map<String, dynamic>.unmodifiable(
      responsibilityMap(value).map(
        (key, item) => MapEntry(key, freezeResponsibility(item, depth + 1)),
      ),
    );
  }
  if (value is List) {
    return List<Object?>.unmodifiable(
      value.map((item) => freezeResponsibility(item, depth + 1)),
    );
  }
  responsibilityRequire(
    value == null ||
        value is String ||
        value is bool ||
        value is int && value.abs() <= 9007199254740991,
  );
  return value;
}

String responsibilityCanonical(Object? value) {
  Object? sort(Object? item) {
    if (item is Map) {
      final map = responsibilityMap(item), names = map.keys.toList()..sort();
      return {for (final name in names) name: sort(map[name])};
    }
    if (item is List) return item.map(sort).toList();
    return item;
  }

  return jsonEncode(sort(value));
}

bool responsibilitySame(Object? a, Object? b) =>
    responsibilityCanonical(a) == responsibilityCanonical(b);
Future<String> responsibilityHash(Object? value) async =>
    (await Sha256().hash(utf8.encode(responsibilityCanonical(value)))).bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
String responsibilityId(Object? value) {
  responsibilityRequire(
    value is String && RegExp(r'^responsibility:[a-f0-9]{64}$').hasMatch(value),
  );
  return value as String;
}

class ResponsibilityOwner {
  const ResponsibilityOwner({
    required this.userId,
    required this.tenantId,
    required this.requestActorId,
    required this.role,
    required this.apiBaseUrl,
  });
  final String userId, tenantId, requestActorId, role, apiBaseUrl;
  String get actorId => 'actor:$userId';
  String get key =>
      jsonEncode([userId, tenantId, requestActorId, role, apiBaseUrl]);
  bool get canManage => const {'operator', 'admin', 'system'}.contains(role);
  static ResponsibilityOwner? fromSession(AppSession? session, String api) {
    if (session == null ||
        !RegExp(
          r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
        ).hasMatch(session.userId) ||
        session.email.isEmpty ||
        session.actorId != session.email ||
        session.tenantId.isEmpty ||
        !const {
          'viewer',
          'operator',
          'admin',
          'system',
        }.contains(session.role)) {
      return null;
    }
    return ResponsibilityOwner(
      userId: session.userId,
      tenantId: session.tenantId,
      requestActorId: session.actorId,
      role: session.role,
      apiBaseUrl: NativeRequestAuthority.normalizeApiBaseUrl(api),
    );
  }
}

ResponsibilityCheck _literal(Object? expected) =>
    (value) => responsibilityRequire(value == expected);
ResponsibilityCheck _choice(String choices) =>
    (value) => responsibilityRequire(
      value is String && choices.split(' ').contains(value),
    );
ResponsibilityCheck _string([int maximum = 240, bool empty = false]) =>
    (value) => responsibilityRequire(
      value is String &&
          value.length <= maximum &&
          (empty || value.isNotEmpty) &&
          value.trim() == value &&
          !RegExp(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]').hasMatch(value),
    );
ResponsibilityCheck _integer([int min = 0, int max = 9007199254740990]) =>
    (value) =>
        responsibilityRequire(value is int && value >= min && value <= max);
ResponsibilityCheck _regex(String pattern) =>
    (value) => responsibilityRequire(
      value is String && RegExp(pattern).hasMatch(value),
    );
ResponsibilityCheck _nullable(ResponsibilityCheck check) => (value) {
  if (value != null) check(value);
};
ResponsibilityCheck _array(
  ResponsibilityCheck check, [
  int maximum = 40,
  int minimum = 0,
]) => (value) {
  responsibilityRequire(
    value is List && value.length >= minimum && value.length <= maximum,
  );
  for (final item in value as List) {
    check(item);
  }
};
ResponsibilityCheck _object(
  Map<String, ResponsibilityCheck> fields, [
  Map<String, ResponsibilityCheck> optional = const {},
]) => (value) {
  final map = responsibilityMap(value);
  responsibilityRequire(
    fields.keys.every(map.containsKey) &&
        map.keys.every(
          (key) => fields.containsKey(key) || optional.containsKey(key),
        ),
  );
  for (final entry in fields.entries) {
    entry.value(map[entry.key]);
  }
  for (final entry in optional.entries) {
    if (map.containsKey(entry.key)) entry.value(map[entry.key]);
  }
};
void _boolean(Object? value) => responsibilityRequire(value is bool);
void _instant(Object? value) {
  responsibilityRequire(
    value is String &&
        RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
            .hasMatch(value),
  );
  final date = DateTime.tryParse(value as String);
  responsibilityRequire(
    date != null && date.toUtc().toIso8601String() == value,
  );
}

final _hash = _regex(r'^[a-f0-9]{64}$');
final _exact = _regex(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$');
final _revision = _integer(1);
final _version = _literal(1);
final _none = _literal('none');
final _false = _literal(false);
ResponsibilityCheck _typedId(String prefix) =>
    _regex('^$prefix:[a-f0-9]{64}\$');
final _ownerFields = <String, ResponsibilityCheck>{
  'tenantId': _exact,
  'actorId': _regex(
    r'^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
  ),
  'responsibilityId': responsibilityId,
};
final _budget = _object({
  for (final key in responsibilityBudgetDimensions)
    key: _integer(0, 1000000000000),
});
void _source(Object? value) {
  final item = responsibilityMap(value);
  switch (item['kind']) {
    case 'meeting':
      _object({
        'kind': _literal('meeting'),
        'id': _exact,
        'workspaceId': _exact,
      })(value);
    case 'capture_asset':
      _object({'kind': _literal('capture_asset'), 'id': _exact})(value);
    case 'thread':
      _object({
        'kind': _literal('thread'),
        'id': _regex(
          r'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',
        ),
      })(value);
    default:
      throw const FormatException('Unsupported Responsibility source.');
  }
}

final _workFields = <String, ResponsibilityCheck>{
  'workspaceId': _exact,
  'projectId': _exact,
  'workItemId': _exact,
};
void _cadence(Object? value) {
  _object({
    'frequency': _choice('hourly daily weekly'),
    'interval': _integer(1, 24),
    'timezone': _string(100),
    'startsAt': _instant,
    'expiresAt': _instant,
    'missedPolicy': _literal('skip'),
  })(value);
  final map = responsibilityMap(value),
      duration = DateTime.parse(map['expiresAt'] as String)
          .difference(DateTime.parse(map['startsAt'] as String));
  responsibilityRequire(
    duration > Duration.zero && duration <= const Duration(days: 366),
  );
  // IANA timezone existence is revalidated by the authoritative service. The
  // native editor offers UTC; existing reviewed timezone identifiers stay exact.
}

final _rule = _object({
  'kind': _literal('material_change_only'),
  'destination': _literal('owner_in_app'),
  'quietOnNoChange': _literal(true),
});
void validateResponsibilityDraft(Object? value) {
  _object({
    'schemaVersion': _version,
    'purpose': _string(2000, true),
    'desiredOutcome': _string(2000, true),
    'sources': _array(_source, 20),
    'cadence': _nullable(_cadence),
    'limits': _nullable(
      _object({
        'maxChecks': _integer(1, 10000),
        'maxNotifications': _integer(0, 1000),
        'cumulative': _budget,
      }),
    ),
    'notificationRule': _nullable(_rule),
    'successCondition': _string(1000, true),
    'stopConditions': _array(_string(500), 8),
    'work': _nullable(_object(_workFields)),
    'procedureId': _nullable(_exact),
    'agentId': _nullable(_exact),
  })(value);
  final sources = responsibilityMap(value)['sources'] as List;
  responsibilityRequire(
    sources.map(responsibilityCanonical).toSet().length == sources.length,
  );
}

ResponsibilityJson emptyResponsibilityDraft() => {
  'schemaVersion': 1,
  'purpose': '',
  'desiredOutcome': '',
  'sources': <Object?>[],
  'cadence': null,
  'limits': null,
  'notificationRule': null,
  'successCondition': '',
  'stopConditions': <String>[],
  'work': null,
  'procedureId': null,
  'agentId': null,
};
final _pins = _object({
  'sources': _array(
    _object({'source': _source, 'revisionSha256': _hash}),
    20,
    1,
  ),
  'work': _object({..._workFields, 'projectionSha256': _hash}),
  'procedure': _object({
    'id': _exact,
    'snapshotSha256': _hash,
    'toolBindingsSha256': _hash,
  }),
  'agent': _object({
    'id': _exact,
    'definitionVersionId': _exact,
    'principalVersionId': _exact,
    'identityPinSha256': _hash,
    'policySha256': _hash,
  }),
});
final _record = _object({
  'schemaVersion': _version,
  'id': responsibilityId,
  'tenantId': _exact,
  'actorId': _ownerFields['actorId']!,
  'revision': _revision,
  'state': _choice('draft reviewed'),
  'draft': validateResponsibilityDraft,
  'draftSha256': _hash,
  'review': _nullable(
    _object({
      'schemaVersion': _version,
      'draftSha256': _hash,
      'reviewSha256': _hash,
      'pins': _pins,
      'reviewedAt': _instant,
      'authorityEffect': _none,
      'activationSupported': _false,
    }),
  ),
  'createdAt': _instant,
  'updatedAt': _instant,
});
final _compatibility = _object({
  'schemaVersion': _version,
  'supportedActions': (v) => responsibilityRequire(
    responsibilitySame(v, ['create', 'update', 'review']),
  ),
  'activationSupported': _false,
  'executionAuthority': _none,
  'observationSupported': _false,
  'deliverySupported': _false,
  'unknownVersionBehavior': _literal('reject_without_mutation'),
});
Map<String, ResponsibilityCheck> _envelope(String contract) => {
  'schemaVersion': _version,
  'contract': _literal(contract),
};
final _draftEnvelope = {
  ..._envelope(responsibilityDraftContract),
  'compatibility': _compatibility,
};
final _coverage = _object({
  'kind': _literal('bounded_recent'),
  'limit': _integer(1, 100),
  'returned': _integer(0, 100),
  'total': _literal(null),
});
void _readiness(Object? value) {
  final map = responsibilityMap(value);
  if (map['state'] == 'ready') {
    _object({
      'state': _literal('ready'),
      'draftSha256': _hash,
      'reviewSha256': _hash,
      'pins': _pins,
      'authorityEffect': _none,
      'activationSupported': _false,
    })(map);
  } else {
    _object({
      'state': _choice('not_checked incomplete blocked'),
      'issues': _array(
        _string(),
        map['state'] == 'blocked'
            ? 1
            : map['state'] == 'not_checked'
            ? 0
            : 12,
        map['state'] == 'not_checked' ? 0 : 1,
      ),
    })(map);
  }
}

final _configuration = _object({
  'schemaVersion': _version,
  'pilot': _literal(responsibilityPilot),
  'responsibilityRevision': _revision,
  'reviewSha256': _hash,
  'draftSha256': _hash,
  'pins': _pins,
  'source': _source,
  'tool': _object({
    'id': _literal('app.meetings.show'),
    'input': _object({'workspaceId': _exact, 'meetingId': _exact}),
    'contractSha256': _hash,
  }),
  'cadence': _cadence,
  'maximumChecks': _integer(1, 10000),
  'cumulativeLimits': _budget,
  'checkReservation': _budget,
  'comparisonPolicySha256': _hash,
  'stops': (v) => responsibilityRequire(
    responsibilitySame(v, ['expiry', 'meeting_started', 'meeting_canceled']),
  ),
  'notificationAuthority': _none,
  'approvalAuthority': _none,
  'mutationAuthority': _none,
  'configurationSha256': _hash,
});
final _lifecycle = _object({
  ..._envelope(responsibilityRuntimeContract),
  ..._ownerFields,
  'revision': _revision,
  'generation': _revision,
  'state': _choice('active pausing paused ending ended blocked'),
  'reason': _choice(
    'owner_activated owner_paused owner_resumed owner_ended expired meeting_started meeting_canceled budget_exhausted source_unavailable authority_changed uncertain_started_work check_settled missed_skipped',
  ),
  'configuration': _configuration,
  'nextDueAt': _nullable(_instant),
  'budget': _object({
    'limits': _budget,
    'used': _budget,
    'reserved': _budget,
    'maximumChecks': _integer(1, 10000),
    'usedChecks': _integer(0, 10000),
    'reservedChecks': _integer(0, 10000),
  }),
  'activatedAt': _instant,
  'updatedAt': _instant,
});
final _wake = _object({
  'schemaVersion': _version,
  'id': _typedId('responsibility-wake'),
  ..._ownerFields,
  'generation': _revision,
  'configurationSha256': _hash,
  'scheduledFor': _instant,
  'revision': _revision,
  'state': _choice(
    'reserved enqueued running completed failed canceled uncertain',
  ),
  'reservation': _budget,
  'charged': _nullable(_budget),
  'workflowRunId': _nullable(
    _regex(
      r'^(?:wf_[a-f0-9]{40}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$',
    ),
  ),
  'operationJobId': _nullable(_exact),
  'leaseGeneration': _integer(),
  'leaseTokenSha256': _nullable(_hash),
  'leaseExpiresAt': _nullable(_instant),
  'startedAt': _nullable(_instant),
  'settledAt': _nullable(_instant),
  'observationId': _nullable(_typedId('responsibility-observation')),
  'observationReceiptSha256': _nullable(_hash),
  'createdAt': _instant,
  'updatedAt': _instant,
});
final _runtimeReceipt = _object({
  'schemaVersion': _version,
  'id': _typedId('responsibility-runtime-receipt'),
  'idempotencySha256': _hash,
  'requestSha256': _hash,
  'action': _choice(
    'activate pause resume end reserve enqueue start settle block reconcile',
  ),
  'previousRevision': _integer(),
  'snapshot': _lifecycle,
  'wake': _nullable(_wake),
  'savedAt': _instant,
  'receiptSha256': _hash,
});
final _draftReceipt = _object({
  'schemaVersion': _version,
  'id': _typedId('responsibility-mutation'),
  'idempotencySha256': _hash,
  'requestSha256': _hash,
  'action': _choice('created updated reviewed'),
  'expectedRevision': _integer(),
  'snapshot': _record,
  'savedAt': _instant,
  'authorityEffect': _none,
  'activationSupported': _false,
});
final _notificationConfiguration = _object({
  'schemaVersion': _version,
  ..._ownerFields,
  'policy': _literal('owner_in_app_material_change_v1'),
  'runtimeConfigurationSha256': _hash,
  'responsibilityRevision': _revision,
  'reviewSha256': _hash,
  'draftSha256': _hash,
  'source': _source,
  'destination': _literal('owner_in_app'),
  'quietOnNoChange': _literal(true),
  'maximumNotifications': _integer(1, 1000),
  'expiresAt': _instant,
  'configurationSha256': _hash,
});
final _admission = _object({
  ..._envelope(responsibilityNotificationContract),
  ..._ownerFields,
  'revision': _revision,
  'generation': _revision,
  'state': _choice('enabled paused draining ended'),
  'reason': _choice(
    'owner_enabled owner_stopped runtime_paused runtime_resumed runtime_ended runtime_blocked expired checks_exhausted',
  ),
  'configuration': _notificationConfiguration,
  'used': _integer(0, 1000),
  'reserved': _integer(0, 1000),
  'enabledAt': _instant,
  'updatedAt': _instant,
});
final _candidate = _object({
  'schemaVersion': _version,
  ..._ownerFields,
  'id': _typedId('responsibility-notification'),
  'changeId': _typedId('responsibility-change'),
  'changeSha256': _hash,
  'configurationSha256': _hash,
  'generation': _revision,
  'revision': _revision,
  'state': _choice('pending held delivered canceled blocked expired'),
  'reason': _choice(
    'material_change quiet_hours delivery_retry in_app_recorded owner_paused owner_ended runtime_blocked expired owner_stopped source_unavailable destination_unavailable notifications_disabled preferences_unavailable notification_limit',
  ),
  'attempts': _integer(0, 100),
  'expiresAt': _instant,
  'nextAttemptAt': _nullable(_instant),
  'notificationId': _nullable(_regex(r'^notification_[a-f0-9]{48}$')),
  'dispositionId': _nullable(
    _regex(r'^notification_disposition_[a-f0-9]{48}$'),
  ),
  'deliveryBindingSha256': _nullable(_hash),
  'createdAt': _instant,
  'updatedAt': _instant,
  'terminalAt': _nullable(_instant),
});
final _notificationReceipt = _object({
  'schemaVersion': _version,
  'id': _typedId('responsibility-notification-receipt'),
  'idempotencySha256': _hash,
  'requestSha256': _hash,
  'previousRevision': _integer(),
  'action': _choice(
    'enable stop admit hold retry deliver cancel block expire lifecycle',
  ),
  'snapshot': _admission,
  'candidate': _nullable(_candidate),
  'savedAt': _instant,
  'contentIncluded': _false,
  'receiptSha256': _hash,
});
final _notificationEnvelope = {
  ..._envelope(responsibilityNotificationContract),
  'disclosure': _string(2000),
  'externalDelivery': _false,
};
final _target = _object({
  ..._ownerFields,
  'responsibilityRevision': _revision,
  'reviewSha256': _hash,
});
final _semantic = _object({
  for (final field in [
    'meeting_time',
    'meeting_state',
    'agenda',
    'participants',
    'facts',
    'commitments',
    'uninterpretedText',
    'semanticSha256',
  ])
    field: _hash,
});
final _evidence = _object({
  'kind': _choice(
    'meeting_revision source_evidence thread_turn capture_extraction',
  ),
  'id': _exact,
  'revisionId': _exact,
  'revisionSha256': _hash,
  'contentSha256': _hash,
});
const _failures =
    'missing access_denied stale partial unsupported retrieval_failed evidence_invalid semantic_comparison_required evidence_conflict';
const _categories =
    'meeting_time meeting_state agenda participants facts commitments';
final _sourceReceipt = _object({
  'source': _source,
  'state': _choice('accepted unavailable'),
  'reason': _nullable(_choice(_failures)),
  'revisionId': _nullable(_exact),
  'revisionSha256': _nullable(_hash),
  'authoritySha256': _nullable(_hash),
  'observedAt': _nullable(_instant),
  'sourceUpdatedAt': _nullable(_instant),
  'freshUntil': _nullable(_instant),
  'evidence': _array(_evidence, 100),
});
final _observation = _object({
  ..._envelope(responsibilityObservationContract),
  'id': _typedId('responsibility-observation'),
  'target': _target,
  'policySha256': _hash,
  'observationKeySha256': _hash,
  'observedAt': _instant,
  'sources': _array(_sourceReceipt, 20, 1),
  'state': _choice('complete insufficient_evidence blocked failed'),
  'semantic': _nullable(_semantic),
  'failureReasons': _array(_choice(_failures), 9),
  'authorityEffect': _none,
  'activationSupported': _false,
  'observationSha256': _hash,
});
final _baseline = _object({
  'schemaVersion': _version,
  'revision': _revision,
  'target': _target,
  'policySha256': _hash,
  'observationId': _typedId('responsibility-observation'),
  'observationSha256': _hash,
  'semantic': _semantic,
  'acceptedAt': _instant,
  'baselineSha256': _hash,
});
final _change = _object({
  'schemaVersion': _version,
  'id': _typedId('responsibility-change'),
  'target': _target,
  'policySha256': _hash,
  'previousBaselineSha256': _hash,
  'observationId': _typedId('responsibility-observation'),
  'categories': _array(_choice(_categories), 6, 1),
  'evidence': _array(_evidence, 2000, 1),
  'previousSemanticSha256': _hash,
  'semanticSha256': _hash,
  'deliveryState': _literal('not_requested'),
  'changeSha256': _hash,
});
final _observationReceipt = _object({
  'schemaVersion': _version,
  'request': _object({
    'responsibilityId': responsibilityId,
    'expectedResponsibilityRevision': _revision,
    'expectedReviewSha256': _hash,
    'expectedBaselineRevision': _integer(),
    'policySha256': _hash,
  }),
  'requestSha256': _hash,
  'plan': _object({
    'expectedBaselineRevision': _integer(),
    'observation': _observation,
    'outcome': _choice(
      'baseline_established material_change no_change insufficient_evidence blocked failed',
    ),
    'reasons': _array(
      _choice(
        '$_failures $_categories observation_outdated first_complete_observation equivalent_evidence',
      ),
      16,
      1,
    ),
    'nextBaseline': _nullable(_baseline),
    'change': _nullable(_change),
    'authorityEffect': _none,
    'activationSupported': _false,
  }),
  'savedAt': _instant,
  'receiptSha256': _hash,
});
final _policy = _object({
  'schemaVersion': _version,
  'id': _literal('responsibility-meeting-comparison:1'),
  'maximumSourceAgeSeconds': _literal(3600),
  'firstObservation': _literal('establish_baseline_without_notification'),
  'advancement': _literal('complete_current_authorized_evidence_only'),
  'uncertainComparison': _literal('insufficient_evidence'),
  'adapterCoverage': _string(2000),
  'materialExamples': _array(_string(2000), 10, 1),
  'cosmeticExamples': _array(_string(2000), 10, 1),
  'unsupportedExamples': _array(_string(2000), 10, 1),
  'policySha256': _hash,
});

enum ResponsibilityLane { draft, runtime, notifications }

enum ResponsibilityRead {
  list,
  detail,
  references,
  runtime,
  observations,
  notifications,
}

void validateResponsibilityMutation(
  ResponsibilityLane lane,
  ResponsibilityJson body,
) {
  final action = body['action'];
  if (lane == ResponsibilityLane.draft) {
    if (action == 'create' || action == 'update') {
      _object({
        'action': _choice('create update'),
        'expectedRevision': action == 'create' ? _literal(0) : _revision,
        'draft': validateResponsibilityDraft,
      })(body);
    } else {
      _object({
        'action': _literal('review'),
        'expectedRevision': _revision,
        'draftSha256': _hash,
        'reviewSha256': _hash,
      })(body);
    }
  } else if (lane == ResponsibilityLane.runtime) {
    _object({
      'action': _choice('activate resume pause end'),
      'expectedRevision': action == 'activate' ? _literal(0) : _integer(),
      'expectedGeneration': action == 'activate' ? _literal(0) : _integer(),
      if (action == 'activate' || action == 'resume') ...{
        'configurationSha256': _hash,
        'acknowledgePilot': _literal(responsibilityPilot),
      },
    })(body);
  } else if (action == 'enable') {
    _object({
      'action': _literal('enable'),
      'expectedRuntimeRevision': _revision,
      'expectedRuntimeGeneration': _revision,
      'configurationSha256': _hash,
      'acknowledgeDestination': _literal('owner_in_app'),
    })(body);
  } else {
    _object({
      'action': _literal('stop'),
      'expectedRevision': _revision,
      'expectedGeneration': _revision,
    })(body);
  }
  responsibilityRequire(
    utf8.encode(jsonEncode(body)).length <=
        (lane == ResponsibilityLane.draft ? 32768 : 4096),
  );
}

class ResponsibilityRecord {
  const ResponsibilityRecord(this.raw);
  final ResponsibilityJson raw;
  String get id => raw['id'] as String;
  int get revision => raw['revision'] as int;
  String get state => raw['state'] as String;
  ResponsibilityJson get draft => responsibilityMap(raw['draft']);
  String get title => (draft['purpose'] as String).isEmpty
      ? 'Untitled responsibility'
      : draft['purpose'] as String;
}

/// Independent wire checks retain exact server coordinates. Local validation
/// neither establishes source provenance nor admits lifecycle/delivery work.
class ResponsibilityVerifier {
  const ResponsibilityVerifier(this.owner);
  final ResponsibilityOwner owner;
  void owned(ResponsibilityJson value, [String? id]) {
    responsibilityRequire(
      value['tenantId'] == owner.tenantId &&
          value['actorId'] == owner.actorId &&
          (id == null || value['responsibilityId'] == id),
    );
  }

  Future<void> digestBody(ResponsibilityJson value, String field) async {
    final body = {...value}..remove(field);
    responsibilityRequire(
      value[field] == await responsibilityHash(body),
      'The Responsibility evidence digest changed.',
    );
  }

  Future<String> reviewDigest(
    ResponsibilityJson record,
    int revision,
    ResponsibilityJson pins,
  ) async {
    final draft = responsibilityMap(record['draft']),
        work = responsibilityMap(pins['work']);
    responsibilityRequire(
      responsibilitySame(
            (pins['sources'] as List)
                .map((p) => responsibilityMap(p)['source'])
                .toList(),
            draft['sources'],
          ) &&
          responsibilitySame({
            for (final key in _workFields.keys) key: work[key],
          }, draft['work']) &&
          responsibilityMap(pins['procedure'])['id'] == draft['procedureId'] &&
          responsibilityMap(pins['agent'])['id'] == draft['agentId'],
    );
    return responsibilityHash({
      'contract': 'responsibility-review:1',
      'id': record['id'],
      'tenantId': record['tenantId'],
      'actorId': record['actorId'],
      'revision': revision,
      'draftSha256': record['draftSha256'],
      'pins': pins,
      'authorityEffect': 'none',
      'activationSupported': false,
    });
  }

  Future<void> record(ResponsibilityJson value, [String? id]) async {
    _record(value);
    owned(value);
    responsibilityRequire(
      (id == null || value['id'] == id) &&
          (value['createdAt'] as String).compareTo(
                value['updatedAt'] as String,
              ) <=
              0 &&
          value['draftSha256'] ==
              await responsibilityHash({
                'contract': 'responsibility-draft:1',
                'draft': value['draft'],
              }),
    );
    if (value['state'] == 'draft') {
      responsibilityRequire(value['review'] == null);
      return;
    }
    final review = responsibilityMap(value['review']);
    responsibilityRequire(
      review['draftSha256'] == value['draftSha256'] &&
          review['reviewedAt'] == value['updatedAt'] &&
          review['reviewSha256'] ==
              await reviewDigest(
                value,
                (value['revision'] as int) - 1,
                responsibilityMap(review['pins']),
              ),
    );
  }

  Future<void> configuration(
    ResponsibilityJson value, {
    String? id,
    bool notification = false,
  }) async {
    if (notification) {
      _notificationConfiguration(value);
      owned(value, id);
    } else {
      _configuration(value);
    }
    responsibilityRequire(
      responsibilityMap(value['source'])['kind'] == 'meeting',
    );
    if (!notification) {
      final source = responsibilityMap(value['source']),
          input = responsibilityMap(responsibilityMap(value['tool'])['input']);
      final pinnedSources = responsibilityMap(value['pins'])['sources'] as List;
      final reservation = {
        for (final field in responsibilityBudgetDimensions)
          field: field == 'wallTimeMs'
              ? 30000
              : field == 'toolCalls' || field == 'agents'
              ? 1
              : 0,
      };
      responsibilityRequire(
        input['meetingId'] == source['id'] &&
            input['workspaceId'] == source['workspaceId'] &&
            responsibilityMap(value['cadence'])['frequency'] != 'hourly' &&
            pinnedSources.length == 1 &&
            responsibilitySame(
              responsibilityMap(pinnedSources.single)['source'],
              source,
            ) &&
            responsibilitySame(value['checkReservation'], reservation),
      );
      for (final field in responsibilityBudgetDimensions) {
        responsibilityRequire(
          (responsibilityMap(value['cumulativeLimits'])[field] as int) >=
              reservation[field]!,
        );
      }
    }
    await digestBody(value, 'configurationSha256');
  }

  Future<void> wake(ResponsibilityJson value, String id) async {
    _wake(value);
    owned(value, id);
    final terminal = const {
      'completed',
      'failed',
      'canceled',
    }.contains(value['state']);
    responsibilityRequire(
      terminal == (value['settledAt'] != null) &&
          terminal == (value['charged'] != null) &&
          (!const {'running', 'uncertain'}.contains(value['state']) ||
              value['startedAt'] != null) &&
          (value['observationId'] == null) ==
              (value['observationReceiptSha256'] == null) &&
          (value['state'] != 'completed' || value['observationId'] != null) &&
          (value['leaseTokenSha256'] == null) ==
              (value['leaseExpiresAt'] == null),
    );
    responsibilityRequire(
      value['id'] ==
          'responsibility-wake:${await responsibilityHash([owner.tenantId, owner.actorId, id, value['generation'], value['scheduledFor']])}',
    );
  }

  Future<void> head(
    ResponsibilityJson value,
    String id,
    ResponsibilityLane lane,
  ) async {
    if (lane == ResponsibilityLane.draft) return record(value, id);
    final notification = lane == ResponsibilityLane.notifications;
    (notification ? _admission : _lifecycle)(value);
    owned(value, id);
    final config = responsibilityMap(value['configuration']);
    await configuration(config, id: id, notification: notification);
    responsibilityRequire(
      (value['updatedAt'] as String).compareTo(
            value[notification ? 'enabledAt' : 'activatedAt'] as String,
          ) >=
          0,
    );
    if (notification) {
      responsibilityRequire(
        (value['used'] as int) + (value['reserved'] as int) <=
                config['maximumNotifications'] &&
            (!const {'paused', 'ended'}.contains(value['state']) ||
                value['reserved'] == 0) &&
            (value['reason'] != 'owner_stopped' || value['state'] == 'ended'),
      );
    } else {
      final budget = responsibilityMap(value['budget']);
      responsibilityRequire(
        (value['state'] == 'active' || value['nextDueAt'] == null) &&
            budget['maximumChecks'] == config['maximumChecks'] &&
            responsibilitySame(budget['limits'], config['cumulativeLimits']) &&
            (budget['usedChecks'] as int) + (budget['reservedChecks'] as int) <=
                budget['maximumChecks'],
      );
      for (final field in responsibilityBudgetDimensions) {
        responsibilityRequire(
          (responsibilityMap(budget['used'])[field] as int) +
                  (responsibilityMap(budget['reserved'])[field] as int) <=
              responsibilityMap(budget['limits'])[field],
        );
      }
    }
  }

  Future<void> candidate(ResponsibilityJson value, String id) async {
    _candidate(value);
    owned(value, id);
    final pending = const {'pending', 'held'}.contains(value['state']),
        delivered = value['state'] == 'delivered';
    responsibilityRequire(
      (value['updatedAt'] as String).compareTo(value['createdAt'] as String) >=
              0 &&
          (value['expiresAt'] as String).compareTo(
                value['createdAt'] as String,
              ) >
              0,
    );
    responsibilityRequire(
      pending
          ? value['terminalAt'] == null &&
                value['nextAttemptAt'] != null &&
                (value['nextAttemptAt'] as String).compareTo(
                      value['updatedAt'] as String,
                    ) >=
                    0 &&
                (value['nextAttemptAt'] as String).compareTo(
                      value['expiresAt'] as String,
                    ) <=
                    0
          : value['nextAttemptAt'] == null &&
                value['terminalAt'] == value['updatedAt'],
    );
    responsibilityRequire(
      delivered == (value['notificationId'] != null) &&
          delivered == (value['deliveryBindingSha256'] != null) &&
          (!delivered ||
              value['dispositionId'] != null &&
                  value['reason'] == 'in_app_recorded'),
    );
    responsibilityRequire(
      value['id'] ==
          'responsibility-notification:${await responsibilityHash([owner.tenantId, owner.actorId, id, value['changeId'], value['changeSha256'], 'owner_in_app'])}',
    );
  }

  Future<void> receipt(
    ResponsibilityJson value,
    String id,
    ResponsibilityLane lane,
  ) async {
    (lane == ResponsibilityLane.draft
        ? _draftReceipt
        : lane == ResponsibilityLane.runtime
        ? _runtimeReceipt
        : _notificationReceipt)(value);
    final snapshot = responsibilityMap(value['snapshot']);
    await head(snapshot, id, lane);
    final prior =
        value[lane == ResponsibilityLane.draft
                ? 'expectedRevision'
                : 'previousRevision']
            as int;
    responsibilityRequire(
      snapshot['revision'] == prior + 1 &&
          value['savedAt'] == snapshot['updatedAt'],
    );
    final prefix = lane == ResponsibilityLane.draft
        ? 'responsibility-mutation'
        : lane == ResponsibilityLane.runtime
        ? 'responsibility-runtime-receipt'
        : 'responsibility-notification-receipt';
    responsibilityRequire(
      value['id'] ==
          '$prefix:${await responsibilityHash([owner.tenantId, owner.actorId, value['idempotencySha256']])}',
    );
    if (lane != ResponsibilityLane.draft) {
      await digestBody(value, 'receiptSha256');
    }
    if (lane == ResponsibilityLane.runtime && value['wake'] != null) {
      final item = responsibilityMap(value['wake']);
      await wake(item, id);
      // A check admitted before pause/end can settle under a later generation.
      responsibilityRequire(
        (item['generation'] as int) <= snapshot['generation'] &&
            item['configurationSha256'] ==
                responsibilityMap(
                  snapshot['configuration'],
                )['configurationSha256'],
      );
    }
    if (lane == ResponsibilityLane.notifications) {
      responsibilityRequire(
        const {'enable', 'stop', 'lifecycle'}.contains(value['action']) ==
            (value['candidate'] == null),
      );
      if (value['candidate'] != null) {
        final item = responsibilityMap(value['candidate']);
        await candidate(item, id);
        responsibilityRequire(
          item['generation'] == snapshot['generation'] &&
              item['updatedAt'] == value['savedAt'] &&
              item['configurationSha256'] ==
                  responsibilityMap(
                    snapshot['configuration'],
                  )['configurationSha256'],
        );
      }
    }
  }

  Future<ResponsibilityJson> mutation(
    Object? raw,
    ResponsibilityLane lane,
    ResponsibilityJson input,
    String key,
    String? requestedId,
  ) async {
    final value = responsibilityMap(raw),
        envelope = lane == ResponsibilityLane.draft
            ? _draftEnvelope
            : lane == ResponsibilityLane.runtime
            ? _envelope(responsibilityRuntimeContract)
            : _notificationEnvelope;
    _object({
      ...envelope,
      'current': lane == ResponsibilityLane.draft
          ? _record
          : lane == ResponsibilityLane.runtime
          ? _lifecycle
          : _admission,
      'receipt': lane == ResponsibilityLane.draft
          ? _draftReceipt
          : lane == ResponsibilityLane.runtime
          ? _runtimeReceipt
          : _notificationReceipt,
      'replayed': _boolean,
    })(value);
    final accepted = responsibilityMap(value['receipt']),
        snapshot = responsibilityMap(accepted['snapshot']),
        current = responsibilityMap(value['current']);
    final id = responsibilityId(
      snapshot[lane == ResponsibilityLane.draft ? 'id' : 'responsibilityId'],
    );
    responsibilityRequire(requestedId == null || requestedId == id);
    await receipt(accepted, id, lane);
    await head(current, id, lane);
    final keyHash = await responsibilityHash([
      'responsibility-idempotency:1',
      key,
    ]);
    responsibilityRequire(
      accepted['idempotencySha256'] == keyHash &&
          accepted['requestSha256'] ==
              await responsibilityHash(
                lane == ResponsibilityLane.draft
                    ? ['responsibility-request:1', id, input]
                    : {'responsibilityId': id, ...input},
              ),
    );
    responsibilityRequire(
      (current['revision'] as int) >= snapshot['revision'] &&
          (current['revision'] != snapshot['revision'] ||
              responsibilitySame(current, snapshot)) &&
          (value['replayed'] == true || responsibilitySame(current, snapshot)),
    );
    if (lane == ResponsibilityLane.draft) {
      responsibilityRequire(
        accepted['action'] ==
                const {
                  'create': 'created',
                  'update': 'updated',
                  'review': 'reviewed',
                }[input['action']] &&
            accepted['expectedRevision'] == input['expectedRevision'],
      );
      if (input['action'] == 'create') {
        responsibilityRequire(
          id ==
              'responsibility:${await responsibilityHash([owner.tenantId, owner.actorId, keyHash])}',
        );
      }
      if (input['action'] == 'review') {
        responsibilityRequire(
          snapshot['state'] == 'reviewed' &&
              responsibilityMap(snapshot['review'])['reviewSha256'] ==
                  input['reviewSha256'] &&
              snapshot['draftSha256'] == input['draftSha256'],
        );
      } else {
        responsibilityRequire(
          snapshot['state'] == 'draft' &&
              responsibilitySame(snapshot['draft'], input['draft']),
        );
      }
    } else {
      responsibilityRequire(accepted['action'] == input['action']);
      if (lane == ResponsibilityLane.runtime) {
        responsibilityRequire(
          accepted['previousRevision'] == input['expectedRevision'] &&
              snapshot['generation'] ==
                  (input['expectedGeneration'] as int) + 1,
        );
        if (input.containsKey('configurationSha256')) {
          responsibilityRequire(
            responsibilityMap(
                  snapshot['configuration'],
                )['configurationSha256'] ==
                input['configurationSha256'],
          );
        }
        responsibilityRequire(switch (input['action']) {
          'activate' || 'resume' => snapshot['state'] == 'active',
          'pause' => const {'paused', 'pausing'}.contains(snapshot['state']),
          'end' => const {'ending', 'ended'}.contains(snapshot['state']),
          _ => false,
        });
      } else {
        responsibilityRequire(
          responsibilitySame(
            current['configuration'],
            snapshot['configuration'],
          ),
        );
        if (input['action'] == 'enable') {
          responsibilityRequire(
            accepted['previousRevision'] == 0 &&
                snapshot['revision'] == 1 &&
                snapshot['generation'] == 1 &&
                snapshot['state'] == 'enabled' &&
                snapshot['reason'] == 'owner_enabled' &&
                snapshot['used'] == 0 &&
                snapshot['reserved'] == 0 &&
                responsibilityMap(
                      snapshot['configuration'],
                    )['configurationSha256'] ==
                    input['configurationSha256'],
          );
        } else {
          responsibilityRequire(
            (accepted['previousRevision'] as int) >=
                    input['expectedRevision'] &&
                snapshot['generation'] ==
                    (input['expectedGeneration'] as int) + 1 &&
                snapshot['state'] == 'ended' &&
                snapshot['reason'] == 'owner_stopped' &&
                snapshot['reserved'] == 0,
          );
        }
      }
    }
    return freezeResponsibility(value) as ResponsibilityJson;
  }

  Future<ResponsibilityJson> read(
    Object? raw,
    ResponsibilityRead kind, {
    String? id,
    bool preview = false,
    int limit = 40,
  }) async {
    final value = responsibilityMap(raw);
    switch (kind) {
      case ResponsibilityRead.list:
        _object({
          ..._draftEnvelope,
          'records': _array(_record, 100),
          'hasMore': _boolean,
          'coverage': _coverage,
        })(value);
        _checkCoverage(value, 'records', limit);
        for (final item in value['records'] as List) {
          await record(responsibilityMap(item));
        }
        _unique(value['records'] as List, 'id');
      case ResponsibilityRead.detail:
        _object({
          ..._draftEnvelope,
          'record': _record,
          'readiness': _readiness,
        })(value);
        final current = responsibilityMap(value['record']),
            ready = responsibilityMap(value['readiness']);
        await record(current, id);
        if (ready['state'] == 'ready') {
          responsibilityRequire(
            ready['draftSha256'] == current['draftSha256'] &&
                ready['reviewSha256'] ==
                    await reviewDigest(
                      current,
                      current['revision'] as int,
                      responsibilityMap(ready['pins']),
                    ),
          );
        }
      case ResponsibilityRead.references:
        _references(value);
      case ResponsibilityRead.runtime:
        _object(
          {
            ..._envelope(responsibilityRuntimeContract),
            'current': _nullable(_lifecycle),
            'disclosure': _object({
              'pilot': _literal(responsibilityPilot),
              for (final field in [
                'source',
                'comparison',
                'cadence',
                'stops',
                'execution',
              ])
                field: _string(2000),
            }),
            'wakes': _array(_wake),
            'receipts': _array(_runtimeReceipt),
            'coverage': _object({
              'limit': _literal(40),
              'total': _literal(null),
              'hasMoreWakes': _boolean,
              'hasMoreReceipts': _boolean,
            }),
            'dispatchReadiness': _literal('not_observed'),
            'deliverySupported': _false,
          },
          {'preview': _preview(false)},
        )(value);
        await _history(value, id!, ResponsibilityLane.runtime);
        if (value['preview'] != null &&
            responsibilityMap(value['preview'])['state'] == 'ready') {
          await configuration(
            responsibilityMap(
              responsibilityMap(value['preview'])['configuration'],
            ),
          );
        }
      case ResponsibilityRead.notifications:
        _object(
          {
            ..._notificationEnvelope,
            'current': _nullable(_admission),
            'candidates': _array(_candidate),
            'receipts': _array(_notificationReceipt),
            'coverage': _object({
              'limit': _literal(40),
              'total': _literal(null),
              'hasMoreCandidates': _boolean,
              'hasMoreReceipts': _boolean,
            }),
          },
          {'preview': _preview(true)},
        )(value);
        await _history(value, id!, ResponsibilityLane.notifications);
        if (value['preview'] != null &&
            responsibilityMap(value['preview'])['state'] == 'ready') {
          responsibilityRequire(value['current'] == null);
          await configuration(
            responsibilityMap(
              responsibilityMap(value['preview'])['configuration'],
            ),
            id: id,
            notification: true,
          );
        }
      case ResponsibilityRead.observations:
        await _observations(value, id!, limit);
    }
    if (preview) {
      responsibilityRequire(
        kind == ResponsibilityRead.detail || value.containsKey('preview'),
      );
    }
    return freezeResponsibility(value) as ResponsibilityJson;
  }

  void _checkCoverage(ResponsibilityJson value, String rows, int limit) {
    final coverage = responsibilityMap(value['coverage']);
    responsibilityRequire(
      coverage['limit'] == limit &&
          coverage['returned'] == (value[rows] as List).length &&
          (value[rows] as List).length <= limit,
    );
  }

  void _unique(List rows, String field) => responsibilityRequire(
    rows.map((row) => responsibilityMap(row)[field]).toSet().length ==
        rows.length,
  );
  ResponsibilityCheck _preview(bool notification) => (value) {
    final map = responsibilityMap(value);
    if (map['state'] == 'blocked') {
      _object({
        'state': _literal('blocked'),
        'reason': _string(),
        'authorityEffect': _none,
      })(map);
      return;
    }
    _object({
      'state': _literal('ready'),
      'authorityEffect': _none,
      'configuration': notification
          ? _notificationConfiguration
          : _configuration,
      if (notification) ...{
        'expectedRuntimeRevision': _revision,
        'expectedRuntimeGeneration': _revision,
      } else
        'dispatchReadiness': _literal('not_observed'),
    })(map);
  };
  void _references(ResponsibilityJson value) {
    ResponsibilityCheck group(ResponsibilityCheck item) => (v) {
      final map = responsibilityMap(v);
      if (map['state'] == 'unavailable') {
        _object({
          'state': _literal('unavailable'),
          'items': _array(item, 0),
          'hasMore': _literal(null),
          'errorCode': _literal('responsibility_reference_read_unavailable'),
        })(map);
      } else {
        _object({
          'state': _literal('available'),
          'items': _array(item),
          'hasMore': _boolean,
        })(map);
      }
    };
    _object({
      ..._envelope('asael-responsibility-references:1'),
      'owner': _object({
        'tenantId': _exact,
        'actorId': _ownerFields['actorId']!,
      }),
      'groups': _object({
        'sources': group(_object({'source': _source, 'label': _string()})),
        'work': group(_object({..._workFields, 'label': _string()})),
        'procedures': group(_object({'id': _exact, 'label': _string()})),
        'agents': group(_object({'id': _exact, 'label': _string()})),
      }),
      'coverage': _object({
        'perGroupLimit': _literal(40),
        'totals': _literal('unavailable'),
      }),
      'authorityEffect': _none,
    })(value);
    owned(responsibilityMap(value['owner']));
  }

  Future<void> _history(
    ResponsibilityJson value,
    String id,
    ResponsibilityLane lane,
  ) async {
    final notification = lane == ResponsibilityLane.notifications,
        rows = value[notification ? 'candidates' : 'wakes'] as List,
        receipts = value['receipts'] as List;
    final current = value['current'] == null
        ? null
        : responsibilityMap(value['current']);
    if (current == null) {
      responsibilityRequire(
        rows.isEmpty &&
            receipts.isEmpty &&
            responsibilityMap(value['coverage']).values
                .whereType<bool>()
                .every((v) => !v),
      );
      return;
    }
    await head(current, id, lane);
    _unique(rows, 'id');
    _unique(receipts, 'id');
    responsibilityRequire(
      receipts
              .map(
                (row) => responsibilityMap(
                  responsibilityMap(row)['snapshot'],
                )['revision'],
              )
              .toSet()
              .length ==
          receipts.length,
    );
    for (final raw in receipts) {
      final item = responsibilityMap(raw);
      await receipt(item, id, lane);
      final snapshot = responsibilityMap(item['snapshot']);
      responsibilityRequire(
        (snapshot['revision'] as int) <= current['revision'] &&
            (snapshot['revision'] != current['revision'] ||
                responsibilitySame(snapshot, current)),
      );
      if (notification) {
        responsibilityRequire(
          responsibilitySame(
            snapshot['configuration'],
            current['configuration'],
          ),
        );
      }
    }
    for (final raw in rows) {
      final item = responsibilityMap(raw);
      owned(item, id);
      responsibilityRequire(
        (item['generation'] as int) <= current['generation'],
      );
      if (notification) {
        await candidate(item, id);
        responsibilityRequire(
          item['configurationSha256'] ==
                  responsibilityMap(
                    current['configuration'],
                  )['configurationSha256'] &&
              (item['updatedAt'] as String).compareTo(
                    current['updatedAt'] as String,
                  ) <=
                  0,
        );
        if (const {'pending', 'held'}.contains(item['state'])) {
          responsibilityRequire(
            item['generation'] == current['generation'] &&
                const {'enabled', 'draining'}.contains(current['state']),
          );
        }
      } else {
        await wake(item, id);
        responsibilityRequire(
          item['configurationSha256'] ==
              responsibilityMap(
                current['configuration'],
              )['configurationSha256'],
        );
      }
    }
    if (notification) {
      responsibilityRequire(
        rows
                    .where(
                      (r) => const {
                        'pending',
                        'held',
                      }.contains(responsibilityMap(r)['state']),
                    )
                    .length <=
                current['reserved'] &&
            rows
                    .where((r) => responsibilityMap(r)['state'] == 'delivered')
                    .length <=
                current['used'],
      );
    }
  }

  Future<void> _observations(
    ResponsibilityJson value,
    String id,
    int limit,
  ) async {
    _object({
      ..._envelope(responsibilityObservationContract),
      'policy': _policy,
      'authorityEffect': _none,
      'activationSupported': _false,
      'deliverySupported': _false,
      'receipts': _array(_observationReceipt, 100),
      'baseline': _nullable(_baseline),
      'hasMore': _boolean,
      'coverage': _coverage,
    })(value);
    _checkCoverage(value, 'receipts', limit);
    final policy = responsibilityMap(value['policy']);
    await digestBody(policy, 'policySha256');
    if (value['baseline'] != null) {
      final baseline = responsibilityMap(value['baseline']);
      owned(responsibilityMap(baseline['target']), id);
      await digestBody(baseline, 'baselineSha256');
      await digestBody(
        responsibilityMap(baseline['semantic']),
        'semanticSha256',
      );
      responsibilityRequire(baseline['policySha256'] == policy['policySha256']);
    }
    _unique(value['receipts'] as List, 'receiptSha256');
    for (final raw in value['receipts'] as List) {
      final item = responsibilityMap(raw),
          plan = responsibilityMap(item['plan']),
          observation = responsibilityMap(plan['observation']),
          target = responsibilityMap(observation['target']),
          request = responsibilityMap(item['request']);
      owned(target, id);
      await digestBody(item, 'receiptSha256');
      await digestBody(observation, 'observationSha256');
      responsibilityRequire(
        item['requestSha256'] ==
                await responsibilityHash({
                  'owner': {
                    'tenantId': owner.tenantId,
                    'actorId': owner.actorId,
                  },
                  'request': request,
                }) &&
            item['savedAt'] == observation['observedAt'] &&
            observation['id'] ==
                'responsibility-observation:${await responsibilityHash([target, observation['observationKeySha256']])}',
      );
      responsibilityRequire(
        request['responsibilityId'] == id &&
            request['expectedResponsibilityRevision'] ==
                target['responsibilityRevision'] &&
            request['expectedReviewSha256'] == target['reviewSha256'] &&
            request['policySha256'] == policy['policySha256'] &&
            observation['policySha256'] == policy['policySha256'] &&
            request['expectedBaselineRevision'] ==
                plan['expectedBaselineRevision'],
      );
      for (final source in observation['sources'] as List) {
        final row = responsibilityMap(source),
            accepted = row['state'] == 'accepted';
        responsibilityRequire(
          accepted == (row['reason'] == null) &&
              (accepted
                  ? (row['evidence'] as List).isNotEmpty
                  : (row['evidence'] as List).isEmpty),
        );
        for (final key in [
          'revisionId',
          'revisionSha256',
          'authoritySha256',
          'observedAt',
          'sourceUpdatedAt',
          'freshUntil',
        ]) {
          responsibilityRequire(accepted == (row[key] != null));
        }
      }
      final complete = observation['state'] == 'complete';
      responsibilityRequire(
        complete == (observation['semantic'] != null) &&
            (complete
                ? (observation['failureReasons'] as List).isEmpty &&
                      (observation['sources'] as List).every(
                        (row) => responsibilityMap(row)['state'] == 'accepted',
                      )
                : (observation['failureReasons'] as List).isNotEmpty &&
                      (plan['outcome'] == observation['state'] ||
                          plan['outcome'] == 'insufficient_evidence' &&
                              (plan['reasons'] as List).contains(
                                'observation_outdated',
                              ))),
      );
      if (observation['semantic'] != null) {
        await digestBody(
          responsibilityMap(observation['semantic']),
          'semanticSha256',
        );
      }
      final outcome = plan['outcome'];
      final advancing = const {
        'baseline_established',
        'material_change',
        'no_change',
      }.contains(outcome);
      responsibilityRequire(
        (outcome == 'material_change') == (plan['change'] != null) &&
            advancing == (plan['nextBaseline'] != null) &&
            (!advancing || complete) &&
            (outcome != 'baseline_established' ||
                plan['expectedBaselineRevision'] == 0) &&
            (!const {'material_change', 'no_change'}.contains(outcome) ||
                plan['expectedBaselineRevision'] != 0),
      );
      if (plan['nextBaseline'] != null) {
        final baseline = responsibilityMap(plan['nextBaseline']);
        owned(responsibilityMap(baseline['target']), id);
        await digestBody(baseline, 'baselineSha256');
        await digestBody(
          responsibilityMap(baseline['semantic']),
          'semanticSha256',
        );
        responsibilityRequire(
          complete &&
              advancing &&
              baseline['observationId'] == observation['id'] &&
              responsibilitySame(baseline['target'], target) &&
              baseline['revision'] ==
                  (plan['expectedBaselineRevision'] as int) + 1 &&
              baseline['policySha256'] == request['policySha256'] &&
              baseline['observationSha256'] ==
                  observation['observationSha256'] &&
              baseline['acceptedAt'] == item['savedAt'] &&
              responsibilitySame(baseline['semantic'], observation['semantic']),
        );
      }
      if (plan['change'] != null) {
        final change = responsibilityMap(plan['change']);
        owned(responsibilityMap(change['target']), id);
        await digestBody(change, 'changeSha256');
        responsibilityRequire(
          complete &&
              change['observationId'] == observation['id'] &&
              responsibilitySame(change['target'], target) &&
              change['policySha256'] == request['policySha256'] &&
              change['semanticSha256'] ==
                  responsibilityMap(
                    observation['semantic'],
                  )['semanticSha256'] &&
              change['id'] ==
                  'responsibility-change:${await responsibilityHash([target, request['policySha256'], change['previousBaselineSha256'], change['semanticSha256']])}',
        );
      }
    }
  }
}
