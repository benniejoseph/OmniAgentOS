import 'package:flutter/material.dart';

import 'meetings.dart';
import 'meetings_recording_contracts.dart';
import 'meetings_recording_controller.dart';
import 'meetings_validation.dart';
import 'meetings_widgets.dart';

class MeetingRecordingPanel extends StatefulWidget {
  const MeetingRecordingPanel({
    super.key,
    required this.controller,
    required this.meeting,
    required this.isCurrent,
    this.active = true,
  });
  final MeetingRecordingController controller;
  final Meeting meeting;
  final bool Function() isCurrent;
  final bool active;
  @override
  State<MeetingRecordingPanel> createState() => _MeetingRecordingPanelState();
}

class _MeetingRecordingPanelState extends State<MeetingRecordingPanel>
    with WidgetsBindingObserver {
  int _epoch = 0;
  bool _opening = false;
  bool get _foreground =>
      WidgetsBinding.instance.lifecycleState == null ||
      WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
  void _activate() {
    if (mounted) {
      widget.controller.setActive(widget.active && _foreground);
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _activate());
  }

  @override
  void didUpdateWidget(covariant MeetingRecordingPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller) ||
        oldWidget.meeting.versionKey != widget.meeting.versionKey ||
        oldWidget.active != widget.active) {
      _epoch++;
      if (!identical(oldWidget.controller, widget.controller)) {
        oldWidget.controller.setActive(false);
      }
      WidgetsBinding.instance.addPostFrameCallback((_) => _activate());
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _epoch++;
    _activate();
  }

  @override
  void dispose() {
    _epoch++;
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.setActive(false);
    super.dispose();
  }

  Future<void> _open(MeetingEvidence source) async {
    if (_opening || !widget.isCurrent() || source.sourceId == null) {
      return;
    }
    final controller = widget.controller,
        epoch = _epoch,
        meeting = widget.meeting;
    final owner = controller.owner?.key;
    bool current() =>
        mounted &&
        epoch == _epoch &&
        identical(widget.controller, controller) &&
        controller.available &&
        controller.owner?.key == owner &&
        widget.active &&
        _foreground &&
        widget.isCurrent() &&
        widget.meeting.versionKey == meeting.versionKey &&
        widget.meeting.evidence.any(
          (value) => value.id == source.id && value.sourceId == source.sourceId,
        );
    setState(() => _opening = true);
    try {
      final review = await controller.review(
        meeting.workspaceId!,
        meeting.id,
        source.sourceId!,
      );
      if (!current() || review == null) {
        return;
      }
      if (review.pin['sourceLinkId'] != source.id ||
          review.pin['meetingRevision'] != meeting.revision ||
          review.pin['meetingSha256'] != meeting.sha256) {
        return;
      }
      if (!mounted) {
        return;
      }
      await showDialog<void>(
        context: context,
        builder: (_) => _RecordingReviewDialog(
          controller: controller,
          review: review,
          isCurrent: current,
        ),
      );
    } finally {
      if (mounted) {
        setState(() => _opening = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller, meeting = widget.meeting;
      if (!controller.available) {
        return const MeetingNotice(
          'Recording controls are hidden until the current account and device access are available.',
        );
      }
      final sources = meeting.evidence
          .where(
            (value) =>
                value.kind == 'capture_recording' && value.sourceId != null,
          )
          .toList();
      final saved = controller.saved
          .where((value) => value.request.scope['meetingId'] == meeting.id)
          .toList();
      return MeetingSection(
        'Recording processing',
        subtitle: 'Review an already linked recording. Original audio is retained. Processing and private Knowledge indexing have separate recorded outcomes.',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (!controller.initialized || controller.loading)
              const Text('Reading protected recording state…'),
            if (sources.isEmpty)
              const Text('No recording is linked to this Meeting.'),
            for (final source in sources)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SelectableText(source.label),
                    OutlinedButton(
                      onPressed:
                          controller.canRead && !_opening && widget.isCurrent()
                          ? () => _open(source)
                          : null,
                      child: const Text('Review recording processing'),
                    ),
                  ],
                ),
              ),
            if (controller.pending != null) ...[
              MeetingNotice(
                controller.pendingDispatched
                    ? 'A recording submission is unconfirmed. It will not be sent again. Check only the exact saved receipt.'
                    : 'A prepared recording request was saved before transport. It can be discarded locally without starting processing.',
              ),
              MeetingValue(
                'Pending recording',
                controller.pending!.recordingId,
              ),
              MeetingValue(
                'Pending Meeting',
                controller.pending!.scope['meetingId'] as String,
              ),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  OutlinedButton(
                    onPressed: controller.canRead
                        ? () => controller.check(controller.pending!)
                        : null,
                    child: const Text('Check exact recording receipt'),
                  ),
                  if (!controller.pendingDispatched)
                    OutlinedButton(
                      onPressed:
                          controller.canRead && !controller.storageUnconfirmed
                          ? controller.discardPrepared
                          : null,
                      child: const Text('Discard unsubmitted request'),
                    ),
                ],
              ),
            ],
            for (final saved in saved)
              _RecordingReceipt(
                saved: saved,
                enabled: controller.canRead,
                check: () => controller.check(saved.request),
              ),
            if (controller.saved.length >= MeetingRecordingController.maxSaved)
              const MeetingNotice(
                'This device has reached its protected recording history limit. Existing receipts remain available; new submissions are held.',
              ),
            if (controller.error != null)
              MeetingNotice(controller.error!, error: true),
            if (controller.storageError != null)
              MeetingNotice(controller.storageError!, error: true),
            if (controller.storageUnconfirmed)
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  OutlinedButton(
                    onPressed:
                        controller.available &&
                            !controller.loading &&
                            !controller.busy
                        ? controller.reload
                        : null,
                    child: const Text('Reload protected recording recovery'),
                  ),
                  if (controller.pending == null && controller.saved.isNotEmpty)
                    OutlinedButton(
                      onPressed: controller.canRead
                          ? controller.saveLocally
                          : null,
                      child: const Text('Save verified receipts locally'),
                    ),
                ],
              ),
          ],
        ),
      );
    },
  );
}

class _RecordingReceipt extends StatelessWidget {
  const _RecordingReceipt({
    required this.saved,
    required this.enabled,
    required this.check,
  });
  final MeetingRecordingSaved saved;
  final bool enabled;
  final VoidCallback check;
  @override
  Widget build(BuildContext context) {
    final accepted = saved.result.acceptance!,
        progress = saved.result.processing!,
        media = progress['media'],
        knowledge = progress['knowledge'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Recording processing accepted',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            MeetingValue('Recording', saved.request.recordingId),
            MeetingValue('Accepted at', accepted['acceptedAt'] as String),
            Text(
              'Last observed processing: ${meetingLabel(progress['phase'] as String)}',
            ),
            Text(
              '${progress['completedSegments']} of ${progress['totalSegments']} segments confirmed',
            ),
            Text(
              media == null
                  ? 'Structured media output is not yet confirmed.'
                  : 'Structured media output is saved.',
            ),
            Text(
              knowledge == null
                  ? 'Private Knowledge indexing has no confirmed status.'
                  : 'Private Knowledge indexing: ${meetingLabel((knowledge as Map)['state'] as String)}',
            ),
            if (progress['reasonCode'] != null)
              Text(
                'Current hold: ${meetingLabel(progress['reasonCode'] as String)}',
              ),
            Text(
              'Observed at ${progress['updatedAt']}. Checking this receipt never retries processing.',
            ),
            MeetingDisclosure(
              'Exact processing receipt',
              children: [
                MeetingValue('Acceptance', accepted['id'] as String),
                MeetingValue(
                  'Reviewed request SHA-256',
                  accepted['requestSha256'] as String,
                ),
                MeetingValue(
                  'Original audio manifest',
                  accepted['sourceAudioManifestSha256'] as String,
                ),
                if (media != null)
                  MeetingValue(
                    'Saved media revision',
                    (media as Map)['mediaRevisionId'] as String,
                  ),
                if (knowledge is Map && knowledge['documentId'] != null)
                  MeetingValue(
                    'Knowledge document',
                    knowledge['documentId'] as String,
                  ),
              ],
            ),
            OutlinedButton(
              onPressed: enabled ? check : null,
              child: const Text('Refresh exact processing status'),
            ),
          ],
        ),
      ),
    );
  }
}

class _RecordingReviewDialog extends StatefulWidget {
  const _RecordingReviewDialog({
    required this.controller,
    required this.review,
    required this.isCurrent,
  });
  final MeetingRecordingController controller;
  final MeetingRecordingReview review;
  final bool Function() isCurrent;
  @override
  State<_RecordingReviewDialog> createState() => _RecordingReviewDialogState();
}

class _RecordingReviewDialogState extends State<_RecordingReviewDialog> {
  late final TextEditingController _languages;
  final _label = TextEditingController();
  final List<MeetingJson> _mappings = [];
  String? _participant, _error;
  bool _reviewed = false, _submitting = false;
  bool get _current =>
      mounted &&
      widget.isCurrent() &&
      widget.controller.available &&
      ModalRoute.of(context)?.isCurrent == true;
  @override
  void initState() {
    super.initState();
    final language = widget.review.recording['language'] as String;
    _languages = TextEditingController(
      text: RegExp(r'^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$').hasMatch(language)
          ? language
          : '',
    );
  }

  @override
  void dispose() {
    _languages.dispose();
    _label.dispose();
    super.dispose();
  }

  List<String> get _languageValues => _languages.text
      .split(',')
      .map((value) => value.trim())
      .where((value) => value.isNotEmpty)
      .toList();
  Future<void> _reviewChoices() async {
    try {
      await MeetingRecordingSubmission.prepare(
        widget.controller.owner!,
        widget.review,
        languages: _languageValues,
        mappings: _mappings,
      );
      if (_current) {
        setState(() {
          _reviewed = true;
          _error = null;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Enter 1–12 distinct language codes and unique, explicitly confirmed speaker mappings.',
        );
      }
    }
  }

  Future<void> _submit() async {
    if (!_current || !_reviewed || !widget.controller.canSubmit) {
      return;
    }
    setState(() => _submitting = true);
    await widget.controller.submit(
      widget.review,
      languages: _languageValues,
      mappings: _mappings,
      isCurrent: () => _current && _reviewed,
    );
    if (!mounted) {
      return;
    }
    setState(() => _submitting = false);
    if (widget.controller.pending != null ||
        widget.controller.acceptedFor(
              widget.review.scope['meetingId'] as String,
              widget.review.scope['recordingId'] as String,
            ) !=
            null) {
      Navigator.pop(context);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      if (!_current) {
        return AlertDialog(
          title: const Text('Recording review unavailable'),
          content: const Text(
            'Current account, Meeting, or device access changed.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close'),
            ),
          ],
        );
      }
      final review = widget.review, record = review.recording;
      return AlertDialog(
        // At large text sizes, the title must share the content viewport so
        // the reviewed retention text stays reachable above the action bar.
        scrollable: true,
        title: const Text('Review recording processing'),
        content: SizedBox(
          width: 600,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SelectableText(record['title'] as String),
              Text(
                '${record['segmentCount']} segments · ${record['durationMs']} ms · ${record['byteCount']} bytes',
              ),
              Text(
                '${record['cachedTranscripts']} verified segment transcripts available for reuse.',
              ),
              const Text(
                'This starts transcription, structured media extraction, and owner-private Knowledge indexing. Original audio is retained. Unconfirmed work is held and will not be automatically repeated.',
              ),
              for (final participant in review.participants)
                Text(
                  '${participant['displayName']}: recording consent ${meetingLabel(participant['recordingConsent'] as String)}',
                ),
              if (!review.processable)
                MeetingNotice(
                  'Processing is unavailable: ${review.reasons.map(meetingLabel).join(', ')}.',
                ),
              if (review.processable && !_reviewed) ...[
                TextField(
                  controller: _languages,
                  enabled: !_submitting,
                  decoration: const InputDecoration(
                    labelText: 'Language codes',
                    helperText: 'Comma-separated codes, for example en, fr-CA.',
                  ),
                ),
                const SizedBox(height: 12),
                const Text(
                  'Optional speaker mapping. Add only labels you have personally confirmed; unmapped speakers remain unidentified.',
                ),
                DropdownButtonFormField<String>(
                  key: ValueKey(_mappings.length),
                  initialValue: _participant,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'Confirmed participant',
                  ),
                  items: [
                    for (final person in review.participants.where(
                      (person) => !_mappings.any(
                        (mapping) =>
                            mapping['participantId'] == person['participantId'],
                      ),
                    ))
                      DropdownMenuItem(
                        value: person['participantId'] as String,
                        child: Text(person['displayName'] as String),
                      ),
                  ],
                  onChanged: _submitting
                      ? null
                      : (value) => setState(() => _participant = value),
                ),
                TextField(
                  controller: _label,
                  maxLength: 80,
                  enabled: !_submitting,
                  decoration: const InputDecoration(
                    labelText: 'Confirmed speaker label',
                  ),
                ),
                OutlinedButton(
                  onPressed: _submitting || _mappings.length >= 40
                      ? null
                      : () {
                          final person = review.participants
                                  .where(
                                    (person) =>
                                        person['participantId'] == _participant,
                                  )
                                  .firstOrNull,
                              label = _label.text.trim();
                          if (person == null ||
                              label.isEmpty ||
                              _mappings.any(
                                (mapping) =>
                                    (mapping['speakerLabel'] as String)
                                        .toLowerCase() ==
                                    label.toLowerCase(),
                              )) {
                            setState(
                              () => _error = 'Choose a participant and a unique confirmed speaker label.',
                            );
                            return;
                          }
                          setState(() {
                            _mappings.add({
                              'speakerLabel': label,
                              'participantId': person['participantId'],
                              'displayName': person['displayName'],
                              'confirmation': 'user_confirmed',
                            });
                            _participant = null;
                            _label.clear();
                            _error = null;
                          });
                        },
                  child: const Text('Add confirmed mapping'),
                ),
              ],
              if (_reviewed) Text('Languages: ${_languageValues.join(', ')}'),
              for (final mapping in _mappings)
                Wrap(
                  spacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(
                      '${mapping['speakerLabel']} → ${mapping['displayName']}',
                    ),
                    if (!_reviewed)
                      TextButton(
                        onPressed: _submitting
                            ? null
                            : () => setState(() => _mappings.remove(mapping)),
                        child: const Text('Remove mapping'),
                      ),
                  ],
                ),
              if (_reviewed && _mappings.isEmpty)
                const Text('No speaker identity mappings will be submitted.'),
              if (_reviewed) const Text('Retention: keep original audio.'),
              MeetingDisclosure(
                'Exact reviewed source',
                children: [
                  MeetingValue(
                    'Recording',
                    review.scope['recordingId'] as String,
                  ),
                  MeetingValue(
                    'Meeting revision',
                    '${review.pin['meetingRevision']}',
                  ),
                  MeetingValue(
                    'Source review SHA-256',
                    review.pin['reviewSha256'] as String,
                  ),
                ],
              ),
              if (_error != null) MeetingNotice(_error!, error: true),
              if (widget.controller.error != null)
                MeetingNotice(widget.controller.error!, error: true),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: _submitting ? null : () => Navigator.pop(context),
            child: const Text('Close'),
          ),
          if (_reviewed)
            TextButton(
              onPressed: _submitting
                  ? null
                  : () => setState(() => _reviewed = false),
              child: const Text('Edit choices'),
            ),
          if (review.processable)
            FilledButton(
              onPressed: !widget.controller.canSubmit || _submitting
                  ? null
                  : _reviewed
                  ? _submit
                  : _reviewChoices,
              child: Text(
                _submitting
                    ? 'Saving exact request…'
                    : _reviewed
                    ? 'Process reviewed recording'
                    : 'Review processing choices',
              ),
            ),
        ],
      );
    },
  );
}
