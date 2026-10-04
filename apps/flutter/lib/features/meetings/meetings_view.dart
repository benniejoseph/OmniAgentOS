import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'meetings.dart';
import 'meetings_action_controller.dart';
import 'meetings_action_widgets.dart';
import 'meetings_calendar_controller.dart';
import 'meetings_calendar_view.dart';
import 'meetings_commitments.dart';
import 'meetings_detail_body.dart';
import 'meetings_mutations.dart';
import 'meetings_snapshots.dart';
import 'meetings_widgets.dart';

class MeetingsView extends StatefulWidget {
  const MeetingsView({
    super.key,
    required this.controller,
    required this.onOpen,
    this.actions,
    this.calendar,
    this.desktop = false,
    this.active = true,
  });
  final MeetingsController controller;
  final ValueChanged<Meeting> onOpen;
  final MeetingActionController? actions;
  final MeetingCalendarController? calendar;
  final bool desktop, active;
  @override
  State<MeetingsView> createState() => _MeetingsViewState();
}

class _MeetingsViewState extends State<MeetingsView>
    with WidgetsBindingObserver {
  String filter = 'active', search = '';
  String? selectedId;
  final searchController = TextEditingController();
  bool preparing = false;
  Future<bool> _refresh() async {
    await widget.controller.refresh();
    return widget.controller.readable &&
        widget.controller.hasLoaded &&
        widget.controller.error == null;
  }

  Future<void> _createMeeting() async {
    final actions = widget.actions;
    if (preparing ||
        actions == null ||
        actions.disabledReason('create') != null) {
      return;
    }
    preparing = true;
    setState(() {});
    try {
      if (!await _refresh() ||
          !mounted ||
          !identical(actions, widget.actions)) {
        return;
      }
      final authority = widget.controller.context;
      if (authority == null || !authority.canWrite) {
        return;
      }
      await showMeetingEditor(
        context,
        actions: actions,
        workspaceId: authority.workspaceId,
        stillCurrent: () =>
            mounted &&
            identical(actions, widget.actions) &&
            actions.available &&
            widget.controller.error == null &&
            widget.controller.context?.authoritySha256 ==
                authority.authoritySha256,
        refresh: _refresh,
      );
    } finally {
      if (mounted) {
        setState(() => preparing = false);
      }
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(_changed);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        widget.controller.setActive(widget.active);
        if (widget.active &&
            !widget.controller.hasLoaded &&
            !widget.controller.loading) {
          widget.controller.refresh();
        }
      }
    });
  }

  void _changed() {
    if (!widget.controller.readable) {
      searchController.clear();
      search = '';
      selectedId = null;
    }
  }

  @override
  void didUpdateWidget(covariant MeetingsView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_changed);
      oldWidget.controller.setActive(false);
      widget.controller.addListener(_changed);
      searchController.clear();
      search = '';
      selectedId = null;
    }
    if (oldWidget.controller != widget.controller ||
        oldWidget.active != widget.active) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) {
          widget.controller.setActive(widget.active);
        }
      });
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    widget.controller.setActive(
      widget.active && state == AppLifecycleState.resumed,
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_changed);
    widget.controller.setActive(false);
    searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CallbackShortcuts(
    bindings: {
      const SingleActivator(LogicalKeyboardKey.keyR, meta: true): () =>
          widget.controller.refresh(),
    },
    child: ListenableBuilder(
      listenable: Listenable.merge([
        widget.controller,
        if (widget.actions != null) widget.actions!,
      ]),
      builder: (context, _) {
        final controller = widget.controller;
        final rows = controller.meetings
            .where(
              (meeting) =>
                  (filter == 'all' ||
                      filter == 'active' && meeting.isActive ||
                      meeting.status == filter) &&
                  '${meeting.title} ${meeting.summary} ${meeting.location}'
                      .toLowerCase()
                      .contains(search.toLowerCase()),
            )
            .toList(growable: false);
        final selected = controller.meetings
            .where((meeting) => meeting.id == selectedId)
            .firstOrNull;
        return Scaffold(
          appBar: AppBar(
            title: const Text('Meetings'),
            actions: [
              IconButton(
                tooltip: 'Refresh meetings',
                onPressed: controller.loading || !controller.readable
                    ? null
                    : controller.refresh,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          body: SafeArea(
            top: false,
            child: LayoutBuilder(
              builder: (context, constraints) {
                final wide =
                    widget.desktop &&
                    constraints.maxWidth >= 1000 &&
                    MediaQuery.textScalerOf(context).scale(14) <= 21;
                Widget agenda() => ListView(
                  padding: const EdgeInsets.all(20),
                  children: [
                    if (widget.calendar != null)
                      MeetingCalendarPanel(
                        controller: widget.calendar!,
                        active: widget.active,
                      ),
                    const Text(
                      'Prepare from saved sources, review consent, and inspect exact follow-up evidence.',
                    ),
                    if (widget.actions != null) ...[
                      MeetingActionFeedback(
                        actions: widget.actions!,
                        refresh: _refresh,
                        onOpen: widget.onOpen,
                      ),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: OutlinedButton(
                          onPressed:
                              !preparing &&
                                  widget.actions!.disabledReason('create') ==
                                      null &&
                                  controller.context?.canWrite == true &&
                                  controller.error == null
                              ? _createMeeting
                              : null,
                          child: Text(
                            preparing
                                ? 'Refreshing create authority…'
                                : 'Create meeting',
                          ),
                        ),
                      ),
                      if (widget.actions!.disabledReason('create') != null)
                        MeetingNotice(
                          widget.actions!.disabledReason('create')!,
                        ),
                    ],
                    if (!controller.readable)
                      const MeetingNotice(
                        'Meeting access is unavailable. Unlock or restore the current workspace session to continue.',
                      )
                    else ...[
                      if (controller.loading)
                        const MeetingNotice('Loading meetings…'),
                      if (controller.error != null)
                        MeetingNotice(
                          controller.hasLoaded || controller.meetings.isNotEmpty
                              ? 'Showing the last available agenda. The latest refresh did not complete.'
                              : 'Meetings are unavailable. No meeting count has been confirmed.',
                          action: 'Retry meetings',
                          onAction: controller.loading
                              ? null
                              : controller.refresh,
                          error: true,
                        ),
                      if (controller.hasLoaded ||
                          controller.meetings.isNotEmpty)
                        Text(
                          '${controller.showingStaleData ? 'Last loaded' : 'Loaded'} ${controller.meetings.length}${controller.atBound ? '+' : ''} meetings · up to 100 accessible records. No complete workspace total is supplied.',
                        ),
                      const SizedBox(height: 16),
                      TextField(
                        controller: searchController,
                        decoration: const InputDecoration(
                          labelText: 'Search loaded meetings',
                          prefixIcon: Icon(Icons.search),
                        ),
                        onChanged: (value) => setState(() => search = value),
                      ),
                      const SizedBox(height: 12),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          for (final value in const [
                            'active',
                            'all',
                            'completed',
                            'cancelled',
                          ])
                            FilterChip(
                              label: Text(meetingLabel(value)),
                              selected: filter == value,
                              onSelected: (_) => setState(() => filter = value),
                            ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      if (controller.hasLoaded && rows.isEmpty)
                        Text(
                          controller.meetings.isEmpty
                              ? 'No meetings were returned in this accessible list.'
                              : 'No loaded meetings match these filters.',
                        ),
                      for (final meeting in rows)
                        Material(
                          color: Colors.transparent,
                          child: Column(
                            children: [
                              ListTile(
                                key: Key('macos-meeting-${meeting.id}'),
                                contentPadding: const EdgeInsets.symmetric(
                                  vertical: 10,
                                ),
                                selected: selectedId == meeting.id,
                                title: Text(
                                  meeting.title,
                                  style: Theme.of(context)
                                      .textTheme
                                      .titleMedium,
                                ),
                                subtitle: Padding(
                                  padding: const EdgeInsets.only(top: 8),
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        '${meetingLabel(meeting.status)} · revision ${meeting.revision}',
                                      ),
                                      Text(
                                        '${meetingTimestamp(meeting.startAt)} · ${meeting.timezone}',
                                      ),
                                      if (meeting.location.isNotEmpty)
                                        Text(meeting.location),
                                      Text(
                                        '${meeting.participants.length} participants · ${meeting.evidence.length} saved sources',
                                      ),
                                    ],
                                  ),
                                ),
                                trailing: const Icon(Icons.chevron_right),
                                onTap: () {
                                  if (wide) {
                                    setState(() => selectedId = meeting.id);
                                  } else {
                                    widget.onOpen(meeting);
                                  }
                                },
                              ),
                              const Divider(height: 1),
                            ],
                          ),
                        ),
                    ],
                  ],
                );
                if (!wide) {
                  return agenda();
                }
                return Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(flex: 3, child: agenda()),
                    const VerticalDivider(width: 1),
                    Expanded(
                      flex: 2,
                      child: ListView(
                        padding: const EdgeInsets.all(24),
                        children: [
                          Semantics(
                            header: true,
                            child: Text(
                              'Meeting brief',
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                          ),
                          const SizedBox(height: 16),
                          if (selected == null)
                            const Text(
                              'Select a meeting to inspect its saved brief.',
                            )
                          else ...[
                            SelectableText(
                              selected.title,
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                            const SizedBox(height: 12),
                            SelectableText(
                              selected.summary.isEmpty
                                  ? 'No summary is recorded.'
                                  : selected.summary,
                              style: Theme.of(context).textTheme.bodyLarge,
                            ),
                            const SizedBox(height: 16),
                            FilledButton(
                              key: const Key('macos-meeting-open'),
                              onPressed: () => widget.onOpen(selected),
                              child: const Text('Open meeting'),
                            ),
                            MeetingValue('Meeting', selected.id),
                            MeetingValue('Workspace', selected.workspaceId),
                            MeetingValue(
                              'Revision',
                              selected.revisionId ??
                                  'Revision ${selected.revision}',
                            ),
                            for (final source in selected.evidence)
                              MeetingValue('Saved source', source.label),
                          ],
                        ],
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        );
      },
    ),
  );
}

class MeetingDetailView extends StatefulWidget {
  const MeetingDetailView({
    super.key,
    required this.id,
    required this.repository,
    this.workspaceId,
    this.actions,
    this.desktop = false,
    this.active = true,
  });
  final String id;
  final String? workspaceId;
  final MeetingsRepository repository;
  final MeetingActionController? actions;
  final bool desktop, active;
  @override
  State<MeetingDetailView> createState() => _MeetingDetailViewState();
}

class _MeetingDetailViewState extends State<MeetingDetailView>
    with WidgetsBindingObserver {
  late MeetingDetailController controller;
  bool preparing = false;
  String? preparationError;
  Future<bool> _refresh() async {
    await controller.refresh();
    return controller.readable &&
        controller.detail != null &&
        controller.detailError == null &&
        (!controller.commitmentsAvailable || controller.currentCommitments);
  }

  Future<void> _edit() async {
    final actions = widget.actions;
    if (preparing ||
        actions == null ||
        actions.disabledReason('update') != null) {
      return;
    }
    setState(() {
      preparing = true;
      preparationError = null;
    });
    try {
      await controller.refreshDetail();
      if (!mounted ||
          !identical(actions, widget.actions) ||
          !controller.readable ||
          controller.detailError != null) {
        return;
      }
      final snapshot = controller.detail;
      if (snapshot == null ||
          snapshot.context?.canWrite != true ||
          snapshot.meeting.ownerActorId != 'actor:${actions.owner?.userId}') {
        return;
      }
      await showMeetingEditor(
        context,
        actions: actions,
        workspaceId: snapshot.meeting.workspaceId!,
        base: snapshot.meeting,
        stillCurrent: () =>
            mounted &&
            identical(actions, widget.actions) &&
            controller.readable &&
            controller.detailError == null &&
            controller.detail?.meeting.versionKey ==
                snapshot.meeting.versionKey &&
            controller.detail?.context?.authoritySha256 ==
                snapshot.context?.authoritySha256,
        refresh: _refresh,
      );
    } finally {
      if (mounted) {
        setState(() => preparing = false);
      }
    }
  }

  Future<void> _review(MeetingCommitmentReview proposal) async {
    final actions = widget.actions;
    if (preparing ||
        actions == null ||
        actions.disabledReason('resolve') != null) {
      return;
    }
    setState(() {
      preparing = true;
      preparationError = null;
    });
    try {
      if (!await _refresh() ||
          !mounted ||
          !identical(actions, widget.actions)) {
        return;
      }
      final snapshot = controller.commitments!,
          meeting = controller.detail!.meeting;
      final current = snapshot.rows
          .where(
            (row) =>
                row.id == proposal.id &&
                row.sha256 == proposal.sha256 &&
                row.reviewable,
          )
          .firstOrNull;
      if (current == null ||
          current.meetingRevisionId != meeting.revisionId ||
          !snapshot.context.canWrite) {
        setState(
          () => preparationError = 'This proposal changed or is no longer reviewable. Inspect the refreshed evidence.',
        );
        return;
      }
      await showMeetingFollowUpReview(
        context,
        actions: actions,
        meeting: meeting,
        snapshot: snapshot,
        proposal: current,
        stillCurrent: () =>
            mounted &&
            identical(actions, widget.actions) &&
            controller.currentCommitments &&
            controller.detail?.meeting.versionKey == meeting.versionKey &&
            controller.commitments!.rows.any(
              (row) =>
                  row.id == current.id &&
                  row.sha256 == current.sha256 &&
                  row.reviewable,
            ),
        refresh: _refresh,
      );
    } finally {
      if (mounted) {
        setState(() => preparing = false);
      }
    }
  }

  Future<void> _propose(
    MeetingSource source,
    MeetingMediaOutput output,
    Json action,
  ) async {
    final actions = widget.actions;
    if (preparing ||
        actions == null ||
        actions.disabledReason('propose') != null) {
      return;
    }
    setState(() {
      preparing = true;
      preparationError = null;
    });
    try {
      await controller.refreshDetail();
      if (!mounted ||
          !identical(actions, widget.actions) ||
          controller.detailError != null ||
          !controller.readable) {
        return;
      }
      final snapshot = controller.detail!;
      final current = snapshot.sources
          .where(
            (row) =>
                row.id == source.id &&
                row.revisionState == 'exact' &&
                row.media?.status == 'ready' &&
                row.media?.output?.revisionId == output.revisionId &&
                row.media?.output?.sha256 == output.sha256,
          )
          .firstOrNull;
      final currentAction = current?.media?.output?.actions
          .where(
            (row) =>
                row['actionItemId'] == action['actionItemId'] &&
                meetingCanonicalJson(row) == meetingCanonicalJson(action),
          )
          .firstOrNull;
      if (current == null ||
          currentAction == null ||
          snapshot.context?.canWrite != true ||
          snapshot.meeting.projectId == null) {
        setState(
          () => preparationError = 'The exact media evidence or Work project is no longer available.',
        );
        return;
      }
      final frozen = MeetingSubmission.freeze(
        action: 'propose',
        owner: actions.owner!,
        id: snapshot.meeting.id,
        body: {
          'workspaceId': snapshot.meeting.workspaceId,
          'mediaRevisionId': output.revisionId,
          'actionItemId': action['actionItemId'],
        },
        evidence: {
          'sourceLinkId': source.id,
          'recordingId': source.sourceId,
          'mediaOutputSha256': output.sha256,
          'actionItemSha256': await meetingSha(action),
        },
      );
      if (!mounted ||
          !identical(actions, widget.actions) ||
          !controller.readable) {
        return;
      }
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => ListenableBuilder(
          listenable: actions,
          builder: (context, _) =>
              !actions.available || actions.owner?.key != frozen.ownerKey
              ? AlertDialog(
                  title: const Text('Review unavailable'),
                  content: const Text(
                    'Private evidence is hidden because Meeting access changed.',
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: const Text('Close'),
                    ),
                  ],
                )
              : AlertDialog(
                  title: const Text('Create exact follow-up proposal'),
                  content: SingleChildScrollView(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SelectableText(action['text'] as String),
                        const SizedBox(height: 12),
                        MeetingValue('Media revision', output.revisionId),
                        MeetingValue('Media output SHA-256', output.sha256),
                        MeetingValue(
                          'Action item',
                          action['actionItemId'] as String,
                        ),
                        const Text(
                          'This records a proposal for later review. It does not create a Work item or send a message.',
                        ),
                      ],
                    ),
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: const Text('Cancel'),
                    ),
                    FilledButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: const Text('Create reviewed proposal'),
                    ),
                  ],
                ),
        ),
      );
      if (confirmed == true &&
          mounted &&
          identical(actions, widget.actions) &&
          controller.readable &&
          controller.detail?.meeting.versionKey ==
              snapshot.meeting.versionKey) {
        await actions.submit(frozen, refresh: _refresh);
      }
    } finally {
      if (mounted) {
        setState(() => preparing = false);
      }
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _create();
  }

  void _create() {
    controller = MeetingDetailController(
      widget.repository,
      id: widget.id,
      workspaceId: widget.workspaceId,
      active: false,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        controller.setActive(widget.active);
      }
    });
  }

  @override
  void didUpdateWidget(covariant MeetingDetailView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.repository != widget.repository) {
      controller.dispose();
      _create();
    } else if (oldWidget.id != widget.id ||
        oldWidget.workspaceId != widget.workspaceId) {
      controller.select(widget.id, workspaceId: widget.workspaceId);
    }
    if (oldWidget.active != widget.active) {
      controller.setActive(widget.active);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    controller.setActive(widget.active && state == AppLifecycleState.resumed);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CallbackShortcuts(
    bindings: {
      const SingleActivator(LogicalKeyboardKey.keyR, meta: true):
          controller.refresh,
    },
    child: ListenableBuilder(
      listenable: Listenable.merge([
        controller,
        if (widget.actions != null) widget.actions!,
      ]),
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          title: const Text('Meeting evidence'),
          actions: [
            IconButton(
              tooltip: 'Refresh meeting and proposals',
              onPressed:
                  controller.detailLoading ||
                      controller.commitmentsLoading ||
                      !controller.readable
                  ? null
                  : controller.refresh,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: SafeArea(
          top: false,
          child: Align(
            alignment: Alignment.topCenter,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1100),
              child: ListView(
                padding: EdgeInsets.all(widget.desktop ? 28 : 20),
                children: [
                  if (widget.actions != null)
                    MeetingActionFeedback(
                      actions: widget.actions!,
                      refresh: _refresh,
                    ),
                  if (preparing)
                    const MeetingNotice('Refreshing exact review evidence…'),
                  if (preparationError != null)
                    MeetingNotice(preparationError!, error: true),
                  MeetingDetailBody(
                    key: ValueKey(
                      '${widget.id}:${widget.workspaceId}:${identityHashCode(widget.repository)}',
                    ),
                    controller: controller,
                    onReview: widget.actions == null ? null : _review,
                    onPropose: widget.actions == null ? null : _propose,
                    reviewDisabledReason: preparing
                        ? 'Another review is opening.'
                        : widget.actions?.disabledReason('resolve'),
                    proposeDisabledReason: preparing
                        ? 'Another review is opening.'
                        : widget.actions?.disabledReason('propose'),
                    actions: widget.actions == null
                        ? null
                        : Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              OutlinedButton(
                                onPressed:
                                    !preparing &&
                                        widget.actions!.disabledReason(
                                              'update',
                                            ) ==
                                            null &&
                                        controller.detail?.context?.canWrite ==
                                            true &&
                                        controller
                                                .detail
                                                ?.meeting
                                                .ownerActorId ==
                                            'actor:${widget.actions!.owner?.userId}'
                                    ? _edit
                                    : null,
                                child: const Text('Edit saved meeting'),
                              ),
                              if (widget.actions!.disabledReason('update') !=
                                  null)
                                MeetingNotice(
                                  widget.actions!.disabledReason('update')!,
                                ),
                              if (controller.detail?.context?.canWrite != true)
                                const Text(
                                  'Current workspace contributor access is required for changes.',
                                ),
                              if (controller.detail?.meeting.ownerActorId !=
                                  'actor:${widget.actions!.owner?.userId}')
                                const Text(
                                  'Only the canonical Meeting owner can edit this saved record.',
                                ),
                            ],
                          ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
