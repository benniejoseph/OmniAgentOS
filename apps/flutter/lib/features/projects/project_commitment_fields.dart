import 'package:flutter/material.dart';

import 'project_contracts.dart';
import 'projects.dart';

class ProjectCommitmentDraft {
  ProjectCommitmentDraft({ProjectTask? task})
    : humanOwner = task?.humanOwner ?? '',
      dueDate = task?.dueDate ?? '',
      dueTimeZone = task?.dueTimeZone ?? '',
      deadline = task?.dueDate != null
          ? 'date'
          : task?.dueAt != null
          ? 'existing'
          : 'none',
      existingDueAt = task?.dueAt,
      dependsOn = [...?task?.dependsOn];
  String humanOwner, dueDate, dueTimeZone, deadline;
  final DateTime? existingDueAt;
  final List<String> dependsOn;
  Json get changes => {
    'humanOwner': humanOwner.trim().isEmpty ? null : humanOwner.trim(),
    if (deadline != 'existing') 'dueAt': null,
    'dueDate': deadline == 'date' ? dueDate : null,
    'dueTimeZone': deadline == 'date' && dueTimeZone.trim().isNotEmpty
        ? dueTimeZone.trim()
        : null,
    'dependsOn': List<String>.of(dependsOn),
  };
}

class ProjectCommitmentFields extends StatefulWidget {
  const ProjectCommitmentFields({
    super.key,
    required this.draft,
    required this.tasks,
    this.taskId,
    this.enabled = true,
  });
  final ProjectCommitmentDraft draft;
  final List<ProjectTask> tasks;
  final String? taskId;
  final bool enabled;
  @override
  State<ProjectCommitmentFields> createState() =>
      _ProjectCommitmentFieldsState();
}

class _ProjectCommitmentFieldsState extends State<ProjectCommitmentFields> {
  late final _owner = TextEditingController(text: widget.draft.humanOwner);
  late final _date = TextEditingController(text: widget.draft.dueDate);
  late final _zone = TextEditingController(text: widget.draft.dueTimeZone);
  @override
  void dispose() {
    _owner.dispose();
    _date.dispose();
    _zone.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final draft = widget.draft;
    final choices = widget.tasks
        .where((task) => task.id != widget.taskId)
        .toList();
    final unavailable = draft.dependsOn
        .where((id) => !choices.any((task) => task.id == id))
        .length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(height: 12),
        Text('Commitment', style: Theme.of(context).textTheme.titleSmall),
        TextFormField(
          key: const Key('project-human-owner'),
          controller: _owner,
          enabled: widget.enabled,
          maxLength: 160,
          decoration: const InputDecoration(
            labelText: 'Responsible person',
            hintText: 'Name, if agreed',
          ),
          onChanged: (value) => draft.humanOwner = value,
        ),
        DropdownButtonFormField<String>(
          key: const Key('project-deadline-kind'),
          initialValue: draft.deadline,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Deadline'),
          items: [
            const DropdownMenuItem(
              value: 'none',
              child: Text('No agreed deadline'),
            ),
            const DropdownMenuItem(
              value: 'date',
              child: Text('Calendar date — no time'),
            ),
            if (draft.existingDueAt != null)
              const DropdownMenuItem(
                value: 'existing',
                child: Text('Keep existing date and time'),
              ),
          ],
          onChanged: widget.enabled
              ? (value) {
                  if (value != null) setState(() => draft.deadline = value);
                }
              : null,
        ),
        if (draft.deadline == 'existing')
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text('Saved deadline: ${draft.existingDueAt!.toLocal()}'),
          ),
        if (draft.deadline == 'date') ...[
          TextFormField(
            key: const Key('project-due-date'),
            controller: _date,
            enabled: widget.enabled,
            keyboardType: TextInputType.datetime,
            decoration: InputDecoration(
              labelText: 'Agreed due date',
              hintText: 'YYYY-MM-DD',
              suffixIcon: IconButton(
                tooltip: 'Choose due date',
                onPressed: widget.enabled ? _pickDate : null,
                icon: const Icon(Icons.calendar_month_outlined),
              ),
            ),
            onChanged: (value) => draft.dueDate = value,
            validator: (value) {
              try {
                if (value == null || value.isEmpty) {
                  return 'Enter the agreed date.';
                }
                projectOptionalCalendarDate(value);
                return null;
              } catch (_) {
                return 'Use a valid calendar date: YYYY-MM-DD.';
              }
            },
          ),
          TextFormField(
            key: const Key('project-due-time-zone'),
            controller: _zone,
            enabled: widget.enabled,
            maxLength: 80,
            decoration: const InputDecoration(
              labelText: 'Deadline time zone, if agreed',
              hintText: 'For example, Asia/Kolkata',
            ),
            onChanged: (value) => draft.dueTimeZone = value,
          ),
          const Text(
            'A date-only commitment has no clock time. Leave the time zone blank if it has not been agreed.',
          ),
        ],
        const SizedBox(height: 12),
        Text('Depends on', style: Theme.of(context).textTheme.titleSmall),
        if (choices.isEmpty) const Text('No other tasks in this project.'),
        for (final task in choices)
          CheckboxListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            title: Text(task.title),
            value: draft.dependsOn.contains(task.id),
            onChanged:
                widget.enabled &&
                    (draft.dependsOn.contains(task.id) ||
                        draft.dependsOn.length < 20)
                ? (value) => setState(() {
                    if (value == true) {
                      draft.dependsOn.add(task.id);
                    } else {
                      draft.dependsOn.remove(task.id);
                    }
                  })
                : null,
          ),
        if (unavailable > 0)
          Text(
            '$unavailable saved dependencies outside this loaded view will be preserved.',
          ),
      ],
    );
  }

  Future<void> _pickDate() async {
    DateTime? selected;
    try {
      final raw = projectOptionalCalendarDate(widget.draft.dueDate);
      if (raw != null) {
        selected = DateTime(
          int.parse(raw.substring(0, 4)),
          int.parse(raw.substring(5, 7)),
          int.parse(raw.substring(8, 10)),
        );
      }
    } catch (_) {
      /* An incomplete typed date does not select a day. */
    }
    final picked = await showDatePicker(
      context: context,
      initialDate: selected,
      firstDate: DateTime(1),
      lastDate: DateTime(9999, 12, 31),
    );
    if (!mounted || picked == null) return;
    final value =
        '${picked.year.toString().padLeft(4, '0')}-${picked.month.toString().padLeft(2, '0')}-${picked.day.toString().padLeft(2, '0')}';
    setState(() {
      widget.draft.dueDate = value;
      _date.text = value;
    });
  }
}
