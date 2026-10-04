import 'dart:convert';

import 'package:flutter/material.dart';

import 'knowledge.dart';
import 'knowledge_mutations.dart';

class MemoryChangeStatus extends StatelessWidget {
  const MemoryChangeStatus({super.key, required this.controller});
  final KnowledgeController controller;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      if (!controller.available) return const SizedBox.shrink();
      final sent = controller.pendingChange,
          accepted = controller.acceptedChange;
      if (sent == null &&
          accepted == null &&
          controller.changeError == null &&
          !controller.recoveryBusy &&
          controller.recoveryError == null) {
        return const SizedBox.shrink();
      }
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (controller.recoveryBusy)
              const Text('Checking protected Memory submissions…'),
            if (controller.recoveryError != null) ...[
              const Text(
                'Protected submission storage needs a fresh read. New changes are held; any accepted receipt below remains valid.',
              ),
              OutlinedButton(
                onPressed: controller.recoveryBusy || controller.changing
                    ? null
                    : controller.reloadRecovery,
                child: const Text('Reload protected Memory submission'),
              ),
            ],
            if (controller.changeRefusal != null)
              Semantics(
                liveRegion: true,
                child: Text(controller.changeRefusal!),
              ),
            if (sent != null) ...[
              Semantics(
                liveRegion: true,
                child: Text(
                  controller.changing
                      ? sent.kind == MemoryChange.review
                            ? 'Checking the exact review decision…'
                            : 'Submitting the reviewed Memory change…'
                      : 'Submission unconfirmed. It may already have been recorded.',
                ),
              ),
              SelectableText(
                'Request key: ${sent.key}\nTarget: ${sent.id ?? 'New private memory'}',
              ),
              ExpansionTile(
                title: const Text('Inspect frozen submitted values'),
                children: [
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: SelectableText(
                      const JsonEncoder.withIndent('  ').convert(sent.body),
                    ),
                  ),
                  if (sent.previewDigest != null)
                    SelectableText('Reviewed impact: ${sent.previewDigest}'),
                ],
              ),
              if (!controller.changing) ...[
                Text(
                  sent.kind == MemoryChange.review
                      ? 'Recovery only reads this exact review with the saved request identity. It never sends the decision again. A visible decision without a matching acceptance does not settle this request.'
                      : sent.replayable
                      ? 'Recovery sends the same frozen request and key. A changed impact or lost authorization may prevent recovery.'
                      : 'This operation has no exact retry receipt. Inspect the live catalogue before making another entry. This app will not resend it.',
                ),
                if (sent.replayable)
                  OutlinedButton(
                    onPressed:
                        controller.supportsChange(sent.kind) &&
                            sent.owner.key ==
                                controller.mutationRepository?.access.owner?.key
                        ? controller.retryChange
                        : null,
                    child: const Text('Recover this exact submission'),
                  ),
                if (sent.kind == MemoryChange.review)
                  OutlinedButton(
                    onPressed: controller.canRecoverReview
                        ? controller.recoverReview
                        : null,
                    child: const Text('Read exact review acceptance'),
                  ),
                if (sent.kind == MemoryChange.review &&
                    controller.changeError != null)
                  Text(
                    controller.changeError is FormatException
                        ? (controller.changeError as FormatException).message
                        : 'The exact acceptance could not be confirmed. The original request remains held.',
                  ),
                if (sent.kind != MemoryChange.review &&
                    sent.owner.key !=
                        controller.mutationRepository?.access.owner?.key)
                  const Text(
                    'The saved submission belongs to earlier account permissions. It remains held until that exact authority can be verified.',
                  ),
              ],
            ],
            if (accepted != null) ...[
              Semantics(liveRegion: true, child: Text(accepted.description)),
              SelectableText('Accepted target: ${accepted.memoryId}'),
              if (controller.error != null)
                const Text(
                  'The change was accepted, but the catalogue refresh failed. The receipt remains available.',
                ),
              ExpansionTile(
                title: const Text('Inspect accepted receipt'),
                children: [
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: SelectableText(
                      const JsonEncoder.withIndent('  ').convert(accepted.raw),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      );
    },
  );
}

Future<void> showMemoryEditor(
  BuildContext context,
  KnowledgeController controller, {
  MemoryRecord? memory,
}) => showDialog<void>(
  context: context,
  builder: (_) => Dialog(
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 640),
      child: MemoryEditor(controller: controller, memory: memory),
    ),
  ),
);

class MemoryEditor extends StatefulWidget {
  const MemoryEditor({super.key, required this.controller, this.memory});
  final KnowledgeController controller;
  final MemoryRecord? memory;
  @override
  State<MemoryEditor> createState() => _MemoryEditorState();
}

class _MemoryEditorState extends State<MemoryEditor> {
  late final _title = TextEditingController(text: widget.memory?.title ?? '');
  late final _content = TextEditingController(
    text: widget.memory?.content ?? '',
  );
  bool _contradiction = false;
  String _type = 'fact';
  String? _error;
  String? _submittedKey;
  @override
  void dispose() {
    _title.dispose();
    _content.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _error = null);
    try {
      final memory = widget.memory;
      final operation = widget.controller.submitChange(
        memory == null ? MemoryChange.create : MemoryChange.correct,
        {
          'title': _title.text.trim(),
          'content': _content.text,
          if (memory == null) 'type': _type,
          if (memory != null) 'contradiction': _contradiction,
        },
        id: memory?.id,
      );
      _submittedKey = widget.controller.pendingChange?.key;
      await operation;
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Review the required title and content, and resolve any pending submission first.',
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      return SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (!controller.available)
              const Text(
                'This Memory session ended. Close this editor and reopen it from the current account.',
              )
            else ...[
              Text(
                widget.memory == null
                    ? 'Add private memory'
                    : 'Review a correction',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              if (widget.memory != null)
                SelectableText('Original identity: ${widget.memory!.id}'),
              const Text(
                'The server may redact sensitive text. The accepted record and its identity remain inspectable in the receipt.',
              ),
              TextField(
                controller: _title,
                maxLength: 240,
                enabled: !controller.changing,
                decoration: const InputDecoration(labelText: 'Title'),
              ),
              TextField(
                controller: _content,
                minLines: 4,
                maxLines: 12,
                maxLength: 200000,
                enabled: !controller.changing,
                decoration: const InputDecoration(labelText: 'Memory content'),
              ),
              if (widget.memory == null)
                DropdownButtonFormField<String>(
                  initialValue: _type,
                  decoration: const InputDecoration(labelText: 'Memory type'),
                  isExpanded: true,
                  items: [
                    for (final value in [
                      'fact',
                      'preference',
                      'episode',
                      'procedure',
                      'knowledge',
                      'decision',
                      'task',
                    ])
                      DropdownMenuItem(value: value, child: Text(value)),
                  ],
                  onChanged: controller.changing
                      ? null
                      : (value) => setState(() => _type = value ?? 'fact'),
                ),
              if (widget.memory != null)
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Propose a contradiction for review'),
                  subtitle: const Text(
                    'A contradiction remains a candidate until it is explicitly resolved. An ordinary correction creates a superseding memory.',
                  ),
                  value: _contradiction,
                  onChanged: controller.changing
                      ? null
                      : (value) =>
                            setState(() => _contradiction = value ?? false),
                ),
              if (_error != null) Text(_error!),
              MemoryChangeStatus(controller: controller),
              FilledButton(
                onPressed:
                    controller.pendingChange != null ||
                        _submittedKey != null &&
                            controller.acceptedChange?.submission.key ==
                                _submittedKey ||
                        !controller.supportsChange(
                          widget.memory == null
                              ? MemoryChange.create
                              : MemoryChange.correct,
                        )
                    ? null
                    : _save,
                child: Text(
                  widget.memory == null
                      ? 'Record private memory'
                      : _contradiction
                      ? 'Submit review candidate'
                      : 'Record correction',
                ),
              ),
            ],
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Close editor'),
            ),
          ],
        ),
      );
    },
  );
}

class MemoryLifecycleControls extends StatefulWidget {
  const MemoryLifecycleControls({
    super.key,
    required this.controller,
    required this.memoryId,
  });
  final KnowledgeController controller;
  final String memoryId;
  @override
  State<MemoryLifecycleControls> createState() =>
      _MemoryLifecycleControlsState();
}

class _MemoryLifecycleControlsState extends State<MemoryLifecycleControls> {
  Json? _review;
  bool _reading = false;
  String? _error;
  int _generation = 0;
  @override
  void didUpdateWidget(covariant MemoryLifecycleControls oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.memoryId != widget.memoryId ||
        !identical(oldWidget.controller, widget.controller)) {
      _generation++;
      _review = null;
      _error = null;
      _reading = false;
    }
  }

  Future<void> _read() async {
    final generation = ++_generation, controller = widget.controller;
    setState(() {
      _reading = true;
      _review = null;
      _error = null;
    });
    try {
      final value = await controller.lifecycle(widget.memoryId);
      if (mounted && generation == _generation && controller.available) {
        setState(() => _review = value);
      }
    } catch (_) {
      if (mounted && generation == _generation) {
        setState(
          () => _error = 'Current lifecycle authority is unavailable. Refresh this review before a change.',
        );
      }
    } finally {
      if (mounted && generation == _generation) {
        setState(() => _reading = false);
      }
    }
  }

  Future<void> _apply(String action) async {
    final reviewed = _review;
    if (reviewed == null) return;
    setState(() => _review = null);
    try {
      await widget.controller.submitChange(MemoryChange.lifecycle, {
        'contract': 'asael-memory-lifecycle-mutation:1',
        'action': action,
        'expectedTargetToken': (reviewed['target'] as Map)['token'],
      }, id: widget.memoryId);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Resolve the pending Memory submission before another lifecycle change.',
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    if (!controller.supportsChange(MemoryChange.lifecycle)) {
      return const Text(
        'Lifecycle changes require a supported app version and current private-memory write permission.',
      );
    }
    final target = _review?['target'] as Map?,
        life = _review?['lifecycle'] as Map?;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        OutlinedButton(
          onPressed: _reading || controller.pendingChange != null
              ? null
              : _read,
          child: Text(
            _reading
                ? 'Reading current lifecycle…'
                : 'Review pin and archive settings',
          ),
        ),
        if (_error != null) Text(_error!),
        if (target != null && life != null) ...[
          SelectableText(
            'Private owner: ${target['ownerActorId']}\nTarget revision: ${target['targetRevision']} · lifecycle revision: ${target['lifecycleRevision']}',
          ),
          const Text(
            'These changes affect retrieval and preserve historical truth. Permanent forgetting has a separate impact review.',
          ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final action
                  in life['archivedAt'] != null
                      ? ['restore']
                      : life['pinnedAt'] != null
                      ? ['unpin']
                      : ['pin', 'archive'])
                FilledButton(
                  onPressed: controller.pendingChange != null
                      ? null
                      : () => _apply(action),
                  child: Text(
                    '${action[0].toUpperCase()}${action.substring(1)} reviewed memory',
                  ),
                ),
            ],
          ),
        ],
      ],
    );
  }
}
