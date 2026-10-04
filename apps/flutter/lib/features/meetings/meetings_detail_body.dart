import 'package:flutter/material.dart';

import 'meetings.dart';
import 'meetings_commitments.dart';
import 'meetings_snapshots.dart';
import 'meetings_widgets.dart';
import 'meetings_recording_controller.dart';
import 'meetings_recording_view.dart';

class MeetingDetailBody extends StatelessWidget {
  const MeetingDetailBody({
    super.key,
    required this.controller,
    this.actions,
    this.onReview,
    this.onPropose,
    this.reviewDisabledReason,
    this.proposeDisabledReason,
    this.recordings,
    this.active = true,
  });
  final MeetingDetailController controller;
  final Widget? actions;
  final void Function(MeetingCommitmentReview)? onReview;
  final void Function(MeetingSource, MeetingMediaOutput, Json)? onPropose;
  final String? reviewDisabledReason, proposeDisabledReason;
  final MeetingRecordingController? recordings;
  final bool active;
  @override
  Widget build(BuildContext context) {
    final snapshot = controller.detail, meeting = snapshot?.meeting;
    if (!controller.readable) {
      return const MeetingNotice(
        'Meeting access is unavailable. Unlock or restore the current workspace session to continue.',
      );
    }
    if (meeting == null) {
      return MeetingNotice(
        controller.detailLoading ? 'Loading the selected meeting…' : 'The selected meeting is unavailable. It may be missing, inaccessible, or the read did not complete.',
        action: 'Retry meeting detail',
        onAction: controller.detailLoading ? null : controller.refreshDetail,
        error: controller.detailError != null,
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (controller.detailError != null)
          MeetingNotice(
            'Showing the last loaded meeting. Current detail and source freshness are unavailable.',
            action: 'Retry meeting detail',
            onAction: controller.detailLoading
                ? null
                : controller.refreshDetail,
            error: true,
          ),
        if (controller.detailLoading)
          const MeetingNotice('Refreshing meeting detail…'),
        Semantics(
          header: true,
          child: SelectableText(
            meeting.title,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
        ),
        const SizedBox(height: 12),
        if (meeting.summary.isNotEmpty)
          SelectableText(
            meeting.summary,
            style: Theme.of(context).textTheme.bodyLarge,
          )
        else
          const Text('No summary is recorded in this revision.'),
        const SizedBox(height: 16),
        Wrap(
          spacing: 24,
          runSpacing: 8,
          children: [
            Text(meetingLabel(meeting.status)),
            Text('Revision ${meeting.revision}'),
            Text(meetingLabel(meeting.accessClass)),
          ],
        ),
        const SizedBox(height: 12),
        MeetingValue(
          'Scheduled start (UTC)',
          meetingTimestamp(meeting.startAt),
        ),
        MeetingValue('Scheduled end (UTC)', meetingTimestamp(meeting.endAt)),
        MeetingValue('Meeting time zone', meeting.timezone),
        MeetingValue(
          'Location',
          meeting.location.isEmpty ? 'No location recorded' : meeting.location,
        ),
        if (meeting.actualStartAt != null)
          MeetingValue(
            'Actual start',
            meetingTimestamp(meeting.actualStartAt!),
          ),
        if (meeting.actualEndAt != null)
          MeetingValue('Actual end', meetingTimestamp(meeting.actualEndAt!)),
        ?actions,
        MeetingDisclosure(
          'Exact meeting identity',
          children: [
            MeetingValue('Meeting', meeting.id),
            MeetingValue('Workspace', meeting.workspaceId),
            MeetingValue('Tenant', meeting.tenantId),
            MeetingValue('Owner', meeting.ownerActorId),
            MeetingValue('Revision', meeting.revisionId),
            MeetingValue('Revision SHA-256', meeting.sha256),
            MeetingValue('Consent snapshot SHA-256', meeting.consentSha256),
            MeetingValue('Work project', meeting.projectId),
            MeetingValue(
              'Access authority SHA-256',
              snapshot!.context?.authoritySha256,
            ),
          ],
        ),
        MeetingSection(
          'Participants & consent',
          subtitle:
              '${meeting.participants.length} participants in this saved revision. Attendance consent and recording consent are separate.',
          child: meeting.participants.isEmpty
              ? const Text(
                  'No participants are recorded. Recording consent is unconfirmed.',
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final person in meeting.participants)
                      MeetingDisclosure(
                        person.name,
                        subtitle:
                            '${meetingLabel(person.role)} · ${meetingLabel(person.response)}',
                        children: [
                          MeetingValue('Participant', person.id),
                          if (person.email != null)
                            MeetingValue('Email', person.email),
                          MeetingValue(
                            'Attendance consent',
                            meetingLabel(person.attendeeConsent),
                          ),
                          MeetingValue(
                            'Recording consent',
                            meetingLabel(person.recordingConsent),
                          ),
                          MeetingValue(
                            'Consent recorded at',
                            person.consentCapturedAt == null
                                ? null
                                : meetingTimestamp(person.consentCapturedAt!),
                          ),
                          MeetingValue(
                            'Source',
                            person.source == null
                                ? null
                                : meetingLabel(person.source!),
                          ),
                        ],
                      ),
                  ],
                ),
        ),
        MeetingSection(
          'Decisions',
          child: _Notes(
            meeting.decisions,
            empty: 'No decisions are recorded in this meeting revision.',
          ),
        ),
        MeetingSection(
          'Commitments',
          child: _Notes(
            meeting.commitments,
            empty: 'No commitments are recorded in this meeting revision.',
          ),
        ),
        MeetingSection(
          'Follow-ups',
          subtitle: 'Recorded follow-up state does not prove delivery or verified completion.',
          child: _Notes(
            meeting.followUps,
            empty: 'No follow-ups are recorded in this meeting revision.',
          ),
        ),
        MeetingSection(
          'Review follow-up proposals',
          subtitle: 'A proposal is evidence for review. Accepting it creates the exact governed Work item and, only when explicitly selected, a communication draft.',
          child: _Commitments(
            controller,
            onReview: onReview,
            disabledReason: reviewDisabledReason,
          ),
        ),
        MeetingSection(
          'Sources & media',
          subtitle: 'Exact identifies the saved source reference. It does not prove current upstream Calendar sync or OAuth authorization. A later GET alone does not establish source freshness.',
          child: meeting.evidence.isEmpty
              ? const Text('No source links are saved in this revision.')
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (proposeDisabledReason != null)
                      MeetingNotice(proposeDisabledReason!),
                    for (final evidence in meeting.evidence)
                      _Source(
                        evidence,
                        snapshot.sources
                            .where((source) => source.id == evidence.id)
                            .firstOrNull,
                        onPropose:
                            proposeDisabledReason == null &&
                                controller.detailError == null &&
                                snapshot.context?.canWrite == true &&
                                meeting.projectId != null
                            ? onPropose
                            : null,
                      ),
                  ],
                ),
        ),
        if (recordings != null && meeting.workspaceId != null)
          MeetingRecordingPanel(
            key: ObjectKey(recordings),
            controller: recordings!,
            meeting: meeting,
            active: active,
            isCurrent: () =>
                controller.readable &&
                controller.detailError == null &&
                !controller.detailLoading &&
                controller.detail?.meeting.versionKey == meeting.versionKey,
          )
        else
          const MeetingNotice(
            'View Calendar connection and sync status in Meetings. Recording review is unavailable in this presentation.',
          ),
      ],
    );
  }
}

class _Notes extends StatelessWidget {
  const _Notes(this.notes, {required this.empty});
  final List<MeetingNote> notes;
  final String empty;
  @override
  Widget build(BuildContext context) => notes.isEmpty
      ? Text(empty)
      : Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final note in notes)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SelectableText(
                      note.label,
                      style: Theme.of(context).textTheme.bodyLarge,
                    ),
                    if (note.status != null) Text(meetingLabel(note.status!)),
                    MeetingDisclosure(
                      'Recorded references',
                      children: [
                        MeetingValue('Identity', note.id),
                        if (note.ownerParticipantId != null)
                          MeetingValue(
                            'Owner participant',
                            note.ownerParticipantId,
                          ),
                        if (note.dueAt != null)
                          MeetingValue('Due', meetingTimestamp(note.dueAt!)),
                        if (note.sourceLinkId != null)
                          MeetingValue('Source link', note.sourceLinkId),
                        if (note.workItemId != null)
                          MeetingValue('Work item', note.workItemId),
                        if (note.draftId != null)
                          MeetingValue('Communication draft', note.draftId),
                      ],
                    ),
                  ],
                ),
              ),
          ],
        );
}

class _Commitments extends StatelessWidget {
  const _Commitments(this.controller, {this.onReview, this.disabledReason});
  final MeetingDetailController controller;
  final void Function(MeetingCommitmentReview)? onReview;
  final String? disabledReason;
  @override
  Widget build(BuildContext context) {
    if (!controller.commitmentsAvailable) {
      return const Text(
        'Follow-up review reads are not published for this native version. Saved meeting commitments remain visible above.',
      );
    }
    final snapshot = controller.commitments;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (disabledReason != null) MeetingNotice(disabledReason!),
        if (controller.commitmentsLoading)
          const MeetingNotice('Loading current follow-up proposals…'),
        if (controller.commitmentsError != null)
          MeetingNotice(
            snapshot == null
                ? 'Follow-up proposals are unavailable. No proposal count has been confirmed.'
                : 'Showing last loaded follow-up proposals. Current review readiness is unavailable.',
            action: 'Retry follow-up proposals',
            onAction: controller.commitmentsLoading
                ? null
                : controller.refreshCommitments,
            error: true,
          ),
        if (snapshot == null &&
            !controller.commitmentsLoading &&
            controller.commitmentsError == null)
          MeetingNotice(
            'Follow-up proposals have not loaded.',
            action: 'Load follow-up proposals',
            onAction: controller.refreshCommitments,
          ),
        if (snapshot != null) ...[
          Text(
            '${snapshot.rows.length} loaded proposals · ${snapshot.meetingRevisionId}',
          ),
          if (!controller.currentCommitments)
            MeetingNotice(
              'The proposal read does not match the current meeting revision. Refresh both reads before reviewing.',
              action: 'Refresh meeting and proposals',
              onAction: controller.refresh,
            ),
          if (snapshot.rows.isEmpty)
            const Text('No proposals were returned in this bounded read.'),
          for (final row in snapshot.rows)
            MeetingDisclosure(
              row.title,
              subtitle: row.decision == null
                  ? 'Proposed · review required'
                  : 'Recorded ${meetingLabel(row.decision!).toLowerCase()}',
              children: [
                MeetingValue('Proposal', row.id),
                MeetingValue('Proposal SHA-256', row.sha256),
                MeetingValue(
                  'Evidence meeting revision',
                  row.meetingRevisionId,
                ),
                MeetingValue('Media revision', row.mediaRevisionId),
                if (row.meetingRevisionId != snapshot.meetingRevisionId)
                  const MeetingNotice(
                    'Historical proposal: its evidence belongs to an earlier meeting revision.',
                  ),
                MeetingValue(
                  'Owner evidence',
                  row.proposal['ownership']['authority'] as String,
                ),
                MeetingValue(
                  'Proposed owner',
                  row.proposal['ownership']['displayName'] as String?,
                ),
                MeetingValue(
                  'Due-date evidence',
                  row.proposal['dueDate']['authority'] as String,
                ),
                MeetingValue(
                  'Proposed due date',
                  row.proposal['dueDate']['dueAt'] as String?,
                ),
                for (final citation in row.citations)
                  MeetingCitationView(citation),
                if (row.resolution != null) ...[
                  MeetingValue(
                    'Resolution SHA-256',
                    row.resolution!['resolutionSha256'] as String,
                  ),
                  MeetingValue(
                    'Work item',
                    row.resolution!['workItemId'] as String?,
                  ),
                  MeetingValue(
                    'Communication draft',
                    row.resolution!['draftId'] as String?,
                  ),
                  const Text(
                    'This resolution records creation or dismissal. It does not establish current delivery or task completion.',
                  ),
                ],
                if (row.reconciliation != null)
                  MeetingDisclosure(
                    'Resolution reconciliation',
                    expanded: true,
                    children: [
                      MeetingValue(
                        'Recorded state',
                        row.reconciliation!['state'] as String,
                      ),
                      MeetingValue(
                        'Exact request SHA-256',
                        row.reconciliation!['requestSha256'] as String,
                      ),
                      const Text(
                        'Automatic retry is prohibited. These phase receipts show known progress; a missing receipt does not prove no effect occurred.',
                      ),
                      for (final phase
                          in row.reconciliation!['phases'] as List) ...[
                        MeetingValue('Phase', phase['phase'] as String),
                        MeetingValue('Recorded at', phase['at'] as String),
                        MeetingValue(
                          'Known child identity',
                          phase['resourceId'] as String?,
                        ),
                        MeetingValue(
                          'Evidence SHA-256',
                          phase['evidenceSha256'] as String?,
                        ),
                      ],
                    ],
                  ),
                if (onReview != null && row.resolution == null)
                  OutlinedButton(
                    onPressed:
                        disabledReason == null &&
                            controller.currentCommitments &&
                            row.reviewable &&
                            row.meetingRevisionId == snapshot.meetingRevisionId
                        ? () => onReview!(row)
                        : null,
                    child: const Text('Review exact follow-up'),
                  ),
              ],
            ),
        ],
      ],
    );
  }
}

class _Source extends StatelessWidget {
  const _Source(this.link, this.source, {this.onPropose});
  final MeetingEvidence link;
  final MeetingSource? source;
  final void Function(MeetingSource, MeetingMediaOutput, Json)? onPropose;
  @override
  Widget build(BuildContext context) {
    final media = source?.media, output = media?.output;
    return MeetingDisclosure(
      link.label,
      subtitle:
          '${meetingLabel(link.kind)} · ${source == null ? 'Current metadata unavailable' : meetingLabel(source!.revisionState)}',
      children: [
        MeetingValue('Source link', link.id),
        MeetingValue('Source', link.sourceId),
        MeetingValue('Saved source revision', link.revisionId),
        MeetingValue('Saved revision SHA-256', link.revisionSha256),
        MeetingValue('Source authority SHA-256', link.authoritySha256),
        MeetingValue('Source access', link.accessClass),
        MeetingValue('Media role', link.role),
        if (source != null) ...[
          MeetingValue('Current source status', source!.status),
          MeetingValue('Media type', source!.mediaType),
          MeetingValue('Duration', meetingDuration(source!.durationMs)),
          MeetingValue('Bytes', source!.byteCount?.toString()),
          if (source!.revisionState != 'exact')
            const MeetingNotice(
              'This source does not currently match its saved revision. Raw transcript and segment access are unavailable for this reference.',
            ),
          if (source!.transcript != null)
            MeetingDisclosure(
              'Raw transcript',
              subtitle: source!.truncated
                  ? 'Bounded excerpt · server truncated this transcript'
                  : 'Transcript returned for the exact linked revision',
              children: [
                source!.transcript!.isEmpty
                    ? const Text('The source returned an empty transcript.')
                    : MeetingTextPages(text: source!.transcript!),
              ],
            ),
          if (source!.segments.isNotEmpty)
            MeetingDisclosure(
              'Recorded segments (${source!.segments.length})',
              children: [
                for (final segment in source!.segments)
                  MeetingValue(
                    'Segment ${segment['segmentIndex']}',
                    '${segment['mimeType']} · ${meetingDuration(segment['durationMs'] as num)}',
                  ),
              ],
            ),
        ],
        if (media == null)
          const Text(
            'Processed media metadata is unavailable. No processing or extraction count is inferred.',
          )
        else ...[
          MeetingValue('Media processing', meetingLabel(media.status)),
          MeetingValue('Operation job', media.jobId),
          MeetingValue('Raw audio deleted at', media.deletedAt),
          if (media.pending)
            const Text(
              'Processing is pending. Status reads continue while this meeting is visible.',
            ),
          if (media.status == 'failed')
            const MeetingNotice(
              'Media processing failed. Existing output, if shown, is historical; no successful retry is implied.',
              error: true,
            ),
          if (output == null) const Text('No processed output was returned.'),
        ],
        if (output != null) ...[
          MeetingValue('Media output revision', output.revisionId),
          MeetingValue('Media output SHA-256', output.sha256),
          if (source!.revisionState != 'exact')
            const MeetingNotice(
              'Historical processed output: the source revision has changed.',
            ),
          for (final warning in output.warnings) MeetingNotice(warning),
          MeetingDisclosure(
            'Cited summary',
            children: [
              SelectableText(
                output.summary['text'] as String,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
              for (final citation in output.citations(output.summary))
                MeetingCitationView(citation),
            ],
          ),
          MeetingDisclosure(
            'Transcript turns (${output.turns.length})',
            children: [MeetingTurns(output.turns)],
          ),
          MeetingDisclosure(
            'Chapters (${output.chapters.length})',
            children: [
              for (final chapter in output.chapters)
                _CitedText(chapter['title'] as String, chapter, output),
            ],
          ),
          MeetingDisclosure(
            'Extracted decisions (${output.decisions.length})',
            children: [
              for (final decision in output.decisions)
                _CitedText('Extracted decision', decision, output),
            ],
          ),
          MeetingDisclosure(
            'Extracted action items (${output.actions.length})',
            children: [
              for (final action in output.actions) ...[
                _CitedText(
                  'Proposed action · ${meetingLabel(action['ownershipEvidence'] as String)} owner evidence',
                  action,
                  output,
                ),
                if (onPropose != null)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: OutlinedButton(
                      onPressed:
                          source!.revisionState == 'exact' &&
                              media!.status == 'ready'
                          ? () => onPropose!(source!, output, action)
                          : null,
                      child: const Text('Review extracted action'),
                    ),
                  ),
              ],
            ],
          ),
        ],
      ],
    );
  }
}

class _CitedText extends StatelessWidget {
  const _CitedText(this.title, this.row, this.output);
  final String title;
  final Json row;
  final MeetingMediaOutput output;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 20),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(title, style: Theme.of(context).textTheme.titleMedium),
        SelectableText(
          row['text'] as String,
          style: Theme.of(context).textTheme.bodyLarge,
        ),
        for (final citation in output.citations(row))
          MeetingCitationView(citation),
      ],
    ),
  );
}

class MeetingCitationView extends StatelessWidget {
  const MeetingCitationView(this.citation, {super.key});
  final MeetingCitation citation;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '${citation.speaker} · segment ${citation.segmentIndex} · ${(citation.startMs / 1000).toStringAsFixed(1)}–${(citation.endMs / 1000).toStringAsFixed(1)} seconds',
        ),
        SelectableText(
          citation.turnId,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        if (citation.participantId != null)
          SelectableText(
            citation.participantId!,
            style: Theme.of(context).textTheme.bodySmall,
          ),
      ],
    ),
  );
}

class MeetingTurns extends StatefulWidget {
  const MeetingTurns(this.turns, {super.key});
  final List<Json> turns;
  @override
  State<MeetingTurns> createState() => _MeetingTurnsState();
}

class _MeetingTurnsState extends State<MeetingTurns> {
  int page = 0;
  @override
  void didUpdateWidget(covariant MeetingTurns oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.turns, widget.turns)) {
      page = 0;
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final turn in widget.turns.skip(page * 40).take(40))
        Padding(
          padding: const EdgeInsets.only(bottom: 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${turn['speaker']['label']} · ${meetingLabel(turn['speaker']['identity'] as String)} · ${turn['languageTag']}',
              ),
              SelectableText(
                turn['text'] as String,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
              SelectableText(
                '${turn['startMilliseconds']}–${turn['endMilliseconds']} ms · ${turn['turnId']}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
      if (widget.turns.length > 40)
        Wrap(
          spacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              'Turns ${page * 40 + 1}–${((page + 1) * 40).clamp(0, widget.turns.length)} of ${widget.turns.length}',
            ),
            TextButton(
              onPressed: page == 0 ? null : () => setState(() => page--),
              child: const Text('Previous turns'),
            ),
            TextButton(
              onPressed: (page + 1) * 40 >= widget.turns.length
                  ? null
                  : () => setState(() => page++),
              child: const Text('Next turns'),
            ),
          ],
        ),
    ],
  );
}
