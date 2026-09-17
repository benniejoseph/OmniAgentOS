import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import 'meetings.dart';

/// A desktop agenda workspace for the installed macOS app.
///
/// The shared [MeetingsController] remains the source of truth. This presenter
/// only changes information density, selection, and navigation for pointer and
/// keyboard use on a large screen.
class MacosMeetingsView extends StatefulWidget {
  const MacosMeetingsView({
    super.key,
    required this.controller,
    required this.onOpen,
  });

  final MeetingsController controller;
  final ValueChanged<Meeting> onOpen;

  @override
  State<MacosMeetingsView> createState() => _MacosMeetingsViewState();
}

class _MacosMeetingsViewState extends State<MacosMeetingsView> {
  String _filter = 'active';
  String? _selectedId;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      final meetings = _visibleMeetings(controller.meetings);
      final selected = _selectedMeeting(meetings);

      return CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.keyR, meta: true):
              controller.refresh,
          const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
              _moveSelection(meetings, 1),
          const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
              _moveSelection(meetings, -1),
          const SingleActivator(LogicalKeyboardKey.enter): () {
            if (selected != null) widget.onOpen(selected);
          },
        },
        child: Focus(
          autofocus: true,
          child: MacosPageScaffold(
            title: 'Meetings',
            description: 'A time-ordered agenda with decisions, consent, and linked evidence.',
            icon: Icons.calendar_month_outlined,
            actions: [
              _RefreshState(
                controller: controller,
                onRefresh: controller.refresh,
              ),
            ],
            toolbar: _MeetingsToolbar(
              filter: _filter,
              counts: _meetingCounts(controller.meetings),
              onFilterChanged: (value) => setState(() => _filter = value),
            ),
            inspector: _MeetingInspector(
              meeting: selected,
              onOpen: selected == null ? null : () => widget.onOpen(selected),
            ),
            inspectorWidth: 360,
            inspectorMinWidth: 310,
            inspectorMaxWidth: 480,
            body: _MeetingsBody(
              controller: controller,
              meetings: meetings,
              selectedId: selected?.id,
              onSelect: (meeting) => setState(() => _selectedId = meeting.id),
            ),
          ),
        ),
      );
    },
  );

  List<Meeting> _visibleMeetings(List<Meeting> values) {
    final visible = values.where((meeting) {
      if (_filter == 'all') return true;
      if (_filter == 'active') return meeting.isActive;
      return meeting.status == _filter;
    }).toList();
    visible.sort((left, right) => left.startAt.compareTo(right.startAt));
    return visible;
  }

  Meeting? _selectedMeeting(List<Meeting> meetings) {
    if (meetings.isEmpty) return null;
    for (final meeting in meetings) {
      if (meeting.id == _selectedId) return meeting;
    }
    return meetings.first;
  }

  void _moveSelection(List<Meeting> meetings, int delta) {
    if (meetings.isEmpty) return;
    final current = meetings.indexWhere((item) => item.id == _selectedId);
    final next = current < 0
        ? 0
        : (current + delta).clamp(0, meetings.length - 1);
    setState(() => _selectedId = meetings[next].id);
  }
}

class _MeetingsToolbar extends StatelessWidget {
  const _MeetingsToolbar({
    required this.filter,
    required this.counts,
    required this.onFilterChanged,
  });

  final String filter;
  final Map<String, int> counts;
  final ValueChanged<String> onFilterChanged;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Text('Show', style: Theme.of(context).textTheme.labelMedium),
      const SizedBox(width: 8),
      SegmentedButton<String>(
        showSelectedIcon: false,
        segments: [
          for (final value in const ['active', 'all', 'completed', 'cancelled'])
            ButtonSegment(
              value: value,
              label: Text(
                '${_meetingStatusLabel(value)}  ${counts[value] ?? 0}',
              ),
            ),
        ],
        selected: {filter},
        onSelectionChanged: (value) => onFilterChanged(value.single),
      ),
      const Spacer(),
      Icon(
        Icons.keyboard_arrow_up_rounded,
        size: 15,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      ),
      Icon(
        Icons.keyboard_arrow_down_rounded,
        size: 15,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      ),
      const SizedBox(width: 4),
      Text(
        'Select · Return opens',
        style: Theme.of(context).textTheme.labelSmall,
      ),
    ],
  );
}

class _RefreshState extends StatelessWidget {
  const _RefreshState({required this.controller, required this.onRefresh});

  final MeetingsController controller;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    final refreshedAt = controller.refreshedAt?.toLocal();
    final refreshedLabel = refreshedAt == null
        ? 'Not synced yet'
        : 'Updated ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(refreshedAt))}';
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (controller.showingStaleData) ...[
          Icon(
            Icons.cloud_off_outlined,
            size: 16,
            color: Theme.of(context).colorScheme.error,
          ),
          const SizedBox(width: 6),
          Text(
            'Cached agenda',
            style: Theme.of(context).textTheme.labelMedium
                ?.copyWith(color: Theme.of(context).colorScheme.error),
          ),
          const SizedBox(width: 8),
        ] else
          Text(refreshedLabel, style: Theme.of(context).textTheme.labelSmall),
        const SizedBox(width: 4),
        IconButton(
          key: const Key('macos-meetings-refresh'),
          tooltip: controller.loading ? 'Refreshing meetings' : 'Refresh (⌘R)',
          onPressed: controller.loading ? null : onRefresh,
          icon: controller.loading
              ? const SizedBox.square(
                  dimension: 15,
                  child: CircularProgressIndicator(strokeWidth: 1.8),
                )
              : const Icon(Icons.refresh_rounded),
        ),
      ],
    );
  }
}

class _MeetingsBody extends StatelessWidget {
  const _MeetingsBody({
    required this.controller,
    required this.meetings,
    required this.selectedId,
    required this.onSelect,
  });

  final MeetingsController controller;
  final List<Meeting> meetings;
  final String? selectedId;
  final ValueChanged<Meeting> onSelect;

  @override
  Widget build(BuildContext context) {
    if (controller.loading && controller.meetings.isEmpty) {
      return const MacosLoadingList(rows: 9);
    }
    if (controller.error != null && controller.meetings.isEmpty) {
      return MacosEmptyState(
        icon: Icons.cloud_off_outlined,
        title: 'The agenda is unavailable',
        message: 'Reconnect to load your meetings and their evidence.',
        action: FilledButton.tonalIcon(
          onPressed: controller.refresh,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Try again'),
        ),
      );
    }

    return Column(
      children: [
        if (controller.showingStaleData)
          _StaleAgendaNotice(onRetry: controller.refresh),
        const _AgendaColumnHeader(),
        Expanded(
          child: meetings.isEmpty
              ? const MacosEmptyState(
                  icon: Icons.event_available_outlined,
                  title: 'No meetings in this view',
                  message: 'Change the status filter or refresh to check the latest agenda.',
                )
              : _GroupedAgenda(
                  meetings: meetings,
                  selectedId: selectedId,
                  onSelect: onSelect,
                ),
        ),
      ],
    );
  }
}

class _StaleAgendaNotice extends StatelessWidget {
  const _StaleAgendaNotice({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
    color: Theme.of(context).colorScheme.errorContainer,
    child: Row(
      children: [
        const Icon(Icons.cloud_off_outlined, size: 16),
        const SizedBox(width: 8),
        const Expanded(
          child: Text(
            'Showing the last available agenda. The latest refresh did not complete.',
          ),
        ),
        TextButton(onPressed: onRetry, child: const Text('Retry')),
      ],
    ),
  );
}

class _AgendaColumnHeader extends StatelessWidget {
  const _AgendaColumnHeader();

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return LayoutBuilder(
      builder: (context, constraints) => Container(
        height: 32,
        padding: const EdgeInsets.symmetric(horizontal: 18),
        decoration: BoxDecoration(
          color: mac.toolbar,
          border: Border(bottom: BorderSide(color: mac.divider)),
        ),
        child: Row(
          children: [
            const SizedBox(width: 68),
            Expanded(
              child: Text(
                'MEETING',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ),
            if (constraints.maxWidth >= 610)
              SizedBox(
                width: 104,
                child: Text(
                  'STATUS',
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ),
            if (constraints.maxWidth >= 740)
              SizedBox(
                width: 86,
                child: Text(
                  'PEOPLE',
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ),
            if (constraints.maxWidth >= 880)
              SizedBox(
                width: 170,
                child: Text(
                  'PLACE',
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _GroupedAgenda extends StatelessWidget {
  const _GroupedAgenda({
    required this.meetings,
    required this.selectedId,
    required this.onSelect,
  });

  final List<Meeting> meetings;
  final String? selectedId;
  final ValueChanged<Meeting> onSelect;

  @override
  Widget build(BuildContext context) {
    final groups = <DateTime, List<Meeting>>{};
    for (final meeting in meetings) {
      final local = meeting.startAt.toLocal();
      final day = DateTime(local.year, local.month, local.day);
      groups.putIfAbsent(day, () => []).add(meeting);
    }
    final entries = groups.entries.toList()
      ..sort((left, right) => left.key.compareTo(right.key));

    return _ManagedScrollbar(
      builder: (scrollController) => ListView.builder(
        controller: scrollController,
        padding: const EdgeInsets.only(bottom: 24),
        itemCount: entries.length,
        itemBuilder: (context, index) {
          final entry = entries[index];
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _DayHeader(day: entry.key, count: entry.value.length),
              for (final meeting in entry.value)
                _AgendaRow(
                  key: Key('macos-meeting-${meeting.id}'),
                  meeting: meeting,
                  selected: meeting.id == selectedId,
                  onTap: () => onSelect(meeting),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _DayHeader extends StatelessWidget {
  const _DayHeader({required this.day, required this.count});

  final DateTime day;
  final int count;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final relative = day == today
        ? 'Today'
        : day == today.add(const Duration(days: 1))
        ? 'Tomorrow'
        : MaterialLocalizations.of(context).formatMediumDate(day);
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 6),
      child: Row(
        children: [
          Text(relative, style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(width: 8),
          Text(
            '$count ${count == 1 ? 'meeting' : 'meetings'}',
            style: Theme.of(context).textTheme.labelSmall,
          ),
        ],
      ),
    );
  }
}

class _AgendaRow extends StatelessWidget {
  const _AgendaRow({
    super.key,
    required this.meeting,
    required this.selected,
    required this.onTap,
  });

  final Meeting meeting;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final scheme = Theme.of(context).colorScheme;
    final local = meeting.startAt.toLocal();
    final time = MaterialLocalizations.of(context)
        .formatTimeOfDay(TimeOfDay.fromDateTime(local));
    return LayoutBuilder(
      builder: (context, constraints) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 1),
        child: Material(
          color: selected ? mac.selection : Colors.transparent,
          borderRadius: BorderRadius.circular(7),
          child: InkWell(
            borderRadius: BorderRadius.circular(7),
            onTap: onTap,
            child: Container(
              constraints: const BoxConstraints(minHeight: 54),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
              decoration: BoxDecoration(
                border: Border(
                  left: BorderSide(
                    color: _meetingAccent(context, meeting.status),
                    width: 3,
                  ),
                ),
              ),
              child: Row(
                children: [
                  SizedBox(
                    width: 68,
                    child: Text(
                      time,
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          meeting.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(fontWeight: FontWeight.w600),
                        ),
                        if (meeting.summary.isNotEmpty)
                          Text(
                            meeting.summary,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                      ],
                    ),
                  ),
                  if (constraints.maxWidth >= 610)
                    SizedBox(
                      width: 104,
                      child: _StatusLabel(
                        label: _meetingStatusLabel(meeting.status),
                        color: _meetingAccent(context, meeting.status),
                      ),
                    ),
                  if (constraints.maxWidth >= 740)
                    SizedBox(
                      width: 86,
                      child: Row(
                        children: [
                          Icon(
                            Icons.people_outline_rounded,
                            size: 14,
                            color: scheme.onSurfaceVariant,
                          ),
                          const SizedBox(width: 5),
                          Text('${meeting.participants.length}'),
                        ],
                      ),
                    ),
                  if (constraints.maxWidth >= 880)
                    SizedBox(
                      width: 170,
                      child: Text(
                        meeting.location.isEmpty ? '—' : meeting.location,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _MeetingInspector extends StatelessWidget {
  const _MeetingInspector({required this.meeting, required this.onOpen});

  final Meeting? meeting;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    final meeting = this.meeting;
    if (meeting == null) {
      return const MacosEmptyState(
        icon: Icons.touch_app_outlined,
        title: 'Select a meeting',
        message:
            'Its briefing, participants, outcomes, and evidence appear here.',
      );
    }
    final local = meeting.startAt.toLocal();
    final end = meeting.endAt.toLocal();
    final localization = MaterialLocalizations.of(context);
    final schedule =
        '${localization.formatMediumDate(local)} · ${localization.formatTimeOfDay(TimeOfDay.fromDateTime(local))}–${localization.formatTimeOfDay(TimeOfDay.fromDateTime(end))}';

    return _ManagedScrollbar(
      builder: (scrollController) => ListView(
        controller: scrollController,
        padding: const EdgeInsets.fromLTRB(18, 20, 18, 24),
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'MEETING BRIEF',
                  style: Theme.of(context).textTheme.labelSmall
                      ?.copyWith(color: Theme.of(context).colorScheme.primary),
                ),
              ),
              _StatusLabel(
                label: _meetingStatusLabel(meeting.status),
                color: _meetingAccent(context, meeting.status),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(meeting.title, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 7),
          Text(schedule, style: Theme.of(context).textTheme.bodySmall),
          if (meeting.location.isNotEmpty) ...[
            const SizedBox(height: 4),
            Row(
              children: [
                const Icon(Icons.location_on_outlined, size: 15),
                const SizedBox(width: 5),
                Expanded(
                  child: Text(
                    meeting.location,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ],
            ),
          ],
          if (meeting.summary.isNotEmpty) ...[
            const SizedBox(height: 18),
            SelectableText(
              meeting.summary,
              style: Theme.of(context).textTheme.bodyMedium
                  ?.copyWith(height: 1.5),
            ),
          ],
          const SizedBox(height: 20),
          _InspectorFacts(meeting: meeting),
          _InspectorSection(
            title: 'People & consent',
            empty: 'No participants recorded.',
            children: [
              for (final participant in meeting.participants)
                _ParticipantLine(participant: participant),
            ],
          ),
          _InspectorSection(
            title: 'Decisions',
            empty: 'No decisions recorded.',
            children: [
              for (final note in meeting.decisions)
                _NoteLine(icon: Icons.check_rounded, note: note),
            ],
          ),
          _InspectorSection(
            title: 'Commitments',
            empty: 'No commitments recorded.',
            children: [
              for (final note in meeting.commitments)
                _NoteLine(icon: Icons.flag_outlined, note: note),
            ],
          ),
          _InspectorSection(
            title: 'Follow-ups',
            empty: 'No follow-ups proposed.',
            children: [
              for (final note in meeting.followUps)
                _NoteLine(icon: Icons.arrow_forward_rounded, note: note),
            ],
          ),
          _InspectorSection(
            title: 'Linked evidence',
            empty: 'No linked evidence.',
            children: [
              for (final evidence in meeting.evidence)
                _EvidenceLine(evidence: evidence),
            ],
          ),
          const SizedBox(height: 18),
          FilledButton.icon(
            key: const Key('macos-meeting-open'),
            onPressed: onOpen,
            icon: const Icon(Icons.open_in_new_rounded),
            label: const Text('Open meeting evidence'),
          ),
        ],
      ),
    );
  }
}

class _InspectorFacts extends StatelessWidget {
  const _InspectorFacts({required this.meeting});

  final Meeting meeting;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: mac.hover,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: mac.divider),
      ),
      child: Row(
        children: [
          Expanded(
            child: _Fact(
              value: '${meeting.participants.length}',
              label: 'people',
            ),
          ),
          Expanded(
            child: _Fact(value: '${meeting.evidence.length}', label: 'sources'),
          ),
          Expanded(
            child: _Fact(value: '${meeting.revision}', label: 'revision'),
          ),
        ],
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Text(value, style: Theme.of(context).textTheme.titleMedium),
      Text(label, style: Theme.of(context).textTheme.labelSmall),
    ],
  );
}

class _InspectorSection extends StatelessWidget {
  const _InspectorSection({
    required this.title,
    required this.empty,
    required this.children,
  });

  final String title;
  final String empty;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 22),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 8),
        if (children.isEmpty)
          Text(empty, style: Theme.of(context).textTheme.bodySmall)
        else
          ...children,
      ],
    ),
  );
}

class _ParticipantLine extends StatelessWidget {
  const _ParticipantLine({required this.participant});

  final MeetingParticipant participant;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        CircleAvatar(
          radius: 13,
          child: Text(
            participant.name.isEmpty ? '?' : participant.name.characters.first,
            style: Theme.of(context).textTheme.labelSmall,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(participant.name),
              Text(
                '${_meetingStatusLabel(participant.response)} · attendance ${_meetingStatusLabel(participant.attendeeConsent)} · recording ${_meetingStatusLabel(participant.recordingConsent)}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

class _NoteLine extends StatelessWidget {
  const _NoteLine({required this.icon, required this.note});

  final IconData icon;
  final MeetingNote note;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 15),
        const SizedBox(width: 7),
        Expanded(
          child: Text(
            note.status == null
                ? note.label
                : '${note.label} · ${_meetingStatusLabel(note.status!)}',
          ),
        ),
      ],
    ),
  );
}

class _EvidenceLine extends StatelessWidget {
  const _EvidenceLine({required this.evidence});

  final MeetingEvidence evidence;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Icon(Icons.link_rounded, size: 15),
        const SizedBox(width: 7),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(evidence.label),
              Text(
                '${_meetingStatusLabel(evidence.role)} · ${_meetingStatusLabel(evidence.kind)}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

class _StatusLabel extends StatelessWidget {
  const _StatusLabel({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.centerLeft,
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .12),
        borderRadius: BorderRadius.circular(5),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color),
      ),
    ),
  );
}

Map<String, int> _meetingCounts(List<Meeting> meetings) => {
  'active': meetings.where((meeting) => meeting.isActive).length,
  'all': meetings.length,
  'completed': meetings
      .where((meeting) => meeting.status == 'completed')
      .length,
  'cancelled': meetings
      .where((meeting) => meeting.status == 'cancelled')
      .length,
};

String _meetingStatusLabel(String value) => value
    .replaceAll('_', ' ')
    .split(' ')
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');

Color _meetingAccent(BuildContext context, String status) {
  final mac = MacosThemeColors.of(context);
  return switch (status) {
    'scheduled' || 'in_progress' => Theme.of(context).colorScheme.primary,
    'completed' => mac.positive,
    'cancelled' => Theme.of(context).colorScheme.error,
    _ => Theme.of(context).colorScheme.onSurfaceVariant,
  };
}

class _ManagedScrollbar extends StatefulWidget {
  const _ManagedScrollbar({required this.builder});

  final Widget Function(ScrollController controller) builder;

  @override
  State<_ManagedScrollbar> createState() => _ManagedScrollbarState();
}

class _ManagedScrollbarState extends State<_ManagedScrollbar> {
  final _controller = ScrollController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      Scrollbar(controller: _controller, child: widget.builder(_controller));
}
