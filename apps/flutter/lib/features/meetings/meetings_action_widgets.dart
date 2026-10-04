import 'package:flutter/material.dart';

import 'meetings.dart';
import 'meetings_action_controller.dart';
import 'meetings_commitments.dart';
import 'meetings_form_model.dart';
import 'meetings_mutations.dart';
import 'meetings_project_selector.dart';
import 'meetings_relationship_fields.dart';
import 'meetings_validation.dart';
import 'meetings_widgets.dart';

class MeetingActionFeedback extends StatelessWidget {
  const MeetingActionFeedback({
    super.key,
    required this.actions,
    required this.refresh,
    this.onOpen,
  });
  final MeetingActionController actions;
  final Future<bool> Function() refresh;
  final ValueChanged<Meeting>? onOpen;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: actions,
    builder: (context, _) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (actions.busy)
          const MeetingNotice(
            'Submitting the frozen Meeting request. Leaving this screen does not cancel work already admitted by the server.',
          ),
        if (actions.error != null) MeetingNotice(actions.error!, error: true),
        if (actions.storageError != null)
          MeetingNotice(actions.storageError!, error: true),
        if (actions.recoveryBlocked || actions.recovering) ...[
          const Text(
            'Reload replaces the visible local draft with the latest protected draft and request. It does not send a request or retry server work.',
          ),
          OutlinedButton(
            onPressed: actions.canReloadRecovery
                ? actions.reloadRecovery
                : null,
            child: Text(
              actions.recovering
                  ? 'Reading protected draft…'
                  : 'Reload protected draft',
            ),
          ),
        ],
        if (actions.refreshing)
          const MeetingNotice(
            'The action was accepted. Refreshing current workspace reads…',
          ),
        if (actions.refreshError != null)
          MeetingNotice(actions.refreshError!, error: true),
        if (actions.recorded != null)
          MeetingDisclosure(
            'Recorded Meeting receipt',
            expanded: true,
            children: [
              const Text(
                'This receipt records the accepted action. It does not prove current task completion, message delivery, or a successful later refresh.',
              ),
              MeetingValue('Action', actions.recorded!['action'] as String),
              MeetingValue('Target', actions.recorded!['targetId'] as String),
              MeetingValue(
                'Receipt SHA-256',
                actions.recorded!['receiptSha256'] as String,
              ),
              for (final field in const [
                'meetingRevisionId',
                'proposalId',
                'resolutionSha256',
                'workItemId',
                'draftId',
                'draftState',
              ])
                if (actions.recorded![field] != null)
                  MeetingValue(
                    meetingLabel(
                      field.replaceAllMapped(
                        RegExp(r'[A-Z]'),
                        (match) => '_${match[0]!.toLowerCase()}',
                      ),
                    ),
                    actions.recorded![field].toString(),
                  ),
              if (actions.accepted?.meeting != null &&
                  onOpen != null &&
                  actions.recorded!['receiptSha256'] ==
                      actions.accepted!.receiptSha256)
                OutlinedButton(
                  onPressed: () => onOpen!(actions.accepted!.meeting!),
                  child: const Text('Open accepted meeting'),
                ),
            ],
          ),
        if (actions.accepted != null &&
            actions.recorded?['receiptSha256'] !=
                actions.accepted!.receiptSha256)
          MeetingDisclosure(
            'Receipt confirmed in this window',
            expanded: true,
            children: [
              const Text(
                'This accepted receipt remains available independently of the latest protected draft and current workspace reads.',
              ),
              MeetingValue('Action', actions.accepted!.submitted.action),
              MeetingValue('Target', actions.accepted!.targetId),
              MeetingValue('Receipt SHA-256', actions.accepted!.receiptSha256),
              if (actions.accepted!.meeting != null && onOpen != null)
                OutlinedButton(
                  onPressed: () => onOpen!(actions.accepted!.meeting!),
                  child: const Text('Open accepted meeting'),
                ),
            ],
          ),
        if (actions.uncertain && actions.submitted != null)
          MeetingDisclosure(
            'Exact unconfirmed request',
            expanded: true,
            children: [
              MeetingValue('Action', actions.submitted!.action),
              MeetingValue(
                'Meeting',
                actions.submitted!.id ?? 'Create a new meeting',
              ),
              MeetingValue('Idempotency key', actions.submitted!.key),
              SelectableText(
                meetingCanonicalJson(actions.submitted!.body),
                style: Theme.of(context).textTheme.bodySmall,
              ),
              if (actions.submitted!.replaySupported)
                OutlinedButton(
                  onPressed:
                      actions.busy ||
                          !actions.available ||
                          actions.recoveryBlocked ||
                          actions.recovering ||
                          !actions.initialized
                      ? null
                      : () => actions.retry(refresh: refresh),
                  child: const Text('Retry the exact saved request'),
                )
              else
                const Text(
                  'This action has no automatic recovery replay. Refresh current proposals and inspect any recorded resolution or reconciliation state before further review.',
                ),
            ],
          ),
      ],
    ),
  );
}

Future<void> showMeetingEditor(
  BuildContext context, {
  required MeetingActionController actions,
  required String workspaceId,
  Meeting? base,
  required bool Function() stillCurrent,
  required Future<bool> Function() refresh,
}) async {
  await showDialog<void>(
    context: context,
    builder: (_) => Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 720),
        child: MeetingEditor(
          actions: actions,
          workspaceId: workspaceId,
          base: base,
          stillCurrent: stillCurrent,
          refresh: refresh,
        ),
      ),
    ),
  );
  await actions.flushDraft();
}

class MeetingEditor extends StatefulWidget {
  const MeetingEditor({
    super.key,
    required this.actions,
    required this.workspaceId,
    this.base,
    required this.stillCurrent,
    required this.refresh,
    this.projectLoader,
  });
  final MeetingActionController actions;
  final String workspaceId;
  final Meeting? base;
  final bool Function() stillCurrent;
  final Future<bool> Function() refresh;
  final MeetingProjectLoader? projectLoader;
  @override
  State<MeetingEditor> createState() => _MeetingEditorState();
}

class _MeetingEditorState extends State<MeetingEditor> {
  final form = GlobalKey<FormState>();
  late Json definition;
  late final Json initialDefinition;
  late final TextEditingController title,
      summary,
      start,
      end,
      actualStart,
      actualEnd,
      timezone,
      location;
  int fieldsRevision = 0;
  bool staleDraft = false, reviewed = false, scopeInvalidated = false;
  late final String? ownerKey;
  String? issue;
  String get action => widget.base == null ? 'create' : 'update';
  bool get canEdit =>
      !scopeInvalidated &&
      !widget.actions.blocked &&
      !staleDraft &&
      widget.stillCurrent();
  @override
  void initState() {
    super.initState();
    ownerKey = widget.actions.owner?.key;
    widget.actions.addListener(_accessChanged);
    final base = widget.base, local = widget.actions.draft;
    final now = DateTime.fromMillisecondsSinceEpoch(
      DateTime.now().millisecondsSinceEpoch,
      isUtc: true,
    );
    definition = base == null
        ? {
            'title': '',
            'summary': '',
            'status': 'scheduled',
            'scheduledStartAt': now
                .add(const Duration(hours: 1))
                .toIso8601String(),
            'scheduledEndAt': now
                .add(const Duration(hours: 2))
                .toIso8601String(),
            'actualStartAt': null,
            'actualEndAt': null,
            'timezone': 'UTC',
            'location': '',
            'projectId': null,
            'declaredAccessClass': 'owner_private',
            'participants': <Object?>[],
            'sourceLinks': <Object?>[],
            'entityLinks': <Object?>[],
            'decisions': <Object?>[],
            'commitments': <Object?>[],
            'followUps': <Object?>[],
          }
        : meetingEditableDefinition(base);
    initialDefinition = freezeMeeting(definition) as Json;
    if (local['kind'] == 'record' &&
        local['body'] is Map &&
        local['savedReceipt'] == null) {
      staleDraft =
          local['baseVersion'] != base?.versionKey ||
          local['workspaceId'] != widget.workspaceId;
      definition = meetingMap(local['body']);
    }
    title = TextEditingController(text: definition['title'] as String? ?? '');
    summary = TextEditingController(
      text: definition['summary'] as String? ?? '',
    );
    start = TextEditingController(
      text: definition['scheduledStartAt'] as String? ?? '',
    );
    end = TextEditingController(
      text: definition['scheduledEndAt'] as String? ?? '',
    );
    actualStart = TextEditingController(
      text: definition['actualStartAt'] as String? ?? '',
    );
    actualEnd = TextEditingController(
      text: definition['actualEndAt'] as String? ?? '',
    );
    timezone = TextEditingController(
      text: definition['timezone'] as String? ?? 'UTC',
    );
    location = TextEditingController(
      text: definition['location'] as String? ?? '',
    );
  }

  Json _body() => {
    ...definition,
    'title': title.text.trim(),
    'summary': summary.text.trim(),
    'scheduledStartAt': start.text.trim(),
    'scheduledEndAt': end.text.trim(),
    'actualStartAt': actualStart.text.trim().isEmpty
        ? null
        : actualStart.text.trim(),
    'actualEndAt': actualEnd.text.trim().isEmpty ? null : actualEnd.text.trim(),
    'timezone': timezone.text.trim(),
    'location': location.text.trim(),
  };
  void _accessChanged() {
    if (!widget.actions.available || widget.actions.owner?.key != ownerKey) {
      _invalidateDraft();
    }
  }

  void _invalidateDraft() {
    scopeInvalidated = true;
    for (final control in [
      title,
      summary,
      start,
      end,
      actualStart,
      actualEnd,
      timezone,
      location,
    ]) {
      control.clear();
    }
    definition = {};
    reviewed = false;
  }

  @override
  void didUpdateWidget(covariant MeetingEditor oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.actions, widget.actions)) {
      oldWidget.actions.removeListener(_accessChanged);
      widget.actions.addListener(_accessChanged);
      _invalidateDraft();
    } else if (oldWidget.workspaceId != widget.workspaceId ||
        oldWidget.base?.versionKey != widget.base?.versionKey) {
      _invalidateDraft();
    }
  }

  void _patch(Json change) {
    if (!canEdit) {
      return;
    }
    setState(() => definition = {...definition, ...change});
    _save();
  }

  void _save() {
    reviewed = false;
    if (!staleDraft) {
      widget.actions.updateDraft({
        'kind': 'record',
        'workspaceId': widget.workspaceId,
        'baseVersion': widget.base?.versionKey,
        'body': _body(),
      });
    }
  }

  void _useSavedRevision() {
    if (!widget.stillCurrent() || widget.actions.blocked) {
      return;
    }
    final saved = widget.base == null
        ? initialDefinition
        : meetingEditableDefinition(widget.base!);
    setState(() {
      definition = saved;
      staleDraft = false;
      reviewed = false;
      fieldsRevision++;
      title.text = saved['title'] as String;
      summary.text = saved['summary'] as String;
      start.text = saved['scheduledStartAt'] as String;
      end.text = saved['scheduledEndAt'] as String;
      actualStart.text = saved['actualStartAt'] as String? ?? '';
      actualEnd.text = saved['actualEndAt'] as String? ?? '';
      timezone.text = saved['timezone'] as String;
      location.text = saved['location'] as String;
    });
    _save();
  }

  @override
  void dispose() {
    widget.actions.removeListener(_accessChanged);
    for (final control in [
      title,
      summary,
      start,
      end,
      actualStart,
      actualEnd,
      timezone,
      location,
    ]) {
      control.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    if (!form.currentState!.validate() ||
        staleDraft ||
        !reviewed ||
        !widget.stillCurrent()) {
      setState(
        () => issue = 'Refresh and review the exact current Meeting revision before submitting.',
      );
      return;
    }
    try {
      final body = normalizeMeetingEditorDefinition(_body());
      meetingRequire(
        meetingDate(body['scheduledEndAt'])
            .isAfter(meetingDate(body['scheduledStartAt'])),
      );
      final frozen = MeetingSubmission.freeze(
        action: action,
        id: widget.base?.id,
        owner: widget.actions.owner!,
        body: {
          'workspaceId': widget.workspaceId,
          ...body,
          if (widget.base != null) 'expectedRevision': widget.base!.revision,
        },
        evidence: {
          if (widget.base != null) 'baseVersion': widget.base!.versionKey,
        },
      );
      final accepted = await widget.actions.submit(
        frozen,
        refresh: widget.refresh,
      );
      if (mounted && accepted) {
        Navigator.of(context).pop();
      }
    } catch (error) {
      if (mounted) {
        setState(
          () => issue = error is FormatException ? error.message : 'The draft is incomplete. Check participant consent, linked references and canonical UTC dates.',
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.actions,
    builder: (context, _) =>
        scopeInvalidated ||
            !widget.actions.available ||
            widget.actions.owner?.key != ownerKey
        ? const Padding(
            padding: EdgeInsets.all(24),
            child: Text(
              'This private draft is hidden because Meeting access changed. Close and reopen it from the current workspace.',
            ),
          )
        : Form(
            key: form,
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Semantics(
                    header: true,
                    child: Text(
                      widget.base == null
                          ? 'Create meeting'
                          : 'Review meeting changes',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  MeetingValue('Workspace', widget.workspaceId),
                  if (widget.base != null)
                    MeetingValue(
                      'Exact edit base',
                      '${widget.base!.revisionId}\n${widget.base!.sha256}',
                    ),
                  const Text(
                    'This local draft is stored encrypted on this device. A saved meeting is not a calendar invitation, recording consent, or a sent message.',
                  ),
                  if (staleDraft) ...[
                    const MeetingNotice(
                      'This recovered draft belongs to an older revision or workspace. Its text remains available, but submitting is blocked until you explicitly replace it.',
                      error: true,
                    ),
                    OutlinedButton(
                      onPressed:
                          widget.actions.blocked || !widget.stillCurrent()
                          ? null
                          : _useSavedRevision,
                      child: Text(
                        widget.base == null
                            ? 'Discard local draft and start new meeting'
                            : 'Discard local draft and use saved revision',
                      ),
                    ),
                  ],
                  _field(title, 'Meeting title', max: 240),
                  _field(
                    summary,
                    'Summary',
                    max: 8000,
                    lines: 4,
                    required: false,
                  ),
                  _field(start, 'Scheduled start · UTC ISO', max: 30),
                  _field(end, 'Scheduled end · UTC ISO', max: 30),
                  _field(
                    actualStart,
                    'Actual start · optional UTC ISO',
                    max: 30,
                    required: false,
                  ),
                  _field(
                    actualEnd,
                    'Actual end · optional UTC ISO',
                    max: 30,
                    required: false,
                  ),
                  _field(timezone, 'Meeting time zone', max: 100),
                  _field(location, 'Location', max: 500, required: false),
                  DropdownButtonFormField<String>(
                    key: ValueKey('meeting-status:${definition['status']}'),
                    initialValue: definition['status'] as String,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: 'Meeting status',
                    ),
                    items: [
                      for (final status in const [
                        'scheduled',
                        'in_progress',
                        'completed',
                        'cancelled',
                      ])
                        DropdownMenuItem(
                          value: status,
                          child: Text(meetingLabel(status)),
                        ),
                    ],
                    onChanged: canEdit
                        ? (value) => _patch({'status': value})
                        : null,
                  ),
                  const SizedBox(height: 16),
                  MeetingProjectSelector(
                    actions: widget.actions,
                    selected: definition['projectId'] as String?,
                    enabled: canEdit,
                    stillCurrent: widget.stillCurrent,
                    loader: widget.projectLoader,
                    onChanged: (value) => _patch({'projectId': value}),
                  ),
                  const SizedBox(height: 16),
                  DropdownButtonFormField<String>(
                    key: ValueKey(
                      'meeting-access:${definition['declaredAccessClass']}',
                    ),
                    initialValue: definition['declaredAccessClass'] as String,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: 'Access ceiling',
                    ),
                    items: const [
                      DropdownMenuItem(
                        value: 'owner_private',
                        child: Text('Owner only'),
                      ),
                      DropdownMenuItem(
                        value: 'project_members',
                        child: Text('Project members'),
                      ),
                      DropdownMenuItem(
                        value: 'workspace_members',
                        child: Text('Workspace members'),
                      ),
                    ],
                    onChanged: canEdit
                        ? (value) => _patch({'declaredAccessClass': value})
                        : null,
                  ),
                  const Text(
                    'Linked source permissions can make the saved Meeting more restrictive than this ceiling. Recorded decisions, commitments and follow-ups remain unchanged.',
                  ),
                  MeetingRelationshipFields(
                    key: ValueKey(fieldsRevision),
                    definition: definition,
                    enabled: canEdit,
                    onChanged: _patch,
                  ),
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    value: reviewed,
                    onChanged: !canEdit
                        ? null
                        : (value) => setState(() => reviewed = value == true),
                    title: Text(
                      widget.base == null
                          ? 'I reviewed this new meeting and its workspace.'
                          : 'I reviewed these changes against revision ${widget.base!.revision}.',
                    ),
                  ),
                  if (issue != null) MeetingNotice(issue!, error: true),
                  if (widget.actions.error != null)
                    MeetingNotice(widget.actions.error!, error: true),
                  if (widget.actions.disabledReason(action) != null)
                    MeetingNotice(widget.actions.disabledReason(action)!),
                  Wrap(
                    spacing: 12,
                    children: [
                      TextButton(
                        onPressed: () => Navigator.of(context).pop(),
                        child: const Text('Close draft'),
                      ),
                      FilledButton(
                        onPressed:
                            widget.actions.disabledReason(action) == null &&
                                reviewed &&
                                !staleDraft &&
                                widget.stillCurrent()
                            ? _submit
                            : null,
                        child: Text(
                          widget.actions.busy
                              ? 'Submitting meeting…'
                              : widget.base == null
                              ? 'Create reviewed meeting'
                              : 'Save reviewed revision',
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
  );
  Widget _field(
    TextEditingController control,
    String label, {
    required int max,
    int lines = 1,
    bool required = true,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: TextFormField(
      controller: control,
      maxLength: max,
      minLines: lines,
      maxLines: lines == 1 ? 1 : 8,
      enabled: canEdit,
      decoration: InputDecoration(labelText: label),
      validator: (value) => required && (value == null || value.trim().isEmpty)
          ? '$label is required.'
          : null,
      onChanged: (_) {
        _save();
        setState(() {});
      },
    ),
  );
}

Future<void> showMeetingFollowUpReview(
  BuildContext context, {
  required MeetingActionController actions,
  required Meeting meeting,
  required MeetingCommitmentsSnapshot snapshot,
  required MeetingCommitmentReview proposal,
  required bool Function() stillCurrent,
  required Future<bool> Function() refresh,
}) async {
  await showDialog<void>(
    context: context,
    builder: (_) => Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 760),
        child: MeetingFollowUpEditor(
          actions: actions,
          meeting: meeting,
          snapshot: snapshot,
          proposal: proposal,
          stillCurrent: stillCurrent,
          refresh: refresh,
        ),
      ),
    ),
  );
  await actions.flushDraft();
}

class MeetingFollowUpEditor extends StatefulWidget {
  const MeetingFollowUpEditor({
    super.key,
    required this.actions,
    required this.meeting,
    required this.snapshot,
    required this.proposal,
    required this.stillCurrent,
    required this.refresh,
  });
  final MeetingActionController actions;
  final Meeting meeting;
  final MeetingCommitmentsSnapshot snapshot;
  final MeetingCommitmentReview proposal;
  final bool Function() stillCurrent;
  final Future<bool> Function() refresh;
  @override
  State<MeetingFollowUpEditor> createState() => _MeetingFollowUpEditorState();
}

class _MeetingFollowUpEditorState extends State<MeetingFollowUpEditor> {
  final subject = TextEditingController(),
      body = TextEditingController(),
      due = TextEditingController();
  String? participantId, policyId, recipientId, issue;
  bool communication = false, confirmed = false;
  late final String? ownerKey;
  @override
  void initState() {
    super.initState();
    ownerKey = widget.actions.owner?.key;
    widget.actions.addListener(_accessChanged);
    participantId =
        widget.proposal.proposal['ownership']['participantId'] as String?;
    due.text = widget.proposal.proposal['dueDate']['dueAt'] as String? ?? '';
    final saved = widget.actions.draft;
    if (saved['kind'] == 'resolution' &&
        saved['proposalId'] == widget.proposal.id &&
        saved['proposalSha256'] == widget.proposal.sha256 &&
        saved['savedReceipt'] == null) {
      participantId = saved['ownerParticipantId'] as String?;
      due.text = saved['dueAt'] as String? ?? '';
      subject.text = saved['subject'] as String? ?? '';
      body.text = saved['body'] as String? ?? '';
      policyId = saved['policyId'] as String?;
      recipientId = saved['recipientId'] as String?;
      communication = saved['communication'] == true;
    }
    if (!widget.meeting.participants.any(
      (person) => person.id == participantId,
    )) {
      participantId = null;
    }
    if (!widget.snapshot.policies.any((policy) => policy['id'] == policyId)) {
      policyId = null;
      recipientId = null;
    }
  }

  void _save() {
    confirmed = false;
    widget.actions.updateDraft({
      'kind': 'resolution',
      'proposalId': widget.proposal.id,
      'proposalSha256': widget.proposal.sha256,
      'ownerParticipantId': participantId,
      'dueAt': due.text,
      'communication': communication,
      'policyId': policyId,
      'recipientId': recipientId,
      'subject': subject.text,
      'body': body.text,
    });
  }

  void _accessChanged() {
    if (!widget.actions.available || widget.actions.owner?.key != ownerKey) {
      subject.clear();
      body.clear();
      due.clear();
      participantId = null;
      policyId = null;
      recipientId = null;
      confirmed = false;
    }
  }

  @override
  void dispose() {
    widget.actions.removeListener(_accessChanged);
    subject.dispose();
    body.dispose();
    due.dispose();
    super.dispose();
  }

  List<MeetingParticipant> get recipients {
    final policy = widget.snapshot.policies
        .where((value) => value['id'] == policyId)
        .firstOrNull;
    return policy == null
        ? const []
        : widget.meeting.participants
              .where(
                (person) =>
                    person.email?.trim().toLowerCase() ==
                    (policy['address'] as String).trim().toLowerCase(),
              )
              .toList();
  }

  Future<void> _submit(String decision) async {
    if (!confirmed || !widget.stillCurrent()) {
      return;
    }
    try {
      final selected = widget.meeting.participants
          .where((person) => person.id == participantId)
          .firstOrNull;
      final recipient = recipients
          .where((person) => person.id == recipientId)
          .firstOrNull;
      final policy = widget.snapshot.policies
          .where((row) => row['id'] == policyId)
          .firstOrNull;
      if (decision == 'confirmed') {
        meetingRequire(selected != null);
        if (due.text.trim().isNotEmpty) {
          meetingDate(due.text.trim());
        }
      }
      Json? communicationBody;
      if (decision == 'confirmed' && communication) {
        meetingRequire(
          policyId != null &&
              recipient != null &&
              subject.text.trim().isNotEmpty &&
              !RegExp(r'[\r\n]').hasMatch(subject.text) &&
              body.text.trim().isNotEmpty,
        );
        communicationBody = {
          'policyId': policyId,
          'recipientParticipantId': recipientId,
          'subject': subject.text.trim(),
          'body': body.text.trim(),
        };
      }
      final frozen = MeetingSubmission.freeze(
        action: 'resolve',
        owner: widget.actions.owner!,
        id: widget.meeting.id,
        body: {
          'workspaceId': widget.meeting.workspaceId,
          'proposalId': widget.proposal.id,
          'expectedProposalSha256': widget.proposal.sha256,
          'decision': decision,
          if (decision == 'confirmed') ...{
            'ownerParticipantId': participantId,
            'dueAt': due.text.trim().isEmpty ? null : due.text.trim(),
            'communication': communicationBody,
          },
        },
        evidence: {
          'meetingVersion': widget.meeting.versionKey,
          if (communicationBody != null) 'recipientEmail': policy!['address'],
        },
      );
      final accepted = await widget.actions.submit(
        frozen,
        refresh: widget.refresh,
      );
      if (mounted && accepted) {
        Navigator.of(context).pop();
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => issue = 'Choose an exact current owner, a valid UTC due date, and the selected policy recipient and content when creating a draft.',
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.actions,
    builder: (context, _) =>
        !widget.actions.available || widget.actions.owner?.key != ownerKey
        ? const Padding(
            padding: EdgeInsets.all(24),
            child: Text(
              'This private review is hidden because Meeting access changed. Close and reopen it from the current workspace.',
            ),
          )
        : SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Semantics(
                  header: true,
                  child: Text(
                    'Review exact follow-up',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                SelectableText(
                  widget.proposal.title,
                  style: Theme.of(context).textTheme.bodyLarge,
                ),
                MeetingValue('Proposal', widget.proposal.id),
                MeetingValue('Proposal SHA-256', widget.proposal.sha256),
                MeetingValue(
                  'Evidence meeting revision',
                  widget.proposal.meetingRevisionId,
                ),
                MeetingValue(
                  'Work project',
                  widget.proposal.proposal['projectId'] as String,
                ),
                const Text(
                  'Confirmation creates a Work item. An optional email draft remains subject to a separate governed delivery action. These child effects are recorded sequentially; an interrupted response can require reconciliation.',
                ),
                DropdownButtonFormField<String>(
                  initialValue: participantId,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'Commitment owner',
                  ),
                  items: [
                    for (final person in widget.meeting.participants)
                      DropdownMenuItem(
                        value: person.id,
                        child: Text(person.name),
                      ),
                  ],
                  onChanged: widget.actions.busy
                      ? null
                      : (value) {
                          setState(() => participantId = value);
                          _save();
                        },
                ),
                TextField(
                  controller: due,
                  maxLength: 30,
                  enabled: !widget.actions.busy,
                  decoration: const InputDecoration(
                    labelText: 'Due · UTC ISO (optional)',
                    helperText: 'Leave blank to explicitly record no due date.',
                  ),
                  onChanged: (_) {
                    _save();
                    setState(() {});
                  },
                ),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  value: communication,
                  onChanged: widget.actions.busy
                      ? null
                      : (value) {
                          setState(() => communication = value == true);
                          _save();
                        },
                  title: const Text(
                    'Also create an email draft for an exact participant',
                  ),
                ),
                if (communication) ...[
                  if (widget.snapshot.policies.isEmpty)
                    const MeetingNotice(
                      'No eligible email policy was returned. No communication draft can be created.',
                    ),
                  DropdownButtonFormField<String>(
                    initialValue: policyId,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: 'Eligible email policy',
                    ),
                    items: [
                      for (final policy in widget.snapshot.policies)
                        DropdownMenuItem(
                          value: policy['id'] as String,
                          child: Text(
                            '${policy['displayName']} · ${policy['address']}',
                          ),
                        ),
                    ],
                    onChanged: widget.actions.busy
                        ? null
                        : (value) {
                            setState(() {
                              policyId = value;
                              recipientId = null;
                            });
                            _save();
                          },
                  ),
                  DropdownButtonFormField<String>(
                    key: ValueKey(policyId),
                    initialValue:
                        recipients.any((person) => person.id == recipientId)
                        ? recipientId
                        : null,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: 'Exact recipient participant',
                    ),
                    items: [
                      for (final person in recipients)
                        DropdownMenuItem(
                          value: person.id,
                          child: Text('${person.name} · ${person.email}'),
                        ),
                    ],
                    onChanged: widget.actions.busy
                        ? null
                        : (value) {
                            setState(() => recipientId = value);
                            _save();
                          },
                  ),
                  TextField(
                    controller: subject,
                    maxLength: 998,
                    enabled: !widget.actions.busy,
                    decoration: const InputDecoration(
                      labelText: 'Email draft subject',
                    ),
                    onChanged: (_) {
                      _save();
                      setState(() {});
                    },
                  ),
                  TextField(
                    controller: body,
                    maxLength: 50000,
                    minLines: 5,
                    maxLines: 12,
                    enabled: !widget.actions.busy,
                    decoration: const InputDecoration(
                      labelText: 'Exact email draft body',
                    ),
                    onChanged: (_) {
                      _save();
                      setState(() {});
                    },
                  ),
                ],
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  value: confirmed,
                  onChanged: widget.actions.busy
                      ? null
                      : (value) => setState(() => confirmed = value == true),
                  title: const Text(
                    'I reviewed the exact proposal, owner, due date and any selected recipient/content.',
                  ),
                ),
                if (!widget.stillCurrent())
                  const MeetingNotice(
                    'The current meeting or proposal changed. Close and reopen this review from fresh reads.',
                    error: true,
                  ),
                if (issue != null) MeetingNotice(issue!, error: true),
                if (widget.actions.error != null)
                  MeetingNotice(widget.actions.error!, error: true),
                if (widget.actions.disabledReason('resolve') != null)
                  MeetingNotice(widget.actions.disabledReason('resolve')!),
                Wrap(
                  spacing: 12,
                  runSpacing: 8,
                  children: [
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: const Text('Close review'),
                    ),
                    OutlinedButton(
                      onPressed:
                          confirmed &&
                              widget.stillCurrent() &&
                              widget.actions.disabledReason('resolve') == null
                          ? () => _submit('dismissed')
                          : null,
                      child: const Text('Dismiss exact proposal'),
                    ),
                    FilledButton(
                      onPressed:
                          confirmed &&
                              widget.stillCurrent() &&
                              participantId != null &&
                              widget.actions.disabledReason('resolve') == null
                          ? () => _submit('confirmed')
                          : null,
                      child: const Text('Confirm Work item and selected draft'),
                    ),
                  ],
                ),
              ],
            ),
          ),
  );
}
