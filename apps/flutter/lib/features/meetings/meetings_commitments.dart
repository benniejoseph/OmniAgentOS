import 'meetings.dart';
import 'meetings_snapshots.dart';
import 'meetings_validation.dart';
import 'meetings_validation.dart' as validation;

const meetingCommitmentContract = 'p10.8-meeting-commitment-conversion:1';

class MeetingCommitmentReview {
  MeetingCommitmentReview._(
    this.proposal,
    this.resolution,
    this.citations,
    this.reconciliation,
  );
  final Json proposal;
  final Json? resolution;
  final Json? reconciliation;
  final List<MeetingCitation> citations;
  String get id => proposal['proposalId'] as String;
  String get sha256 => proposal['proposalSha256'] as String;
  String get title => proposal['title'] as String;
  String get meetingRevisionId => proposal['meetingRevisionId'] as String;
  String get mediaRevisionId => proposal['mediaRevisionId'] as String;
  String? get decision => resolution?['decision'] as String?;
  bool get reviewable => resolution == null && reconciliation == null;
  factory MeetingCommitmentReview.parse(
    Json value, {
    required String meetingIdValue,
    required String tenantId,
    required String workspaceId,
  }) {
    final proposal = meetingMap(value['proposal']);
    meetingRequire(
      proposal['schemaVersion'] == 1 &&
          proposal['contractVersion'] == meetingCommitmentContract &&
          proposal['meetingId'] == meetingIdValue &&
          proposal['tenantId'] == tenantId &&
          proposal['workspaceId'] == workspaceId,
    );
    meetingRequire(
      RegExp(r'^meeting-commitment-proposal:[a-f0-9]{64}$')
          .hasMatch(meetingId(proposal['proposalId'])),
    );
    for (final key in [
      'proposalSha256',
      'meetingSha256',
      'mediaOutputSha256',
      'actionItemSha256',
    ]) {
      meetingHash(proposal[key]);
    }
    for (final key in [
      'meetingRevisionId',
      'projectId',
      'sourceLinkId',
      'recordingId',
      'mediaRevisionId',
      'proposedByActorId',
    ]) {
      meetingId(proposal[key]);
    }
    meetingRequire(
      RegExp(r'^media-action:[a-f0-9]{64}$')
          .hasMatch(meetingId(proposal['actionItemId'])),
    );
    meetingText(proposal['title'], max: 12000);
    meetingDate(proposal['proposedAt']);
    final citations = meetingList(
      proposal['citations'],
      24,
      MeetingCitation.parse,
    );
    meetingRequire(citations.isNotEmpty);
    final ownership = meetingMap(proposal['ownership']),
        due = meetingMap(proposal['dueDate']);
    final person = meetingNullableId(ownership['participantId']),
        name = meetingNullableText(ownership['displayName'], max: 160);
    final authority = meetingMember(ownership['authority'], const [
      'explicit_transcript',
      'confirmation_required',
    ]);
    meetingRequire(
      authority == 'explicit_transcript'
          ? person != null && name != null
          : person == null && name == null,
    );
    final dueAt = meetingNullableDate(due['dueAt']),
        dueAuthority = meetingMember(due['authority'], const [
          'explicit_transcript',
          'confirmation_required',
        ]);
    meetingRequire((dueAt != null) == (dueAuthority == 'explicit_transcript'));
    Json? resolution;
    if (value['resolution'] != null) {
      resolution = meetingMap(value['resolution']);
      meetingRequire(
        resolution['schemaVersion'] == 1 &&
            resolution['contractVersion'] == meetingCommitmentContract &&
            resolution['proposalId'] == proposal['proposalId'] &&
            resolution['proposalSha256'] == proposal['proposalSha256'],
      );
      meetingRequire(
        RegExp(r'^meeting-commitment-resolution:[a-f0-9]{64}$')
            .hasMatch(meetingId(resolution['resolutionId'])),
      );
      meetingHash(resolution['resolutionSha256']);
      meetingDate(resolution['resolvedAt']);
      meetingId(resolution['resolvedByActorId']);
      final confirmed =
          meetingMember(resolution['decision'], const [
            'confirmed',
            'dismissed',
          ]) ==
          'confirmed';
      final owner = meetingNullableId(resolution['ownerParticipantId']),
          ownerName = meetingNullableText(
            resolution['ownerDisplayName'],
            max: 160,
          );
      final work = meetingNullableId(resolution['workItemId']),
          revision = meetingNullableId(resolution['meetingRevisionId']);
      final ownerAuthority = resolution['ownershipAuthority'] == null
          ? null
          : meetingMember(resolution['ownershipAuthority'], const [
              'explicit_transcript',
              'user_confirmed',
            ]);
      meetingRequire(
        confirmed
            ? owner != null &&
                  ownerName != null &&
                  ownerAuthority != null &&
                  work != null &&
                  revision != null
            : owner == null &&
                  ownerName == null &&
                  ownerAuthority == null &&
                  work == null &&
                  revision == null,
      );
      final date = meetingNullableDate(resolution['dueAt']),
          dateAuthority = resolution['dueDateAuthority'] == null
              ? null
              : meetingMember(resolution['dueDateAuthority'], const [
                  'explicit_transcript',
                  'user_confirmed',
                ]);
      meetingRequire((date != null) == (dateAuthority != null));
      final draft = meetingNullableId(resolution['draftId']),
          policy = meetingNullableId(resolution['communicationPolicyId']);
      meetingRequire(
        (draft != null) == (policy != null) &&
            (confirmed || date == null && draft == null),
      );
      resolution = freezeMeeting(resolution) as Json;
    }
    Json? reconciliation;
    if (value['reconciliation'] != null) {
      final row = meetingMap(value['reconciliation']);
      meetingRequire(
        row.length == 7 &&
            row.keys.every(
              const {
                'schemaVersion',
                'requestSha256',
                'decision',
                'state',
                'automaticRetryAllowed',
                'createdAt',
                'phases',
              }.contains,
            ),
      );
      meetingRequire(
        row['schemaVersion'] == 1 && row['automaticRetryAllowed'] == false,
      );
      meetingHash(row['requestSha256']);
      meetingMember(row['decision'], const ['confirmed', 'dismissed']);
      meetingMember(row['state'], const [
        'pending',
        'partial',
        'uncertain',
        'resolved',
      ]);
      meetingInstant(row['createdAt']);
      final phases = meetingList(row['phases'], 8, (phase) {
        meetingRequire(
          phase.length == 4 &&
              phase.keys.every(
                const {'phase', 'at', 'resourceId', 'evidenceSha256'}.contains,
              ),
        );
        final name = meetingMember(phase['phase'], const [
          'work_started',
          'work_completed',
          'draft_started',
          'draft_completed',
          'meeting_started',
          'meeting_completed',
          'resolution_started',
          'interrupted',
        ]);
        meetingInstant(phase['at']);
        meetingRequire(
          phase.containsKey('resourceId') &&
              phase.containsKey('evidenceSha256'),
        );
        final resource = phase['resourceId'] == null
                ? null
                : meetingId(phase['resourceId'], max: 240),
            hash = phase['evidenceSha256'] == null
                ? null
                : meetingHash(phase['evidenceSha256']);
        meetingRequire(
          name.endsWith('_completed')
              ? resource != null && hash != null
              : resource == null && hash == null,
        );
        return phase;
      });
      final names = phases.map((phase) => phase['phase'] as String).toList();
      meetingUnique(names);
      final sequence = names.isNotEmpty && names.last == 'interrupted'
          ? names.sublist(0, names.length - 1)
          : names;
      final plans = row['decision'] == 'dismissed'
          ? const [
              ['resolution_started'],
            ]
          : const [
              [
                'work_started',
                'work_completed',
                'meeting_started',
                'meeting_completed',
                'resolution_started',
              ],
              [
                'work_started',
                'work_completed',
                'draft_started',
                'draft_completed',
                'meeting_started',
                'meeting_completed',
                'resolution_started',
              ],
            ];
      meetingRequire(
        plans.any(
          (plan) =>
              sequence.length <= plan.length &&
              List.generate(
                sequence.length,
                (index) => plan[index] == sequence[index],
              ).every((matches) => matches),
        ),
      );
      final unconfirmed = names.any(
        (name) =>
            name.endsWith('_started') &&
            !names.contains(name.replaceFirst('_started', '_completed')),
      );
      final unresolvedState = names.contains('interrupted') || unconfirmed
          ? 'uncertain'
          : names.any((name) => name.endsWith('_completed'))
          ? 'partial'
          : 'pending';
      meetingRequire(
        row['state'] == 'resolved'
            ? names.isNotEmpty && names.last == 'resolution_started'
            : row['state'] == unresolvedState,
      );
      meetingRequire((row['state'] == 'resolved') == (resolution != null));
      if (resolution != null) {
        meetingRequire(row['decision'] == resolution['decision']);
      }
      reconciliation = freezeMeeting(row) as Json;
    }
    return MeetingCommitmentReview._(
      freezeMeeting(proposal) as Json,
      resolution,
      citations,
      reconciliation,
    );
  }
}

class MeetingCommitmentsSnapshot {
  const MeetingCommitmentsSnapshot(
    this.context,
    this.meetingId,
    this.meetingRevisionId,
    this.revision,
    this.rows,
    this.policies,
  );
  final MeetingContext context;
  final String meetingId, meetingRevisionId;
  final int revision;
  final List<MeetingCommitmentReview> rows;
  final List<Json> policies;
  bool matches(Meeting meeting) =>
      meeting.id == meetingId &&
      meeting.revisionId == meetingRevisionId &&
      meeting.revision == revision &&
      meeting.workspaceId == context.workspaceId;
  factory MeetingCommitmentsSnapshot.parse(
    Json value, {
    required String id,
    required String tenantId,
    String? workspaceId,
  }) {
    final context = MeetingContext.parse(value['context']);
    meetingRequire(workspaceId == null || context.workspaceId == workspaceId);
    final summary = meetingMap(value['meeting']);
    final revision = meetingInt(summary['revision'], minimum: 1);
    meetingRequire(
      summary['meetingId'] == id &&
          summary['meetingRevisionId'] == '$id:v$revision',
    );
    meetingText(summary['title'], max: 240);
    meetingNullableId(summary['projectId']);
    final participants = meetingList(
      summary['participants'],
      250,
      MeetingParticipant.fromJson,
    );
    meetingUnique(participants.map((person) => person.id));
    final rows = meetingList(
      value['commitments'],
      500,
      (row) => MeetingCommitmentReview.parse(
        row,
        meetingIdValue: id,
        tenantId: tenantId,
        workspaceId: context.workspaceId,
      ),
    );
    meetingUnique(rows.map((row) => row.id));
    final policies = meetingList(value['eligiblePolicies'], 200, (policy) {
      validation.meetingId(policy['id']);
      meetingText(policy['displayName'], max: 240);
      meetingText(policy['address'], max: 500);
      meetingRequire(
        policy['channel'] == 'email' &&
            policy['status'] == 'active' &&
            policy['consent'] != 'unknown',
      );
      meetingRequire(
        policy['version'] == 'p9.14-governed-communication:1' &&
            policy['tenantId'] == tenantId &&
            policy['approvalMode'] == 'always' &&
            policy['senderIdentity'] == 'connected_account',
      );
      meetingText(policy['ownerActorId'], max: 500);
      validation.meetingId(policy['personRef']);
      meetingHash(policy['policySha256']);
      meetingMember(policy['consent'], const [
        'explicit',
        'relationship_basis',
      ]);
      meetingMember(policy['allowedDisclosure'], const [
        'relationship_context',
        'confidential',
      ]);
      meetingMember(policy['relationship'], const [
        'personal',
        'colleague',
        'customer',
        'vendor',
        'other',
      ]);
      meetingInt(policy['lifecycleRevision'], minimum: 1);
      meetingInt(policy['maxDeliveriesPerDay'], minimum: 1, maximum: 50);
      meetingInstant(policy['createdAt']);
      meetingInstant(policy['updatedAt']);
      meetingRequire(policy['optOutReason'] == null);
      final hours = meetingMap(policy['quietHours']);
      meetingRequire(hours['enabled'] is bool);
      meetingText(hours['timeZone'], max: 120);
      for (final key in ['start', 'end']) {
        meetingRequire(
          RegExp(r'^([01]\d|2[0-3]):[0-5]\d$')
              .hasMatch(meetingText(hours[key])),
        );
      }
      final purposes = policy['allowedPurposes'];
      meetingRequire(purposes is List && purposes.contains('follow_up'));
      meetingRequire(
        (purposes as List).isNotEmpty &&
            purposes.length <= 5 &&
            purposes.every(
              const [
                'informational',
                'coordination',
                'follow_up',
                'support',
                'commercial',
              ].contains,
            ),
      );
      meetingRequire(
        participants.any(
          (person) =>
              person.email?.trim().toLowerCase() ==
              (policy['address'] as String).trim().toLowerCase(),
        ),
      );
      return freezeMeeting(policy) as Json;
    });
    meetingUnique(policies.map((policy) => policy['id'] as String));
    return MeetingCommitmentsSnapshot(
      context,
      id,
      '$id:v$revision',
      revision,
      rows,
      policies,
    );
  }
}
