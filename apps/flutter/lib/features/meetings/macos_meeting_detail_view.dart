import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import '../macos_detail_support.dart';
import 'meetings.dart';

/// A macOS evidence workspace for one governed meeting projection.
class MacosMeetingDetailView extends StatefulWidget {
  const MacosMeetingDetailView({
    super.key,
    required this.id,
    required this.repository,
  });

  final String id;
  final MeetingsRepository repository;

  @override
  State<MacosMeetingDetailView> createState() => _MacosMeetingDetailViewState();
}

class _MacosMeetingDetailViewState extends State<MacosMeetingDetailView> {
  Meeting? _meeting;
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant MacosMeetingDetailView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.id != widget.id) {
      _meeting = null;
      _load();
    }
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final meeting = await widget.repository.detail(widget.id);
      if (mounted) setState(() => _meeting = meeting);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) => CallbackShortcuts(
    bindings: {
      const SingleActivator(LogicalKeyboardKey.bracketLeft, meta: true): () =>
          macosNavigateBack(context, '/meetings'),
      const SingleActivator(LogicalKeyboardKey.keyR, meta: true): _load,
    },
    child: Focus(autofocus: true, child: _page(context)),
  );

  Widget _page(BuildContext context) {
    final meeting = _meeting;
    return MacosPageScaffold(
      title: meeting?.title ?? 'Meeting evidence',
      description: meeting == null
          ? 'Decisions, commitments, consent, and linked source evidence.'
          : _scheduleDescription(context, meeting),
      icon: Icons.groups_2_outlined,
      actions: [
        IconButton(
          key: const Key('macos-meeting-detail-refresh'),
          tooltip: 'Refresh meeting (⌘R)',
          onPressed: _loading ? null : _load,
          icon: _loading
              ? const SizedBox.square(
                  dimension: 15,
                  child: CircularProgressIndicator(strokeWidth: 1.8),
                )
              : const Icon(Icons.refresh_rounded),
        ),
      ],
      toolbar: Row(
        children: [
          const MacosDetailBackButton(
            fallbackLocation: '/meetings',
            label: 'Meetings',
          ),
          if (meeting != null) ...[
            const SizedBox(width: 12),
            MacosStatusBadge(
              label: macosHumanize(meeting.status),
              tone: macosToneForStatus(meeting.status),
            ),
            const SizedBox(width: 8),
            MacosStatusBadge(
              label: macosHumanize(meeting.accessClass),
              icon: Icons.lock_outline_rounded,
            ),
          ],
        ],
      ),
      inspector: meeting == null ? null : _MeetingInspector(meeting: meeting),
      inspectorWidth: 350,
      inspectorMinWidth: 300,
      inspectorMaxWidth: 470,
      body: _body(meeting),
    );
  }

  Widget _body(Meeting? meeting) {
    if (_loading && meeting == null) return const MacosLoadingList(rows: 8);
    if (_error != null && meeting == null) {
      return MacosEmptyState(
        icon: Icons.cloud_off_outlined,
        title: 'Meeting evidence is unavailable',
        message: 'The meeting projection could not be loaded. Reconnect and try again.',
        action: FilledButton.tonalIcon(
          onPressed: _load,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Try again'),
        ),
      );
    }
    if (meeting == null) {
      return const MacosEmptyState(
        icon: Icons.event_busy_outlined,
        title: 'Meeting not found',
        message:
            'This meeting is no longer available to the current workspace.',
      );
    }
    return Column(
      children: [
        if (_error != null)
          MacosDetailNotice(
            message:
                'Showing the last available meeting projection. Refresh failed: $_error',
            action: TextButton(onPressed: _load, child: const Text('Retry')),
          ),
        Expanded(child: _MeetingDocument(meeting: meeting)),
      ],
    );
  }
}

class _MeetingDocument extends StatelessWidget {
  const _MeetingDocument({required this.meeting});
  final Meeting meeting;

  @override
  Widget build(BuildContext context) => SelectionArea(
    child: ListView(
      padding: const EdgeInsets.all(22),
      children: [
        MacosPane(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'MEETING RECORD',
                          style: Theme.of(context).textTheme.labelSmall,
                        ),
                        const SizedBox(height: 6),
                        Text(
                          meeting.title,
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                      ],
                    ),
                  ),
                  MacosStatusBadge(
                    label: macosHumanize(meeting.status),
                    tone: macosToneForStatus(meeting.status),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Text(
                meeting.summary.isEmpty
                    ? 'No meeting summary has been recorded yet.'
                    : meeting.summary,
                style: const TextStyle(height: 1.5),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        _MeetingOutcomeGrid(meeting: meeting),
        const SizedBox(height: 16),
        _ParticipantsTable(participants: meeting.participants),
      ],
    ),
  );
}

class _MeetingOutcomeGrid extends StatelessWidget {
  const _MeetingOutcomeGrid({required this.meeting});
  final Meeting meeting;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final columns = constraints.maxWidth >= 980
          ? 3
          : constraints.maxWidth >= 620
          ? 2
          : 1;
      final width = (constraints.maxWidth - ((columns - 1) * 12)) / columns;
      return Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          SizedBox(
            width: width,
            child: _NotesPane(
              title: 'Decisions',
              icon: Icons.gavel_outlined,
              empty: 'No decisions recorded.',
              notes: meeting.decisions,
            ),
          ),
          SizedBox(
            width: width,
            child: _NotesPane(
              title: 'Commitments',
              icon: Icons.handshake_outlined,
              empty: 'No commitments recorded.',
              notes: meeting.commitments,
            ),
          ),
          SizedBox(
            width: width,
            child: _NotesPane(
              title: 'Follow-ups',
              icon: Icons.next_plan_outlined,
              empty: 'No follow-ups proposed.',
              notes: meeting.followUps,
            ),
          ),
        ],
      );
    },
  );
}

class _NotesPane extends StatelessWidget {
  const _NotesPane({
    required this.title,
    required this.icon,
    required this.empty,
    required this.notes,
  });
  final String title, empty;
  final IconData icon;
  final List<MeetingNote> notes;

  @override
  Widget build(BuildContext context) => MacosPane(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(icon, size: 17),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                title,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            Text(
              '${notes.length}',
              style: Theme.of(context).textTheme.labelSmall,
            ),
          ],
        ),
        const SizedBox(height: 12),
        if (notes.isEmpty)
          Text(empty, style: Theme.of(context).textTheme.bodySmall)
        else
          for (final note in notes)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Padding(
                    padding: EdgeInsets.only(top: 2),
                    child: Icon(Icons.check_circle_outline_rounded, size: 15),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(note.label),
                        if (note.status != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 3),
                            child: MacosStatusBadge(
                              label: macosHumanize(note.status!),
                              tone: macosToneForStatus(note.status!),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
      ],
    ),
  );
}

class _ParticipantsTable extends StatelessWidget {
  const _ParticipantsTable({required this.participants});
  final List<MeetingParticipant> participants;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return MacosPane(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
            child: MacosSectionHeader(
              title: 'Participants & consent',
              description:
                  '${participants.length} people recorded in this meeting revision',
            ),
          ),
          Container(
            height: 30,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(
              color: mac.toolbar,
              border: Border.symmetric(
                horizontal: BorderSide(color: mac.divider),
              ),
            ),
            child: Row(
              children: [
                Expanded(
                  flex: 3,
                  child: Text(
                    'PARTICIPANT',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
                Expanded(
                  flex: 2,
                  child: Text(
                    'ROLE',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
                Expanded(
                  flex: 2,
                  child: Text(
                    'RESPONSE',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
                Expanded(
                  flex: 2,
                  child: Text(
                    'ATTENDANCE',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
                Expanded(
                  flex: 2,
                  child: Text(
                    'RECORDING',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
              ],
            ),
          ),
          if (participants.isEmpty)
            const Padding(
              padding: EdgeInsets.all(18),
              child: Text('No participants recorded.'),
            )
          else
            for (final participant in participants)
              Container(
                constraints: const BoxConstraints(minHeight: 46),
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 8,
                ),
                decoration: BoxDecoration(
                  border: Border(bottom: BorderSide(color: mac.divider)),
                ),
                child: Row(
                  children: [
                    Expanded(
                      flex: 3,
                      child: Text(
                        participant.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    Expanded(
                      flex: 2,
                      child: Text(macosHumanize(participant.role)),
                    ),
                    Expanded(
                      flex: 2,
                      child: Text(macosHumanize(participant.response)),
                    ),
                    Expanded(
                      flex: 2,
                      child: Text(macosHumanize(participant.attendeeConsent)),
                    ),
                    Expanded(
                      flex: 2,
                      child: Text(macosHumanize(participant.recordingConsent)),
                    ),
                  ],
                ),
              ),
        ],
      ),
    );
  }
}

class _MeetingInspector extends StatelessWidget {
  const _MeetingInspector({required this.meeting});
  final Meeting meeting;

  @override
  Widget build(BuildContext context) {
    final localStart = meeting.startAt.toLocal();
    final localEnd = meeting.endAt.toLocal();
    final localization = MaterialLocalizations.of(context);
    return ListView(
      children: [
        MacosInspectorSection(
          title: 'Schedule',
          child: Column(
            children: [
              MacosKeyValue(
                label: 'Date',
                value: localization.formatFullDate(localStart),
              ),
              MacosKeyValue(
                label: 'Starts',
                value: localization.formatTimeOfDay(
                  TimeOfDay.fromDateTime(localStart),
                ),
              ),
              MacosKeyValue(
                label: 'Ends',
                value: localization.formatTimeOfDay(
                  TimeOfDay.fromDateTime(localEnd),
                ),
              ),
              MacosKeyValue(label: 'Timezone', value: meeting.timezone),
              MacosKeyValue(
                label: 'Location',
                value: meeting.location.isEmpty
                    ? 'Not specified'
                    : meeting.location,
              ),
            ],
          ),
        ),
        MacosInspectorSection(
          title: 'Governance',
          child: Column(
            children: [
              MacosKeyValue(
                label: 'Access',
                value: macosHumanize(meeting.accessClass),
              ),
              MacosKeyValue(label: 'Revision', value: '${meeting.revision}'),
              MacosKeyValue(label: 'Meeting ID', value: meeting.id),
              MacosKeyValue(
                label: 'Project',
                value: meeting.projectId ?? 'Not linked',
              ),
            ],
          ),
        ),
        MacosInspectorSection(
          title: 'Linked evidence',
          description: '${meeting.evidence.length} source references',
          child: meeting.evidence.isEmpty
              ? Text(
                  'No linked evidence.',
                  style: Theme.of(context).textTheme.bodySmall,
                )
              : Column(
                  children: [
                    for (final item in meeting.evidence)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Icon(Icons.link_rounded, size: 16),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  SelectableText(item.label),
                                  const SizedBox(height: 2),
                                  Text(
                                    '${macosHumanize(item.role)} · ${macosHumanize(item.kind)}',
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodySmall,
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
        ),
        const SizedBox(height: 20),
      ],
    );
  }
}

String _scheduleDescription(BuildContext context, Meeting meeting) {
  final local = meeting.startAt.toLocal();
  final localization = MaterialLocalizations.of(context);
  return '${localization.formatFullDate(local)} · ${localization.formatTimeOfDay(TimeOfDay.fromDateTime(local))} · ${meeting.timezone}';
}
