import 'package:flutter/foundation.dart';

typedef Json = Map<String, dynamic>;

class MeetingParticipant {
  const MeetingParticipant({
    required this.id,
    required this.name,
    required this.role,
    required this.response,
    required this.attendeeConsent,
    required this.recordingConsent,
  });

  final String id, name, role, response, attendeeConsent, recordingConsent;

  factory MeetingParticipant.fromJson(Json json) => MeetingParticipant(
    id: json['participantId']?.toString() ?? '',
    name: json['displayName']?.toString() ?? 'Participant',
    role: json['role']?.toString() ?? 'guest',
    response: json['response']?.toString() ?? 'unknown',
    attendeeConsent: json['attendeeConsent']?.toString() ?? 'unknown',
    recordingConsent: json['recordingConsent']?.toString() ?? 'unknown',
  );
}

class MeetingEvidence {
  const MeetingEvidence({
    required this.id,
    required this.label,
    required this.kind,
    required this.role,
  });

  final String id, label, kind, role;

  factory MeetingEvidence.fromJson(Json json) => MeetingEvidence(
    id: json['linkId']?.toString() ?? '',
    label: json['label']?.toString() ?? 'Evidence',
    kind: json['kind']?.toString() ?? 'source_revision',
    role: json['mediaRole']?.toString() ?? 'reference',
  );
}

class MeetingNote {
  const MeetingNote({required this.id, required this.label, this.status});
  final String id, label;
  final String? status;
}

class Meeting {
  const Meeting({
    required this.id,
    required this.title,
    required this.summary,
    required this.status,
    required this.startAt,
    required this.endAt,
    required this.timezone,
    required this.location,
    required this.accessClass,
    required this.revision,
    required this.participants,
    required this.decisions,
    required this.commitments,
    required this.followUps,
    required this.evidence,
    this.projectId,
  });

  final String id, title, summary, status, timezone, location, accessClass;
  final DateTime startAt, endAt;
  final int revision;
  final String? projectId;
  final List<MeetingParticipant> participants;
  final List<MeetingNote> decisions, commitments, followUps;
  final List<MeetingEvidence> evidence;

  bool get isActive => status == 'scheduled' || status == 'in_progress';

  factory Meeting.fromJson(Json json) {
    final id = json['meetingId'];
    final title = json['title'];
    final startAt = DateTime.tryParse(
      json['scheduledStartAt'] as String? ?? '',
    );
    final endAt = DateTime.tryParse(json['scheduledEndAt'] as String? ?? '');
    if (id is! String || title is! String || startAt == null || endAt == null) {
      throw const FormatException('Meeting response is invalid.');
    }
    return Meeting(
      id: id,
      title: title,
      summary: json['summary']?.toString() ?? '',
      status: json['status']?.toString() ?? 'scheduled',
      startAt: startAt,
      endAt: endAt,
      timezone: json['timezone']?.toString() ?? 'UTC',
      location: json['location']?.toString() ?? '',
      accessClass: json['effectiveAccessClass']?.toString() ?? 'owner_private',
      revision: (json['revision'] as num?)?.toInt() ?? 1,
      projectId: json['projectId']?.toString(),
      participants: _objects(json['participants'])
          .map(MeetingParticipant.fromJson)
          .toList(growable: false),
      decisions: _notes(json['decisions'], 'decisionId', 'summary'),
      commitments: _notes(json['commitments'], 'commitmentId', 'summary'),
      followUps: _notes(
        json['followUps'],
        'followUpId',
        'label',
        includeStatus: true,
      ),
      evidence: _objects(json['sourceLinks'])
          .map(MeetingEvidence.fromJson)
          .toList(growable: false),
    );
  }
}

List<Json> _objects(Object? value) => value is List
    ? value.whereType<Map>().map((item) => Json.from(item)).toList()
    : const [];

List<MeetingNote> _notes(
  Object? value,
  String idKey,
  String labelKey, {
  bool includeStatus = false,
}) => _objects(value)
    .map(
      (item) => MeetingNote(
        id: item[idKey]?.toString() ?? '',
        label: item[labelKey]?.toString() ?? '',
        status: includeStatus ? item['status']?.toString() : null,
      ),
    )
    .where((item) => item.label.isNotEmpty)
    .toList(growable: false);

abstract interface class MeetingsRepository {
  Future<List<Meeting>> list();
  Future<Meeting> detail(String id);
}

class MeetingsController extends ChangeNotifier {
  MeetingsController(this.repository);
  final MeetingsRepository repository;
  List<Meeting> meetings = const [];
  Object? error;
  bool loading = false;
  DateTime? refreshedAt;

  bool get showingStaleData => error != null && meetings.isNotEmpty;

  Future<void> refresh() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      meetings = await repository.list();
      refreshedAt = DateTime.now();
    } catch (value) {
      error = value;
    } finally {
      loading = false;
      notifyListeners();
    }
  }
}
