import 'package:flutter/material.dart';

import 'meetings.dart';

class MeetingsView extends StatefulWidget {
  const MeetingsView({
    super.key,
    required this.controller,
    required this.onOpen,
  });
  final MeetingsController controller;
  final ValueChanged<Meeting> onOpen;

  @override
  State<MeetingsView> createState() => _MeetingsViewState();
}

class _MeetingsViewState extends State<MeetingsView> {
  String filter = 'active';

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (_, _) {
      final controller = widget.controller;
      if (controller.loading && controller.meetings.isEmpty) {
        return const _MeetingsSkeleton();
      }
      if (controller.error != null && controller.meetings.isEmpty) {
        return _MeetingsFailure(onRetry: controller.refresh);
      }
      final meetings = controller.meetings
          .where((meeting) {
            if (filter == 'all') return true;
            if (filter == 'active') return meeting.isActive;
            return meeting.status == filter;
          })
          .toList(growable: false);
      return RefreshIndicator(
        onRefresh: controller.refresh,
        child: CustomScrollView(
          slivers: [
            SliverAppBar.large(
              title: const Text('Meetings'),
              actions: [
                IconButton(
                  tooltip: 'Refresh meetings',
                  onPressed: controller.refresh,
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
            if (controller.showingStaleData)
              SliverToBoxAdapter(
                child: _StaleNotice(onRetry: controller.refresh),
              ),
            SliverToBoxAdapter(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: Row(
                  children: [
                    for (final value in const [
                      'active',
                      'all',
                      'completed',
                      'cancelled',
                    ])
                      Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: ChoiceChip(
                          label: Text(_statusLabel(value)),
                          selected: filter == value,
                          onSelected: (_) => setState(() => filter = value),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            if (meetings.isEmpty)
              const SliverFillRemaining(child: _MeetingsEmpty())
            else
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
                sliver: SliverList.separated(
                  itemCount: meetings.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 10),
                  itemBuilder: (_, index) => _MeetingCard(
                    meeting: meetings[index],
                    onTap: () => widget.onOpen(meetings[index]),
                  ),
                ),
              ),
          ],
        ),
      );
    },
  );
}

class _MeetingCard extends StatelessWidget {
  const _MeetingCard({required this.meeting, required this.onTap});
  final Meeting meeting;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final local = meeting.startAt.toLocal();
    final date = MaterialLocalizations.of(context).formatMediumDate(local);
    final time = MaterialLocalizations.of(context)
        .formatTimeOfDay(TimeOfDay.fromDateTime(local));
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.primaryContainer,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Icon(Icons.groups_2_outlined),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      meeting.title,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 5),
                    Text('$date · $time · ${meeting.timezone}'),
                    if (meeting.location.isNotEmpty) ...[
                      const SizedBox(height: 3),
                      Text(
                        meeting.location,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                    const SizedBox(height: 9),
                    Wrap(
                      spacing: 7,
                      runSpacing: 7,
                      children: [
                        _MeetingChip(_statusLabel(meeting.status)),
                        _MeetingChip('${meeting.participants.length} people'),
                        if (meeting.evidence.isNotEmpty)
                          _MeetingChip('${meeting.evidence.length} sources'),
                      ],
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded),
            ],
          ),
        ),
      ),
    );
  }
}

class MeetingDetailView extends StatefulWidget {
  const MeetingDetailView({
    super.key,
    required this.id,
    required this.repository,
  });
  final String id;
  final MeetingsRepository repository;

  @override
  State<MeetingDetailView> createState() => _MeetingDetailViewState();
}

class _MeetingDetailViewState extends State<MeetingDetailView> {
  late Future<Meeting> request;

  @override
  void initState() {
    super.initState();
    request = widget.repository.detail(widget.id);
  }

  void retry() => setState(() => request = widget.repository.detail(widget.id));

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Meeting evidence')),
    body: FutureBuilder<Meeting>(
      future: request,
      builder: (_, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError || snapshot.data == null) {
          return _MeetingsFailure(onRetry: retry);
        }
        return _MeetingDetail(meeting: snapshot.data!);
      },
    ),
  );
}

class _MeetingDetail extends StatelessWidget {
  const _MeetingDetail({required this.meeting});
  final Meeting meeting;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(16, 12, 16, 36),
    children: [
      Text(meeting.title, style: Theme.of(context).textTheme.headlineSmall),
      const SizedBox(height: 8),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          _MeetingChip(_statusLabel(meeting.status)),
          _MeetingChip(meeting.accessClass.replaceAll('_', ' ')),
          _MeetingChip('Revision ${meeting.revision}'),
        ],
      ),
      if (meeting.summary.isNotEmpty) ...[
        const SizedBox(height: 20),
        Text(meeting.summary),
      ],
      _DetailSection(
        title: 'Participants & consent',
        empty: 'No participants recorded.',
        children: meeting.participants
            .map(
              (participant) => ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const CircleAvatar(child: Icon(Icons.person_outline)),
                title: Text(participant.name),
                subtitle: Text(
                  '${participant.role} · ${participant.response}\n'
                  'Attendance: ${participant.attendeeConsent} · Recording: ${participant.recordingConsent}',
                ),
              ),
            )
            .toList(),
      ),
      _DetailSection(
        title: 'Decisions',
        empty: 'No decisions recorded.',
        children: meeting.decisions.map(_noteTile).toList(),
      ),
      _DetailSection(
        title: 'Commitments',
        empty: 'No commitments recorded.',
        children: meeting.commitments.map(_noteTile).toList(),
      ),
      _DetailSection(
        title: 'Follow-ups',
        empty: 'No follow-ups proposed.',
        children: meeting.followUps.map(_noteTile).toList(),
      ),
      _DetailSection(
        title: 'Linked evidence',
        empty: 'No linked evidence.',
        children: meeting.evidence
            .map(
              (item) => ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.link_rounded),
                title: Text(item.label),
                subtitle: Text('${item.role} · ${item.kind}'),
              ),
            )
            .toList(),
      ),
    ],
  );

  static Widget _noteTile(MeetingNote note) => ListTile(
    contentPadding: EdgeInsets.zero,
    leading: const Icon(Icons.check_circle_outline_rounded),
    title: Text(note.label),
    subtitle: note.status == null ? null : Text(_statusLabel(note.status!)),
  );
}

class _DetailSection extends StatelessWidget {
  const _DetailSection({
    required this.title,
    required this.empty,
    required this.children,
  });
  final String title, empty;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 6),
        if (children.isEmpty) Text(empty) else ...children,
      ],
    ),
  );
}

class _MeetingChip extends StatelessWidget {
  const _MeetingChip(this.label);
  final String label;
  @override
  Widget build(BuildContext context) => Chip(
    label: Text(label),
    visualDensity: VisualDensity.compact,
    side: BorderSide.none,
  );
}

class _StaleNotice extends StatelessWidget {
  const _StaleNotice({required this.onRetry});
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.errorContainer,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Row(
      children: [
        const Icon(Icons.cloud_off_outlined),
        const SizedBox(width: 10),
        const Expanded(
          child: Text('Offline · showing last available meetings'),
        ),
        TextButton(onPressed: onRetry, child: const Text('Retry')),
      ],
    ),
  );
}

class _MeetingsFailure extends StatelessWidget {
  const _MeetingsFailure({required this.onRetry});
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Center(
    child: FilledButton.tonalIcon(
      onPressed: onRetry,
      icon: const Icon(Icons.refresh_rounded),
      label: const Text('Reconnect meetings'),
    ),
  );
}

class _MeetingsEmpty extends StatelessWidget {
  const _MeetingsEmpty();
  @override
  Widget build(BuildContext context) => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          Icons.event_available_outlined,
          size: 48,
          color: Theme.of(context).colorScheme.primary,
        ),
        const SizedBox(height: 12),
        Text('No meetings here', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 6),
        const Text('Try another status or refresh the schedule.'),
      ],
    ),
  );
}

class _MeetingsSkeleton extends StatelessWidget {
  const _MeetingsSkeleton();
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(16, 84, 16, 16),
    children: List.generate(
      4,
      (_) => Container(
        height: 138,
        margin: const EdgeInsets.only(bottom: 10),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(14),
        ),
      ),
    ),
  );
}

String _statusLabel(String value) => value
    .split('_')
    .map(
      (part) =>
          part.isEmpty ? part : '${part[0].toUpperCase()}${part.substring(1)}',
    )
    .join(' ');
