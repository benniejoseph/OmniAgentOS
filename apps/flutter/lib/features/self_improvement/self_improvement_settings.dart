import 'package:flutter/material.dart';

import 'self_improvement_controller.dart';
import 'self_improvement_models.dart';
import 'self_improvement_widgets.dart';

/// An inline editor stays inside the owner-bound route and keeps its starting
/// generation until save. A refresh never silently rebases an open draft.
class SelfImprovementSettings extends StatefulWidget {
  const SelfImprovementSettings({
    super.key,
    required this.controller,
    this.configuration,
    required this.onClose,
  });
  final SelfImprovementController controller;
  final SelfImprovementConfiguration? configuration;
  final VoidCallback onClose;
  @override
  State<SelfImprovementSettings> createState() =>
      _SelfImprovementSettingsState();
}

class _SelfImprovementSettingsState extends State<SelfImprovementSettings> {
  final _form = GlobalKey<FormState>();
  late final SelfImprovementConfiguration? _initial = widget.configuration;
  late final _daily = TextEditingController(
    text: _initial?.policy.dailyBudgetUsd.toString() ?? '100',
  );
  late final _cycle = TextEditingController(
    text: _initial?.policy.maxCycleBudgetUsd.toString() ?? '10',
  );
  late final _zone = TextEditingController(
    text: _initial?.timeZone ?? 'Asia/Kolkata',
  );
  late String? _projectId = _initial?.projectId,
      _repositoryId = _initial?.repositoryId;
  late int _hour = _initial?.dailyHour ?? 7;
  late bool _automatic = _initial?.policy.autoReleaseRoutineChanges ?? true;
  late bool _notifications = _initial?.policy.notifyOutcomes ?? true;
  String? _error;

  @override
  void dispose() {
    _daily.dispose();
    _cycle.dispose();
    _zone.dispose();
    super.dispose();
  }

  bool get _generationChanged {
    if (_initial == null) return false;
    final matching = widget.controller.snapshot?.configurations.where(
      (item) => item.id == _initial.id,
    );
    return matching == null ||
        matching.isEmpty ||
        matching.first.generation != _initial.generation;
  }

  bool get _enabled =>
      widget.controller.current &&
      widget.controller.canManage &&
      !widget.controller.acting &&
      !widget.controller.loading &&
      !widget.controller.refreshRequired &&
      !_generationChanged &&
      _error == null;

  Future<void> _save() async {
    if (!_enabled || !_form.currentState!.validate()) return;
    final origin = widget.controller;
    try {
      final saved = await origin.configure(
        SelfImprovementConfigureInput(
          projectId: _projectId!,
          repositoryId: _repositoryId!,
          dailyBudgetUsd: double.parse(_daily.text),
          maxCycleBudgetUsd: double.parse(_cycle.text),
          dailyHour: _hour,
          timeZone: _zone.text.trim(),
          autoReleaseRoutineChanges: _automatic,
          notifyOutcomes: _notifications,
          expectedGeneration: _initial?.generation,
        ),
      );
      if (mounted &&
          identical(origin, widget.controller) &&
          origin.current &&
          saved) {
        widget.onClose();
      }
    } catch (error) {
      if (mounted && origin.current) {
        setState(
          () => _error = error is FormatException
              ? error.message
              : error is StateError
              ? error.message
              : 'These settings could not be confirmed. Close the editor and refresh before continuing.',
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller, theme = Theme.of(context);
    final repositories = controller.repositories
        .where((item) => item.supported)
        .toList();
    final projectItems = <DropdownMenuItem<String>>[
      if (_initial != null &&
          !controller.projects.any((item) => item.id == _initial.projectId))
        DropdownMenuItem(
          value: _initial.projectId,
          child: const Text('Current improvement project'),
        ),
      for (final project in controller.projects)
        DropdownMenuItem(
          value: project.id,
          child: Text(project.title, overflow: TextOverflow.ellipsis),
        ),
    ];
    final repositoryItems = <DropdownMenuItem<String>>[
      if (_initial != null &&
          !repositories.any(
            (item) => item.repositoryId == _initial.repositoryId,
          ))
        DropdownMenuItem(
          value: _initial.repositoryId,
          child: Text(_initial.repository.fullName),
        ),
      for (final repository in repositories)
        DropdownMenuItem(
          value: repository.repositoryId,
          child: Text(repository.fullName, overflow: TextOverflow.ellipsis),
        ),
    ];
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Align(
        alignment: Alignment.topLeft,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: Form(
            key: _form,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _initial == null
                      ? 'Set up daily improvement'
                      : 'Improvement settings',
                  style: theme.textTheme.titleLarge,
                ),
                const SizedBox(height: 8),
                const Text(
                  'Atlas investigates, Forge prepares a repair, and Sentinel reviews the evidence. Each cycle stays within your limits.',
                ),
                if (controller.setupLoading)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 16),
                    child: LinearProgressIndicator(),
                  ),
                if (_generationChanged)
                  const ImprovementNotice(
                    'The saved settings changed while this draft was open. Close this editor and read the current settings before saving.',
                    error: true,
                  ),
                if (_error != null) ImprovementNotice(_error!, error: true),
                const SizedBox(height: 24),
                DropdownButtonFormField<String>(
                  key: const Key('improvement-project'),
                  initialValue: _projectId,
                  isExpanded: true,
                  items: projectItems,
                  decoration: const InputDecoration(labelText: 'Work project'),
                  onChanged: _enabled && _initial == null
                      ? (value) => setState(() => _projectId = value)
                      : null,
                  validator: (value) => value == null
                      ? 'Choose the project for this work.'
                      : null,
                ),
                if (!controller.setupLoading && projectItems.isEmpty)
                  const ImprovementNotice(
                    'Create a project in My work, then refresh this setup.',
                  ),
                const SizedBox(height: 16),
                DropdownButtonFormField<String>(
                  key: const Key('improvement-repository'),
                  initialValue: _repositoryId,
                  isExpanded: true,
                  items: repositoryItems,
                  decoration: const InputDecoration(
                    labelText: 'Source repository',
                  ),
                  onChanged: _enabled
                      ? (value) => setState(() => _repositoryId = value)
                      : null,
                  validator: (value) => value == null
                      ? 'Choose the connected Asael repository.'
                      : null,
                ),
                const SizedBox(height: 24),
                LayoutBuilder(
                  builder: (context, constraints) {
                    final fields = [
                      TextFormField(
                        key: const Key('improvement-daily-budget'),
                        controller: _daily,
                        enabled: _enabled,
                        keyboardType: const TextInputType.numberWithOptions(
                          decimal: true,
                        ),
                        decoration: const InputDecoration(
                          labelText: 'Daily AI limit (USD, UTC)',
                        ),
                        validator: (value) => _budget(value) == null
                            ? 'Enter an amount above 0 and at most 100.'
                            : null,
                      ),
                      TextFormField(
                        key: const Key('improvement-cycle-budget'),
                        controller: _cycle,
                        enabled: _enabled,
                        keyboardType: const TextInputType.numberWithOptions(
                          decimal: true,
                        ),
                        decoration: const InputDecoration(
                          labelText: 'Limit per cycle (USD)',
                        ),
                        validator: (value) {
                          final amount = _budget(value),
                              daily = _budget(_daily.text);
                          return amount == null ||
                                  daily == null ||
                                  amount > daily
                              ? 'Use an amount above 0, within the daily limit.'
                              : null;
                        },
                      ),
                    ];
                    return constraints.maxWidth < 520
                        ? Column(
                            children: [
                              fields[0],
                              const SizedBox(height: 16),
                              fields[1],
                            ],
                          )
                        : Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Expanded(child: fields[0]),
                              const SizedBox(width: 16),
                              Expanded(child: fields[1]),
                            ],
                          );
                  },
                ),
                const SizedBox(height: 8),
                Text(
                  'The daily limit includes work carried over from earlier days. Changing the schedule does not reset it.',
                  style: theme.textTheme.bodySmall,
                ),
                const SizedBox(height: 24),
                DropdownButtonFormField<int>(
                  key: const Key('improvement-hour'),
                  initialValue: _hour,
                  decoration: const InputDecoration(
                    labelText: 'Daily start time',
                  ),
                  items: [
                    for (var hour = 0; hour < 24; hour++)
                      DropdownMenuItem(
                        value: hour,
                        child: Text('${hour.toString().padLeft(2, '0')}:00'),
                      ),
                  ],
                  onChanged: _enabled
                      ? (value) => setState(() => _hour = value!)
                      : null,
                ),
                const SizedBox(height: 16),
                TextFormField(
                  key: const Key('improvement-time-zone'),
                  controller: _zone,
                  enabled: _enabled,
                  decoration: const InputDecoration(
                    labelText: 'Schedule time zone',
                    hintText: 'Asia/Kolkata',
                  ),
                  validator: (value) =>
                      value == null || value.trim().isEmpty || value.length > 80
                      ? 'Enter a time zone, such as Asia/Kolkata.'
                      : null,
                ),
                const SizedBox(height: 20),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: _automatic,
                  onChanged: _enabled
                      ? (value) => setState(() => _automatic = value!)
                      : null,
                  title: const Text(
                    'Publish verified routine repairs automatically',
                  ),
                  subtitle: const Text(
                    'Larger changes need your review. Protected code always requires a trusted manual release.',
                  ),
                ),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: _notifications,
                  onChanged: _enabled
                      ? (value) => setState(() => _notifications = value!)
                      : null,
                  title: const Text('Outcome notifications'),
                  subtitle: const Text(
                    'Notify me when a repair finishes or needs attention. Applies to new cycles; history is always retained.',
                  ),
                ),
                const ImprovementNotice(
                  'Changes to budgets, automatic publishing or notifications require the Mac publisher to be enrolled for the new policy. Schedule-only edits do not change that policy.',
                ),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    FilledButton(
                      key: const Key('improvement-save-settings'),
                      onPressed: _enabled && !controller.setupLoading
                          ? _save
                          : null,
                      child: Text(
                        controller.acting
                            ? 'Saving settings…'
                            : 'Save settings',
                      ),
                    ),
                    TextButton(
                      onPressed: controller.acting ? null : widget.onClose,
                      child: const Text('Cancel settings'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  double? _budget(String? value) {
    final amount = double.tryParse(value ?? '');
    return amount != null && amount.isFinite && amount > 0 && amount <= 100
        ? amount
        : null;
  }
}
