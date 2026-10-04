import 'package:flutter/material.dart';

import 'agent_skill_contracts.dart';
import 'agent_skill_controller.dart';
import 'specialist_contracts.dart';

Future<void> showAgentSkillDecision(
  BuildContext context,
  AgentSkillController controller,
  String operation,
  String? id,
) => showDialog<void>(
  context: context,
  useRootNavigator: false,
  builder: (_) => AgentSkillDecisionView(
    controller: controller,
    operation: operation,
    resourceId: id,
  ),
);

class AgentSkillDecisionView extends StatefulWidget {
  const AgentSkillDecisionView({
    super.key,
    required this.controller,
    required this.operation,
    this.resourceId,
  });
  final AgentSkillController controller;
  final String operation;
  final String? resourceId;
  @override
  State<AgentSkillDecisionView> createState() => _AgentSkillDecisionViewState();
}

class _AgentSkillDecisionViewState extends State<AgentSkillDecisionView>
    with WidgetsBindingObserver {
  final _fields = <String, TextEditingController>{};
  AgentSkillReview? _review;
  SpecialistJson? _request;
  String _category = 'personal', _status = 'active';
  String? _error;
  bool _loading = false, _foreground = true;
  int _epoch = 0;
  bool get _deletion => widget.operation.endsWith('.delete');
  bool get _current =>
      mounted &&
      _foreground &&
      widget.controller.current &&
      (ModalRoute.of(context)?.isCurrent ?? true) &&
      TickerMode.valuesOf(context).enabled;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    for (final field in [
      'name',
      'description',
      'instructions',
      'toolIds',
      'tags',
      'knowledgeTags',
    ]) {
      _fields[field] = TextEditingController();
    }
    if (widget.resourceId != null) {
      _load();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _epoch++;
    if (mounted) {
      setState(() => _request = null);
    }
  }

  @override
  void dispose() {
    _epoch++;
    WidgetsBinding.instance.removeObserver(this);
    for (final field in _fields.values) {
      field.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    final epoch = ++_epoch;
    setState(() {
      _loading = true;
      _error = null;
      _request = null;
      _review = null;
    });
    try {
      final review = await widget.controller.review(
        widget.operation,
        widget.resourceId!,
      );
      if (!_current || epoch != _epoch) {
        return;
      }
      setState(() {
        _review = review;
        if (!_deletion) {
          final resource = review.resource;
          for (final entry in _fields.entries) {
            final value = resource[entry.key];
            entry.value.text = value is List
                ? value.join('\n')
                : value as String;
          }
          _category = resource['category'] as String;
          _status = resource['status'] as String;
        }
      });
    } catch (_) {
      if (_current && epoch == _epoch) {
        setState(
          () => _error = 'The exact current review is unavailable. Refresh before deciding.',
        );
      }
    } finally {
      if (mounted && epoch == _epoch) {
        setState(() => _loading = false);
      }
    }
  }

  void _edit() {
    if (_request != null) {
      setState(() => _request = null);
    }
    _epoch++;
  }

  void _prepare() {
    if (!_current ||
        _loading ||
        !widget.controller.canWrite(widget.operation)) {
      return;
    }
    try {
      SpecialistJson request;
      if (_deletion) {
        final review = _review;
        specialistRequire(
          review != null && review.unexpired,
          'This deletion review expired. Refresh it before deciding.',
        );
        request = {
          'contract': 'asael-agent-skill-delete:1',
          'review': review!.pin,
          'preview': review.preview,
        };
      } else {
        final skill = validateAgentSkillInput({
          'name': _fields['name']!.text.trim(),
          'description': _fields['description']!.text.trim(),
          'instructions': _fields['instructions']!.text.trim(),
          'category': _category,
          'status': _status,
          for (final key in ['toolIds', 'tags', 'knowledgeTags'])
            key: _fields[key]!.text.trim().isEmpty
                ? <String>[]
                : _fields[key]!.text
                      .trim()
                      .split('\n')
                      .map((value) => value.trim())
                      .toList(),
        });
        if (widget.operation == 'skill.create') {
          request = {'contract': 'asael-skill-create:1', 'skill': skill};
        } else {
          specialistRequire(_review != null);
          request = {
            'contract': 'asael-skill-update:1',
            'review': _review!.pin,
            'change': skill,
          };
        }
      }
      setState(() {
        _request = specialistFreeze(request);
        _error = null;
      });
    } catch (error) {
      setState(
        () => _error =
            'Review the field bounds and use unique, nonempty list entries. ${error is StateError ? error.message : ''}',
      );
    }
  }

  Future<void> _confirm() async {
    final request = _request,
        epoch = _epoch,
        controller = widget.controller,
        priorKey = widget.controller.acceptedIntent?.key;
    if (request == null || !_current) {
      return;
    }
    await controller.submit(
      request,
      isCurrent: () =>
          _current &&
          epoch == _epoch &&
          identical(_request, request) &&
          identical(widget.controller, controller),
    );
    if (!mounted) {
      return;
    }
    // Keep the immutable receipt visible in the workspace after closing the form.
    if (controller.acceptedIntent != null &&
        controller.acceptedIntent!.key != priorKey &&
        specialistCanonical(controller.acceptedIntent!.request) ==
            specialistCanonical(request) &&
        controller.pending == null) {
      Navigator.of(context).pop();
    } else if (_current) {
      setState(() => _error = controller.error);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller,
          enabled =
              controller.canWrite(widget.operation) && _current && !_loading;
      final title = switch (widget.operation) {
        'agent.delete' => 'Review Agent deletion',
        'skill.delete' => 'Review Skill deletion',
        'skill.update' => 'Edit Skill',
        _ => 'Create Skill',
      };
      return AlertDialog(
        insetPadding: const EdgeInsets.all(12),
        title: Text(title),
        content: SizedBox(
          width: 640,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (_loading) const LinearProgressIndicator(),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Text(
                      _error!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
                if (controller.pending != null)
                  const Text(
                    'An earlier decision is unconfirmed. Close this form and check its exact receipt before another change.',
                  ),
                if (widget.resourceId != null)
                  OutlinedButton(
                    onPressed: controller.busy || _loading ? null : _load,
                    child: const Text('Refresh exact review'),
                  ),
                if (_review case final review?) ...[
                  Text(
                    review.resource['name'] as String,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  if (review.pin['resourceVersion'] != null)
                    Text('Current version ${review.pin['resourceVersion']}'),
                  Text(
                    'Affected Agents: ${(review.raw['affectedAgents'] as List).length}',
                  ),
                  for (final item in review.raw['affectedAgents'] as List)
                    Text('• ${item['name']}'),
                  if (review.raw['agentLifecycle'] case final Map lifecycle)
                    Text(
                      'Release ${lifecycle['releaseState']} · definition ${lifecycle['activeDefinitionVersion']} · principal ${lifecycle['principalState']}',
                    ),
                  if (review.preview case final preview?) ...[
                    const SizedBox(height: 12),
                    Text(preview['effectSummary'] as String),
                    Text('Review expires ${preview['expiresAt']}'),
                    Text(
                      widget.operation == 'agent.delete'
                          ? 'Trash recovery creates an equivalent Agent with a new identity. It does not reactivate this Agent’s retired identity.'
                          : 'Trash recovery can restore the Skill and its surviving assignments within the retention period.',
                    ),
                  ],
                ],
                if (!_deletion) ...[
                  for (final (key, label, minLines, maxLines, limit) in [
                    ('name', 'Name', 1, 2, 120),
                    ('description', 'Description', 2, 4, 500),
                    ('instructions', 'Instructions', 4, 12, 12000),
                  ])
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: TextField(
                        controller: _fields[key],
                        enabled: enabled,
                        onChanged: (_) => _edit(),
                        minLines: minLines,
                        maxLines: maxLines,
                        maxLength: limit,
                        decoration: InputDecoration(
                          labelText: label,
                          border: const OutlineInputBorder(),
                        ),
                      ),
                    ),
                  DropdownButtonFormField<String>(
                    key: ValueKey('category-$_category'),
                    initialValue: _category,
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: 'Category'),
                    items: agentSkillCategories
                        .map(
                          (value) => DropdownMenuItem(
                            value: value,
                            child: Text(value),
                          ),
                        )
                        .toList(),
                    onChanged: enabled
                        ? (value) {
                            if (value != null) {
                              setState(() {
                                _category = value;
                                _request = null;
                                _epoch++;
                              });
                            }
                          }
                        : null,
                  ),
                  DropdownButtonFormField<String>(
                    key: ValueKey('status-$_status'),
                    initialValue: _status,
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: 'Status'),
                    items: ['active', 'disabled']
                        .map(
                          (value) => DropdownMenuItem(
                            value: value,
                            child: Text(value),
                          ),
                        )
                        .toList(),
                    onChanged: enabled
                        ? (value) {
                            if (value != null) {
                              setState(() {
                                _status = value;
                                _request = null;
                                _epoch++;
                              });
                            }
                          }
                        : null,
                  ),
                  for (final (key, label) in [
                    ('toolIds', 'Tool IDs · one per line, up to 40'),
                    ('tags', 'Tags · one per line, up to 30'),
                    (
                      'knowledgeTags',
                      'Knowledge tags · one per line, up to 30',
                    ),
                  ])
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: TextField(
                        controller: _fields[key],
                        enabled: enabled,
                        onChanged: (_) => _edit(),
                        minLines: 2,
                        maxLines: 5,
                        decoration: InputDecoration(
                          labelText: label,
                          border: const OutlineInputBorder(),
                        ),
                      ),
                    ),
                  const Text(
                    'Tool IDs configure the Skill. Saving does not grant execution access or run a tool.',
                  ),
                ],
                if (_request case final request?) ...[
                  const Divider(),
                  Text(
                    'Review exact change',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  if (_deletion)
                    Text(
                      '${widget.operation}\n${widget.resourceId}\n${_review!.preview!['effectSummary']}',
                    )
                  else
                    for (final entry in specialistMap(
                      request[widget.operation == 'skill.create'
                          ? 'skill'
                          : 'change'],
                    ).entries)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        child: Text(
                          '${_fieldLabel(entry.key)}: ${entry.value is List ? (entry.value as List).join(', ') : entry.value}',
                        ),
                      ),
                  const Text(
                    'This submits once. If the response is interrupted, recovery checks only the exact saved receipt.',
                  ),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Close'),
          ),
          if (_request == null)
            FilledButton(
              onPressed:
                  enabled && (_review != null || widget.resourceId == null)
                  ? _prepare
                  : null,
              child: const Text('Review change'),
            )
          else
            FilledButton(
              onPressed: enabled ? _confirm : null,
              child: Text(_deletion ? 'Confirm move to Trash' : 'Confirm save'),
            ),
        ],
      );
    },
  );

  String _fieldLabel(String key) => switch (key) {
    'name' => 'Name',
    'description' => 'Description',
    'instructions' => 'Instructions',
    'category' => 'Category',
    'status' => 'Status',
    'toolIds' => 'Tool IDs',
    'tags' => 'Tags',
    'knowledgeTags' => 'Knowledge tags',
    _ => key,
  };
}

class AgentSkillRecoveryPanel extends StatelessWidget {
  const AgentSkillRecoveryPanel({super.key, required this.controller});
  final AgentSkillController controller;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      if (!controller.current ||
          controller.pending == null &&
              controller.accepted == null &&
              controller.notSubmitted == null &&
              controller.error == null) {
        return const SizedBox.shrink();
      }
      return Material(
        color: Theme.of(context).colorScheme.surfaceContainerLow,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * .3,
          ),
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (controller.error != null) Text(controller.error!),
                if (controller.pending case final pending?) ...[
                  Text(
                    'Unconfirmed ${pending.operation}',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  SelectableText(
                    'Exact request ${pending.key}\n${pending.resourceId ?? 'New Skill'}',
                  ),
                  const Text(
                    'This saved request will never be resent. A missing or unavailable receipt leaves it unconfirmed.',
                  ),
                  OutlinedButton(
                    onPressed:
                        controller.busy ||
                            controller.client.recoveryError != null
                        ? null
                        : controller.recover,
                    child: const Text('Check exact receipt'),
                  ),
                ],
                if (controller.accepted case final accepted?) ...[
                  Text(
                    'Accepted ${accepted.raw['operation']}',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  SelectableText(
                    '${accepted.raw['resourceId']} · ${accepted.raw['acceptedAt']}',
                  ),
                  if (accepted.raw['afterVersion'] != null)
                    Text('Saved version ${accepted.raw['afterVersion']}'),
                  if (accepted.raw['trash'] != null)
                    Text(
                      'Moved to Trash · ${accepted.raw['trash']['compensation'] == 'exact_restore' ? 'exact restore available within retention' : 'equivalent replacement only; original Agent stays retired'}',
                    ),
                  if (controller.needsLocalSave)
                    OutlinedButton(
                      onPressed:
                          controller.busy ||
                              controller.client.recoveryError != null
                          ? null
                          : controller.settleLocally,
                      child: const Text('Save accepted receipt locally'),
                    ),
                ],
                if (controller.notSubmitted != null)
                  const Text(
                    'The last review closed before dispatch. No catalog request was sent.',
                  ),
                if (!controller.loaded ||
                    controller.client.recoveryError != null)
                  OutlinedButton(
                    onPressed: controller.busy ? null : controller.reload,
                    child: const Text('Reload protected catalog recovery'),
                  ),
              ],
            ),
          ),
        ),
      );
    },
  );
}
