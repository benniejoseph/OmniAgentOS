import 'dart:convert';

import 'meetings_access.dart';
import 'meetings_mutations.dart';
import 'meetings_validation.dart';

const recordingReadContract = 'asael-meeting-recording-read:1';
const recordingReasons = [
  'recording_empty',
  'audio_deleted',
  'consent_required',
  'source_changed',
  'legacy_processing_pending',
  'legacy_effect_unconfirmed',
  'already_accepted',
  'authority_changed',
  'source_manifest_changed',
  'provider_effect_unconfirmed',
  'projection_unconfirmed',
  'job_unavailable',
];

MeetingJson _shape(Object? value, String fields) {
  final row = meetingMap(value), names = fields.split(' ');
  meetingRequire(row.length == names.length && names.every(row.containsKey));
  return row;
}

String _normalized(Object? value, int maximum) {
  final text = meetingText(value, max: maximum);
  meetingRequire(text == text.trim());
  return text;
}

String _id(Object? value, [int maximum = 200]) {
  final text = meetingText(value, max: maximum);
  meetingRequire(RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$').hasMatch(text));
  return text;
}

int _count(Object? value, [int maximum = 2147483647]) =>
    meetingInt(value, maximum: maximum);
String _workspace(Object? value) {
  final text = _id(value, 240);
  meetingRequire(
    RegExp(r'^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$').hasMatch(text),
  );
  return text;
}

String _meeting(Object? value) {
  final text = _id(value);
  meetingRequire(
    RegExp(
      r'^meeting:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    ).hasMatch(text),
  );
  return text;
}

bool _same(Object? first, Object? second) =>
    meetingCanonicalJson(first) == meetingCanonicalJson(second);

MeetingJson recordingScope(
  MeetingsOwner owner,
  String workspace,
  String meeting,
  String recording,
) {
  meetingRequire(
    RegExp(
      r'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',
    ).hasMatch(owner.userId),
  );
  return Map.unmodifiable({
    'tenantId': _normalized(owner.tenantId, 120),
    'ownerActorId': _normalized(owner.actorId, 320),
    'canonicalActorId': 'actor:${owner.userId}',
    'workspaceId': _workspace(workspace),
    'meetingId': _meeting(meeting),
    'recordingId': _id(recording),
  });
}

Future<MeetingJson> _pin(Object? value) async {
  final pin = _shape(
    value,
    'meetingRevision meetingSha256 sourceLinkId sourceLinkSha256 consentSha256 recordingStateSha256 sourceAudioManifestSha256 transcriptCheckpointSha256 mediaGeneration mediaHeadSha256 policySha256 reviewSha256',
  );
  meetingInt(pin['meetingRevision'], minimum: 1, maximum: 2147483647);
  _id(pin['sourceLinkId']);
  for (final field in [
    'meetingSha256',
    'sourceLinkSha256',
    'consentSha256',
    'recordingStateSha256',
    'sourceAudioManifestSha256',
    'transcriptCheckpointSha256',
    'policySha256',
    'reviewSha256',
  ]) {
    meetingHash(pin[field]);
  }
  final generation = _count(pin['mediaGeneration']);
  meetingRequire((generation == 0) == (pin['mediaHeadSha256'] == null));
  if (pin['mediaHeadSha256'] != null) {
    meetingHash(pin['mediaHeadSha256']);
  }
  meetingRequire(
    pin['policySha256'] ==
        await meetingSha({
          'version': 'meeting-recording-policy:1',
          'retention': 'retain',
          'nativeProviderAttempts': 1,
          'acceptanceRecovery': 'read_only',
          'uncertainEffect': 'hold',
          'source': 'exact_owned_linked_recording',
        }),
  );
  await verifyMeetingDigest(pin, 'reviewSha256');
  return freezeMeeting(pin) as MeetingJson;
}

class MeetingRecordingReview {
  MeetingRecordingReview._(this.scope, this.raw);
  final MeetingJson scope, raw;
  MeetingJson get pin => meetingMap(raw['pin']);
  MeetingJson get recording => meetingMap(raw['recording']);
  List<MeetingJson> get participants =>
      (raw['participants'] as List).map(meetingMap).toList(growable: false);
  List<String> get reasons =>
      List<String>.from((raw['eligibility'] as Map)['reasonCodes'] as List);
  bool get processable => (raw['eligibility'] as Map)['processable'] == true;
  static Future<MeetingRecordingReview> parse(
    Object? value,
    MeetingsOwner owner,
    MeetingJson scope,
  ) async {
    final body = _shape(value, 'contract scope review serviceReceipt');
    final raw = _shape(
      body['review'],
      'pin recording participants eligibility',
    );
    await _pin(raw['pin']);
    final recording = _shape(
      raw['recording'],
      'title status language segmentCount durationMs byteCount cachedTranscripts',
    );
    meetingText(recording['title'], max: 240, empty: true);
    meetingMember(recording['status'], [
      'recording',
      'processing',
      'ready',
      'failed',
    ]);
    _normalized(recording['language'], 35);
    final segments = _count(recording['segmentCount'], 1440),
        cached = _count(recording['cachedTranscripts'], 1440);
    meetingRequire(cached <= segments);
    _count(recording['durationMs'], 86400000);
    _count(recording['byteCount'], 1073741824);
    final people = meetingList(raw['participants'], 200, (person) {
      _shape(
        person,
        'participantId displayName recordingConsent consentCapturedAt',
      );
      _id(person['participantId']);
      _normalized(person['displayName'], 160);
      meetingMember(person['recordingConsent'], [
        'granted',
        'declined',
        'pending',
        'not_required',
        'unknown',
      ]);
      meetingNullableDate(person['consentCapturedAt']);
      return person;
    });
    meetingUnique(people.map((person) => person['participantId'] as String));
    final eligible = _shape(raw['eligibility'], 'processable reasonCodes'),
        reasons = eligible['reasonCodes'];
    meetingRequire(
      eligible['processable'] is bool &&
          reasons is List &&
          reasons.length <= 12,
    );
    for (final reason in reasons as List) {
      meetingMember(reason, recordingReasons);
    }
    meetingRequire(eligible['processable'] == reasons.isEmpty);
    if (eligible['processable'] == true) {
      meetingRequire(
        segments > 0 &&
            people.isNotEmpty &&
            people.every(
              (person) => [
                'granted',
                'not_required',
              ].contains(person['recordingConsent']),
            ),
      );
    }
    await _receipt(body, owner, scope, 'app.meetings.recordings.review', 1);
    return MeetingRecordingReview._(
      Map.unmodifiable(scope),
      freezeMeeting(raw) as MeetingJson,
    );
  }
}

class MeetingRecordingSubmission {
  MeetingRecordingSubmission._(
    this.ownerKey,
    this.key,
    this.scope,
    this.body,
    this.keySha256,
    this.requestSha256,
  );
  final String ownerKey, key, keySha256, requestSha256;
  final MeetingJson scope, body;
  String get recordingId => scope['recordingId'] as String;
  MeetingJson get stored => {
    'ownerKey': ownerKey,
    'key': key,
    'scope': scope,
    'body': body,
    'keySha256': keySha256,
    'requestSha256': requestSha256,
  };
  static Future<MeetingRecordingSubmission> prepare(
    MeetingsOwner owner,
    MeetingRecordingReview review, {
    required List<String> languages,
    required List<MeetingJson> mappings,
    String? key,
  }) async {
    meetingRequire(owner.canManage && review.processable);
    for (final mapping in mappings) {
      meetingRequire(
        review.participants.any(
          (person) =>
              person['participantId'] == mapping['participantId'] &&
              person['displayName'] == mapping['displayName'],
        ),
      );
    }
    return _build(owner, key ?? newMeetingMutationKey(), review.scope, {
      'contract': 'asael-meeting-recording-process:1',
      'workspaceId': review.scope['workspaceId'],
      'meetingId': review.scope['meetingId'],
      'review': review.pin,
      'languageHints': languages,
      'speakerMappings': mappings,
      'rawAudioRetention': {'mode': 'retain'},
    });
  }

  static Future<MeetingRecordingSubmission> _build(
    MeetingsOwner owner,
    String key,
    MeetingJson scope,
    MeetingJson body,
  ) async {
    meetingRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    meetingRequire(
      _same(
        scope,
        recordingScope(
          owner,
          _workspace(scope['workspaceId']),
          _meeting(scope['meetingId']),
          _id(scope['recordingId']),
        ),
      ),
    );
    _shape(
      body,
      'contract workspaceId meetingId review languageHints speakerMappings rawAudioRetention',
    );
    meetingRequire(
      body['contract'] == 'asael-meeting-recording-process:1' &&
          body['workspaceId'] == scope['workspaceId'] &&
          body['meetingId'] == scope['meetingId'],
    );
    final pin = await _pin(body['review']);
    meetingRequire((pin['mediaGeneration'] as int) < 2147483647);
    final languages = body['languageHints'];
    meetingRequire(
      languages is List && languages.isNotEmpty && languages.length <= 12,
    );
    final languageValues = <String>[];
    for (final value in languages as List) {
      final language = meetingText(value, max: 35);
      meetingRequire(
        RegExp(r'^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$').hasMatch(language),
      );
      languageValues.add(language);
    }
    meetingUnique(languageValues);
    final mappings = meetingList(body['speakerMappings'], 40, (mapping) {
      _shape(mapping, 'speakerLabel participantId displayName confirmation');
      _normalized(mapping['speakerLabel'], 80);
      _id(mapping['participantId']);
      _normalized(mapping['displayName'], 160);
      meetingRequire(mapping['confirmation'] == 'user_confirmed');
      return mapping;
    });
    meetingUnique(
      mappings.map((value) => (value['speakerLabel'] as String).toLowerCase()),
    );
    meetingUnique(mappings.map((value) => value['participantId'] as String));
    meetingRequire(
      _same(body['rawAudioRetention'], {'mode': 'retain'}) &&
          utf8.encode(jsonEncode(body)).length <= 32768,
    );
    final keySha = await meetingShaText('${owner.tenantId}\u0000$key');
    final requestSha = await meetingSha({
      'contract': 'asael-meeting-recording-intent:1',
      'scope': scope,
      'keySha256': keySha,
      'request': body,
    });
    return MeetingRecordingSubmission._(
      owner.key,
      key,
      freezeMeeting(scope) as MeetingJson,
      freezeMeeting(body) as MeetingJson,
      keySha,
      requestSha,
    );
  }

  static Future<MeetingRecordingSubmission> restore(
    Object? value,
    MeetingsOwner owner,
  ) async {
    final row = _shape(
      value,
      'ownerKey key scope body keySha256 requestSha256',
    );
    meetingRequire(row['ownerKey'] == owner.key);
    final restored = await _build(
      owner,
      meetingText(row['key'], max: 512),
      meetingMap(row['scope']),
      meetingMap(row['body']),
    );
    meetingRequire(_same(restored.stored, row));
    return restored;
  }

  Future<String> authoritySha(MeetingsOwner owner) async => meetingSha({
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'tenantId': owner.tenantId,
    'actorId': owner.actorId,
    'role': owner.role,
    'executionScope': {
      'version': 1,
      'tenantId': owner.tenantId,
      'initiatingActorId': owner.actorId,
      'executingPrincipalType': 'user',
      'executingPrincipalId': owner.actorId,
      'workspaceId': scope['workspaceId'],
      'projectId': null,
      'missionId': null,
      'delegationId': null,
      'correlationId': key.length <= 256 ? key : await meetingSha(key),
      'causationId': recordingId,
      'contextGrantIds': <String>[],
      'capabilityGrantIds': <String>[],
      'purpose': 'api.meeting-recording.process',
    },
  });
}

class MeetingRecordingResult {
  MeetingRecordingResult._(this.raw, this.acceptance, this.processing);
  final MeetingJson raw;
  final MeetingJson? acceptance, processing;
  static Future<MeetingRecordingResult> parse(
    Object? value,
    MeetingsOwner owner,
    MeetingRecordingSubmission submitted, {
    required bool mutation,
  }) async {
    final raw = _shape(
      value,
      'contract scope acceptance processing serviceReceipt${mutation ? ' replayed' : ''}',
    );
    if (mutation) {
      meetingRequire(raw['replayed'] is bool && raw['acceptance'] != null);
    }
    final proof = raw['acceptance'] == null
        ? null
        : _shape(
            raw['acceptance'],
            'contract id scope keySha256 requestSha256 reviewSha256 operationJobId acceptedMediaGeneration sourceAudioManifestSha256 acceptedAt acceptanceSha256',
          );
    meetingRequire((proof == null) == (raw['processing'] == null));
    if (proof != null) {
      meetingRequire(
        proof['contract'] == 'asael-meeting-recording-acceptance:1' &&
            _same(proof['scope'], submitted.scope) &&
            proof['keySha256'] == submitted.keySha256 &&
            proof['requestSha256'] == submitted.requestSha256 &&
            proof['reviewSha256'] ==
                (submitted.body['review'] as Map)['reviewSha256'] &&
            proof['sourceAudioManifestSha256'] ==
                (submitted.body['review']
                    as Map)['sourceAudioManifestSha256'] &&
            proof['acceptedMediaGeneration'] ==
                (submitted.body['review'] as Map)['mediaGeneration'] + 1,
      );
      meetingRequire(
        proof['id'] ==
            'meeting-recording-acceptance:${await meetingSha({'scope': submitted.scope, 'keySha256': submitted.keySha256})}',
      );
      _id(proof['operationJobId']);
      meetingDate(proof['acceptedAt']);
      await verifyMeetingDigest(proof, 'acceptanceSha256');
    }
    final progress = raw['processing'] == null
        ? null
        : _shape(
            raw['processing'],
            'phase completedSegments totalSegments media knowledge reasonCode updatedAt automaticRetryAllowed',
          );
    if (progress != null) {
      meetingMember(progress['phase'], [
        'queued',
        'transcribing',
        'extracting',
        'indexing',
        'completed',
        'reconciliation_required',
        'blocked',
      ]);
      meetingRequire(
        _count(progress['completedSegments'], 1440) <=
                _count(progress['totalSegments'], 1440) &&
            progress['automaticRetryAllowed'] == false,
      );
      meetingDate(progress['updatedAt']);
      if (progress['reasonCode'] != null) {
        meetingMember(progress['reasonCode'], recordingReasons);
      }
      if (progress['media'] != null) {
        final media = _shape(progress['media'], 'mediaRevisionId outputSha256');
        meetingRequire(
          meetingText(
            media['mediaRevisionId'],
            max: 260,
          ).startsWith('${submitted.recordingId}:media:v'),
        );
        meetingHash(media['outputSha256']);
      }
      if (progress['knowledge'] != null) {
        final knowledge = _shape(
          progress['knowledge'],
          'state jobId documentId',
        );
        meetingMember(knowledge['state'], [
          'queued',
          'started',
          'committed',
          'unconfirmed',
          'blocked',
        ]);
        _id(knowledge['jobId']);
        if (knowledge['documentId'] != null) {
          _id(knowledge['documentId']);
        }
      }
      meetingRequire(
        progress['phase'] != 'completed' ||
            progress['media'] != null &&
                progress['knowledge'] is Map &&
                (progress['knowledge'] as Map)['state'] == 'committed',
      );
    }
    await _receipt(
      raw,
      owner,
      submitted.scope,
      mutation
          ? 'app.meetings.recordings.process'
          : 'app.meetings.recordings.processing.show',
      proof == null ? 0 : 1,
      submitted: mutation ? submitted : null,
    );
    return MeetingRecordingResult._(
      freezeMeeting(raw) as MeetingJson,
      proof == null ? null : freezeMeeting(proof) as MeetingJson,
      progress == null ? null : freezeMeeting(progress) as MeetingJson,
    );
  }
}

Future<void> _receipt(
  MeetingJson value,
  MeetingsOwner owner,
  MeetingJson scope,
  String operation,
  int count, {
  MeetingRecordingSubmission? submitted,
}) async {
  meetingRequire(
    value['contract'] == recordingReadContract && _same(value['scope'], scope),
  );
  final proof = _shape(
    value['serviceReceipt'],
    'schemaVersion receiptKind boundaryVersion operation action resourceType accessMode eventContract authoritySha256 idempotencyKeySha256 outcomeSha256 resourceCount occurredAt receiptSha256',
  );
  final mutation = submitted != null;
  meetingRequire(
    proof['schemaVersion'] == 1 &&
        proof['receiptKind'] == 'app_service_receipt' &&
        proof['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
        proof['operation'] == operation &&
        proof['action'] == (mutation ? 'write.memory' : 'read') &&
        proof['resourceType'] == 'capture_recording' &&
        proof['accessMode'] == (mutation ? 'mutation' : 'read') &&
        proof['eventContract'] ==
            (mutation
                ? 'meeting-recording-processing-events.v1'
                : 'read_only:no_domain_mutation') &&
        proof['resourceCount'] == count &&
        proof['idempotencyKeySha256'] == submitted?.keySha256,
  );
  meetingDate(proof['occurredAt']);
  await verifyMeetingDigest(proof, 'receiptSha256');
  final body = {...value}..remove('serviceReceipt');
  meetingRequire(proof['outcomeSha256'] == await meetingSha(body));
  final authority = mutation
      ? await submitted.authoritySha(owner)
      : await meetingSha({
          'boundaryVersion': 'p9.1-app-service-boundary:1',
          'tenantId': owner.tenantId,
          'actorId': owner.actorId,
          'role': owner.role,
          'executionScope': null,
        });
  meetingRequire(proof['authoritySha256'] == authority);
}
