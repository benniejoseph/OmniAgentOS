import 'meetings.dart';
import 'meetings_validation.dart';

class MeetingContext {
  const MeetingContext(
    this.workspaceId,
    this.accessLevel,
    this.canWrite,
    this.authoritySha256,
  );
  final String workspaceId, accessLevel, authoritySha256;
  final bool canWrite;
  factory MeetingContext.parse(Object? value) {
    final row = meetingMap(value);
    meetingRequire(row['scope'] == 'workspace' && row['canWrite'] is bool);
    final level = meetingMember(row['accessLevel'], const [
      'reader',
      'contributor',
      'manager',
    ]);
    meetingRequire(row['canWrite'] == (level != 'reader'));
    final workspace = meetingId(row['workspaceId']);
    meetingRequire(workspace.startsWith('workspace:'));
    return MeetingContext(
      workspace,
      level,
      row['canWrite'] as bool,
      meetingHash(row['authoritySha256']),
    );
  }
}

class MeetingsSnapshot {
  const MeetingsSnapshot(this.meetings, this.context, {this.limit = 100});
  final List<Meeting> meetings;
  final MeetingContext context;
  final int limit;
  bool get atBound => meetings.length == limit;
  factory MeetingsSnapshot.parse(
    Json value, {
    required String tenantId,
    String? workspaceId,
    int limit = 100,
  }) {
    final context = MeetingContext.parse(value['context']);
    meetingRequire(workspaceId == null || context.workspaceId == workspaceId);
    final records = meetingList(value['meetings'], limit, Meeting.fromJson);
    meetingUnique(records.map((meeting) => meeting.id));
    for (final record in records) {
      meetingRequire(
        record.tenantId == tenantId &&
            record.workspaceId == context.workspaceId,
      );
    }
    return MeetingsSnapshot(records, context, limit: limit);
  }
}

class MeetingDetailSnapshot {
  const MeetingDetailSnapshot(this.meeting, this.context, this.sources);
  final Meeting meeting;
  final MeetingContext? context;
  final List<MeetingSource> sources;
  bool get processing => sources.any((source) => source.media?.pending == true);
  factory MeetingDetailSnapshot.parse(
    Json value, {
    required String id,
    required String tenantId,
    String? workspaceId,
  }) {
    final meeting = Meeting.fromJson(meetingMap(value['meeting']));
    final context = MeetingContext.parse(value['context']);
    meetingRequire(
      meeting.id == id &&
          meeting.tenantId == tenantId &&
          meeting.workspaceId == context.workspaceId &&
          (workspaceId == null || context.workspaceId == workspaceId),
      'The Meeting read belongs to a different identity or workspace.',
    );
    final sources = meetingList(
      value['linkedSources'],
      100,
      (row) => MeetingSource.parse(row, meeting),
    );
    meetingUnique(sources.map((source) => source.id));
    meetingRequire(
      sources.length == meeting.evidence.length,
      'The linked source coverage is incomplete.',
    );
    return MeetingDetailSnapshot(meeting, context, sources);
  }
}

class MeetingSource {
  MeetingSource._(this.raw, this.media);
  final Json raw;
  final MeetingMedia? media;
  String get id => raw['linkId'] as String;
  String get kind => raw['kind'] as String;
  String get sourceId => raw['sourceId'] as String;
  String get label => raw['label'] as String;
  String get role => raw['mediaRole'] as String;
  String get revisionState => raw['revisionState'] as String;
  String? get status => raw['status'] as String?;
  String? get mediaType => raw['mediaType'] as String?;
  String? get transcript => raw['transcript'] as String?;
  bool get truncated => raw['transcriptTruncated'] as bool;
  num? get durationMs => raw['durationMs'] as num?;
  num? get byteCount => raw['byteCount'] as num?;
  List<Json> get segments =>
      (raw['segments'] as List).map(meetingMap).toList(growable: false);
  factory MeetingSource.parse(Json row, Meeting meeting) {
    final id = meetingId(row['linkId']);
    final linked = meeting.evidence.where((source) => source.id == id).toList();
    meetingRequire(linked.length == 1);
    final link = linked.single;
    meetingRequire(
      row['kind'] == link.kind &&
          row['sourceId'] == link.sourceId &&
          row['mediaRole'] == link.role &&
          row['label'] == link.label,
    );
    final state = meetingMember(row['revisionState'], const [
      'exact',
      'changed',
      'unavailable',
    ]);
    meetingNullableText(row['status']);
    meetingNullableText(row['mediaType']);
    meetingNullableNumber(row['durationMs']);
    meetingNullableNumber(row['byteCount']);
    meetingNullableDate(row['updatedAt']);
    if (row['transcript'] != null) {
      meetingText(row['transcript'], max: 500000, empty: true);
    }
    meetingRequire(row['transcriptTruncated'] is bool);
    final segments = meetingList(row['segments'], 1440, (segment) {
      meetingInt(segment['segmentIndex'], maximum: 1439);
      meetingText(segment['mimeType'], max: 200);
      meetingRequire(meetingNullableNumber(segment['durationMs']) != null);
      return segment;
    });
    meetingUnique(
      segments.map((segment) => segment['segmentIndex'].toString()),
    );
    if (state != 'exact') {
      meetingRequire(
        row['transcript'] == null &&
            row['transcriptTruncated'] == false &&
            segments.isEmpty,
      );
    }
    if (state == 'unavailable') {
      meetingRequire(
        row['status'] == null &&
            row['mediaType'] == null &&
            row['durationMs'] == null &&
            row['byteCount'] == null &&
            row['updatedAt'] == null &&
            row['media'] == null,
      );
    }
    final media = row['media'] == null
        ? null
        : MeetingMedia.parse(meetingMap(row['media']), meeting, link.sourceId!);
    return MeetingSource._(freezeMeeting(row) as Json, media);
  }
}

class MeetingCitation {
  const MeetingCitation(
    this.turnId,
    this.segmentIndex,
    this.startMs,
    this.endMs,
    this.speaker,
    this.participantId,
  );
  final String turnId, speaker;
  final String? participantId;
  final int segmentIndex, startMs, endMs;
  factory MeetingCitation.parse(Json value) {
    final id = meetingId(value['turnId']);
    meetingRequire(RegExp(r'^media-turn:[a-f0-9]{64}$').hasMatch(id));
    final start = meetingInt(value['startMilliseconds'], maximum: 86400000),
        end = meetingInt(
          value['endMilliseconds'],
          minimum: 1,
          maximum: 86400000,
        );
    meetingRequire(end > start);
    return MeetingCitation(
      id,
      meetingInt(value['segmentIndex'], maximum: 1439),
      start,
      end,
      meetingText(value['speakerLabel'], max: 80),
      meetingNullableId(value['speakerParticipantId']),
    );
  }
}

class MeetingMedia {
  MeetingMedia._(this.raw, this.output);
  final Json raw;
  final MeetingMediaOutput? output;
  String get status => raw['processingStatus'] as String;
  String get jobId => raw['operationJobId'] as String;
  String? get deletedAt => raw['rawAudioDeletedAt'] as String?;
  bool get pending =>
      const ['queued', 'processing', 'waiting'].contains(status);
  factory MeetingMedia.parse(Json value, Meeting meeting, String sourceId) {
    meetingMember(value['processingStatus'], const [
      'queued',
      'processing',
      'waiting',
      'ready',
      'failed',
    ]);
    meetingId(value['operationJobId']);
    meetingDate(value['updatedAt']);
    meetingNullableDate(value['rawAudioDeletedAt']);
    return MeetingMedia._(
      freezeMeeting(value) as Json,
      value['output'] == null
          ? null
          : MeetingMediaOutput.parse(
              meetingMap(value['output']),
              meeting,
              sourceId,
            ),
    );
  }
}

class MeetingMediaOutput {
  MeetingMediaOutput._(
    this.raw,
    this.turns,
    this.chapters,
    this.summary,
    this.actions,
    this.decisions,
  );
  final Json raw, summary;
  final List<Json> turns, chapters, actions, decisions;
  String get revisionId => raw['mediaRevisionId'] as String;
  String get sha256 => raw['outputSha256'] as String;
  List<String> get warnings => List<String>.from(raw['warnings'] as List);
  List<MeetingCitation> citations(Json row) =>
      meetingList(row['citations'], 24, MeetingCitation.parse);
  factory MeetingMediaOutput.parse(
    Json value,
    Meeting meeting,
    String sourceId,
  ) {
    meetingRequire(
      value['schemaVersion'] == 1 &&
          value['tenantId'] == meeting.tenantId &&
          value['recordingId'] == sourceId &&
          (value['meetingId'] == null || value['meetingId'] == meeting.id),
    );
    meetingText(value['ownerActorId'], max: 320);
    final revision = meetingInt(value['mediaRevision'], minimum: 1);
    meetingRequire(value['mediaRevisionId'] == '$sourceId:media:v$revision');
    for (final key in ['sourceAudioManifestSha256', 'outputSha256']) {
      meetingHash(value[key]);
    }
    for (final key in ['transcriptionModel', 'extractionModel']) {
      meetingText(value[key], max: 160);
    }
    meetingInstant(value['processedAt']);
    final languages = value['languageTags'];
    meetingRequire(
      languages is List && languages.isNotEmpty && languages.length <= 24,
    );
    for (final language in languages as List) {
      meetingText(language, max: 35);
    }
    final turns = meetingList(value['turns'], 50000, (row) {
      meetingRequire(
        RegExp(r'^media-turn:[a-f0-9]{64}$').hasMatch(meetingId(row['turnId'])),
      );
      meetingId(row['segmentId']);
      meetingInt(row['segmentIndex'], maximum: 1439);
      meetingHash(row['sourceAudioSha256']);
      final start = meetingInt(row['startMilliseconds'], maximum: 86400000),
          end = meetingInt(
            row['endMilliseconds'],
            minimum: 1,
            maximum: 86400000,
          );
      meetingRequire(end > start);
      meetingText(row['languageTag'], max: 35);
      meetingText(row['text'], max: 24000);
      final speaker = meetingMap(row['speaker']);
      meetingText(speaker['label'], max: 80);
      final identity = meetingMember(speaker['identity'], const [
        'known',
        'diarized',
        'unknown',
      ]);
      final person = meetingNullableId(speaker['participantId']),
          name = meetingNullableText(speaker['displayName'], max: 160);
      meetingRequire(
        identity == 'known'
            ? person != null && name != null
            : person == null && name == null,
      );
      return freezeMeeting(row) as Json;
    });
    meetingRequire(turns.isNotEmpty);
    meetingUnique(turns.map((turn) => turn['turnId'] as String));
    final actualLanguages =
        turns.map((turn) => turn['languageTag'] as String).toSet().toList()
          ..sort();
    meetingRequire(
      languages.length == actualLanguages.length &&
          List.generate(
            actualLanguages.length,
            (index) => languages[index] == actualLanguages[index],
          ).every((same) => same),
    );
    final byId = {for (final turn in turns) turn['turnId'] as String: turn};
    Json cited(Json row) {
      meetingText(row['text'], max: 12000);
      final citations = meetingList(
        row['citations'],
        24,
        MeetingCitation.parse,
      );
      meetingRequire(citations.isNotEmpty);
      for (final citation in citations) {
        final turn = byId[citation.turnId];
        meetingRequire(turn != null);
        final speaker = meetingMap(turn!['speaker']);
        meetingRequire(
          citation.segmentIndex == turn['segmentIndex'] &&
              citation.startMs == turn['startMilliseconds'] &&
              citation.endMs == turn['endMilliseconds'] &&
              citation.speaker == speaker['label'] &&
              citation.participantId == speaker['participantId'],
          'Media citation does not match its exact transcript turn.',
        );
      }
      return freezeMeeting(row) as Json;
    }

    final chapters = meetingList(value['chapters'], 240, (row) {
      meetingId(row['chapterId']);
      meetingText(row['title'], max: 180);
      meetingRequire(
        meetingInt(row['endMilliseconds'], minimum: 1, maximum: 86400000) >
            meetingInt(row['startMilliseconds'], maximum: 86400000),
      );
      return cited(row);
    });
    final actions = meetingList(value['actionItems'], 500, (row) {
      meetingRequire(
        RegExp(r'^media-action:[a-f0-9]{64}$')
            .hasMatch(meetingId(row['actionItemId'])),
      );
      final owner = meetingNullableId(row['ownerParticipantId']);
      final due = row['dueAt'] == null ? null : meetingInstant(row['dueAt']);
      final ownership = meetingMember(row['ownershipEvidence'], const [
            'explicit',
            'unconfirmed',
          ]),
          dueEvidence = meetingMember(row['dueDateEvidence'], const [
            'explicit',
            'unconfirmed',
          ]);
      meetingRequire(
        (owner == null || ownership == 'explicit') &&
            (due == null || dueEvidence == 'explicit'),
      );
      return cited(row);
    });
    final decisions = meetingList(value['decisions'], 500, (row) {
      meetingId(row['decisionId']);
      return cited(row);
    });
    meetingUnique(chapters.map((row) => row['chapterId'] as String));
    meetingUnique(actions.map((row) => row['actionItemId'] as String));
    meetingUnique(decisions.map((row) => row['decisionId'] as String));
    final warnings = value['warnings'];
    meetingRequire(warnings is List && warnings.length <= 100);
    for (final warning in warnings as List) {
      meetingText(warning, max: 240);
    }
    final retention = meetingMap(value['rawAudioRetention']);
    final mode = meetingMember(retention['mode'], const [
      'retain',
      'delete_after_processing',
    ]);
    if (retention['retainUntil'] != null) {
      meetingRequire(mode == 'retain');
      meetingInstant(retention['retainUntil']);
    }
    return MeetingMediaOutput._(
      freezeMeeting(value) as Json,
      turns,
      chapters,
      cited(meetingMap(value['summary'])),
      actions,
      decisions,
    );
  }
}

DateTime meetingInstant(Object? value) {
  final text = meetingText(value, max: 64);
  final match = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$',
  ).firstMatch(text);
  meetingRequire(match != null);
  final parts = [for (var i = 1; i <= 6; i++) int.parse(match!.group(i)!)];
  meetingRequire(
    parts[1] >= 1 &&
        parts[1] <= 12 &&
        parts[2] >= 1 &&
        parts[2] <= DateTime.utc(parts[0], parts[1] + 1, 0).day &&
        parts[3] < 24 &&
        parts[4] < 60 &&
        parts[5] < 60,
  );
  final result = DateTime.tryParse(text);
  meetingRequire(result != null);
  return result!.toUtc();
}
