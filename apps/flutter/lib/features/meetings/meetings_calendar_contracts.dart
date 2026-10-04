import 'meetings_access.dart';
import 'meetings_mutations.dart';
import 'meetings_validation.dart';

const meetingCalendarReadContract = 'asael-meeting-calendar-read:1';
const meetingCalendarSyncContract = 'asael-meeting-calendar-sync:1';
const meetingCalendarAcceptanceContract =
    'asael-meeting-calendar-sync-acceptance:1';

MeetingJson _shape(Object? value, String fields) {
  final row = meetingMap(value), keys = fields.split(' ').toSet();
  meetingRequire(row.length == keys.length && row.keys.every(keys.contains));
  return row;
}

String _uuid(Object? value) {
  final text = meetingText(value, max: 36);
  meetingRequire(
    RegExp(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
        .hasMatch(text),
  );
  return text;
}

MeetingJson meetingCalendarScope(MeetingsOwner owner) => {
  'tenantId': owner.tenantId,
  'ownerActorId': owner.actorId,
  'canonicalActorId': 'actor:${owner.userId}',
  'workspaceId': 'workspace:personal:${owner.userId}',
};
void _scope(Object? value, MeetingsOwner owner) {
  final row = _shape(
    value,
    'tenantId ownerActorId canonicalActorId workspaceId',
  );
  meetingRequire(
    meetingCanonicalJson(row) ==
        meetingCanonicalJson(meetingCalendarScope(owner)),
  );
}

MeetingJson _coverage(Object? value) {
  final row = _shape(
    value,
    'status backfillState lastAttemptedAt lastSuccessfulAt failureCode',
  );
  meetingMember(row['status'], const ['syncing', 'healthy', 'error']);
  meetingMember(row['backfillState'], const [
    'unknown',
    'in_progress',
    'complete',
  ]);
  meetingMember(row['failureCode'], const [
    'none',
    'provider_unauthorized',
    'provider_forbidden',
    'provider_rate_limited',
    'provider_unavailable',
    'processing_failed',
  ]);
  meetingDate(row['lastAttemptedAt']);
  meetingNullableDate(row['lastSuccessfulAt']);
  return row;
}

class MeetingCalendarConnection {
  const MeetingCalendarConnection(this.raw);
  final MeetingJson raw;
  String get id => raw['id'] as String;
  String get email => raw['accountEmail'] as String;
  int get generation => raw['authorizationGeneration'] as int;
  bool get ready =>
      raw['status'] == 'active' && raw['calendarReadAllowed'] == true;
  static MeetingCalendarConnection parse(Object? value, MeetingsOwner owner) {
    final row = _shape(
      value,
      'id tenantId ownerActorId accountEmail authorizationGeneration status calendarReadAllowed coverage lastSyncedAt retryAfter updatedAt',
    );
    _uuid(row['id']);
    meetingInt(row['authorizationGeneration'], minimum: 1);
    meetingRequire(
      row['tenantId'] == owner.tenantId &&
          row['ownerActorId'] == owner.actorId &&
          row['calendarReadAllowed'] is bool,
    );
    final email = meetingText(row['accountEmail'], max: 320);
    meetingRequire(RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(email));
    meetingMember(row['status'], const ['active', 'revoked']);
    if (row['coverage'] != null) {
      _coverage(row['coverage']);
    }
    meetingNullableDate(row['lastSyncedAt']);
    meetingNullableDate(row['retryAfter']);
    meetingDate(row['updatedAt']);
    return MeetingCalendarConnection(freezeMeeting(row) as MeetingJson);
  }
}

class MeetingCalendarSubmission {
  const MeetingCalendarSubmission._(
    this.ownerKey,
    this.key,
    this.scope,
    this.connection,
    this.body,
  );
  final String ownerKey, key;
  final MeetingJson scope, connection, body;
  MeetingJson get json => {
    'ownerKey': ownerKey,
    'key': key,
    'scope': scope,
    'connection': connection,
    'body': body,
  };
  Future<String> get keySha256 => meetingShaText(key);
  Future<String> get id async =>
      'meeting-calendar-sync:${await meetingSha(['meeting-calendar-sync:1', scope['tenantId'], scope['ownerActorId'], await keySha256])}';
  factory MeetingCalendarSubmission.freeze(
    MeetingsOwner owner,
    MeetingCalendarConnection connection, {
    String? key,
  }) {
    meetingRequire(connection.ready);
    final mutationKey = key ?? newMeetingMutationKey();
    meetingRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(mutationKey),
    );
    final checked = MeetingCalendarConnection.parse(connection.raw, owner);
    return MeetingCalendarSubmission._(
      owner.key,
      mutationKey,
      freezeMeeting(meetingCalendarScope(owner)) as MeetingJson,
      checked.raw,
      freezeMeeting({
        'contract': meetingCalendarSyncContract,
        'connectionId': checked.id,
        'expectedAuthorizationGeneration': checked.generation,
      }) as MeetingJson,
    );
  }
  factory MeetingCalendarSubmission.restore(
    Object? value,
    MeetingsOwner owner,
  ) {
    final row = _shape(value, 'ownerKey key scope connection body');
    meetingRequire(row['ownerKey'] == owner.key);
    _scope(row['scope'], owner);
    final result = MeetingCalendarSubmission.freeze(
      owner,
      MeetingCalendarConnection.parse(row['connection'], owner),
      key: meetingText(row['key'], max: 512),
    );
    meetingRequire(
      meetingCanonicalJson(row['body']) == meetingCanonicalJson(result.body),
    );
    return result;
  }
}

class MeetingCalendarSync {
  const MeetingCalendarSync(this.raw);
  final MeetingJson raw;
  MeetingJson get acceptance => meetingMap(raw['acceptance']);
  String get id => acceptance['id'] as String;
  String get keySha256 => acceptance['idempotencyKeySha256'] as String;
  String get state => raw['state'] as String;
  bool get settled => state == 'settled';
  MeetingJson? get settlement =>
      raw['settlement'] == null ? null : meetingMap(raw['settlement']);
  static Future<MeetingCalendarSync> parse(
    Object? value,
    MeetingsOwner owner, {
    MeetingCalendarSubmission? sent,
    String? exactId,
    String? exactKey,
  }) async {
    final row = _shape(value, 'acceptance state settlement updatedAt');
    final acceptance = _shape(
      row['acceptance'],
      'contract id scope connectionId authorizationGeneration idempotencyKeySha256 requestSha256 acceptedAt',
    );
    _scope(acceptance['scope'], owner);
    _uuid(acceptance['connectionId']);
    meetingInt(acceptance['authorizationGeneration'], minimum: 1);
    final keyHash = meetingHash(acceptance['idempotencyKeySha256']);
    final id =
        'meeting-calendar-sync:${await meetingSha(['meeting-calendar-sync:1', owner.tenantId, owner.actorId, keyHash])}';
    meetingRequire(
      acceptance['contract'] == meetingCalendarAcceptanceContract &&
          acceptance['id'] == id &&
          (exactId == null || exactId == id) &&
          (exactKey == null || exactKey == keyHash),
    );
    final request = {
      'contract': meetingCalendarSyncContract,
      'connectionId': acceptance['connectionId'],
      'expectedAuthorizationGeneration': acceptance['authorizationGeneration'],
    };
    meetingRequire(
      acceptance['requestSha256'] ==
          await meetingSha({
            'contract': meetingCalendarAcceptanceContract,
            'scope': acceptance['scope'],
            'request': request,
          }),
    );
    if (sent != null) {
      meetingRequire(
        sent.ownerKey == owner.key &&
            keyHash == await sent.keySha256 &&
            id == await sent.id &&
            meetingCanonicalJson(request) == meetingCanonicalJson(sent.body) &&
            meetingCanonicalJson(acceptance['scope']) ==
                meetingCanonicalJson(sent.scope),
      );
    }
    final acceptedAt = meetingDate(acceptance['acceptedAt']),
        updatedAt = meetingDate(row['updatedAt']);
    final state = meetingMember(row['state'], const [
      'accepted',
      'settled',
      'unconfirmed',
    ]);
    meetingRequire(
      !updatedAt.isBefore(acceptedAt) &&
          (state == 'settled') == (row['settlement'] != null),
    );
    if (row['settlement'] != null) {
      final settlement = _shape(
        row['settlement'],
        'status imported removed cursorAdvanced coverage settledAt',
      );
      meetingInt(settlement['imported']);
      meetingInt(settlement['removed']);
      meetingRequire(
        settlement['cursorAdvanced'] is bool &&
            settlement['settledAt'] == row['updatedAt'],
      );
      final coverage = _coverage(settlement['coverage']);
      meetingRequire(
        settlement['status'] ==
            (coverage['status'] == 'syncing' ? 'partial' : coverage['status']),
      );
    }
    return MeetingCalendarSync(freezeMeeting(row) as MeetingJson);
  }
}

Future<void> _receipt(
  MeetingJson envelope,
  MeetingsOwner owner,
  String operation,
  int count, {
  MeetingCalendarSubmission? sent,
}) async {
  final row = _shape(
    envelope['serviceReceipt'],
    'schemaVersion receiptKind boundaryVersion operation action resourceType accessMode eventContract authoritySha256 idempotencyKeySha256 outcomeSha256 resourceCount occurredAt receiptSha256',
  );
  final mutation = operation == 'meetings.calendar.sync';
  meetingRequire(!mutation || sent != null);
  MeetingJson? execution;
  if (mutation) {
    final request = sent!;
    execution = {
      'version': 1,
      'tenantId': owner.tenantId,
      'initiatingActorId': owner.actorId,
      'executingPrincipalType': 'user',
      'executingPrincipalId': owner.actorId,
      'workspaceId': null,
      'projectId': null,
      'missionId': null,
      'delegationId': null,
      'correlationId': request.key.length <= 256
          ? request.key
          : 'idempotency-key:${await meetingSha(request.key)}',
      'causationId': request.body['connectionId'],
      'contextGrantIds': <String>[],
      'capabilityGrantIds': <String>[],
      'purpose': 'api.meetings.calendar.sync',
    };
  }
  meetingRequire(
    row['schemaVersion'] == 1 &&
        row['receiptKind'] == 'app_service_receipt' &&
        row['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
        row['operation'] == operation &&
        row['action'] == (mutation ? 'write.memory' : 'read') &&
        row['resourceType'] == 'meeting_calendar' &&
        row['accessMode'] == (mutation ? 'mutation' : 'read') &&
        row['eventContract'] ==
            (mutation
                ? 'meeting-calendar-sync-events.v1'
                : 'read_only:no_domain_mutation') &&
        row['resourceCount'] == count &&
        row['idempotencyKeySha256'] ==
            (mutation
                ? await meetingShaText('${owner.tenantId}\u0000${sent!.key}')
                : null),
  );
  meetingDate(row['occurredAt']);
  meetingRequire(
    row['authoritySha256'] ==
        await meetingSha({
          'boundaryVersion': 'p9.1-app-service-boundary:1',
          'tenantId': owner.tenantId,
          'actorId': owner.actorId,
          'role': owner.role,
          'executionScope': execution,
        }),
  );
  final body = {...envelope}..remove('serviceReceipt'),
      proof = {...row}..remove('receiptSha256');
  meetingRequire(
    row['outcomeSha256'] == await meetingSha(body) &&
        row['receiptSha256'] == await meetingSha(proof),
  );
}

class MeetingCalendarStatus {
  const MeetingCalendarStatus(this.raw, this.connection, this.blocked);
  final MeetingJson raw;
  final MeetingCalendarConnection? connection;
  final MeetingCalendarSync? blocked;
  static Future<MeetingCalendarStatus> parse(
    Object? value,
    MeetingsOwner owner,
  ) async {
    final row = _shape(
      value,
      'contract scope connection blockedSync serviceReceipt',
    );
    meetingRequire(row['contract'] == meetingCalendarReadContract);
    _scope(row['scope'], owner);
    final connection = row['connection'] == null
        ? null
        : MeetingCalendarConnection.parse(row['connection'], owner);
    final blocked = row['blockedSync'] == null
        ? null
        : await MeetingCalendarSync.parse(row['blockedSync'], owner);
    if (blocked != null) {
      meetingRequire(
        !blocked.settled &&
            blocked.acceptance['connectionId'] == connection?.id,
      );
    }
    await _receipt(
      row,
      owner,
      'meetings.calendar.get',
      connection == null ? 0 : 1,
    );
    return MeetingCalendarStatus(
      freezeMeeting(row) as MeetingJson,
      connection,
      blocked,
    );
  }
}

class MeetingCalendarResult {
  const MeetingCalendarResult(this.raw, this.sync);
  final MeetingJson raw;
  final MeetingCalendarSync sync;
  static Future<MeetingCalendarResult> parse(
    Object? value,
    MeetingsOwner owner, {
    MeetingCalendarSubmission? sent,
    bool mutation = false,
    String? exactId,
    String? exactKey,
  }) async {
    final row = _shape(
      value,
      'contract scope sync serviceReceipt${mutation ? ' replayed' : ''}',
    );
    meetingRequire(
      row['contract'] ==
          (mutation
              ? meetingCalendarSyncContract
              : meetingCalendarReadContract),
    );
    _scope(row['scope'], owner);
    if (mutation) {
      meetingRequire(sent != null && row['replayed'] is bool);
    }
    final sync = await MeetingCalendarSync.parse(
      row['sync'],
      owner,
      sent: sent,
      exactId: exactId,
      exactKey: exactKey,
    );
    await _receipt(
      row,
      owner,
      mutation ? 'meetings.calendar.sync' : 'meetings.calendar.sync.get',
      1,
      sent: sent,
    );
    return MeetingCalendarResult(freezeMeeting(row) as MeetingJson, sync);
  }
}
