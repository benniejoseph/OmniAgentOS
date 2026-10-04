import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/meetings/meetings.dart';
import 'package:asael/features/meetings/meetings_action_controller.dart';
import 'package:asael/features/meetings/meetings_commitments.dart';
import 'package:asael/features/meetings/meetings_draft_store.dart';
import 'package:asael/features/meetings/meetings_mutations.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_test_support.dart';

const _at = '2026-10-04T10:00:00.000Z';
const _policy = 'contact_policy:33333333-3333-4333-8333-333333333333';
const _draftId = 'message_draft:44444444-4444-4444-8444-444444444444';
Future<Json> _proposal() async {
  final body = <String, dynamic>{
    'schemaVersion': 1,
    'contractVersion': meetingCommitmentContract,
    'proposalId': 'meeting-commitment-proposal:${'a' * 64}',
    'tenantId': meetingOwner.tenantId,
    'workspaceId': 'workspace:native',
    'meetingId': meetingTestId,
    'meetingRevisionId': '$meetingTestId:v2',
    'meetingSha256': meetingDigest,
    'projectId': 'project-1',
    'sourceLinkId': 'source-1',
    'recordingId': 'recording-1',
    'mediaRevisionId': 'recording-1:media:v1',
    'mediaOutputSha256': meetingDigest,
    'actionItemId': 'media-action:${'b' * 64}',
    'actionItemSha256': meetingDigest,
    'title': 'Prepare the reviewed release',
    'citations': [
      {
        'turnId': 'media-turn:${'c' * 64}',
        'segmentIndex': 0,
        'startMilliseconds': 0,
        'endMilliseconds': 1000,
        'speakerLabel': 'Owner',
        'speakerParticipantId': 'person-1',
      },
    ],
    'ownership': {
      'participantId': null,
      'displayName': null,
      'authority': 'confirmation_required',
    },
    'dueDate': {'dueAt': null, 'authority': 'confirmation_required'},
    'proposedByActorId': 'actor:$meetingUserId',
    'proposedAt': _at,
  };
  return {...body, 'proposalSha256': await meetingSha(body)};
}

MeetingSubmission _submission(
  Json proposal, {
  bool communication = true,
  String decision = 'confirmed',
}) => MeetingSubmission.freeze(
  action: 'resolve',
  id: meetingTestId,
  owner: meetingOwner,
  body: {
    'workspaceId': 'workspace:native',
    'proposalId': proposal['proposalId'],
    'expectedProposalSha256': proposal['proposalSha256'],
    'decision': decision,
    if (decision == 'confirmed') ...{
      'ownerParticipantId': 'person-1',
      'dueAt': null,
      if (communication)
        'communication': {
          'policyId': _policy,
          'recipientParticipantId': 'person-1',
          'subject': 'Release review',
          'body': 'Please review the exact release.',
        },
    },
  },
  evidence: communication ? {'recipientEmail': 'owner@example.test'} : {},
);
Json _phase(String name) => {
  'phase': name,
  'at': _at,
  'resourceId': name.endsWith('_completed') ? '$name:exact' : null,
  'evidenceSha256': name.endsWith('_completed') ? meetingDigest : null,
};
Json _reconciliation({
  required String state,
  required List<String> phases,
  String decision = 'confirmed',
}) => {
  'schemaVersion': 1,
  'requestSha256': meetingDigest,
  'decision': decision,
  'state': state,
  'automaticRetryAllowed': false,
  'createdAt': _at,
  'phases': phases.map(_phase).toList(),
};
Future<Json> _sealReceipt(Json data, MeetingSubmission submitted) async {
  final service = <String, dynamic>{
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': 'app.meetings.commitments.resolve',
    'action': 'manage.workflow',
    'resourceType': 'meeting_commitment',
    'accessMode': 'mutation',
    'eventContract': 'meeting-commitment-events.v1+projects.atomic-events.v1+governed-communication-events.v1',
    'authoritySha256': meetingDigest,
    'idempotencyKeySha256': await meetingShaText(
      '${meetingOwner.tenantId}\u0000${submitted.key}',
    ),
    'outcomeSha256': await meetingSha(data),
    'resourceCount': 1,
    'occurredAt': _at,
  };
  return {
    ...data,
    'serviceReceipt': {...service, 'receiptSha256': await meetingSha(service)},
  };
}

Future<Json> _receipt(
  Json proposal,
  MeetingSubmission submitted, {
  String draftState = 'ready',
  String? recordedRecipientId,
}) async {
  final confirmed = submitted.body['decision'] == 'confirmed';
  final communication =
      submitted.body['communication'] as Map<String, dynamic>?;
  final resolutionBody = <String, dynamic>{
    'schemaVersion': 1,
    'contractVersion': meetingCommitmentContract,
    'resolutionId': 'meeting-commitment-resolution:${'d' * 64}',
    'proposalId': proposal['proposalId'],
    'proposalSha256': proposal['proposalSha256'],
    'decision': submitted.body['decision'],
    'ownerParticipantId': confirmed ? 'person-1' : null,
    'ownerDisplayName': confirmed ? 'Owner' : null,
    'ownershipAuthority': confirmed ? 'user_confirmed' : null,
    'dueAt': null,
    'dueDateAuthority': null,
    'workItemId': confirmed ? 'work-item:release' : null,
    'draftId': communication == null ? null : _draftId,
    'communicationPolicyId': communication == null ? null : _policy,
    'meetingRevisionId': confirmed ? '$meetingTestId:v3' : null,
    'resolvedByActorId': 'actor:$meetingUserId',
    'resolvedAt': _at,
  };
  final resolution = {
    ...resolutionBody,
    'resolutionSha256': await meetingSha(resolutionBody),
  };
  final request = confirmed
      ? {
          'decision': 'confirmed',
          'ownerParticipantId': 'person-1',
          'dueAt': null,
          'communication': communication == null
              ? null
              : {
                  ...communication,
                  'connectionId': null,
                  'recipientParticipantId': ?recordedRecipientId,
                },
        }
      : {'decision': 'dismissed'};
  final requestSha256 = await meetingSha({
    'schemaVersion': 1,
    'contract': 'meeting-commitment-resolution-intent:1',
    'tenantId': meetingOwner.tenantId,
    'workspaceId': 'workspace:native',
    'meetingId': meetingTestId,
    'proposalId': proposal['proposalId'],
    'proposalSha256': proposal['proposalSha256'],
    'ownerActorId': 'actor:$meetingUserId',
    'request': request,
  });
  final reconciliation = _reconciliation(
    state: 'resolved',
    decision: submitted.body['decision'] as String,
    phases: confirmed
        ? [
            'work_started',
            'work_completed',
            if (communication != null) ...['draft_started', 'draft_completed'],
            'meeting_started',
            'meeting_completed',
            'resolution_started',
          ]
        : ['resolution_started'],
  )..['requestSha256'] = requestSha256;
  Json? draft;
  if (communication != null) {
    final immutable = <String, dynamic>{
      'version': 'p9.14-governed-communication:1',
      'id': _draftId,
      'intentId': 'communication_intent:55555555-5555-4555-8555-555555555555',
      'policyId': _policy,
      'channel': 'email',
      'recipient': 'owner@example.test',
      'subject': communication['subject'],
      'body': communication['body'],
      'senderIdentity': 'connected_account',
      'createdAt': _at,
    };
    draft = {
      ...immutable,
      'draftSha256': await meetingSha(immutable),
      'state': draftState,
      'lifecycleRevision': draftState == 'delivered' ? 3 : 1,
      'updatedAt': _at,
    };
  }
  return _sealReceipt({
    'context': meetingContextJson(),
    'commitment': {
      'proposal': proposal,
      'resolution': resolution,
      'reconciliation': reconciliation,
    },
    'draft': ?draft,
  }, submitted);
}

MeetingCommitmentReview _parse(Json value) => MeetingCommitmentReview.parse(
  value,
  meetingIdValue: meetingTestId,
  tenantId: meetingOwner.tenantId,
  workspaceId: 'workspace:native',
);

void main() {
  test('shared Meeting receipt binds the proposal actor independently of the Meeting owner', () async {
    const differentOwner = 'actor:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    final proposal = await _proposal();
    final submitted = _submission(proposal, communication: false);
    final data = await _receipt(proposal, submitted);
    data.remove('serviceReceipt');
    data['meeting'] = await sealMeeting({
      ...meetingJson(revision: 3),
      'ownerActorId': differentOwner,
      'projectId': 'project-1',
      'declaredAccessClass': 'workspace_members',
      'effectiveAccessClass': 'workspace_members',
    });
    final accepted = await MeetingAcceptedReceipt.parse(
      await _sealReceipt(data, submitted),
      submitted,
      meetingOwner,
    );
    expect(accepted.meeting!.ownerActorId, differentOwner);
    expect(
      accepted.commitment!.proposal['proposedByActorId'],
      'actor:$meetingUserId',
    );
    expect(accepted.commitment!.reconciliation!['state'], 'resolved');
    final wrongDigest = await meetingSha({
      'schemaVersion': 1,
      'contract': 'meeting-commitment-resolution-intent:1',
      'tenantId': meetingOwner.tenantId,
      'workspaceId': 'workspace:native',
      'meetingId': meetingTestId,
      'proposalId': proposal['proposalId'],
      'proposalSha256': proposal['proposalSha256'],
      'ownerActorId': differentOwner,
      'request': {
        'decision': 'confirmed',
        'ownerParticipantId': 'person-1',
        'dueAt': null,
        'communication': null,
      },
    });
    data['commitment']['reconciliation']['requestSha256'] = wrongDigest;
    await expectLater(
      MeetingAcceptedReceipt.parse(
        await _sealReceipt(data, submitted),
        submitted,
        meetingOwner,
      ),
      throwsFormatException,
    );
  });
  test('exact resolution receipt retains returned draft lifecycle without inventing delivery', () async {
    final proposal = await _proposal(),
        submitted = _submission(await _proposal());
    final ready = await MeetingAcceptedReceipt.parse(
      await _receipt(proposal, submitted),
      submitted,
      meetingOwner,
    );
    expect(ready.commitment!.reviewable, isFalse);
    expect(ready.draft!['state'], 'ready');
    final later = await MeetingAcceptedReceipt.parse(
      await _receipt(proposal, submitted, draftState: 'delivered'),
      submitted,
      meetingOwner,
    );
    expect(later.draft!['state'], 'delivered');
    expect(later.commitment!.resolution!['workItemId'], 'work-item:release');
    expect(
      later.submitted.body['communication']['recipientParticipantId'],
      'person-1',
    );
  });
  test('same email with another participant does not bind the exact reviewed recipient', () async {
    final proposal = await _proposal(),
        submitted = _submission(await _proposal());
    await expectLater(
      MeetingAcceptedReceipt.parse(
        await _receipt(proposal, submitted, recordedRecipientId: 'person-2'),
        submitted,
        meetingOwner,
      ),
      throwsFormatException,
    );
  });
  test('native confirmation freezes an explicit due choice and the accepted canonical owner', () async {
    final proposal = await _proposal(),
        submitted = _submission(await _proposal());
    final omitted = {...submitted.body}..remove('dueAt');
    expect(
      () => MeetingSubmission.freeze(
        action: 'resolve',
        id: meetingTestId,
        owner: meetingOwner,
        body: omitted,
      ),
      throwsFormatException,
    );
    final value = await _receipt(proposal, submitted);
    final resolution = value['commitment']['resolution'] as Json;
    resolution['resolvedByActorId'] =
        'actor:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    final body = {...resolution}..remove('resolutionSha256');
    resolution['resolutionSha256'] = await meetingSha(body);
    value.remove('serviceReceipt');
    await expectLater(
      MeetingAcceptedReceipt.parse(
        await _sealReceipt(value, submitted),
        submitted,
        meetingOwner,
      ),
      throwsFormatException,
    );
  });
  test('re-signed draft content or missing draft cannot become an accepted communication', () async {
    final proposal = await _proposal(),
        submitted = _submission(await _proposal());
    final changed = await _receipt(proposal, submitted);
    final draft = changed['draft'] as Json;
    draft['subject'] = 'A different review';
    final immutable = {...draft}
      ..remove('draftSha256')
      ..remove('state')
      ..remove('lifecycleRevision')
      ..remove('updatedAt');
    draft['draftSha256'] = await meetingSha(immutable);
    changed.remove('serviceReceipt');
    await expectLater(
      MeetingAcceptedReceipt.parse(
        await _sealReceipt(changed, submitted),
        submitted,
        meetingOwner,
      ),
      throwsFormatException,
    );
    final missing = await _receipt(proposal, submitted);
    missing.remove('serviceReceipt');
    missing.remove('draft');
    await expectLater(
      MeetingAcceptedReceipt.parse(
        await _sealReceipt(missing, submitted),
        submitted,
        meetingOwner,
      ),
      throwsFormatException,
    );
  });
  test('legacy records remain readable but cannot confirm an unrecorded new recipient choice', () async {
    final proposal = await _proposal(),
        submitted = _submission(await _proposal());
    final value = await _receipt(proposal, submitted);
    (value['commitment'] as Json).remove('reconciliation');
    expect(_parse(value['commitment'] as Json).reviewable, isFalse);
    value.remove('serviceReceipt');
    await expectLater(
      MeetingAcceptedReceipt.parse(
        await _sealReceipt(value, submitted),
        submitted,
        meetingOwner,
      ),
      throwsFormatException,
    );
  });
  test('dismissal receipt binds only its exact immutable decision and records no children', () async {
    final proposal = await _proposal(),
        submitted = _submission(
          await _proposal(),
          communication: false,
          decision: 'dismissed',
        );
    final value = await MeetingAcceptedReceipt.parse(
      await _receipt(proposal, submitted),
      submitted,
      meetingOwner,
    );
    expect(value.commitment!.decision, 'dismissed');
    expect(value.commitment!.resolution!['workItemId'], isNull);
    expect(value.draft, isNull);
  });
  test('nonterminal reconciliation preserves exact child receipts and blocks another review', () async {
    final proposal = await _proposal();
    final view = _parse({
      'proposal': proposal,
      'resolution': null,
      'reconciliation': _reconciliation(
        state: 'partial',
        phases: ['work_started', 'work_completed'],
      ),
    });
    expect(view.reviewable, isFalse);
    expect(view.reconciliation!['automaticRetryAllowed'], isFalse);
    expect(
      view.reconciliation!['phases'][1]['resourceId'],
      'work_completed:exact',
    );
    final uncertain = _parse({
      'proposal': proposal,
      'resolution': null,
      'reconciliation': _reconciliation(
        state: 'uncertain',
        phases: ['work_started', 'interrupted'],
      ),
    });
    expect(uncertain.reconciliation!['state'], 'uncertain');
  });
  test('reconciliation rejects invented child evidence, reordered phases and optimistic state', () async {
    final proposal = await _proposal();
    final missing = _reconciliation(
      state: 'partial',
      phases: ['work_started', 'work_completed'],
    );
    missing['phases'][1]['evidenceSha256'] = null;
    final invented = _reconciliation(
      state: 'uncertain',
      phases: ['work_started'],
    );
    invented['phases'][0]['resourceId'] = 'not-confirmed';
    final tooLong = _reconciliation(
      state: 'partial',
      phases: ['work_started', 'work_completed'],
    );
    tooLong['phases'][1]['resourceId'] = 'a' * 241;
    final phaseExtra = _reconciliation(
      state: 'partial',
      phases: ['work_started', 'work_completed'],
    );
    phaseExtra['phases'][0]['privateText'] = 'Not part of the public receipt';
    final invalid = [
      missing,
      invented,
      tooLong,
      phaseExtra,
      {
        ..._reconciliation(state: 'pending', phases: []),
        'automaticTakeover': true,
      },
      _reconciliation(
        state: 'partial',
        phases: ['meeting_started', 'meeting_completed'],
      ),
      _reconciliation(state: 'pending', phases: ['work_started']),
      _reconciliation(
        state: 'resolved',
        phases: ['work_started', 'work_completed'],
      ),
      _reconciliation(
        state: 'uncertain',
        phases: ['work_started', 'work_started'],
      ),
    ];
    for (final reconciliation in invalid) {
      expect(
        () => _parse({
          'proposal': proposal,
          'resolution': null,
          'reconciliation': reconciliation,
        }),
        throwsFormatException,
      );
    }
  });
  test(
    'a confirmed resolve remains accepted when subsequent reads fail',
    () async {
      final proposal = await _proposal(),
          submitted = _submission(await _proposal());
      final repository = FakeMeetingsRepository()
        ..writer = (request) => _receipt(proposal, request);
      final actions = MeetingActionController(
        repository,
        MemoryMeetingDraftStore(),
        meetingTestId,
      );
      await actions.initialize();
      expect(
        await actions.submit(submitted, refresh: () async => false),
        isTrue,
      );
      await Future<void>.delayed(Duration.zero);
      expect(actions.accepted!.commitment!.decision, 'confirmed');
      expect(actions.needsRefresh, isTrue);
      expect(actions.refreshError, isNotNull);
      expect(actions.uncertain, isFalse);
      actions.dispose();
    },
  );
  test('unknown resolution is retained across restart without offering child-effect replay', () async {
    final submitted = _submission(await _proposal());
    final repository = FakeMeetingsRepository()
      ..writer = (_) =>
          Future.error(const ApiException('Resolution outcome unavailable'));
    final store = MemoryMeetingDraftStore();
    final actions = MeetingActionController(repository, store, meetingTestId);
    await actions.initialize();
    await actions.submit(submitted, refresh: () async => true);
    expect(actions.uncertain, isTrue);
    expect(await actions.retry(refresh: () async => true), isFalse);
    actions.dispose();
    final restored = MeetingActionController(repository, store, meetingTestId);
    await restored.initialize();
    expect(restored.uncertain, isTrue);
    expect(restored.submitted!.key, submitted.key);
    expect(await restored.retry(refresh: () async => true), isFalse);
    expect(repository.writes, 1);
    restored.dispose();
  });
}
